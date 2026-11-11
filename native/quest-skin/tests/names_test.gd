extends SceneTree
## Bone-name parsing for common rigs.
func _initialize() -> void:
	var cases := {
		"mixamorig:LeftHandIndex1": "left finger index num1",
		"RightHandThumb3": "right finger thumb num3",
		"index_01_l": "left finger index num1",
		"thumb_03_r": "right finger thumb num3",
		"index_metacarpal_l": "left finger index mc",
		"pinky_02_r": "right finger little num2",
		"hand_l": "left hand",
		"lowerarm_r": "right forearm",
		"upperarm_l": "left upperarm",
		"LeftForeArm": "left forearm",
		"LeftArm": "left upperarm",
		"LeftIndexProximal": "left finger index prox",
		"leftThumbMetacarpal": "left finger thumb mc",
		"RightLittleDistal": "right finger little dist",
		"f_index.01.L": "left finger index num1",
		"thumb.02.R": "right finger thumb num2",
		"hand.L": "left hand",
		"forearm.R": "right forearm",
		"Hand_R": "right hand",
		"J_Bip_L_Index1": "left finger index num1",
	}
	var bad := 0
	for n in cases:
		var p := HandBoneMap.parse(n)
		var got: String = p.side + " " + p.part
		if p.part == "finger":
			got += " " + p.finger + " " + (p.kind if p.kind != "" else "num%d" % p.num)
		if got != cases[n]:
			bad += 1
			print("FAIL %s -> %s (want %s) tokens=%s" % [n, got, cases[n], HandBoneMap.tokens(n)])
	print("names: %d/%d ok" % [cases.size() - bad, cases.size()])
	quit(1 if bad else 0)
