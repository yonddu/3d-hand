// Synthetic landmark source: animates a hidden reference hand through a set of
// gestures, reads its 21 joint positions and adds jitter. The result goes
// through the exact same filter + solver pipeline as camera landmarks, so the
// demo exercises the real code path without a camera.
import * as THREE from 'three';
import { FINGERS, sideSign } from './skeleton.js';
import { HandRig } from './handRig.js';
import { CATALOG, measure } from './objects.js';

const D2R = Math.PI / 180;

// Per gesture: thumb [cmcFlex, cmcAbd, mcp, ip], fingers [mcp, spread, pip, dip],
// wrist [pitch, yaw, roll] in degrees.
const GESTURES = [
  { name: '편 손', thumb: [0, 10, 5, 5], f: [[0, -6, 0, 0], [0, 0, 0, 0], [0, 6, 0, 0], [0, 12, 0, 0]], wrist: [0, 0, 0] },
  { name: '주먹', thumb: [35, -10, 50, 60], f: [[88, 0, 100, 70], [90, 0, 105, 72], [90, 0, 105, 70], [88, 0, 100, 68]], wrist: [10, 0, 0] },
  { name: '가리키기', thumb: [30, -5, 40, 40], f: [[0, 0, 0, 0], [88, 0, 105, 70], [90, 0, 105, 70], [88, 0, 100, 68]], wrist: [-5, 20, 0] },
  { name: '브이', thumb: [35, -10, 45, 50], f: [[0, -10, 0, 0], [0, 10, 0, 0], [88, 0, 105, 70], [88, 0, 100, 68]], wrist: [0, -15, 10] },
  { name: '갈고리 손', thumb: [10, 30, 20, 50], f: [[-20, -14, 85, 70], [-22, 0, 95, 75], [-20, 10, 95, 75], [-18, 20, 90, 72]], wrist: [-30, 0, -15] },
  { name: '집기', thumb: [40, 10, 15, 0], f: [[70, 0, 40, 24], [70, 0, 90, 60], [80, 0, 95, 60], [85, 0, 95, 60]], wrist: [15, 25, 0] },
  // `holds`: what a camera would recognize in this grip, [class, long side, short side] in meters.
  { name: '컵 쥐기', holds: ['cup', 0.1, 0.075], thumb: [35, 35, 20, 25], f: [[50, -4, 62, 32], [52, 0, 64, 34], [55, 3, 66, 36], [58, 6, 70, 38]], wrist: [0, 10, 0] },
  { name: '공 쥐기', holds: ['orange', 0.078, 0.074], thumb: [25, 40, 10, 15], f: [[30, -16, 40, 28], [32, -4, 42, 30], [32, 6, 42, 30], [30, 18, 40, 28]], wrist: [-10, 0, 0] },
  { name: '폰 쥐기', holds: ['cell phone', 0.15, 0.072], thumb: [20, 25, 10, 10], f: [[40, 0, 45, 20], [42, 0, 48, 22], [44, 0, 50, 24], [46, 0, 52, 26]], wrist: [-15, 0, 10] },
  { name: '펜 쥐기', holds: ['toothbrush', 0.15, 0.012], thumb: [40, 10, 15, 0], f: [[62, 0, 38, 20], [70, 0, 70, 45], [80, 0, 95, 60], [85, 0, 95, 60]], wrist: [10, 20, 0] },
];

const ease = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

export class DemoSource {
  constructor() {
    this.rigs = { left: new HandRig('left'), right: new HandRig('right') };
    this.hold = 1.1; // seconds per gesture
    this.blend = 0.7;
  }

  gestureAt(t, phase) {
    const period = this.hold + this.blend;
    const x = (t + phase) / period;
    const i = Math.floor(x) % GESTURES.length;
    const local = (x - Math.floor(x)) * period;
    const k = local < this.hold ? 0 : ease((local - this.hold) / this.blend);
    const a = GESTURES[i];
    const b = GESTURES[(i + 1) % GESTURES.length];
    const g = k < 0.5 ? a : b;
    return { a, b, k, name: g.name, holds: g.holds };
  }

  // Returns [{ side, world: Vector3[21], anchor: Vector3, gesture }]
  frame(t) {
    return ['left', 'right'].map((side, si) => {
      const rig = this.rigs[side];
      const s = sideSign(side);
      const { a, b, k, name, holds } = this.gestureAt(t, si * 0.9);
      const mix = (arrA, arrB) => arrA.map((v, j) => lerp(v, arrB[j], k));

      const th = mix(a.thumb, b.thumb);
      const thumbAngles = [[th[0], th[1]], [th[2], 0], [th[3], 0]];
      FINGERS.forEach((finger, fi) => {
        const chain = rig.chains[finger.key];
        let ang;
        if (finger.key === 'thumb') ang = thumbAngles;
        else {
          const f = mix(a.f[fi - 1], b.f[fi - 1]);
          ang = [[f[0], f[1]], [f[2], 0], [f[3], 0]];
        }
        chain.forEach((link, j) => {
          const [flex, abdThumb] = ang[j];
          const e = new THREE.Euler(flex * D2R, 0, -abdThumb * s * D2R, 'XZY');
          link.bone.quaternion.copy(link.restLocal).multiply(new THREE.Quaternion().setFromEuler(e));
        });
      });

      const w = mix(a.wrist, b.wrist);
      const sway = Math.sin(t * 0.9 + si) * 8;
      // Seen from the player's eyes: backs of the hands toward the camera,
      // fingers reaching up and forward (turned 180 degrees, tilted 40).
      const reach = new THREE.Quaternion().setFromEuler(new THREE.Euler(40 * D2R, Math.PI, 0, 'YXZ'));
      const rot = new THREE.Quaternion().setFromEuler(
        new THREE.Euler((w[0] + sway * 0.5) * D2R, (w[1] * s + sway) * D2R, (w[2] * s - 8 * s) * D2R, 'YXZ'),
      );
      rig.wrist.quaternion.copy(reach).multiply(rot).multiply(rig.wristRest);

      const P = rig.landmarkPositions();
      // Camera-like jitter (~2.5 mm) so the smoothing has something to do.
      P.forEach((p) => p.add(new THREE.Vector3(gauss() * 0.0025, gauss() * 0.0025, gauss() * 0.004)));
      const anchor = new THREE.Vector3(
        0.11 * s + Math.sin(t * 0.7 + si * 2) * 0.015,
        -0.11 + Math.sin(t * 1.1 + si) * 0.01,
        -0.42,
      );
      const vision = holds ? { category: holds[0], score: 0.9, source: 'demo', ...measure(CATALOG[holds[0]], holds[1], holds[2]) } : null;
      return { side, world: P, anchor, gesture: name, vision };
    });
  }
}

function gauss() {
  return (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
}
