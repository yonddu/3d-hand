class_name SkinRig
extends Node3D
## Puts any rigged hand/arm skin on one tracked Quest hand.
## Retarget = rotation copy: each mapped bone takes the Quest joint's frame times a fixed
## offset computed once from the skin's rest pose (bone direction + back-of-hand direction),
## so the skin keeps its own finger lengths. Works for any bone naming HandBoneMap understands.

const THUMB_ROLL_DEG := 88.0   # Quest thumb nail axis vs back of hand (measured on pair recordings)

var side := "left"               # tracked hand this rig follows
var user_scale := 1.0            # only skin edit the app offers
var auto_scale := 0.0            # skin hand length -> user's hand length (0 = not measured yet)
var status := "no skin"

var _skin_root: Node3D
var _skel: Skeleton3D
var _map := {}
var _order: PackedInt32Array = []
var _offset := {}                # bone -> Basis (rest frame -> bone rest basis)
var _target_joint := {}          # bone -> xr joint
var _arm_off := {}               # "forearm"/"upperarm" -> rest offset
var _arm_len := [0.0, 0.0]       # forearm, upper arm length (skeleton space)
var use_ik := true
var _halves := []                 # [helper bone, the bone it follows half-way]
var _thenar := -1                  # optional helper bone ("...Thenar"), see tools/thenar_helper.py
const THENAR_SHARE := 0.5
var last_contact := []
var contact_fix := true            # real thumb tip near a fingertip -> skin thumb tip near it too
const CONTACT_FULL := 0.025        # Quest gap (m) at or below which the skin gap follows fully
const CONTACT_NONE := 0.045        # Quest gap above which nothing is changed
const CONTACT_MAX_DEG := 30.0      # most a thumb bone may turn for it per frame
var _wrist_back := Vector3.UP
const SHOULDER := Vector3(0.18, -0.24, 0.06)   # from eyes: side, down, back (metres, user's body)
var _mirror := false
var _model_len := 0.0            # skin wrist -> middle tip at scale 1 (metres in world)
var _len_samples: Array = []
var _len_from := 0                # chain the skin length was measured on (Quest side matches it)


func _init(p_side := "left") -> void:
	side = p_side
	name = "Skin_" + side


## bytes = .glb/.gltf/.fbx file content. Returns "" on success or an error text.
func load_skin(bytes: PackedByteArray, ext := "glb") -> String:
	var doc: GLTFDocument
	var st: GLTFState
	if ext == "fbx":
		doc = FBXDocument.new()
		st = FBXState.new()
	else:
		doc = GLTFDocument.new()
		st = GLTFState.new()
	var err := doc.append_from_buffer(bytes, "", st)
	if err != OK:
		return "file read failed (%d)" % err
	var scene := doc.generate_scene(st)
	if scene == null:
		return "no scene in file"
	return use_scene(scene)


func use_scene(scene: Node) -> String:
	if _skin_root:
		_skin_root.queue_free()
	_skel = null
	_skin_root = Node3D.new()
	_skin_root.name = "SkinRoot"
	add_child(_skin_root)
	_skin_root.add_child(scene)
	for s in _find_skeletons(scene):
		var m := HandBoneMap.map_hand(s, side)
		if not m.is_empty() and m.joints.size() > _map.get("joints", {}).size():
			_skel = s
			_map = m
	if _skel == null:
		status = "no hand bones found"
		return status
	_mirror = _map.side != side
	_thenar = -1
	_halves.clear()
	for b in _skel.get_bone_count():
		var bn := _skel.get_bone_name(b)
		if bn.ends_with("_half"):
			var c := _skel.find_bone(bn.trim_suffix("_half"))
			if c >= 0:
				_halves.append([b, c])
		if _skel.get_bone_name(b).to_lower().contains("thenar"):
			_thenar = b
	_skin_root.scale = Vector3(-1, 1, 1) if _mirror else Vector3.ONE
	_prepare()
	auto_scale = 0.0
	_len_samples.clear()
	status = "%d bones%s" % [_map.joints.size(), " (mirrored)" if _mirror else ""]
	var miss := missing_fingers()
	if not miss.is_empty():
		status += ", no " + ",".join(miss)
	return ""


func _find_skeletons(n: Node) -> Array:
	var out := []
	if n is Skeleton3D:
		out.append(n)
	for c in n.get_children():
		out.append_array(_find_skeletons(c))
	return out


func _prepare() -> void:
	var s := _skel
	_order = []
	var stack: Array = Array(s.get_parentless_bones())
	stack.reverse()
	while not stack.is_empty():
		var b: int = stack.pop_back()
		_order.append(b)
		var ch := Array(s.get_bone_children(b))
		ch.reverse()
		stack.append_array(ch)
	var rest := {}
	for b in s.get_bone_count():
		rest[b] = s.get_bone_global_rest(b)
	var J: Dictionary = _map.joints
	var hand: int = _map.hand
	var hp: Vector3 = rest[hand].origin
	var mid: int = J.get(12, J.get(11, -1))
	var idx: int = J.get(7, J.get(6, -1))
	var lit: int = J.get(22, J.get(21, J.get(17, -1)))
	var fwd_h := Vector3(0, 0, -1)
	if mid >= 0:
		fwd_h = (rest[mid].origin - hp).normalized()
	var lat := Vector3(1, 0, 0)
	if idx >= 0 and lit >= 0:
		lat = (rest[idx].origin - rest[lit].origin).normalized()
	var back: Vector3 = lat.cross(fwd_h) if _map.side == "left" else fwd_h.cross(lat)
	back = back.normalized()
	_offset.clear()
	_target_joint.clear()
	# finger chains: direction to the next mapped joint (or tip bone)
	for j in J:
		var b: int = J[j]
		var fwd := Vector3.ZERO
		if j == HandBoneMap.WRIST:
			fwd = fwd_h
		else:
			var nb := _next_bone(j)
			if nb >= 0:
				fwd = rest[nb].origin - rest[b].origin
			if fwd.length() < 1e-6:
				var pb := s.get_bone_parent(b)
				fwd = rest[b].origin - rest[pb].origin if pb >= 0 else fwd_h
		fwd = fwd.normalized()
		var roll := 0.0
		if j >= 2 and j <= 4:
			roll = deg_to_rad(THUMB_ROLL_DEG) * (1.0 if _map.side == "left" else -1.0)
		_offset[b] = _frame(fwd, back, roll).inverse() * rest[b].basis
		_target_joint[b] = j
	# forearm / upper arm: elbow IK from an estimated shoulder (head pose); wrist frame if no head
	_arm_off.clear()
	_arm_len = [0.0, 0.0]
	for key in ["forearm", "upperarm"]:
		var b: int = _map[key]
		if b < 0:
			continue
		var child: int = hand if key == "forearm" else _map.forearm
		if child < 0:
			continue
		var fwd: Vector3 = (rest[child].origin - rest[b].origin)
		_arm_len[0 if key == "forearm" else 1] = fwd.length()
		_arm_off[key] = _frame(fwd, back, 0.0).inverse() * rest[b].basis
		_offset[b] = _arm_off[key]
		_target_joint[b] = HandBoneMap.WRIST
	# hand size = length along the middle finger chain (pose independent: a fist is as long as a flat hand)
	var chain := [hand]
	for j in [12, 13, 14]:
		if J.has(j):
			chain.append(J[j])
	if _map.tip.has("middle"):
		chain.append(_map.tip["middle"])
	_model_len = 0.0
	_len_from = chain.size()
	if chain.size() >= 3:
		var w := _skel.global_transform
		for i in range(1, chain.size()):
			_model_len += (w * rest[chain[i]].origin).distance_to(w * rest[chain[i - 1]].origin)
		_model_len /= max(absf(_skin_root.global_transform.basis.get_scale().x), 1e-6)


func _next_bone(j: int) -> int:
	var J: Dictionary = _map.joints
	for f in HandBoneMap.FINGER_BASE:
		var base: int = HandBoneMap.FINGER_BASE[f]
		var last := base + (3 if f == "thumb" else 4)
		if j >= base and j < last:
			if J.has(j + 1):
				return J[j + 1]
			if j + 1 == last and _map.tip.has(f):
				return _map.tip[f]
	return -1


## Frame with Quest/OpenXR convention: -Z toward fingertip, +Y back of hand, X = Y x Z.
static func _frame(fwd_in: Vector3, back: Vector3, roll: float) -> Basis:
	var fwd := fwd_in.normalized()
	var z := -fwd
	var y := back - fwd * back.dot(fwd)
	if y.length() < 1e-5:
		y = Vector3.UP - fwd * fwd.y
	y = y.normalized()
	if roll != 0.0:
		y = Basis(fwd, roll) * y
	var x := y.cross(z).normalized()
	return Basis(x, y, z)


## joints: Array of 26 Transform3D in world space (null when the joint has no pose).
func apply(joints: Array, head = null) -> void:
	if _skel == null:
		return
	var wt: Transform3D = joints[HandBoneMap.WRIST]
	if auto_scale == 0.0 and _model_len > 0.0:
		_len_samples.append(_quest_len(joints))
		if _len_samples.size() >= 30:
			_len_samples.sort()
			auto_scale = _len_samples[15] / _model_len
	var sc: float = (auto_scale if auto_scale > 0.0 else 1.0) * user_scale
	_skin_root.scale = Vector3(-sc if _mirror else sc, sc, sc)
	var inv := _skel.global_transform.affine_inverse()
	var frames := {}
	for b in _target_joint:
		var t: Transform3D = inv * joints[_target_joint[b]]
		var f := t.basis.orthonormalized()
		if _mirror:
			f.x = -f.x
		frames[b] = f * _offset[b]
		if b == _map.hand:
			_wrist_back = f.y
	var wrist_local: Vector3 = inv * wt.origin
	if head != null and use_ik and _arm_off.has("forearm") and _arm_off.has("upperarm"):
		_elbow_ik(frames, inv, head, wrist_local)
	var glob := {}
	for b in _order:
		var p := _skel.get_bone_parent(b)
		var pg: Transform3D = glob[p] if p >= 0 else Transform3D.IDENTITY
		var g := pg * _skel.get_bone_rest(b)
		if frames.has(b):
			g.basis = frames[b]
		glob[b] = g
	if contact_fix:
		_thumb_contact(glob, joints, inv)
	if _thenar >= 0 and _map.joints.has(2):
		# thenar helper turns half as much as the thumb metacarpal -> skin keeps its volume
		var t1: int = _map.joints[2]
		var hb: Transform3D = glob[_skel.get_bone_parent(t1)]
		var q_rest := _skel.get_bone_rest(t1).basis.get_rotation_quaternion()
		var q_now: Quaternion = (hb.basis.orthonormalized().inverse() * glob[t1].basis.orthonormalized()).get_rotation_quaternion()
		glob[_thenar] = hb * Transform3D(Basis(q_rest.slerp(q_now, THENAR_SHARE)), _skel.get_bone_rest(t1).origin)
	# half-joint helpers ("<bone>_half", tools/thenar_helper.py): turn half of their bone's rotation
	for pair in _halves:
		var hb: int = pair[0]
		var c: int = pair[1]
		var pg: Transform3D = glob[_skel.get_bone_parent(hb)]
		var qr := _skel.get_bone_rest(c).basis.get_rotation_quaternion()
		var qn: Quaternion = (pg.basis.orthonormalized().inverse() * glob[c].basis.orthonormalized()).get_rotation_quaternion()
		glob[hb] = pg * Transform3D(Basis(qr.slerp(qn, 0.5)), _skel.get_bone_rest(c).origin)
	# move the whole skeleton so the hand bone sits on the tracked wrist
	var delta: Vector3 = wrist_local - glob[_map.hand].origin
	for b in _order:
		var p := _skel.get_bone_parent(b)
		var g: Transform3D = glob[b]
		var loc: Transform3D
		if p >= 0:
			loc = glob[p].affine_inverse() * g
		else:
			loc = Transform3D(g.basis, g.origin + delta)
		_skel.set_bone_pose_rotation(b, loc.basis.get_rotation_quaternion())
		_skel.set_bone_pose_position(b, loc.origin)


func _elbow_ik(frames: Dictionary, inv: Transform3D, head: Transform3D, w: Vector3) -> void:
	var yaw := -head.basis.z
	yaw.y = 0.0
	yaw = yaw.normalized() if yaw.length() > 0.01 else Vector3(0, 0, -1)
	var right := yaw.cross(Vector3.UP)
	var out := -right if side == "left" else right
	var sh_w := head.origin + out * SHOULDER.x + Vector3.UP * SHOULDER.y - yaw * SHOULDER.z
	var pole_w := (Vector3.DOWN + out * 0.5 - yaw * 0.3).normalized()
	var sh: Vector3 = inv * sh_w
	var pole: Vector3 = (inv.basis * pole_w).normalized()
	var a: float = _arm_len[1]
	var b: float = _arm_len[0]
	var to := w - sh
	var d := clampf(to.length(), absf(a - b) + 1e-4, a + b - 1e-4)
	var dir := to.normalized()
	var cos_a := clampf((a * a + d * d - b * b) / (2.0 * a * d), -1.0, 1.0)
	var perp := pole - dir * pole.dot(dir)
	perp = perp.normalized() if perp.length() > 1e-5 else Vector3.DOWN
	var e := sh + dir * (a * cos_a) + perp * (a * sqrt(1.0 - cos_a * cos_a))
	var up_f := (e - sh).normalized()
	var fo_f := (w - e).normalized()
	var hb := _wrist_back
	var n := up_f.cross(fo_f)
	if n.length() < 1e-3:
		n = hb
	n = n.normalized()
	if n.dot(hb) < 0.0:
		n = -n
	var hbp := hb - fo_f * hb.dot(fo_f)
	var fb := (n + hbp.normalized()).normalized() if hbp.length() > 1e-4 else n
	frames[_map.upperarm] = _frame(up_f, n, 0.0) * _arm_off["upperarm"]
	frames[_map.forearm] = _frame(fo_f, fb, 0.0) * _arm_off["forearm"]


## "손 펴고 맞추기": the user holds their hand like the skin's rest pose; from now on that
## pose of theirs = the skin's rest pose (fixes skins whose rest pose is curled or twisted).
func calibrate(joints: Array) -> void:
	if _skel == null:
		return
	var inv := _skel.global_transform.affine_inverse()
	for b in _target_joint:
		if b == _map.forearm or b == _map.upperarm:
			continue
		var f := (inv * (joints[_target_joint[b]] as Transform3D)).basis.orthonormalized()
		if _mirror:
			f.x = -f.x
		_offset[b] = f.inverse() * _skel.get_bone_global_rest(b).basis
	status = status.replace(", calibrated", "") + ", calibrated"


func reset_calibration() -> void:
	if _skel:
		_prepare()
		status = status.replace(", calibrated", "")


func missing_fingers() -> PackedStringArray:
	var out := PackedStringArray()
	if _skel == null:
		return out
	for f in HandBoneMap.FINGER_BASE:
		var base: int = HandBoneMap.FINGER_BASE[f]
		if not _map.joints.has(base + 1) and not _map.joints.has(base + 2):
			out.append(f)
	return out


## Pinch / touch keeping: when the real thumb tip is within a few cm of a real fingertip, turn the
## skin's thumb (distal, proximal, metacarpal; CCD) so its tip sits at the same offset from the skin's
## fingertip. Fixes contacts that a rotation copy breaks when the skin's proportions differ.
func _thumb_contact(glob: Dictionary, joints: Array, inv: Transform3D) -> void:
	var tt: int = _map.tip.get("thumb", -1)
	if tt < 0:
		return
	var qt: Vector3 = (joints[5] as Transform3D).origin
	var best := -1
	var bd := 1e9
	for f in ["index", "middle", "ring", "little"]:
		if not _map.tip.has(f):
			continue
		var d: float = qt.distance_to((joints[HandBoneMap.FINGER_BASE[f] + 4] as Transform3D).origin)
		if d < bd:
			bd = d
			best = HandBoneMap.FINGER_BASE[f]
	if best < 0 or bd > CONTACT_NONE:
		return
	var w := clampf((CONTACT_NONE - bd) / (CONTACT_NONE - CONTACT_FULL), 0.0, 1.0)
	var fname: String = HandBoneMap.FINGER_BASE.find_key(best)
	var ftip: int = _map.tip[fname]
	var gap: Vector3 = inv.basis * (qt - (joints[best + 4] as Transform3D).origin)
	var t_chain := []
	for j in [4, 3, 2]:
		if _map.joints.has(j):
			t_chain.append(_map.joints[j])
	var f_chain := []
	for j in [best + 3, best + 2, best + 1]:
		if _map.joints.has(j):
			f_chain.append(_map.joints[j])
	var start_t: Vector3 = glob[tt].origin
	var start_f: Vector3 = glob[ftip].origin
	# both sides move: the thumb toward (fingertip + real gap), the finger toward (thumb tip - real gap)
	for it in 4:
		_ccd(glob, t_chain, tt, glob[tt].origin.lerp(glob[ftip].origin + gap, w))
		_ccd(glob, f_chain, ftip, glob[ftip].origin.lerp(glob[tt].origin - gap, w * 0.5))
	last_contact = [fname, bd, w, ((glob[tt].origin - glob[ftip].origin) - gap).length(), start_t.distance_to(glob[tt].origin), start_f.distance_to(glob[ftip].origin)]


func _ccd(glob: Dictionary, chain: Array, tip: int, want: Vector3) -> void:
	for b in chain:
		var piv: Vector3 = glob[b].origin
		var v1: Vector3 = glob[tip].origin - piv
		var v2: Vector3 = want - piv
		if v1.length() < 1e-6 or v2.length() < 1e-6:
			continue
		var ax := v1.cross(v2)
		if ax.length() < 1e-8:
			continue
		var ang := minf(v1.angle_to(v2), deg_to_rad(CONTACT_MAX_DEG))
		_turn_subtree(glob, b, Basis(ax.normalized(), ang))


func _turn_subtree(glob: Dictionary, b: int, q: Basis) -> void:
	var piv: Vector3 = glob[b].origin
	var stack := [b]
	while not stack.is_empty():
		var c: int = stack.pop_back()
		var g: Transform3D = glob[c]
		glob[c] = Transform3D(q * g.basis, piv + q * (g.origin - piv))
		stack.append_array(Array(_skel.get_bone_children(c)))


## Quest length along the same middle-finger chain as the skin: wrist -> proximal -> ... -> tip.
func _quest_len(joints: Array) -> float:
	var ids := [1]
	for j in [12, 13, 14]:
		if _map.joints.has(j):
			ids.append(j)
	if _map.tip.has("middle"):
		ids.append(15)
	var L := 0.0
	for i in range(1, ids.size()):
		L += (joints[ids[i]] as Transform3D).origin.distance_to((joints[ids[i - 1]] as Transform3D).origin)
	return L


## World position of a mapped joint after posing (tests / debug).
func bone_world(j: int) -> Vector3:
	var b: int = _map.joints.get(j, -1)
	if b < 0:
		return Vector3.ZERO
	return _skel.global_transform * _skel.get_bone_global_pose(b).origin


func tip_world(f: String) -> Vector3:
	var b: int = _map.tip.get(f, -1)
	if b < 0:
		return Vector3.ZERO
	return _skel.global_transform * _skel.get_bone_global_pose(b).origin
