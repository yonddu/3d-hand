extends Node3D
## Quest app: the user's skin follows their tracked hands.
## Step 1: built-in hand skin on both hands (left model, mirrored for the right hand).

const VERSION := "q-skin 0.1"
const DEFAULT_SKIN := "res://skins/hand_left.glb.bin"

var xr: XRInterface
var origin: XROrigin3D
var cam: XRCamera3D
var label: Label3D
var rigs := {}
var dots := {}


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
	label.pixel_size = 0.0006
	label.font_size = 32
	label.outline_size = 8
	label.no_depth_test = true
	label.position = Vector3(0, -0.28, -0.9)
	cam.add_child(label)
	var bytes := FileAccess.get_file_as_bytes(DEFAULT_SKIN)
	for s in ["left", "right"]:
		var r := SkinRig.new(s)
		origin.add_child(r)
		rigs[s] = r
		var err := r.load_skin(bytes, "glb")
		if err != "":
			push_warning("skin %s: %s" % [s, err])
		dots[s] = _make_dots(Color(0.3, 0.6, 1) if s == "left" else Color(0.3, 1, 0.5))
		origin.add_child(dots[s])


func _passthrough() -> void:
	var modes: Array = xr.get_supported_environment_blend_modes()
	if XRInterface.XR_ENV_BLEND_MODE_ALPHA_BLEND in modes:
		xr.environment_blend_mode = XRInterface.XR_ENV_BLEND_MODE_ALPHA_BLEND
		get_viewport().transparent_bg = true


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


func _process(_dt: float) -> void:
	var lines := [VERSION]
	for s in rigs:
		var r: SkinRig = rigs[s]
		var tr := XRServer.get_tracker(StringName("/user/hand_tracker/" + s)) as XRHandTracker
		var ok := tr != null and tr.has_tracking_data
		r.visible = ok
		dots[s].visible = ok and r.status.begins_with("no")
		if ok:
			var joints := []
			for j in 26:
				joints.append(origin.global_transform * tr.get_hand_joint_transform(j))
			r.apply(joints)
			var mm: MultiMesh = dots[s].multimesh
			for j in 26:
				mm.set_instance_transform(j, Transform3D(Basis(), (joints[j] as Transform3D).origin))
		lines.append("%s: %s, %s, size x%.2f" % [s, "tracked" if ok else "-", r.status, r.auto_scale * r.user_scale])
	label.text = "\n".join(lines)
