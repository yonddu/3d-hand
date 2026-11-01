package com.yonddu.handmotion

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToLong

/** Raw landmark positions, not a fitted mesh or inferred finger twist. */
data class RawHandFrame(val t: Double, val hands: Map<String, DoubleArray>)

/** Dependency-free FBX 7.4 binary skeleton writer. Runs only when saving. */
object RawFbx {
    private const val TICKS = 46186158000.0
    private data class P(val type: Char, val value: Any)
    private data class N(val name: String, val props: List<P> = emptyList(), val children: List<N> = emptyList())
    private fun i(v: Int) = P('I', v)
    private fun l(v: Long) = P('L', v)
    private fun d(v: Double) = P('D', v)
    private fun s(v: String) = P('S', v)
    private fun n(name: String, vararg p: P) = N(name, p.toList())
    private fun property(name: String, type: String, vararg v: P) = N("P", listOf(s(name), s(type), s(""), s("A")) + v)
    private fun props(vararg p: N) = N("Properties70", children = p.toList())
    private fun named(name: String, type: String) = s("$name\u0000\u0001$type")
    private val parents = intArrayOf(-1,0,1,2,3,0,5,6,7,0,9,10,11,0,13,14,15,0,17,18,19)
    private val suffix = arrayOf("Hand", "HandThumb1", "HandThumb2", "HandThumb3", "HandThumb4",
        "HandIndex1", "HandIndex2", "HandIndex3", "HandIndex4", "HandMiddle1", "HandMiddle2", "HandMiddle3", "HandMiddle4",
        "HandRing1", "HandRing2", "HandRing3", "HandRing4", "HandPinky1", "HandPinky2", "HandPinky3", "HandPinky4")
    fun jointName(side: String, joint: Int) = (if (side == "right") "Right" else "Left") + suffix[joint]
    private fun valid(p: DoubleArray?) = p != null && p.size == 63 && p.all { it.isFinite() }
    private fun local(p: DoubleArray, j: Int): DoubleArray {
        val parent = parents[j]
        return DoubleArray(3) { k ->
            val x = p[j * 3 + k] - if (parent >= 0) p[parent * 3 + k] else 0.0
            if (k == 0) x else -x
        }
    }

    fun encode(frames: List<RawHandFrame>, name: String = "HandMotionCapture"): ByteArray {
        require(frames.isNotEmpty()) { "손 관절 기록이 없습니다." }
        require(frames.all { it.t.isFinite() } && frames.zipWithNext().all { it.second.t > it.first.t }) { "기록 시간이 올바르지 않습니다." }
        val sides = listOf("left", "right").filter { side -> frames.any { valid(it.hands[side]) } }
        require(sides.isNotEmpty()) { "기록에 손 관절이 없습니다. 손을 보이게 측정한 뒤 저장하세요." }
        val times = LongArray(frames.size) { ((frames[it].t - frames[0].t) * TICKS).roundToLong() }
        var next = 100000L
        val objects = ArrayList<N>()
        val connections = ArrayList<N>()
        fun connect(from: Long, to: Long, property: String? = null) {
            connections += N("C", listOf(s(if (property == null) "OO" else "OP"), l(from), l(to)) + if (property == null) emptyList() else listOf(s(property)))
        }
        val root = next++
        objects += N("Model", listOf(l(root), named(name, "Model"), s("Null")), listOf(n("Version", i(232)), props(
            property("Lcl Translation", "Lcl Translation", d(0.0),d(0.0),d(0.0)),
            property("Lcl Rotation", "Lcl Rotation", d(0.0),d(0.0),d(0.0)),
            property("Lcl Scaling", "Lcl Scaling", d(1.0),d(1.0),d(1.0)),
            property("HMS_Source", "KString", s("Raw MediaPipe world landmark positions; relative hand coordinates; not absolute camera motion")),
            property("HMS_Representation", "KString", s("21-joint position animation; no mesh, no fitted bone rotations, no hidden-hand prediction")))))
        connect(root, 0)
        val stack = next++
        val layer = next++
        objects += N("AnimationStack", listOf(l(stack), named(name, "AnimStack"), s("")), listOf(props(
            property("LocalStart", "KTime", l(0)), property("LocalStop", "KTime", l(times.last())),
            property("ReferenceStart", "KTime", l(0)), property("ReferenceStop", "KTime", l(times.last())))))
        objects += N("AnimationLayer", listOf(l(layer), named("BaseLayer", "AnimLayer"), s("")), listOf(props(
            property("Weight", "Number", d(100.0)),property("BlendMode", "enum", i(1)))))
        connect(layer, stack)
        fun curves(model: Long, type: String, values: Array<DoubleArray>, seen: BooleanArray) {
            val id = next++
            objects += N("AnimationCurveNode", listOf(l(id), named(type, "AnimCurveNode"), s("")), listOf(N("Properties70", children = (0..2).map { k -> property("d|${"XYZ"[k]}", "Number", d(values[0][k])) })))
            connect(id, layer)
            connect(id, model, if (type == "T") "Lcl Translation" else "Lcl Scaling")
            for (axis in 0..2) {
                val cid = next++
                objects += N("AnimationCurve", listOf(l(cid), named("", "AnimCurve"), s("")), listOf(
                    n("Default", d(values[0][axis])), n("KeyVer", i(4008)),
                    n("KeyTime", P('l', times)), n("KeyValueFloat", P('f', FloatArray(values.size) { values[it][axis].toFloat() })),
                    n("KeyAttrFlags", P('i', IntArray(frames.size) { k -> if (type == "S" || !seen[k] || k + 1 < seen.size && !seen[k + 1]) 2 else 4 })), n("KeyAttrDataFloat", P('f', FloatArray(frames.size * 4))),
                    n("KeyAttrRefCount", P('i', IntArray(frames.size) { 1 }))))
                connect(cid, id, "d|${"XYZ"[axis]}")
            }
        }
        for (side in sides) {
            val seen = BooleanArray(frames.size) { valid(frames[it].hands[side]) }
            val ids = LongArray(21) { next++ }
            val first = frames.first { valid(it.hands[side]) }.hands.getValue(side)
            for (j in 0..20) {
                val position = local(first, j)
                objects += N("Model", listOf(l(ids[j]), named(jointName(side,j), "Model"), s("LimbNode")), listOf(n("Version", i(232)), props(
                    property("Lcl Translation", "Lcl Translation", *position.map(::d).toTypedArray()),
                    property("Lcl Rotation", "Lcl Rotation", d(0.0),d(0.0),d(0.0)),
                    property("Lcl Scaling", "Lcl Scaling", d(1.0),d(1.0),d(1.0)),
                    property("RotationOrder", "enum", i(0)),property("InheritType", "enum", i(1)))))
                connect(ids[j], if (j == 0) root else ids[parents[j]])
                val attr = next++
                objects += N("NodeAttribute", listOf(l(attr), named(jointName(side,j), "NodeAttribute"), s("LimbNode")), listOf(n("TypeFlags", s("Skeleton")), props(property("Size", "double", d(0.005)))))
                connect(attr, ids[j])
                val values = Array(frames.size) { f -> frames[f].hands[side].let { if (valid(it)) local(it!!,j) else DoubleArray(3) } }
                curves(ids[j], "T", values, seen)
            }
            curves(ids[0], "S", Array(frames.size) { f -> DoubleArray(3) { if (seen[f]) 1.0 else 0.0 } }, seen)
        }
        val groups = objects.groupingBy { it.name }.eachCount()
        return binary(listOf(
            N("FBXHeaderExtension", children = listOf(n("FBXHeaderVersion",i(1003)),n("FBXVersion",i(7400)),n("EncryptionType",i(0)),n("Creator",s("Hand Motion native raw capture")))),
            N("GlobalSettings", children = listOf(n("Version",i(1000)),props(
                property("UpAxis","int",i(1)),property("UpAxisSign","int",i(1)),property("FrontAxis","int",i(2)),property("FrontAxisSign","int",i(1)),
                property("CoordAxis","int",i(0)),property("CoordAxisSign","int",i(1)),property("UnitScaleFactor","double",d(100.0)),property("OriginalUnitScaleFactor","double",d(100.0)),
                property("TimeMode","enum",i(14)),property("CustomFrameRate","double",d(if (frames.size > 1) (frames.size-1)/(frames.last().t-frames.first().t) else 30.0)),
                property("TimeSpanStart","KTime",l(0)),property("TimeSpanStop","KTime",l(times.last()))))),
            N("Documents",listOf(i(1)),listOf(N("Document",listOf(l(next++),s(name),s("Scene")),listOf(props(property("ActiveAnimStackName","KString",s(name))),n("RootNode",l(0)))))),
            n("References"),N("Definitions",children=listOf(n("Version",i(100)),n("Count",i(objects.size)))+groups.map { (key,count)->N("ObjectType",listOf(s(key)),listOf(n("Count",i(count)))) }),
            N("Objects",children=objects),N("Connections",children=connections),N("Takes",children=listOf(n("Current",s(name))))))
    }

    private data class Encoded(val name: ByteArray, val props: List<ByteArray>, val children: List<Encoded>, val size: Int)
    private fun encodeProperty(p: P): ByteArray {
        val arraySize = when(p.type) { 'l' -> (p.value as LongArray).size; 'i' -> (p.value as IntArray).size; 'f' -> (p.value as FloatArray).size; else -> -1 }
        val width = if (p.type == 'l') 8 else 4
        val str = if(p.type == 'S') (p.value as String).toByteArray(Charsets.UTF_8) else null
        val size = if(arraySize >= 0) 13+arraySize*width else if(str != null) 5+str.size else if(p.type=='I') 5 else 9
        val b = ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN);b.put(p.type.code.toByte())
        if(arraySize >= 0) {
            b.putInt(arraySize).putInt(0).putInt(arraySize*width)
            when(p.type) { 'l' -> (p.value as LongArray).forEach { b.putLong(it) }; 'i' -> (p.value as IntArray).forEach { b.putInt(it) }; else -> (p.value as FloatArray).forEach { b.putFloat(it) } }
        } else when(p.type) { 'S' -> { b.putInt(str!!.size);b.put(str) }; 'I' -> b.putInt(p.value as Int); 'L' -> b.putLong(p.value as Long); 'D' -> b.putDouble(p.value as Double) }
        return b.array()
    }
    private fun binary(nodes: List<N>): ByteArray {
        fun prepare(n: N): Encoded {
            val name=n.name.toByteArray(Charsets.UTF_8);val p=n.props.map(::encodeProperty);val c=n.children.map(::prepare)
            return Encoded(name,p,c,13+name.size+p.sumOf { it.size }+c.sumOf { it.size }+if(c.isEmpty())0 else 13)
        }
        val encoded=nodes.map(::prepare);val footer=27+encoded.sumOf { it.size }+13;val padding=(16-(footer+16)%16)%16
        val b=ByteBuffer.allocate(footer+16+padding+4+120+16).order(ByteOrder.LITTLE_ENDIAN)
        b.put("Kaydara FBX Binary  \u0000\u001a\u0000".toByteArray(Charsets.US_ASCII));b.putInt(7400)
        fun write(n: Encoded) {
            val end=b.position()+n.size;b.putInt(end).putInt(n.props.size).putInt(n.props.sumOf { it.size }).put(n.name.size.toByte()).put(n.name)
            n.props.forEach { b.put(it) };n.children.forEach(::write);if(n.children.isNotEmpty())b.put(ByteArray(13))
        }
        encoded.forEach(::write);b.put(ByteArray(13))
        b.put(byteArrayOf(0xfa.toByte(),0xbc.toByte(),0xab.toByte(),0x09,0xd0.toByte(),0xc8.toByte(),0xd4.toByte(),0x66,0xb1.toByte(),0x76,0xfb.toByte(),0x83.toByte(),0x1c,0xf7.toByte(),0x26,0x7e))
        b.put(ByteArray(padding)).putInt(7400).put(ByteArray(120))
        b.put(byteArrayOf(0xf8.toByte(),0x5a,0x8c.toByte(),0x6a,0xde.toByte(),0xf5.toByte(),0xd9.toByte(),0x7e,0xec.toByte(),0xe9.toByte(),0x0c,0xe3.toByte(),0x75,0x8f.toByte(),0x29,0x0b))
        return b.array()
    }
}
