// The ball of the thumb (thenar), kept as soft tissue.
//
// The thenar is muscle between the thumb's metacarpal and the palm. With
// plain skinning each of its vertices is a fixed blend of those two bones,
// so as the thumb swings in front of the palm (any grip, fist or pinch) the
// pad swings out with it and swells into a ball on the side of the hand.
// Here the pad is solved each frame instead: the bone and the skin over it
// stay rigid, the palm stays rigid, and the soft pad between them takes the
// smoothest surface that keeps its own rest shape (a Laplacian solve: every
// soft vertex sits at the mean of its neighbours plus its rest offset from
// that mean, turned with the bones). The result goes to the GPU as a morph
// target, so the normal skinning path is unchanged.
import * as THREE from 'three';

const BONE_SKIN = [0.008, 0.013]; // m from the metacarpal's axis: skin on the bone -> soft pad

export class ThenarPad {
  // mesh: the hand's SkinnedMesh (indexed, welded); rest: joint rest positions
  // in mesh space.
  constructor(mesh, rest) {
    this.mesh = mesh;
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const si = g.attributes.skinIndex;
    const sw = g.attributes.skinWeight;
    const names = mesh.skeleton.bones.map((b) => b.name);
    const META = names.indexOf('thumb-metacarpal');
    const n = pos.count;
    this.ok = META >= 0 && !!g.index;
    if (!this.ok) return;

    // Neighbours from the triangles.
    const nb = Array.from({ length: n }, () => new Set());
    const idx = g.index.array;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      nb[a].add(b).add(c);
      nb[b].add(a).add(c);
      nb[c].add(a).add(b);
    }

    // Softness: everything the model ties to the metacarpal except the bone's
    // own thin skin (near its axis, between the base and the knuckle). Tissue
    // below the base must not ride on it either: there the bone's turn would
    // lever it out the other way.
    const base = rest['thumb-metacarpal'];
    const axis = rest['thumb-phalanx-proximal'].clone().sub(base);
    const len2 = axis.lengthSq();
    const v = new THREE.Vector3();
    const soft = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === META) w += sw.getComponent(i, k);
      if (w < 0.02) continue;
      v.fromBufferAttribute(pos, i).sub(base);
      const t = v.dot(axis) / len2;
      const dist = v.addScaledVector(axis, -THREE.MathUtils.clamp(t, 0, 1)).length();
      const onBone = (1 - THREE.MathUtils.smoothstep(dist, BONE_SKIN[0], BONE_SKIN[1])) * THREE.MathUtils.smoothstep(t, 0, 0.3);
      const nearKnuckle = THREE.MathUtils.smoothstep(t, 0.8, 1.05);
      soft[i] = (1 - Math.max(onBone, nearKnuckle)) * THREE.MathUtils.smoothstep(w, 0.02, 0.15);
    }

    // Free vertices (solved) and the fixed ring around them.
    const free = [];
    const slot = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) if (soft[i] > 0.01) slot[i] = free.push(i) - 1;
    const ring = new Set();
    for (const i of free) for (const j of nb[i]) if (slot[j] < 0) ring.add(j);
    this.free = free;
    this.ring = [...ring];
    this.slot = slot;
    this.soft = soft;
    this.nb = free.map((i) => [...nb[i]]);

    // Rest offsets from the neighbour mean.
    const P = (i) => new THREE.Vector3().fromBufferAttribute(pos, i);
    this.delta = free.map((i, f) => {
      const m = new THREE.Vector3();
      for (const j of this.nb[f]) m.add(P(j));
      return P(i).sub(m.divideScalar(this.nb[f].length));
    });
    // Rest mean edge length around each free vertex, to tell where the
    // skinning squeezes the pad.
    this.restEdge = free.map((i, f) => this.nb[f].reduce((sum, j) => sum + P(i).distanceTo(P(j)), 0) / this.nb[f].length);

    // x_i - s_i * mean(x_j over free j) = (1 - s_i) p_i + s_i (r_i + mean(p_j over fixed j))
    // The matrix is the same every frame: invert it once.
    const F = free.length;
    const A = new Float64Array(F * F);
    free.forEach((i, f) => {
      A[f * F + f] = 1;
      const k = soft[i] / this.nb[f].length;
      for (const j of this.nb[f]) if (slot[j] >= 0) A[f * F + slot[j]] -= k;
    });
    this.inv = invert(A, F);

    this.morph = new Float32Array(n * 3);
    this.morphN = new Float32Array(n * 3);
    g.morphAttributes.position = [new THREE.BufferAttribute(this.morph, 3)];
    g.morphAttributes.normal = [new THREE.BufferAttribute(this.morphN, 3)];
    g.morphTargetsRelative = true;
    mesh.updateMorphTargets();
    mesh.morphTargetInfluences[0] = 1;
    this.faces = this.facesOf(idx, slot);
  }

  // Triangles touching a free vertex, for its normal.
  facesOf(idx, slot) {
    const out = this.free.map(() => []);
    for (let t = 0; t < idx.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const f = slot[idx[t + k]];
        if (f >= 0) out[f].push(t);
      }
    }
    return out;
  }

  // Call after the joints are posed (bone world matrices up to date).
  update() {
    if (!this.ok) return;
    const mesh = this.mesh;
    const skel = mesh.skeleton;
    skel.update();
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const si = g.attributes.skinIndex;
    const sw = g.attributes.skinWeight;
    const bm = skel.boneMatrices;
    const blend = (i, out) => {
      const e = out.elements;
      e.fill(0);
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (!w) continue;
        const o = si.getComponent(i, k) * 16;
        for (let c = 0; c < 16; c++) e[c] += bm[o + c] * w;
      }
      return out.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
    };
    const M = new THREE.Matrix4();
    const skinned = new Map();
    const mats = [];
    for (const i of this.ring) skinned.set(i, new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(blend(i, M)));
    const F = this.free.length;
    const lbs = this.free.map((i) => {
      const B = blend(i, new THREE.Matrix4());
      mats.push(B);
      return new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(B);
    });
    const at = (j) => (this.slot[j] >= 0 ? lbs[this.slot[j]] : skinned.get(j));
    // How much the skinning squeezes the tissue around each vertex: where it
    // keeps its size the pad keeps its full rest relief (it then matches the
    // skinned surface), where it is squeezed the relief flattens instead of
    // bulging out.
    const keep = this.free.map((i, f) => {
      const e = this.nb[f].reduce((sum, j) => sum + lbs[f].distanceTo(at(j)), 0) / this.nb[f].length;
      return THREE.MathUtils.lerp(ThenarPad.detail, 1, THREE.MathUtils.smoothstep(e / this.restEdge[f], ThenarPad.squeeze[0], ThenarPad.squeeze[1]));
    });
    const rhs = new Float64Array(F * 3);
    const v = new THREE.Vector3();
    const r = new THREE.Vector3();
    const m3 = new THREE.Matrix3();
    this.free.forEach((i, f) => {
      const B = mats[f];
      const s = this.soft[i];
      v.copy(lbs[f]);
      // Rest offset turned with the bones.
      const d = this.delta[f];
      r.copy(d).applyMatrix3(m3.setFromMatrix4(B)).setLength(d.length() * keep[f]);
      const k = s / this.nb[f].length;
      let fx = 0;
      let fy = 0;
      let fz = 0;
      for (const j of this.nb[f]) {
        if (this.slot[j] >= 0) continue;
        const p = skinned.get(j);
        fx += p.x;
        fy += p.y;
        fz += p.z;
      }
      rhs[f * 3] = (1 - s) * v.x + s * r.x + k * fx;
      rhs[f * 3 + 1] = (1 - s) * v.y + s * r.y + k * fy;
      rhs[f * 3 + 2] = (1 - s) * v.z + s * r.z + k * fz;
    });
    const x = new Float64Array(F * 3);
    const inv = this.inv;
    for (let a = 0; a < F; a++) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      const row = a * F;
      for (let b = 0; b < F; b++) {
        const c = inv[row + b];
        if (c === 0) continue;
        sx += c * rhs[b * 3];
        sy += c * rhs[b * 3 + 1];
        sz += c * rhs[b * 3 + 2];
      }
      x[a * 3] = sx;
      x[a * 3 + 1] = sy;
      x[a * 3 + 2] = sz;
    }

    // Back to rest space through each vertex's own skin transform: that is
    // what the GPU will apply to the morphed rest position.
    const idx = g.index.array;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const restN = g.attributes.normal;
    const Minv = new THREE.Matrix4();
    this.free.forEach((i, f) => {
      Minv.copy(mats[f]).invert();
      v.set(x[f * 3], x[f * 3 + 1], x[f * 3 + 2]).applyMatrix4(Minv);
      this.morph[i * 3] = v.x - pos.getX(i);
      this.morph[i * 3 + 1] = v.y - pos.getY(i);
      this.morph[i * 3 + 2] = v.z - pos.getZ(i);
      // Normal from the solved surface (vertices outside the pad use their
      // skinned place), taken back to rest space the same way.
      nrm.set(0, 0, 0);
      for (const t of this.faces[f]) {
        const pa = this.pointAt(idx[t], x, skinned, pos, mats, a);
        const pb = this.pointAt(idx[t + 1], x, skinned, pos, mats, b);
        const pc = this.pointAt(idx[t + 2], x, skinned, pos, mats, c);
        nrm.add(pb.sub(pa).cross(pc.sub(pa)));
      }
      nrm.applyMatrix3(m3.setFromMatrix4(Minv)).normalize();
      this.morphN[i * 3] = nrm.x - restN.getX(i);
      this.morphN[i * 3 + 1] = nrm.y - restN.getY(i);
      this.morphN[i * 3 + 2] = nrm.z - restN.getZ(i);
    });
    g.morphAttributes.position[0].needsUpdate = true;
    g.morphAttributes.normal[0].needsUpdate = true;
  }

  pointAt(i, x, skinned, pos, mats, out) {
    const f = this.slot[i];
    if (f >= 0) return out.set(x[f * 3], x[f * 3 + 1], x[f * 3 + 2]);
    const s = skinned.get(i);
    if (s) return out.copy(s);
    // A vertex two rings out: skin it here.
    const g = this.mesh.geometry;
    const si = g.attributes.skinIndex;
    const sw = g.attributes.skinWeight;
    const bm = this.mesh.skeleton.boneMatrices;
    const M = new THREE.Matrix4();
    const e = M.elements;
    e.fill(0);
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (!w) continue;
      const o = si.getComponent(i, k) * 16;
      for (let c = 0; c < 16; c++) e[c] += bm[o + c] * w;
    }
    M.premultiply(this.mesh.bindMatrixInverse).multiply(this.mesh.bindMatrix);
    const p = out.fromBufferAttribute(pos, i).applyMatrix4(M);
    skinned.set(i, p.clone());
    return p;
  }
}

// Share of the pad's rest relief kept on top of the smooth surface where the
// skinning squeezes it.
ThenarPad.detail = 0.3;
// Skinned/rest edge length ratio: below the first the pad is squeezed, above
// the second it is not.
ThenarPad.squeeze = [0.85, 1];

// Dense inverse by Gauss-Jordan with partial pivoting (n is a few hundred).
function invert(A, n) {
  const a = Float64Array.from(A);
  const inv = new Float64Array(n * n);
  for (let i = 0; i < n; i++) inv[i * n + i] = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r * n + c]) > Math.abs(a[p * n + c])) p = r;
    if (p !== c) {
      for (let k = 0; k < n; k++) {
        [a[c * n + k], a[p * n + k]] = [a[p * n + k], a[c * n + k]];
        [inv[c * n + k], inv[p * n + k]] = [inv[p * n + k], inv[c * n + k]];
      }
    }
    const d = a[c * n + c];
    for (let k = 0; k < n; k++) {
      a[c * n + k] /= d;
      inv[c * n + k] /= d;
    }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r * n + c];
      if (f === 0) continue;
      for (let k = 0; k < n; k++) {
        a[r * n + k] -= f * a[c * n + k];
        inv[r * n + k] -= f * inv[c * n + k];
      }
    }
  }
  return inv;
}
