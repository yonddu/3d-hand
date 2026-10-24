// Procedural rigged hand: a THREE.Skeleton with Mixamo-style bone names and a
// SkinnedMesh bound to it, so the same bone rotations can later drive any
// character hand (and be exported to GLB).
import * as THREE from 'three';
import { FINGERS, RADII, restLandmarks, sideSign, wristName, boneName } from './skeleton.js';

const v = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// Rotation whose +Y is `dir` and whose +X is as close to `xHint` as possible.
export function basisQuat(dir, xHint) {
  const y = dir.clone().normalize();
  const x = xHint.clone().sub(y.clone().multiplyScalar(xHint.dot(y))).normalize();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

// Hand frame from landmarks 0 (wrist), 5 (index MCP), 9 (middle MCP), 17 (pinky MCP).
export function handFrameQuat(P, side) {
  const w = P[0];
  const y = new THREE.Vector3().subVectors(P[9], w).normalize();
  const a = new THREE.Vector3().subVectors(P[5], w);
  const b = new THREE.Vector3().subVectors(P[17], w);
  const z = side === 'right' ? a.cross(b) : b.cross(a);
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  z.crossVectors(x, y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

// Axis a bone flexes about, given in rig space.
function flexHint(side, fingerKey, dir) {
  if (fingerKey !== 'thumb') return new THREE.Vector3(1, 0, 0);
  // The thumb curls toward the palm and across it, toward the pinky.
  const across = new THREE.Vector3(-0.55 * sideSign(side), 0, 0.85);
  return new THREE.Vector3().crossVectors(dir.clone().normalize(), across);
}

export class HandRig {
  constructor(side, { material } = {}) {
    this.side = side;
    this.rest = restLandmarks(side).map(v);
    this.group = new THREE.Group();
    this.group.name = `${wristName(side)}Rig`;

    // --- bones -----------------------------------------------------------
    const restFrame = handFrameQuat(this.rest, side);
    this.wrist = new THREE.Bone();
    this.wrist.name = wristName(side);
    this.wrist.quaternion.copy(restFrame);
    this.wristRest = restFrame.clone();
    this.bones = [this.wrist];
    this.chains = {}; // fingerKey -> [{ bone, restLocal, restGlobal, finger, k }]
    this.boneByLandmark = { 0: this.wrist };

    for (const finger of FINGERS) {
      const chain = [];
      let parent = this.wrist;
      let parentGlobal = restFrame.clone();
      let parentPos = this.rest[0];
      for (let k = 0; k < 4; k++) {
        const jIdx = finger.joints[k];
        const pos = this.rest[jIdx];
        const bone = new THREE.Bone();
        bone.name = boneName(side, finger, k);
        let global;
        if (k < 3) {
          const dir = new THREE.Vector3().subVectors(this.rest[finger.joints[k + 1]], pos);
          global = basisQuat(dir, flexHint(side, finger.key, dir));
        } else {
          global = parentGlobal.clone(); // tip end bone, never rotated
        }
        const invParent = parentGlobal.clone().invert();
        bone.position.copy(pos.clone().sub(parentPos).applyQuaternion(invParent));
        bone.quaternion.copy(invParent.clone().multiply(global));
        parent.add(bone);
        this.bones.push(bone);
        this.boneByLandmark[jIdx] = bone;
        if (k < 3) {
          chain.push({ bone, finger, k, restLocal: bone.quaternion.clone(), restGlobal: global.clone() });
        }
        parent = bone;
        parentGlobal = global;
        parentPos = pos;
      }
      this.chains[finger.key] = chain;
    }

    this.group.add(this.wrist);
    this.group.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this.bones);

    // --- skinned mesh ------------------------------------------------------
    this.material = material || new THREE.MeshStandardMaterial({ color: 0xd9a888, roughness: 0.62, metalness: 0.0 });
    this.mesh = this.buildMesh();
    this.group.add(this.mesh);
    this.mesh.bind(this.skeleton);
    this.joints = this.buildJointMarkers();
  }

  boneIndex(bone) {
    return this.bones.indexOf(bone);
  }

  // Merge capsules (fingers) and an extruded palm into one skinned geometry.
  buildMesh() {
    const parts = [];
    const sign = sideSign(this.side);

    // Palm: extruded outline through wrist, thumb base and knuckles.
    const outline = [0, 1, 2, 5, 9, 13, 17].map((i) => this.rest[i]);
    const wristW = 0.030;
    const pts = [
      new THREE.Vector2(-wristW * sign, -0.006),
      new THREE.Vector2(wristW * 0.85 * sign, -0.004),
      new THREE.Vector2(outline[1].x + 0.004 * sign, outline[1].y),
      new THREE.Vector2(outline[2].x - 0.008 * sign, outline[2].y + 0.006),
      new THREE.Vector2(outline[3].x + 0.004 * sign, outline[3].y + 0.004),
      new THREE.Vector2(outline[4].x, outline[4].y + 0.006),
      new THREE.Vector2(outline[5].x, outline[5].y + 0.004),
      new THREE.Vector2(outline[6].x - 0.005 * sign, outline[6].y + 0.002),
      new THREE.Vector2(outline[6].x - 0.008 * sign, outline[6].y - 0.03),
    ];
    if (sign < 0) pts.reverse();
    // Smooth the outline so the palm reads as flesh rather than a plate.
    const n = pts.length;
    const loop = [pts[n - 1], ...pts, pts[0], pts[1]];
    const smooth = new THREE.SplineCurve(loop).getSpacedPoints(64);
    const seg = 64 / (loop.length - 1);
    const shape = new THREE.Shape(smooth.slice(Math.round(seg), Math.round(seg * (n + 1))));
    const palm = new THREE.ExtrudeGeometry(shape, {
      depth: 0.010, bevelEnabled: true, bevelThickness: 0.009, bevelSize: 0.007, bevelSegments: 6, curveSegments: 6,
    });
    palm.translate(0, 0, -0.005);
    palm.deleteAttribute('uv');
    parts.push(this.skinRigid(palm, this.wrist, (p) => this.palmWeights(p)));

    // Forearm stub so the wrist reads as a wrist.
    const fore = new THREE.CapsuleGeometry(0.024, 0.05, 6, 16);
    fore.scale(1, 1, 0.72);
    fore.translate(0, -0.045, 0);
    fore.deleteAttribute('uv');
    parts.push(this.skinRigid(fore, this.wrist));

    // Finger segments.
    for (const finger of FINGERS) {
      const chain = this.chains[finger.key];
      chain.forEach((link, k) => {
        const a = this.rest[finger.joints[k]];
        const b = this.rest[finger.joints[k + 1]];
        const len = a.distanceTo(b);
        const r = RADII[finger.key][k];
        const g = new THREE.CapsuleGeometry(r, Math.max(0.001, len - (k === 2 ? r : 0)), 6, 14);
        g.translate(0, (len - (k === 2 ? r : 0)) / 2, 0);
        g.deleteAttribute('uv');
        const parentBone = k === 0 ? this.wrist : chain[k - 1].bone;
        // Blend the lower cap with the parent bone for smoother knuckles.
        const weights = (p) => {
          const t = THREE.MathUtils.clamp((p.y + r) / (2 * r), 0, 1);
          const self = k === 0 && finger.key !== 'thumb' ? 0.6 + 0.4 * t : 0.5 + 0.5 * t;
          return [[link.bone, self], [parentBone, 1 - self]];
        };
        // Geometry is authored in bone space; move it to bind (rig) space.
        const m = new THREE.Matrix4().compose(a, link.restGlobal, new THREE.Vector3(1, 1, 1));
        parts.push(this.skinGeometry(g, m, weights));
      });
    }

    const merged = mergeSkinned(parts);
    const mesh = new THREE.SkinnedMesh(merged, this.material);
    mesh.name = `${wristName(this.side)}Mesh`;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  palmWeights(p) {
    // Knuckle area of the palm follows the proximal phalanges slightly.
    const out = [[this.wrist, 1]];
    for (const finger of FINGERS) {
      if (finger.key === 'thumb') continue;
      const mcp = this.rest[finger.joints[0]];
      const d = Math.hypot(p.x - mcp.x, p.y - mcp.y);
      if (d < 0.012 && p.y > mcp.y - 0.012) {
        const w = 0.35 * (1 - d / 0.012);
        out[0][1] -= w;
        out.push([this.chains[finger.key][0].bone, w]);
        break;
      }
    }
    return out;
  }

  skinRigid(geometry, bone, weightFn) {
    return this.skinGeometry(geometry, new THREE.Matrix4(), weightFn || (() => [[bone, 1]]));
  }

  // weightFn(localPoint) -> [[bone, weight], ...] (up to 4)
  skinGeometry(geometry, matrix, weightFn) {
    const pos = geometry.attributes.position;
    const n = pos.count;
    const skinIndex = new Uint16Array(n * 4);
    const skinWeight = new Float32Array(n * 4);
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      p.fromBufferAttribute(pos, i);
      const w = weightFn(p);
      w.slice(0, 4).forEach(([bone, weight], j) => {
        skinIndex[i * 4 + j] = this.boneIndex(bone);
        skinWeight[i * 4 + j] = weight;
      });
    }
    geometry.applyMatrix4(matrix);
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
    return geometry;
  }

  buildJointMarkers() {
    const geo = new THREE.SphereGeometry(0.0042, 10, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0x3fd0c9, depthTest: false, transparent: true, opacity: 0.9 });
    const markers = [];
    for (const bone of this.bones) {
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 10;
      bone.add(m);
      markers.push(m);
    }
    markers.forEach((m) => (m.visible = false));
    return markers;
  }

  setJointsVisible(on) {
    this.joints.forEach((m) => (m.visible = on));
  }

  // --- pose I/O --------------------------------------------------------------

  resetPose() {
    this.wrist.quaternion.copy(this.wristRest);
    for (const chain of Object.values(this.chains)) {
      for (const link of chain) link.bone.quaternion.copy(link.restLocal);
    }
  }

  // Snapshot of every animated bone's local rotation.
  getPose() {
    const bones = {};
    for (const chain of Object.values(this.chains)) {
      for (const link of chain) bones[link.bone.name] = link.bone.quaternion.toArray();
    }
    return {
      position: this.group.position.toArray(),
      wrist: this.wrist.quaternion.toArray(),
      bones,
    };
  }

  // Rotation of each bone relative to its bind pose (what a retargeter wants).
  getPoseDelta() {
    const out = {};
    const inv = new THREE.Quaternion();
    for (const chain of Object.values(this.chains)) {
      for (const link of chain) {
        inv.copy(link.restLocal).invert();
        out[link.bone.name] = inv.multiply(link.bone.quaternion).toArray();
      }
    }
    return out;
  }

  setPose(pose) {
    if (pose.position) this.group.position.fromArray(pose.position);
    if (pose.wrist) this.wrist.quaternion.fromArray(pose.wrist);
    for (const chain of Object.values(this.chains)) {
      for (const link of chain) {
        const q = pose.bones && pose.bones[link.bone.name];
        if (q) link.bone.quaternion.fromArray(q);
      }
    }
  }

  // World positions of the 21 landmark joints (used by the demo generator).
  landmarkPositions() {
    this.group.updateMatrixWorld(true);
    const out = [];
    for (let i = 0; i < 21; i++) {
      out.push(new THREE.Vector3().setFromMatrixPosition(this.boneByLandmark[i].matrixWorld));
    }
    return out;
  }
}

function mergeSkinned(geoms) {
  const nonIndexed = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = nonIndexed.reduce((s, g) => s + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  const names = ['position', 'normal', 'skinIndex', 'skinWeight'];
  for (const name of names) {
    const first = nonIndexed[0].attributes[name];
    const Arr = first.array.constructor;
    const arr = new Arr(total * first.itemSize);
    let off = 0;
    for (const g of nonIndexed) {
      arr.set(g.attributes[name].array, off);
      off += g.attributes[name].array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, first.itemSize));
  }
  return out;
}
