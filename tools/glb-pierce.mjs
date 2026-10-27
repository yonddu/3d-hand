// Fingers inside each other in a saved GLB, measured on the animation as it
// was saved (what the user sees), not on a fresh solve of its raw frames as
// tools/replay.mjs does: the grip pass, the clean-up and the export all come
// after the solver's walls.
//
//   node tools/glb-pierce.mjs take.glb [more.glb ...] [--list]
import fs from 'fs';
import * as THREE from 'three';
import { overlaps, palmFrame, palmDepth, RADIUS } from '../src/collide.js';

const PIERCE = 0.008; // as tools/replay.mjs
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const TYPES = { SCALAR: 1, VEC3: 3, VEC4: 4 };

function readGlb(path) {
  const b = fs.readFileSync(path);
  const jl = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jl).toString());
  const binAt = 20 + jl + 8;
  const read = (i) => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const n = a.count * TYPES[a.type];
    const off = binAt + (v.byteOffset || 0) + (a.byteOffset || 0);
    return new Float32Array(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + n * 4));
  };
  return { json, read };
}

export function measureGlb(path) {
  const { json, read } = readGlb(path);
  const nodes = json.nodes.map((n) => {
    const o = new THREE.Object3D();
    o.name = n.name;
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  const root = new THREE.Object3D();
  json.nodes.forEach((n, i) => (n.children || []).forEach((c) => nodes[i].add(nodes[c])));
  nodes.forEach((o) => !o.parent && root.add(o));
  const anim = json.animations[0];
  const tracks = anim.channels.map((c) => {
    const s = anim.samplers[c.sampler];
    return { node: nodes[c.target.node], path: c.target.path, times: read(s.input), values: read(s.output) };
  });
  const times = tracks.reduce((a, t) => (t.times.length > a.length ? t.times : a), []);
  const byName = Object.fromEntries(nodes.map((o) => [o.name, o]));
  const out = { frames: times.length, pierce: 0, ppierce: 0, thumb: 0, marks: [] };
  const v = new THREE.Vector3();
  for (let fi = 0; fi < times.length; fi++) {
    const t = times[fi];
    for (const tr of tracks) {
      let k = tr.times.findIndex((x) => x >= t - 1e-4);
      if (k < 0) k = tr.times.length - 1;
      const w = TYPES[tr.path === 'rotation' ? 'VEC4' : 'VEC3'];
      const val = Array.from(tr.values.subarray(k * w, k * w + w));
      if (tr.path === 'rotation') tr.node.quaternion.fromArray(val);
      else if (tr.path === 'translation') tr.node.position.fromArray(val);
      else tr.node.scale.fromArray(val);
    }
    root.updateMatrixWorld(true);
    for (const side of ['Left', 'Right']) {
      const hand = byName[`${side}Hand`];
      if (!hand || hand.getWorldScale(v).x < 1e-3) continue; // hand not in this frame
      const L = [hand.getWorldPosition(new THREE.Vector3()).toArray()];
      for (const f of FINGERS) for (let j = 1; j <= 4; j++) L.push(byName[`${side}Hand${f}${j}`].getWorldPosition(new THREE.Vector3()).toArray());
      for (const o of overlaps(L, Math.hypot(...L[9].map((v, i) => v - L[0][i])) / 0.09, PIERCE)) {
        out.pierce++;
        if (o.a === 'thumb') out.thumb++;
        out.marks.push({ t: +t.toFixed(2), side, kind: 'pierce', about: `${o.a}-${o.b} ${Math.round(o.depth * 1000)}mm bones ${o.bones.join('/')}` });
      }
      // Palm side: the way the fingers' middle joints lie from the knuckles' plane.
      const w = new THREE.Vector3(...L[0]);
      const n = new THREE.Vector3(...L[5]).sub(w).cross(new THREE.Vector3(...L[17]).sub(w)).normalize();
      if (side === 'Left') n.negate();
      const pf = palmFrame(L[0], L[5], L[17], L[9], n.toArray());
      for (const [key, idx] of [['thumb', [3, 4]], ['index', [7, 8]], ['middle', [11, 12]], ['ring', [15, 16]], ['pinky', [19, 20]]]) {
        const deep = Math.max(...idx.map((i) => palmDepth(L[i], RADIUS[key], pf)));
        if (deep > PIERCE) {
          out.ppierce++;
          out.marks.push({ t: +t.toFixed(2), side, kind: 'ppierce', about: `${key} ${Math.round(deep * 1000)}mm` });
        }
      }
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = process.argv.includes('--list');
  for (const p of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
    const r = measureGlb(p);
    console.log(`${p.split('/').pop()}: ${r.frames} frames, pierce ${r.pierce} (thumb ${r.thumb}), ppierce ${r.ppierce}`);
    if (list) for (const m of r.marks) console.log(`  ${m.t}s ${m.side} ${m.kind} ${m.about}`);
  }
}
