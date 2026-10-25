// Small mesh toolkit for skinned geometry: weld, cut with a plane, subdivide,
// find open borders. Skin weights travel with the vertices as {bone: weight}
// maps and are blended like positions, then packed back to 4 influences.
import * as THREE from 'three';

// Indexed, welded working copy. Vertices that share a position become one
// (UV seams are dropped: the hand materials do not use UVs).
export function fromGeometry(g) {
  const pos = g.attributes.position;
  const si = g.attributes.skinIndex;
  const sw = g.attributes.skinWeight;
  const ids = new Map();
  const remap = new Int32Array(pos.count);
  const P = [];
  const W = [];
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`;
    let id = ids.get(k);
    if (id === undefined) {
      id = P.length;
      ids.set(k, id);
      P.push(new THREE.Vector3().fromBufferAttribute(pos, i));
      const w = new Map();
      for (let j = 0; j < 4; j++) {
        const x = sw.getComponent(i, j);
        if (x > 0) w.set(si.getComponent(i, j), (w.get(si.getComponent(i, j)) || 0) + x);
      }
      W.push(w);
    }
    remap[i] = id;
  }
  const T = [];
  const n = g.index ? g.index.count : pos.count;
  for (let t = 0; t < n; t += 3) {
    const v = [0, 1, 2].map((k) => remap[g.index ? g.index.getX(t + k) : t + k]);
    if (v[0] !== v[1] && v[1] !== v[2] && v[0] !== v[2]) T.push(v);
  }
  const m = { P, W, T, N: null };
  m.N = vertexNormals(m);
  return m;
}

function mixWeights(list) {
  // list: [[map, factor], ...]
  const out = new Map();
  for (const [w, f] of list) for (const [b, x] of w) out.set(b, (out.get(b) || 0) + x * f);
  return out;
}

export function vertexNormals(m) {
  const N = m.P.map(() => new THREE.Vector3());
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  for (const [a, b, c] of m.T) {
    e1.subVectors(m.P[b], m.P[a]);
    e2.subVectors(m.P[c], m.P[a]);
    const f = e1.cross(e2); // area-weighted
    N[a].add(f);
    N[b].add(f);
    N[c].add(f);
  }
  return N.map((n) => n.normalize());
}

// Keep the side of the plane dot(normal, p) >= k. Triangles crossing it are
// split on the plane, so the cut leaves one clean planar border.
export function clipPlane(m, normal, k, snap = 0.0006) {
  const d = m.P.map((p, i) => {
    let x = normal.dot(p) - k;
    if (Math.abs(x) < snap) {
      p.addScaledVector(normal, -x); // settle near-plane vertices onto it: no slivers
      x = 0;
    }
    return x;
  });
  const P = m.P.slice();
  const W = m.W.slice();
  const N = m.N.slice();
  const edgeVert = new Map();
  const cut = (a, b) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    let id = edgeVert.get(key);
    if (id === undefined) {
      const t = d[a] / (d[a] - d[b]);
      id = P.length;
      P.push(P[a].clone().lerp(P[b], t));
      N.push(N[a].clone().lerp(N[b], t).normalize());
      W.push(mixWeights([[W[a], 1 - t], [W[b], t]]));
      edgeVert.set(key, id);
    }
    return id;
  };
  const T = [];
  for (const tri of m.T) {
    const s = tri.map((v) => d[v]);
    if (s.every((x) => x >= 0)) {
      T.push(tri);
      continue;
    }
    if (s.every((x) => x <= 0)) continue;
    // Walk the triangle edges, keeping inside vertices and plane crossings in order.
    const poly = [];
    for (let i = 0; i < 3; i++) {
      const a = tri[i];
      const b = tri[(i + 1) % 3];
      if (d[a] >= 0) poly.push(a);
      if ((d[a] > 0 && d[b] < 0) || (d[a] < 0 && d[b] > 0)) poly.push(cut(a, b));
    }
    for (let i = 1; i + 1 < poly.length; i++) T.push([poly[0], poly[i], poly[i + 1]]);
  }
  return compact({ P, W, N, T });
}

// Drop vertices no triangle uses.
function compact(m) {
  const used = new Int32Array(m.P.length).fill(-1);
  const out = { P: [], W: [], N: [], T: [] };
  for (const tri of m.T) {
    out.T.push(
      tri.map((v) => {
        if (used[v] < 0) {
          used[v] = out.P.length;
          out.P.push(m.P[v]);
          out.W.push(m.W[v]);
          out.N.push(m.N[v]);
        }
        return used[v];
      }),
    );
  }
  return out;
}

function edgeCounts(m) {
  const count = new Map();
  for (const tri of m.T) {
    for (let i = 0; i < 3; i++) {
      const a = tri[i];
      const b = tri[(i + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  return count;
}

// One level of 1-to-4 subdivision. Original vertices stay put; each new edge
// vertex is lifted off the flat midpoint by Phong tessellation (projection onto
// the two end vertices' tangent planes), so the surface gets rounder without
// shrinking the way approximating schemes do. Border edges stay straight.
export function subdivide(m, alpha = 0.75) {
  const counts = edgeCounts(m);
  const P = m.P.slice();
  const N = m.N.slice();
  const W = m.W.slice();
  const mid = new Map();
  const tmp = new THREE.Vector3();
  const project = (q, p, n) => q.clone().addScaledVector(n, -tmp.subVectors(q, p).dot(n));
  const edge = (a, b) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    let id = mid.get(key);
    if (id === undefined) {
      const q = P[a].clone().add(P[b]).multiplyScalar(0.5);
      let p = q;
      if (counts.get(key) > 1) {
        const phong = project(q, P[a], N[a]).add(project(q, P[b], N[b])).multiplyScalar(0.5);
        p = q.clone().lerp(phong, alpha);
      }
      id = P.length;
      P.push(p);
      N.push(N[a].clone().add(N[b]).normalize());
      W.push(mixWeights([[W[a], 0.5], [W[b], 0.5]]));
      mid.set(key, id);
    }
    return id;
  };
  const T = [];
  for (const [a, b, c] of m.T) {
    const ab = edge(a, b);
    const bc = edge(b, c);
    const ca = edge(c, a);
    T.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
  }
  const out = { P, W, N, T };
  out.N = vertexNormals(out);
  return out;
}

// Open borders as ordered vertex loops.
export function borderLoops(m) {
  const counts = edgeCounts(m);
  const next = new Map();
  // Directed border edges keep the triangle winding, so loops come out ordered.
  for (const tri of m.T) {
    for (let i = 0; i < 3; i++) {
      const a = tri[i];
      const b = tri[(i + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (counts.get(key) === 1) next.set(a, b);
    }
  }
  const loops = [];
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let v = start;
    while (v !== undefined && !seen.has(v)) {
      seen.add(v);
      loop.push(v);
      v = next.get(v);
    }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}

// Back to a BufferGeometry with up to 4 normalized influences per vertex.
export function toGeometry(m) {
  const n = m.P.length;
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    m.P[i].toArray(position, i * 3);
    m.N[i].toArray(normal, i * 3);
    const top = [...m.W[i]].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
    top.forEach(([b, w], j) => {
      skinIndex[i * 4 + j] = b;
      skinWeight[i * 4 + j] = w / sum;
    });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  g.setIndex(m.T.flat());
  return g;
}
