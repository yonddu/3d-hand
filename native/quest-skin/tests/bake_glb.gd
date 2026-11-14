extends SceneTree
## Bake a Quest recording segment onto a skin and export one animated GLB per hand, plus the raw
## Quest joint positions (JSON) for side-by-side checks, plus fidelity numbers.
## godot --headless --path native/quest-skin --script res://tests/bake_glb.gd -- <jsonl> <t0 s> <t1 s> <out dir> [skin]

const FPS := 30.0


func _initialize() -> void:
	process_frame.connect(_run, CONNECT_ONE_SHOT)


func _run() -> void:
	var a := OS.get_cmdline_user_args()
	var path: String = a[0]
	var t0 := float(a[1])
	var t1 := float(a[2])
	var out: String = a[3]
	var skin: String = a[4] if a.size() > 4 else "res://skins/hand_left.glb.bin"
	DirAccess.make_dir_recursive_absolute(out)
	# read frames in [t0, t1]
	var frames := []
	var f := FileAccess.open(path, FileAccess.READ)
	f.get_line()
	while not f.eof_reached():
		var d = JSON.parse_string(f.get_line())
		if d == null or not d.has("hands"):
			continue
		var t: float = d.t / 1000.0
		if t < t0:
			continue
		if t > t1:
			break
		frames.append(d)
	# resample at FPS
	var picks := []
	var k := 0
	var n := int((t1 - t0) * FPS)
	for i in n:
		var want := t0 + i / FPS
		while k + 1 < frames.size() and frames[k + 1].t / 1000.0 <= want:
			k += 1
		picks.append(frames[k])
	var bytes := FileAccess.get_file_as_bytes(skin)
	var joints_out := {"fps": FPS, "t0": t0, "left": [], "right": [], "head": []}
	for d in picks:
		joints_out.head.append(d.get("head"))
	var report := []
	for s in ["left", "right"]:
		var root := Node3D.new()
		get_root().add_child(root)
		var r := SkinRig.new(s)
		root.add_child(r)
		r.contact_fix = OS.get_environment("NOCONTACT") == ""
		var e := r.load_skin(bytes, "glb")
		if e != "":
			print(s, " load error ", e)
			continue
		# auto size from the whole segment first (median)
		for d in picks:
			r.apply(_joints(d.hands[s]), _head(d))
		var skel: Skeleton3D = r._skel
		var scene_root: Node = r._skin_root.get_child(0)
		var ap := AnimationPlayer.new()
		ap.name = "AnimationPlayer"
		scene_root.add_child(ap)
		var anim := Animation.new()
		anim.length = n / FPS
		var sp := String(scene_root.get_path_to(skel))
		var rot_tr := {}
		var pos_tr := {}
		for b in skel.get_bone_count():
			var bn := skel.get_bone_name(b)
			var ti := anim.add_track(Animation.TYPE_ROTATION_3D)
			anim.track_set_path(ti, NodePath(sp + ":" + bn))
			rot_tr[b] = ti
			var tp := anim.add_track(Animation.TYPE_POSITION_3D)
			anim.track_set_path(tp, NodePath(sp + ":" + bn))
			pos_tr[b] = tp
		var tipgap := []
		var pinch := []
		for i in picks.size():
			var d = picks[i]
			var J := _joints(d.hands[s])
			r.apply(J, _head(d))
			var tt := i / FPS
			for b in skel.get_bone_count():
				anim.rotation_track_insert_key(rot_tr[b], tt, skel.get_bone_pose_rotation(b))
				anim.position_track_insert_key(pos_tr[b], tt, skel.get_bone_pose_position(b))
			var pts := []
			for j in 26:
				var p: Vector3 = J[j].origin
				pts.append([snappedf(p.x, 0.0001), snappedf(p.y, 0.0001), snappedf(p.z, 0.0001)])
			joints_out[s].append(pts)
			for fname in ["thumb", "index", "middle", "ring", "little"]:
				var tip := r.tip_world(fname)
				var qi: int = HandBoneMap.FINGER_BASE[fname] + (3 if fname == "thumb" else 4)
				tipgap.append(tip.distance_to(J[qi].origin) * 100.0)
			var qp: float = J[5].origin.distance_to(J[10].origin) * 100.0
			if qp < 2.0:
				pinch.append([qp, r.tip_world("thumb").distance_to(r.tip_world("index")) * 100.0])
				if OS.get_environment("DEBUG") != "":
					print(s, " q=%.1f skin=%.1f contact=%s" % [qp, pinch[-1][1], str(r.last_contact)])
		var lib := AnimationLibrary.new()
		lib.add_animation("quest_take", anim)
		ap.add_animation_library("", lib)
		var doc := GLTFDocument.new()
		var st := GLTFState.new()
		var err := doc.append_from_scene(r._skin_root, st)
		if err == OK:
			err = doc.write_to_filesystem(st, out.path_join("skin_%s.glb" % s))
		tipgap.sort()
		var pin_s := "no pinch frames"
		if pinch.size():
			var sk := []
			for p in pinch:
				sk.append(p[1])
			sk.sort()
			pin_s = "%d pinch frames (Quest thumb-index < 2 cm): skin gap median %.1f cm, max %.1f cm" % [pinch.size(), sk[sk.size() / 2], sk[-1]]
		var line := "%s: export %s, size x%.3f, fingertip offset skin vs Quest median %.1f cm, p90 %.1f cm; %s" % [s, error_string(err), r.auto_scale * r.user_scale, tipgap[tipgap.size() / 2], tipgap[int(tipgap.size() * 0.9)], pin_s]
		print(line)
		report.append(line)
	var jf := FileAccess.open(out.path_join("quest_joints.json"), FileAccess.WRITE)
	jf.store_string(JSON.stringify(joints_out))
	var rf := FileAccess.open(out.path_join("report.txt"), FileAccess.WRITE)
	rf.store_string("\n".join(report))
	quit()


func _joints(arr) -> Array:
	var J := []
	for row in arr:
		J.append(Transform3D(Basis(Quaternion(row[3], row[4], row[5], row[6])), Vector3(row[0], row[1], row[2])))
	return J


func _head(d):
	var hd = d.get("head")
	if hd == null or hd.size() < 7:
		return null
	return Transform3D(Basis(Quaternion(hd[3], hd[4], hd[5], hd[6])), Vector3(hd[0], hd[1], hd[2]))
