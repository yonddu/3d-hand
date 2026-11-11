class_name HandBoneMap
extends RefCounted
## Finds hand/arm bones in any skeleton by name (Mixamo, Unreal, Godot/VRM humanoid,
## Blender-style). Result maps OpenXR hand joint index -> bone index.

# OpenXR / Godot XRHandTracker joint order
const PALM := 0
const WRIST := 1
const FINGER_BASE := {"thumb": 2, "index": 6, "middle": 11, "ring": 16, "little": 21}
const MC := "mc"
const PROX := "prox"
const INT := "int"
const DIST := "dist"
const TIP := "tip"


static func tokens(name: String) -> PackedStringArray:
	var s := ""
	var prev := ""
	for i in name.length():
		var c := name[i]
		var lower := c != c.to_upper()
		var upper := c != c.to_lower()
		var dig := c >= "0" and c <= "9"
		var plower := prev != "" and prev != prev.to_upper()
		var pdig := prev != "" and prev >= "0" and prev <= "9"
		var pletter := prev != "" and prev != prev.to_upper() or (prev != "" and prev != prev.to_lower())
		if (upper and plower) or (dig and pletter) or ((lower or upper) and pdig):
			s += " "
		s += c
		prev = c
	s = s.to_lower()
	for sep in [":", "_", ".", "-", "|", "/"]:
		s = s.replace(sep, " ")
	var keep := PackedStringArray()
	for t in s.split(" ", false):
		if t in ["mixamorig", "def", "org", "bip", "armature", "b", "bone", "j", "jnt"]:
			continue
		keep.append(t)
	return keep


static func parse(name: String) -> Dictionary:
	var t := tokens(name)
	var side := ""
	for x in t:
		if x == "left" or x == "l":
			side = "left"
		elif x == "right" or x == "r":
			side = "right"
	var finger := ""
	for x in t:
		if x == "thumb":
			finger = "thumb"
		elif x == "index" or x == "pointer":
			finger = "index"
		elif x == "middle":
			finger = "middle"
		elif x == "ring":
			finger = "ring"
		elif x == "pinky" or x == "little":
			finger = "little"
	var part := ""
	if finger != "":
		part = "finger"
	elif t.has("hand") or t.has("wrist"):
		part = "hand"
	elif t.has("forearm") or t.has("lowerarm") or (t.has("lower") and t.has("arm")) or (t.has("fore") and t.has("arm")):
		part = "forearm"
	elif t.has("upperarm") or (t.has("upper") and t.has("arm")) or t.has("arm"):
		part = "upperarm"
	var kind := ""
	for x in t:
		if x == "metacarpal" or x == "meta":
			kind = MC
		elif x == "proximal":
			kind = PROX
		elif x == "intermediate":
			kind = INT
		elif x == "distal":
			kind = DIST
		elif x == "tip" or x == "end" or x == "nub":
			kind = TIP
	var num := -1
	for x in t:
		if x.is_valid_int():
			num = x.to_int()
	return {"side": side, "finger": finger, "part": part, "kind": kind, "num": num}


## Returns {"side": "left"/"right", "joints": {xr_joint: bone}, "tip": {finger: bone},
## "forearm": bone or -1, "upperarm": bone or -1, "hand": bone}. Empty dict if no hand.
static func map_hand(skel: Skeleton3D, want_side: String) -> Dictionary:
	var by_side := {"left": [], "right": [], "": []}
	for b in skel.get_bone_count():
		var p := parse(skel.get_bone_name(b))
		p["bone"] = b
		by_side[p.side].append(p)
	var side := want_side
	if _hand_of(by_side[side]) < 0:
		var other := "right" if want_side == "left" else "left"
		if _hand_of(by_side[other]) >= 0:
			side = other
		elif _hand_of(by_side[""]) >= 0:
			side = ""
		else:
			return {}
	var list: Array = by_side[side]
	var res := {"side": side if side != "" else "left", "joints": {}, "tip": {}, "forearm": -1, "upperarm": -1}
	var hand := _hand_of(list)
	res["hand"] = hand
	res.joints[WRIST] = hand
	for p in list:
		if p.part == "forearm" and res.forearm < 0:
			res.forearm = p.bone
		elif p.part == "upperarm" and res.upperarm < 0:
			res.upperarm = p.bone
	for f in FINGER_BASE:
		var bones: Array = []
		for p in list:
			if p.finger == f:
				bones.append(p)
		if bones.is_empty():
			continue
		var slots := _slots(f, bones)
		var base: int = FINGER_BASE[f]
		var order := [MC, PROX, DIST, TIP] if f == "thumb" else [MC, PROX, INT, DIST, TIP]
		for i in order.size():
			var k: String = order[i]
			if not slots.has(k):
				continue
			if k == TIP:
				res.tip[f] = slots[k]
			else:
				res.joints[base + i] = slots[k]
	return res


static func _hand_of(list: Array) -> int:
	for p in list:
		if p.part == "hand":
			return p.bone
	return -1


static func _slots(f: String, bones: Array) -> Dictionary:
	var named := {}
	var numbered: Array = []
	for p in bones:
		if p.kind != "":
			named[p.kind] = p.bone
		elif p.num >= 0:
			numbered.append(p)
	if f == "thumb" and named.has(INT):
		# VRM0 style thumb: proximal / intermediate / distal = metacarpal / proximal / distal
		var n2 := {}
		if named.has(PROX): n2[MC] = named[PROX]
		n2[PROX] = named[INT]
		if named.has(DIST): n2[DIST] = named[DIST]
		if named.has(TIP): n2[TIP] = named[TIP]
		named = n2
	if numbered.is_empty():
		return named
	numbered.sort_custom(func(a, b): return a.num < b.num)
	var seq := [MC, PROX, DIST, TIP] if f == "thumb" else [PROX, INT, DIST, TIP]
	var start := 0
	if numbered[0].num == 0 and f != "thumb":
		named[MC] = numbered[0].bone
		start = 1
	for i in range(start, numbered.size()):
		var k: int = i - start
		if k < seq.size() and not named.has(seq[k]):
			named[seq[k]] = numbered[i].bone
	return named
