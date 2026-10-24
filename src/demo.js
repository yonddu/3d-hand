// Synthetic landmark source: animates a hidden reference hand through a set of
// gestures, reads its 21 joint positions and adds jitter. The result goes
// through the exact same filter + solver pipeline as camera landmarks, so the
// demo exercises the real code path without a camera.
import * as THREE from 'three';
import { FINGERS, sideSign } from './skeleton.js';
import { HandRig } from './handRig.js';

const D2R = Math.PI / 180;

// Per gesture: thumb [cmcFlex, cmcAbd, mcp, ip], fingers [mcp, spread, pip, dip],
// wrist [pitch, yaw, roll] in degrees.
const GESTURES = [
  { name: '편 손', thumb: [0, 10, 5, 5], f: [[0, -6, 0, 0], [0, 0, 0, 0], [0, 6, 0, 0], [0, 12, 0, 0]], wrist: [0, 0, 0] },
  { name: '주먹', thumb: [35, -10, 50, 60], f: [[88, 0, 100, 70], [90, 0, 105, 72], [90, 0, 105, 70], [88, 0, 100, 68]], wrist: [10, 0, 0] },
  { name: '가리키기', thumb: [30, -5, 40, 40], f: [[0, 0, 0, 0], [88, 0, 105, 70], [90, 0, 105, 70], [88, 0, 100, 68]], wrist: [-5, 20, 0] },
  { name: '브이', thumb: [35, -10, 45, 50], f: [[0, -10, 0, 0], [0, 10, 0, 0], [88, 0, 105, 70], [88, 0, 100, 68]], wrist: [0, -15, 10] },
  { name: '귀신 손', thumb: [10, 30, 20, 50], f: [[-20, -14, 85, 70], [-22, 0, 95, 75], [-20, 10, 95, 75], [-18, 20, 90, 72]], wrist: [-30, 0, -15] },
  { name: '집기', thumb: [40, 20, 25, 25], f: [[45, 0, 40, 25], [60, 0, 80, 50], [75, 0, 95, 60], [80, 0, 95, 60]], wrist: [15, 25, 0] },
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
    return { a, b, k, name: k < 0.5 ? a.name : b.name };
  }

  // Returns [{ side, world: Vector3[21], anchor: Vector3, gesture }]
  frame(t) {
    return ['left', 'right'].map((side, si) => {
      const rig = this.rigs[side];
      const s = sideSign(side);
      const { a, b, k, name } = this.gestureAt(t, si * 0.9);
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
      return { side, world: P, anchor, gesture: name };
    });
  }
}

function gauss() {
  return (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
}
