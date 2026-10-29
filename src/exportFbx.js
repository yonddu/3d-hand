// Browser-side FBX 7.4 binary writer for the same skinned scene as exportGlb.
// No proprietary SDK, remote converter or additional runtime dependency.
import * as THREE from "three";
import { buildMotionScene } from "./exportGlb.js";

const encoder = new TextEncoder();
const KTIME = 46186158000;
const VERSION = 7400;
const node = (name, props = [], children = []) => ({ name, props, children });
const prop = (type, value) => ({ type, value });
const I = (v) => prop("I", v),
  L = (v) => prop("L", v),
  D = (v) => prop("D", v);
const S = (v) => prop("S", String(v));
const array = (type, value) => prop(type, value);
const property = (name, type, values, flag = "A") =>
  node("P", [S(name), S(type), S(""), S(flag), ...values]);
const xyz = (name, v) => property(name, name, v.map(D));
const properties = (rows) => node("Properties70", [], rows);
const named = (name, type) => S(`${name}\0\x01${type}`);

function encodedProperty(p) {
  const t = p.type,
    v = p.value;
  const sizes = { d: 8, f: 4, i: 4, l: 8 };
  let bytes;
  if (t === "S") bytes = encoder.encode(v);
  else if (t === "R") bytes = v;
  const length = sizes[t]
    ? 13 + v.length * sizes[t]
    : bytes
      ? 5 + bytes.length
      : { I: 5, L: 9, D: 9, C: 2 }[t];
  if (!length) throw new Error(`Unsupported FBX property ${t}`);
  const out = new Uint8Array(length),
    dv = new DataView(out.buffer);
  out[0] = t.charCodeAt(0);
  if (sizes[t]) {
    dv.setUint32(1, v.length, true);
    dv.setUint32(5, 0, true);
    dv.setUint32(9, v.length * sizes[t], true);
    for (let i = 0; i < v.length; i++) {
      const at = 13 + i * sizes[t];
      if (t === "d") dv.setFloat64(at, v[i], true);
      else if (t === "f") dv.setFloat32(at, v[i], true);
      else if (t === "i") dv.setInt32(at, v[i], true);
      else dv.setBigInt64(at, BigInt(v[i]), true);
    }
  } else if (bytes) {
    dv.setUint32(1, bytes.length, true);
    out.set(bytes, 5);
  } else if (t === "I") dv.setInt32(1, v, true);
  else if (t === "L") dv.setBigInt64(1, BigInt(v), true);
  else if (t === "D") dv.setFloat64(1, v, true);
  else out[1] = v ? 1 : 0;
  return out;
}
function binary(nodes) {
  function prepare(n) {
    const name = encoder.encode(n.name);
    if (name.length > 255) throw new Error("FBX node name too long");
    const props = n.props.map(encodedProperty),
      children = n.children.map(prepare);
    return {
      name,
      props,
      children,
      size:
        13 +
        name.length +
        props.reduce((s, p) => s + p.length, 0) +
        children.reduce((s, c) => s + c.size, 0) +
        (children.length ? 13 : 0),
    };
  }
  const list = nodes.map(prepare),
    bodySize = list.reduce((s, n) => s + n.size, 0);
  const footerStart = 27 + bodySize + 13;
  const padding = (16 - ((footerStart + 16) % 16)) % 16;
  const total = footerStart + 16 + padding + 4 + 120 + 16;
  if (total > 0xffffffff)
    throw new Error("FBX 7.4 file exceeds its 4 GB size limit");
  const out = new Uint8Array(total),
    dv = new DataView(out.buffer);
  out.set(encoder.encode("Kaydara FBX Binary  \0\x1a\0"));
  dv.setUint32(23, VERSION, true);
  function write(n, offset) {
    dv.setUint32(offset, offset + n.size, true);
    dv.setUint32(offset + 4, n.props.length, true);
    dv.setUint32(
      offset + 8,
      n.props.reduce((s, p) => s + p.length, 0),
      true,
    );
    out[offset + 12] = n.name.length;
    let at = offset + 13;
    out.set(n.name, at);
    at += n.name.length;
    for (const p of n.props) {
      out.set(p, at);
      at += p.length;
    }
    for (const c of n.children) {
      write(c, at);
      at += c.size;
    }
  }
  let at = 27;
  for (const n of list) {
    write(n, at);
    at += n.size;
  }
  // Standard binary footer and 7.4 version marker. No compressed array codec.
  out.set(
    [
      0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83,
      0x1c, 0xf7, 0x26, 0x7e,
    ],
    footerStart,
  );
  dv.setUint32(footerStart + 16 + padding, VERSION, true);
  out.set(
    [
      0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3,
      0x75, 0x8f, 0x29, 0x0b,
    ],
    out.length - 16,
  );
  return out.buffer;
}
const degrees = (q) =>
  new THREE.Euler()
    .setFromQuaternion(q.clone().normalize(), "ZYX")
    .toArray()
    .slice(0, 3)
    .map((v) => (v * 180) / Math.PI);
function unwrap(v, prev) {
  return prev ? v.map((x, i) => x + 360 * Math.round((prev[i] - x) / 360)) : v;
}
function continuousEuler(q, prev) {
  const e = degrees(q),
    a = unwrap(e, prev);
  if (!prev) return a;
  const b = unwrap([e[0] + 180, 180 - e[1], e[2] + 180], prev);
  const cost = (v) => v.reduce((s, x, i) => s + (x - prev[i]) ** 2, 0);
  return cost(a) <= cost(b) ? a : b;
}
// FBX uses Euler curves. Bake quaternion interpolation at <=1/60s and refine
// where Euler interpolation deviates, without changing the source motion.
export function rotationSamples(track) {
  const get = (i) =>
    new THREE.Quaternion().fromArray(track.values, i * 4).normalize();
  const times = [],
    values = [];
  let previous = null;
  function append(t, q) {
    const e = continuousEuler(q, previous);
    times.push(t);
    values.push(e);
    previous = e;
  }
  function segment(ta, qa, ea, tb, qb, depth = 0) {
    const eb = continuousEuler(qb, ea),
      mid = qa.clone().slerp(qb, 0.5);
    const avg = ea.map((x, i) => (x + eb[i]) * 0.5);
    const linear = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(...avg.map((x) => (x * Math.PI) / 180), "ZYX"),
    );
    if (
      depth < 16 &&
      tb - ta > 1e-6 &&
      (tb - ta > 1 / 60 + 1e-8 || mid.angleTo(linear) > Math.PI / 1800)
    ) {
      const tm = (ta + tb) * 0.5;
      segment(ta, qa, ea, tm, mid, depth + 1);
      segment(tm, mid, previous, tb, qb, depth + 1);
    } else append(tb, qb);
  }
  append(track.times[0], get(0));
  for (let i = 1; i < track.times.length; i++)
    segment(track.times[i - 1], get(i - 1), previous, track.times[i], get(i));
  return { times, values };
}

export function sceneToFbx({ root, clip, bindTransforms }) {
  let nextId = 100000;
  const objects = [],
    connections = [],
    models = new Map(),
    nodes = [];
  const connect = (from, to, propertyName) =>
    connections.push(
      node("C", [
        S(propertyName ? "OP" : "OO"),
        L(from),
        L(to),
        ...(propertyName ? [S(propertyName)] : []),
      ]),
    );
  root.traverse((o) => {
    if (o.isBone || o.isMesh) {
      models.set(o, nextId++);
      nodes.push(o);
    }
  });
  function bind(o) {
    return (
      bindTransforms.get(o) || {
        local: o.matrix.clone(),
        world: o.matrixWorld.clone(),
      }
    );
  }
  function transform(m) {
    const p = new THREE.Vector3(),
      q = new THREE.Quaternion(),
      s = new THREE.Vector3();
    m.decompose(p, q, s);
    return [
      xyz("Lcl Translation", p.toArray()),
      xyz("Lcl Rotation", degrees(q)),
      xyz("Lcl Scaling", s.toArray()),
      property("RotationOrder", "enum", [I(0)]),
      property("InheritType", "enum", [I(1)]),
    ];
  }
  const poseEntries = [];
  for (const o of nodes) {
    const id = models.get(o),
      type = o.isBone ? "LimbNode" : "Mesh";
    objects.push(
      node(
        "Model",
        [L(id), named(o.name, "Model"), S(type)],
        [
          node("Version", [I(232)]),
          properties(transform(clip.duration > 0 ? bind(o).local : o.matrix)),
          node("Shading", [prop("C", true)]),
          node("Culling", [S("CullingOff")]),
        ],
      ),
    );
    connect(id, models.get(o.parent) || 0);
    if (o.isBone) {
      const aid = nextId++;
      objects.push(
        node(
          "NodeAttribute",
          [L(aid), named(o.name, "NodeAttribute"), S("LimbNode")],
          [
            node("TypeFlags", [S("Skeleton")]),
            properties([property("Size", "double", [D(0.01)])]),
          ],
        ),
      );
      connect(aid, id);
    }
    poseEntries.push(
      node(
        "PoseNode",
        [],
        [
          node("Node", [L(id)]),
          node("Matrix", [array("d", bind(o).world.elements)]),
        ],
      ),
    );
    if (!o.isMesh) continue;
    const g = o.geometry,
      position = g.attributes.position,
      normal = g.attributes.normal,
      index = g.index;
    if (!position) throw new Error("FBX mesh has no positions");
    const vertices = Array.from(position.array),
      polygons = [];
    const ids = index
      ? Array.from(index.array)
      : Array.from({ length: position.count }, (_, i) => i);
    if (ids.length % 3) throw new Error("FBX export requires triangles");
    for (let i = 0; i < ids.length; i += 3)
      polygons.push(ids[i], ids[i + 1], ~ids[i + 2]);
    const gid = nextId++,
      mid = nextId++;
    const layers = [
      node(
        "LayerElementMaterial",
        [I(0)],
        [
          node("Version", [I(101)]),
          node("Name", [S("")]),
          node("MappingInformationType", [S("AllSame")]),
          node("ReferenceInformationType", [S("IndexToDirect")]),
          node("Materials", [array("i", [0])]),
        ],
      ),
    ];
    if (normal)
      layers.push(
        node(
          "LayerElementNormal",
          [I(0)],
          [
            node("Version", [I(101)]),
            node("Name", [S("")]),
            node("MappingInformationType", [S("ByVertice")]),
            node("ReferenceInformationType", [S("Direct")]),
            node("Normals", [array("d", Array.from(normal.array))]),
          ],
        ),
      );
    const uv = g.attributes.uv;
    if (uv)
      layers.push(
        node(
          "LayerElementUV",
          [I(0)],
          [
            node("Version", [I(101)]),
            node("Name", [S("UVMap")]),
            node("MappingInformationType", [S("ByVertice")]),
            node("ReferenceInformationType", [S("Direct")]),
            node("UV", [array("d", Array.from(uv.array))]),
          ],
        ),
      );
    const layer = node(
      "Layer",
      [I(0)],
      [
        node("Version", [I(100)]),
        ...layers.map((l) =>
          node(
            "LayerElement",
            [],
            [node("Type", [S(l.name)]), node("TypedIndex", [I(0)])],
          ),
        ),
      ],
    );
    objects.push(
      node(
        "Geometry",
        [L(gid), named(o.name, "Geometry"), S("Mesh")],
        [
          node("GeometryVersion", [I(124)]),
          node("Vertices", [array("d", vertices)]),
          node("PolygonVertexIndex", [array("i", polygons)]),
          ...layers,
          layer,
        ],
      ),
    );
    connect(gid, id);
    const mat = Array.isArray(o.material) ? o.material[0] : o.material,
      c = mat?.color || new THREE.Color(0.8, 0.7, 0.6);
    objects.push(
      node(
        "Material",
        [L(mid), named(mat?.name || "Skin", "Material"), S("")],
        [
          node("Version", [I(102)]),
          node("ShadingModel", [S("phong")]),
          node("MultiLayer", [I(0)]),
          properties([
            property("DiffuseColor", "Color", [D(c.r), D(c.g), D(c.b)]),
            property("DiffuseFactor", "Number", [D(1)]),
          ]),
        ],
      ),
    );
    connect(mid, id);
    if (o.isSkinnedMesh) {
      const skin = nextId++,
        sk = o.skeleton,
        si = g.attributes.skinIndex,
        sw = g.attributes.skinWeight;
      objects.push(
        node(
          "Deformer",
          [L(skin), named(o.name, "Deformer"), S("Skin")],
          [
            node("Version", [I(101)]),
            node("Link_DeformAcuracy", [D(50)]),
            node("SkinningType", [S("Linear")]),
          ],
        ),
      );
      connect(skin, gid);
      const weights = sk.bones.map(() => ({ indices: [], weights: [] }));
      for (let v = 0; v < position.count; v++) {
        const sums = new Map();
        for (let k = 0; k < 4; k++) {
          const b = si.getComponent(v, k),
            w = sw.getComponent(v, k);
          if (w > 0) sums.set(b, (sums.get(b) || 0) + w);
        }
        for (const [b, w] of sums) {
          weights[b].indices.push(v);
          weights[b].weights.push(w);
        }
      }
      sk.bones.forEach((bone, i) => {
        if (!models.has(bone))
          throw new Error("FBX skeleton contains an unmapped bone");
        const cid = nextId++,
          w = weights[i];
        objects.push(
          node(
            "Deformer",
            [L(cid), named(bone.name, "SubDeformer"), S("Cluster")],
            [
              node("Version", [I(100)]),
              node("UserData", [S(""), S("")]),
              node("Indexes", [array("i", w.indices)]),
              node("Weights", [array("d", w.weights)]),
              node("Transform", [
                array(
                  "d",
                  sk.boneInverses[i].clone().multiply(bind(o).world).elements,
                ),
              ]),
              node("TransformLink", [
                array("d", sk.boneInverses[i].clone().invert().elements),
              ]),
            ],
          ),
        );
        connect(cid, skin);
        connect(models.get(bone), cid);
      });
    }
  }
  const pose = nextId++;
  objects.push(
    node(
      "Pose",
      [L(pose), named("BindPose", "Pose"), S("BindPose")],
      [
        node("Type", [S("BindPose")]),
        node("Version", [I(100)]),
        node("NbPoseNodes", [I(poseEntries.length)]),
        ...poseEntries,
      ],
    ),
  );
  const stack = nextId++,
    animLayer = nextId++,
    end = clip.duration > 0 ? clip.duration : 0;
  objects.push(
    node(
      "AnimationStack",
      [L(stack), named(clip.name, "AnimStack"), S("")],
      [
        properties([
          property("LocalStart", "KTime", [L(0)]),
          property("LocalStop", "KTime", [L(Math.round(end * KTIME))]),
          property("ReferenceStart", "KTime", [L(0)]),
          property("ReferenceStop", "KTime", [L(Math.round(end * KTIME))]),
        ]),
      ],
    ),
  );
  objects.push(
    node(
      "AnimationLayer",
      [L(animLayer), named("BaseLayer", "AnimLayer"), S("")],
      [
        properties([
          property("Weight", "Number", [D(100)]),
          property("Mute", "bool", [I(0)]),
          property("Solo", "bool", [I(0)]),
          property("BlendMode", "enum", [I(1)]),
          property("RotationAccumulationMode", "enum", [I(0)]),
        ]),
      ],
    ),
  );
  connect(animLayer, stack);
  for (const track of clip.tracks) {
    const split = track.name.lastIndexOf("."),
      name = track.name.slice(0, split),
      attr = track.name.slice(split + 1);
    const o = nodes.find((n) => n.name === name);
    if (!o) continue;
    const type = { position: "T", quaternion: "R", scale: "S" }[attr];
    if (!type) continue;
    const sampled =
      attr === "quaternion"
        ? rotationSamples(track)
        : {
            times: Array.from(track.times),
            values: Array.from({ length: track.times.length }, (_, i) =>
              Array.from(track.values.slice(i * 3, i * 3 + 3)),
            ),
          };
    const cid = nextId++,
      first = sampled.values[0];
    objects.push(
      node(
        "AnimationCurveNode",
        [L(cid), named(type, "AnimCurveNode"), S("")],
        [
          properties(
            first.map((v, i) => property(`d|${"XYZ"[i]}`, "Number", [D(v)])),
          ),
        ],
      ),
    );
    connect(cid, animLayer);
    connect(
      cid,
      models.get(o),
      `Lcl ${type === "T" ? "Translation" : type === "R" ? "Rotation" : "Scaling"}`,
    );
    for (let k = 0; k < 3; k++) {
      const id = nextId++;
      objects.push(
        node(
          "AnimationCurve",
          [L(id), named(`${name}_${type}${"XYZ"[k]}`, "AnimCurve"), S("")],
          [
            node("Default", [D(first[k])]),
            node("KeyVer", [I(4008)]),
            node("KeyTime", [
              array(
                "l",
                sampled.times.map((t) => Math.round(t * KTIME)),
              ),
            ]),
            node("KeyValueFloat", [
              array(
                "f",
                sampled.values.map((v) => v[k]),
              ),
            ]),
            node("KeyAttrFlags", [array("i", [4])]),
            node("KeyAttrDataFloat", [array("f", [0, 0, 0, 0])]),
            node("KeyAttrRefCount", [array("i", [sampled.times.length])]),
          ],
        ),
      );
      connect(id, cid, `d|${"XYZ"[k]}`);
    }
  }
  const counts = new Map();
  for (const o of objects) counts.set(o.name, (counts.get(o.name) || 0) + 1);
  return binary([
    node(
      "FBXHeaderExtension",
      [],
      [
        node("FBXHeaderVersion", [I(1003)]),
        node("FBXVersion", [I(VERSION)]),
        node("EncryptionType", [I(0)]),
        node("Creator", [S("Hand Motion Studio")]),
      ],
    ),
    node(
      "GlobalSettings",
      [],
      [
        node("Version", [I(1000)]),
        properties([
          property("UpAxis", "int", [I(1)]),
          property("UpAxisSign", "int", [I(1)]),
          property("FrontAxis", "int", [I(2)]),
          property("FrontAxisSign", "int", [I(1)]),
          property("CoordAxis", "int", [I(0)]),
          property("CoordAxisSign", "int", [I(1)]),
          property("OriginalUpAxis", "int", [I(1)]),
          property("OriginalUpAxisSign", "int", [I(1)]),
          property("UnitScaleFactor", "double", [D(100)]),
          property("OriginalUnitScaleFactor", "double", [D(100)]),
          property("TimeMode", "enum", [I(14)]),
          property("CustomFrameRate", "double", [D(root.userData.fps || 30)]),
          property("TimeSpanStart", "KTime", [L(0)]),
          property("TimeSpanStop", "KTime", [L(Math.round(end * KTIME))]),
        ]),
      ],
    ),
    node(
      "Documents",
      [I(1)],
      [
        node(
          "Document",
          [L(nextId++), S(root.name), S("Scene")],
          [
            properties([
              property("ActiveAnimStackName", "KString", [S(clip.name)]),
            ]),
            node("RootNode", [L(0)]),
          ],
        ),
      ],
    ),
    node("References"),
    node(
      "Definitions",
      [],
      [
        node("Version", [I(100)]),
        node("Count", [I(objects.length)]),
        ...Array.from(counts, ([name, count]) =>
          node("ObjectType", [S(name)], [node("Count", [I(count)])]),
        ),
      ],
    ),
    node("Objects", [], objects),
    node("Connections", [], connections),
    node("Takes", [], [node("Current", [S(clip.name)])]),
  ]);
}

export async function exportFbx(options) {
  return sceneToFbx(buildMotionScene(options));
}
