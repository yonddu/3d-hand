class_name PokePanel
extends Node3D
## Floating panel of buttons pressed by touching them with an index fingertip (no controller).

signal pressed(id: String)

const W := 0.11
const H := 0.04
const GAP := 0.012
const DEPTH := 0.03          # how far behind the button face a fingertip still counts

var buttons := {}            # id -> {node, label, rect(Vector2 centre)}
var _cool := {}              # id -> seconds left before it can fire again
var _inside := {}            # id -> fingertip currently inside
var title: Label3D
var font: Font


func _init() -> void:
	var sf := SystemFont.new()
	sf.font_names = PackedStringArray(["Noto Sans CJK KR", "Noto Sans KR", "NotoSansCJK", "Droid Sans Fallback", "sans-serif"])
	font = sf
	title = _label("", 26)
	title.position = Vector3(0, 0.05, 0.001)
	title.vertical_alignment = VERTICAL_ALIGNMENT_BOTTOM
	add_child(title)


func _label(text: String, size: int) -> Label3D:
	var l := Label3D.new()
	l.text = text
	l.font = font
	l.font_size = size
	l.pixel_size = 0.0005
	l.outline_size = 6
	l.double_sided = false
	return l


## rows: Array of Array of [id, text]
func build(rows: Array) -> void:
	for id in buttons:
		buttons[id].node.queue_free()
	buttons.clear()
	for r in rows.size():
		var row: Array = rows[r]
		var total := row.size() * W + (row.size() - 1) * GAP
		for c in row.size():
			var id: String = row[c][0]
			var x := -total / 2.0 + W / 2.0 + c * (W + GAP)
			var y := -r * (H + GAP)
			var n := MeshInstance3D.new()
			var box := BoxMesh.new()
			box.size = Vector3(W, H, 0.008)
			var mat := StandardMaterial3D.new()
			mat.albedo_color = Color(0.15, 0.17, 0.22, 0.85)
			mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
			mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
			box.material = mat
			n.mesh = box
			n.position = Vector3(x, y, 0)
			add_child(n)
			var l := _label(row[c][1], 22)
			l.position = Vector3(0, 0, 0.0045)
			n.add_child(l)
			buttons[id] = {"node": n, "label": l, "mat": mat, "c": Vector2(x, y)}


func set_text(id: String, text: String) -> void:
	if buttons.has(id):
		buttons[id].label.text = text


## tips: world positions of index fingertips.
func poke(tips: Array, dt: float) -> void:
	if not visible:
		return
	var inv := global_transform.affine_inverse()
	for id in buttons:
		_cool[id] = max(0.0, _cool.get(id, 0.0) - dt)
		var b: Dictionary = buttons[id]
		var hit := false
		for t in tips:
			var p: Vector3 = inv * t
			if absf(p.x - b.c.x) < W / 2 and absf(p.y - b.c.y) < H / 2 and p.z < 0.006 and p.z > -DEPTH:
				hit = true
		var was: bool = _inside.get(id, false)
		if hit and not was and _cool[id] == 0.0:
			_cool[id] = 0.4
			pressed.emit(id)
		_inside[id] = hit
		b.mat.albedo_color = Color(0.25, 0.5, 0.9, 0.9) if hit else Color(0.15, 0.17, 0.22, 0.85)
