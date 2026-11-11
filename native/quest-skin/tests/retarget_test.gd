extends SceneTree
## Headless check: feed a Quest recording (q0.1 jsonl) into SkinRig and measure how far the
## skin's bone directions are from the Quest bone directions (degrees), per hand.
## godot --headless --path native/quest-skin --script res://tests/retarget_test.gd -- <jsonl> [skin] [frames]

func _initialize() -> void:
	process_frame.connect(_run, CONNECT_ONE_SHOT)


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var path: String = args[0]
	var skin: String = args[1] if args.size() > 1 else "res://skins/hand_left.glb.bin"
	var max_frames: int = int(args[2]) if args.size() > 2 else 600
	var root := Node3D.new()
	get_root().add_child(root)
	var rigs := {}
	var bytes := FileAccess.get_file_as_bytes(skin)
	for s in ["left", "right"]:
		var r := SkinRig.new(s)
		root.add_child(r)
		var e := r.load_skin(bytes, skin.get_extension() if skin.get_extension() == "fbx" else "glb")
		print(s, " load: ", e if e != "" else r.status, " map=", r._map.joints.size(), " tips=", r._map.tip.keys())
		rigs[s] = r
		r.use_ik = OS.get_environment("NOIK") == ""
	var f := FileAccess.open(path, FileAccess.READ)
	f.get_line()
	var n := 0
	var err := {"left": [], "right": []}
	var tipd := {"left": [], "right": []}
	var backd := {"left": [], "right": []}
	var elbow := {"left": [], "right": []}
	while not f.eof_reached() and n < max_frames:
		var d = JSON.parse_string(f.get_line())
		if d == null or not d.has("hands"):
			continue
		for s in d.hands:
			var arr = d.hands[s]
			if arr == null:
				continue
			var J := []
			for row in arr:
				J.append(Transform3D(Basis(Quaternion(row[3], row[4], row[5], row[6])), Vector3(row[0], row[1], row[2])))
			var r: SkinRig = rigs[s]
			var hd = d.get("head")
			var head = null
			if hd != null and hd.size() >= 7:
				head = Transform3D(Basis(Quaternion(hd[3], hd[4], hd[5], hd[6])), Vector3(hd[0], hd[1], hd[2]))
			r.apply(J, head)
			if head != null and r._map.forearm >= 0 and r._map.upperarm >= 0:
				var sk: Skeleton3D = r._skel
				var ua: Vector3 = sk.global_transform * sk.get_bone_global_pose(r._map.upperarm).origin
				var el: Vector3 = sk.global_transform * sk.get_bone_global_pose(r._map.forearm).origin
				elbow[s].append([ua.distance_to(head.origin), el.y - head.origin.y, r.bone_world(1).distance_to(J[1].origin)])
			for base in [2, 6, 11, 16, 21]:
				var last: int = base + (3 if base == 2 else 4)
				for j in range(base if base == 2 else base + 1, last - 1):
					var a := r.bone_world(j); var b := r.bone_world(j + 1)
					if a == Vector3.ZERO or b == Vector3.ZERO: continue
					var qd: Vector3 = J[j + 1].origin - J[j].origin
					err[s].append(rad_to_deg((b - a).angle_to(qd)))
			var lat := r.bone_world(7) - r.bone_world(22)
			var fw := r.bone_world(12) - r.bone_world(1)
			var bk := lat.cross(fw) if s == "left" else fw.cross(lat)
			backd[s].append(rad_to_deg(bk.angle_to(J[0].basis.y)))
			var t := r.tip_world("index")
			if t != Vector3.ZERO:
				tipd[s].append(t.distance_to(J[10].origin) * 100.0)
		n += 1
	for s in err:
		var e: Array = err[s]; e.sort()
		var td: Array = tipd[s]; td.sort()
		if e.is_empty(): continue
		var bd: Array = backd[s]; bd.sort()
		var el: Array = elbow[s]
		if el.size():
			var m: Array = el[el.size() / 2]
			print("%s arm: shoulder-head %.2f m, elbow below eyes %.2f m, hand on wrist %.3f m (mid frame)" % [s, m[0], -m[1], m[2]])
		print("%s back-of-hand vs Quest palm normal: median %.1f p90 %.1f deg" % [s, bd[bd.size()/2], bd[int(bd.size()*0.9)]])
		print("%s: frames-bones %d  bone dir err median %.1f  p90 %.1f  max %.1f deg | index tip off median %.1f cm (scale %.3f)" % [s, e.size(), e[e.size()/2], e[int(e.size()*0.9)], e[-1], td[td.size()/2] if td.size() else -1.0, rigs[s].auto_scale])
	quit()
