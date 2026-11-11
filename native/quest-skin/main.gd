extends Node3D
## Quest app: the user's skin follows their tracked hands.
## Panel buttons are pressed by touching them with an index fingertip.

const VERSION := "q-skin 0.3"
const DEFAULT_SKIN := "res://skins/hand_left.glb.bin"
const SKIN_DIRS := ["/sdcard/Download", "/sdcard/Download/HandSkin", "/sdcard/HandSkin"]
const SIZE_STEP := 1.05
const CALIB_WAIT := 3.0

var xr: XRInterface
var origin: XROrigin3D
var cam: XRCamera3D
var label: Label3D
var panel: PokePanel
var rigs := {}
var dots := {}
var files: Array = []          # [path] skin files found on the Quest
var file_i := -1               # -1 = built-in skin
var calib_left := -1.0
var last_joints := {}
var note := ""


func _ready() -> void:
	xr = XRServer.find_interface("OpenXR")
	if xr and xr.is_initialized():
		get_viewport().use_xr = true
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
		_passthrough()
	origin = XROrigin3D.new()
	add_child(origin)
	cam = XRCamera3D.new()
	origin.add_child(cam)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 30, 0)
	add_child(sun)
	var env := WorldEnvironment.new()
	env.environment = Environment.new()
	env.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.environment.ambient_light_color = Color(0.6, 0.6, 0.65)
	env.environment.background_mode = Environment.BG_COLOR
	env.environment.background_color = Color(0, 0, 0, 0)
	add_child(env)
	label = Label3D.new()
	label.pixel_size = 0.0005
	label.font_size = 28
	label.outline_size = 8
	label.no_depth_test = true
	label.position = Vector3(0, -0.3, -0.9)
	cam.add_child(label)
	panel = PokePanel.new()
	label.font = panel.font
	add_child(panel)
	panel.build([
		[["prev", "◀ 스킨"], ["next", "스킨 ▶"], ["files", "파일 다시 찾기"]],
		[["smaller", "크기 −"], ["bigger", "크기 +"], ["size1", "자동 크기"]],
		[["calib", "손 펴고 맞추기"], ["uncalib", "맞춤 취소"], ["here", "패널 이리로"]],
	])
	panel.pressed.connect(_on_button)
	for s in ["left", "right"]:
		var r := SkinRig.new(s)
		origin.add_child(r)
		rigs[s] = r
		dots[s] = _make_dots(Color(0.3, 0.6, 1) if s == "left" else Color(0.3, 1, 0.5))
		origin.add_child(dots[s])
	_load_current()
	_ask_files_permission()
	_find_files()
	await get_tree().create_timer(0.5).timeout
	_panel_here()


func _passthrough() -> void:
	var modes: Array = xr.get_supported_environment_blend_modes()
	if XRInterface.XR_ENV_BLEND_MODE_ALPHA_BLEND in modes:
		xr.environment_blend_mode = XRInterface.XR_ENV_BLEND_MODE_ALPHA_BLEND
		get_viewport().transparent_bg = true


func _ask_files_permission() -> void:
	if OS.get_name() == "Android":
		OS.request_permissions()


func _find_files() -> void:
	files.clear()
	for d in SKIN_DIRS:
		var da := DirAccess.open(d)
		if da == null:
			continue
		for f in da.get_files():
			var e := f.get_extension().to_lower()
			if e in ["glb", "gltf", "fbx"]:
				files.append(d.path_join(f))
	files.sort()
	note = "스킨 파일 %d개 (Download 폴더)" % files.size()
	if files.is_empty() and OS.get_name() == "Android":
		note += " - 안 보이면 설정에서 '모든 파일 접근' 허용"


func _load_current() -> void:
	var bytes: PackedByteArray
	var ext := "glb"
	var name := "기본 건틀렛"
	if file_i >= 0 and file_i < files.size():
		var path: String = files[file_i]
		bytes = FileAccess.get_file_as_bytes(path)
		ext = path.get_extension().to_lower()
		name = path.get_file()
		if bytes.size() > 80 * 1024 * 1024:
			note = "경고: %s 는 %.0f MB, 퀘스트에서 느릴 수 있음" % [name, bytes.size() / 1048576.0]
	else:
		bytes = FileAccess.get_file_as_bytes(DEFAULT_SKIN)
	if bytes.is_empty():
		note = "파일을 못 읽음: " + name
		return
	var scale_keep: float = rigs.left.user_scale
	for s in rigs:
		var r: SkinRig = rigs[s]
		var err := r.load_skin(bytes, ext)
		r.user_scale = scale_keep
		if err != "":
			note = "%s: %s" % [name, err]
			return
	note = "스킨: " + name


func _on_button(id: String) -> void:
	match id:
		"next", "prev":
			if files.is_empty():
				_find_files()
			var n := files.size() + 1
			var k := file_i + 1 + (1 if id == "next" else -1)
			file_i = posmod(k, n) - 1
			_load_current()
		"files":
			_find_files()
		"smaller", "bigger":
			for s in rigs:
				rigs[s].user_scale *= SIZE_STEP if id == "bigger" else 1.0 / SIZE_STEP
		"size1":
			for s in rigs:
				rigs[s].user_scale = 1.0
		"calib":
			calib_left = CALIB_WAIT
		"uncalib":
			for s in rigs:
				rigs[s].reset_calibration()
		"here":
			_panel_here()


func _panel_here() -> void:
	var ct := cam.global_transform
	var fwd := -ct.basis.z
	fwd.y = 0
	fwd = fwd.normalized() if fwd.length() > 0.01 else Vector3(0, 0, -1)
	var pos := ct.origin + fwd * 0.45 + Vector3(0, -0.15, 0)
	panel.global_transform = Transform3D(Basis.looking_at(fwd, Vector3.UP), pos)


func _make_dots(c: Color) -> MultiMeshInstance3D:
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	var sph := SphereMesh.new()
	sph.radius = 0.004
	sph.height = 0.008
	var mat := StandardMaterial3D.new()
	mat.albedo_color = c
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	sph.material = mat
	mm.mesh = sph
	mm.instance_count = 26
	var mi := MultiMeshInstance3D.new()
	mi.multimesh = mm
	return mi


func _process(dt: float) -> void:
	var lines := [VERSION, note]
	var tips := []
	for s in rigs:
		var r: SkinRig = rigs[s]
		var tr := XRServer.get_tracker(StringName("/user/hand_tracker/" + s)) as XRHandTracker
		var ok := tr != null and tr.has_tracking_data
		r.visible = ok
		dots[s].visible = ok and r.status.begins_with("no")
		last_joints.erase(s)
		if ok:
			var joints := []
			for j in 26:
				joints.append(origin.global_transform * tr.get_hand_joint_transform(j))
			last_joints[s] = joints
			r.apply(joints, cam.global_transform)
			tips.append((joints[10] as Transform3D).origin)
			var mm: MultiMesh = dots[s].multimesh
			for j in 26:
				mm.set_instance_transform(j, Transform3D(Basis(), origin.global_transform.affine_inverse() * (joints[j] as Transform3D).origin))
		lines.append("%s: %s, %s, 크기 x%.2f" % ["왼손" if s == "left" else "오른손", "인식" if ok else "-", r.status, r.auto_scale * r.user_scale])
	if calib_left >= 0.0:
		calib_left -= dt
		lines.append("스킨 기본 자세처럼 손을 두세요... %d" % ceili(calib_left))
		if calib_left < 0.0:
			for s in last_joints:
				rigs[s].calibrate(last_joints[s])
			note = "맞춤 완료 (%s)" % ", ".join(last_joints.keys())
	else:
		panel.poke(tips, dt)
	label.text = "\n".join(lines)
