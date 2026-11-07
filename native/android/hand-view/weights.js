// Skin weights that follow the skin surface (like Blender's automatic weights), not straight lines.
//  1. Each vertex starts on its straight-nearest bone (its "seed" bone).
//  2. The distance to every other bone spreads over the skin from that bone's seed vertices
//     (Dijkstra on the mesh edges; vertices at the same place are welded first so UV seams don't
//     cut the surface). A neighbouring finger's bone is reached only by going round the gap
//     between the fingers, so it stays far and gets no weight; straight lines leaked across.
//  3. Weights from those surface distances: nearest bone, blended over the next ones within
//     max(0.06 * scale, 0.5 * nearest), capped at 0.25 * scale so far skin (the forearm) stays
//     on one bone instead of smearing over the fingers.
// Loose pieces a bone can't reach over the skin use straight distance + 0.5 * scale for it.
// Gauntlet v1/v2 fist (edges stretched > 1.5x): straight 5.66% / 2.87% -> 3.16% / 1.55%.
// pos: Float32Array n*3 (root space), index: triangle indices or null, segs: [{bi, a, b}] Vector3.

export function surfaceWeights(pos, index, segs, scale) {
  const n = pos.length / 3;
  const nb = Math.max(...segs.map((s) => s.bi)) + 1;
  const tri = index ? Array.from(index) : Array.from({ length: n }, (_, i) => i);
  // weld vertices at the same place
  const q = scale * 1e-4; const key = new Map(); const wid = new Int32Array(n); const wp = [];
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos[3 * i] / q)},${Math.round(pos[3 * i + 1] / q)},${Math.round(pos[3 * i + 2] / q)}`;
    let w = key.get(k); if (w === undefined) { w = wp.length / 3; key.set(k, w); wp.push(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]); }
    wid[i] = w;
  }
  const m = wp.length / 3; const P = Float64Array.from(wp);
  // straight distance from each welded vertex to each bone (its nearest segment)
  const D = new Float64Array(m * nb).fill(Infinity);
  const S = segs.map((s) => ({ bi: s.bi, a: [s.a.x, s.a.y, s.a.z], b: [s.b.x, s.b.y, s.b.z] }));
  for (let v = 0; v < m; v++) {
    const px = P[3 * v], py = P[3 * v + 1], pz = P[3 * v + 2];
    for (const s of S) {
      const abx = s.b[0] - s.a[0], aby = s.b[1] - s.a[1], abz = s.b[2] - s.a[2];
      const l2 = abx * abx + aby * aby + abz * abz;
      let t = l2 > 1e-20 ? ((px - s.a[0]) * abx + (py - s.a[1]) * aby + (pz - s.a[2]) * abz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = s.a[0] + abx * t, cy = s.a[1] + aby * t, cz = s.a[2] + abz * t;
      const d = Math.hypot(px - cx, py - cy, pz - cz);
      const o = v * nb + s.bi; if (d < D[o]) D[o] = d;
    }
  }
  // welded triangles, edges
  const T = []; const nbr = Array.from({ length: m }, () => new Map());
  for (let i = 0; i + 2 < tri.length; i += 3) {
    const a = wid[tri[i]], b = wid[tri[i + 1]], c = wid[tri[i + 2]];
    if (a === b || b === c || a === c) continue;
    T.push(a, b, c);
    for (const [x, y] of [[a, b], [b, c], [c, a]]) { if (!nbr[x].has(y)) { const l = Math.hypot(P[3 * x] - P[3 * y], P[3 * x + 1] - P[3 * y + 1], P[3 * x + 2] - P[3 * y + 2]); nbr[x].set(y, l); nbr[y].set(x, l); } }
  }
  const nt = T.length / 3;
  // seeds: each vertex starts at its straight-nearest bone (a see-through test was tried: on the
  // layered gauntlets it made fists worse, 1.55 -> 6.4% torn edges on v2)
  const seedOf = new Int32Array(m).fill(-1);
  for (let v = 0; v < m; v++) { let best = -1; for (let b = 0; b < nb; b++) if (isFinite(D[v * nb + b]) && (best < 0 || D[v * nb + b] < D[v * nb + best])) best = b; seedOf[v] = best; }
  // a bone with no seed (outside the skin): its straight-nearest vertices are its seeds
  const has = new Uint8Array(nb); for (let v = 0; v < m; v++) if (seedOf[v] >= 0) has[seedOf[v]] = 1;
  const used = new Uint8Array(nb); for (const s of segs) used[s.bi] = 1;
  const extra = Array.from({ length: nb }, () => []);
  for (let v = 0; v < m; v++) { let best = -1; for (let b = 0; b < nb; b++) if (used[b] && (best < 0 || D[v * nb + b] < D[v * nb + best])) best = b; if (best >= 0 && !has[best]) extra[best].push(v); }
  // surface distance per bone: Dijkstra from its seeds (start value = straight distance)
  const Gd = new Float64Array(m * nb).fill(Infinity);
  const heap = new Heap(m);
  for (let b = 0; b < nb; b++) {
    if (!used[b]) continue;
    const dist = new Float64Array(m).fill(Infinity);
    heap.clear();
    for (let v = 0; v < m; v++) if (seedOf[v] === b) { dist[v] = D[v * nb + b]; heap.push(v, dist[v]); }
    for (const v of extra[b]) { dist[v] = D[v * nb + b]; heap.push(v, dist[v]); }
    while (heap.size) {
      const [v, d] = heap.pop(); if (d > dist[v]) continue;
      for (const [u, l] of nbr[v]) { const nd = d + l; if (nd < dist[u]) { dist[u] = nd; heap.push(u, nd); } }
    }
    for (let v = 0; v < m; v++) Gd[v * nb + b] = dist[v];
  }
  // weights per welded vertex
  const wi = new Uint16Array(m * 4); const ww = new Float32Array(m * 4); let loose = 0;
  for (let v = 0; v < m; v++) {
    // a bone the skin can't reach from here (another loose piece): straight distance + a penalty
    let any = false; for (let b = 0; b < nb; b++) if (used[b] && isFinite(Gd[v * nb + b])) { any = true; break; }
    if (!any) loose++;
    const list = []; for (let b = 0; b < nb; b++) if (used[b]) { const g = Gd[v * nb + b]; list.push({ b, d: isFinite(g) ? g : D[v * nb + b] + (any ? 0.5 * scale : 0) }); }
    list.sort((x, y) => x.d - y.d); list.length = Math.min(list.length, 4);
    const d0 = list[0].d; const blend = Math.min(Math.max(0.06 * scale, d0 * 0.5), 0.25 * scale); // capped: far skin (forearm) stays on one bone
    let ws = list.map((x) => (x.d - d0 > blend ? 0 : Math.pow(1 - (x.d - d0) / blend, 2)));
    const sum = ws.reduce((a, b) => a + b, 0) || 1; ws = ws.map((w) => w / sum);
    list.forEach((x, k) => { wi[v * 4 + k] = x.b; ww[v * 4 + k] = ws[k]; });
  }
  const si = new Uint16Array(n * 4); const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) { si[i * 4 + k] = wi[wid[i] * 4 + k]; sw[i * 4 + k] = ww[wid[i] * 4 + k]; }
  return { si, sw, stats: { verts: n, welded: m, tris: nt, loose } };
}

class Heap {
  constructor(cap) { this.k = []; this.v = []; this.size = 0; }
  clear() { this.k.length = 0; this.v.length = 0; this.size = 0; }
  push(id, d) {
    let i = this.size++; this.k[i] = d; this.v[i] = id;
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= this.k[i]) break; this.swap(i, p); i = p; }
  }
  pop() {
    const id = this.v[0], d = this.k[0]; const n = --this.size;
    if (n > 0) { this.k[0] = this.k[n]; this.v[0] = this.v[n]; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < n && this.k[l] < this.k[s]) s = l; if (r < n && this.k[r] < this.k[s]) s = r; if (s === i) break; this.swap(i, s); i = s; } }
    this.k.length = n; this.v.length = n;
    return [id, d];
  }
  swap(a, b) { const k = this.k[a]; this.k[a] = this.k[b]; this.k[b] = k; const v = this.v[a]; this.v[a] = this.v[b]; this.v[b] = v; }
}
