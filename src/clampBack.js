// No joint bends backward past its limit in the finished take. The solver's
// own walls are soft and leave 3 degrees, and the passes after it (contacts,
// the grip, the thumb kept out of the fingers, the hands kept apart) turn
// bones with no limits at all: user check 2026-10-27, finger knuckles 13
// degrees and the thumb's base 10 degrees past theirs toward the back of the
// hand. So the last step takes every finger bone back to its backward limit
// (flexion minimum, skeleton.js LIMITS), and the thumb's base to THUMB_BACK:
// the corner of its range where the thumb tip stays in front of the back of
// the hand (user: the thumb bends toward the palm, never past the back; at
// the old -30 / -35 corner the tip sat 16 mm behind the knuckles' plane, 4 mm
// past the skin). Only here and not in the solver's limits: there the
// narrower range made the fit jump between answers (user takes thumb_out,
// book_floor). Bending toward the palm and twist are left alone.
import * as THREE from 'three';
import { FINGERS, limitsFor, sideSign } from './skeleton.js';

const D2R = Math.PI / 180;
export const THUMB_BACK = [-20, -25]; // thumb base: least flexion, least abduction (degrees)
const e = new THREE.Euler();
const q = new THREE.Quaternion();
const inv = new THREE.Quaternion();

// One hand ({ fingers } by bone name) on its side's HandRig: the finger map
// taken back to the limits (null when nothing was past them).
export function handBack(h, side, rig) {
  let fingers = null;
  for (const finger of FINGERS) {
    rig.chains[finger.key].forEach((link, k) => {
      const name = link.bone.name;
      const v = h.fingers[name];
      if (!v) return;
      const base = finger.key === 'thumb' && k === 0;
      const [fLim, , aLim] = limitsFor(finger.key, k);
      const fMin = base ? Math.max(fLim, THUMB_BACK[0]) : fLim;
      const aMin = Math.max(aLim, THUMB_BACK[1]);
      // Local turn = rest * Euler(flex, roll, -abd * side, 'XZY') (fit.js localFrom).
      e.setFromQuaternion(inv.copy(link.restLocal).invert().multiply(q.fromArray(v)), 'XZY');
      let changed = false;
      if (e.x < fMin * D2R - 1e-4) {
        e.x = fMin * D2R;
        changed = true;
      }
      if (base && -e.z * sideSign(side) < aMin * D2R - 1e-4) {
        e.z = -aMin * D2R * sideSign(side);
        changed = true;
      }
      if (!changed) return;
      fingers ||= { ...h.fingers };
      fingers[name] = link.restLocal.clone().multiply(q.setFromEuler(e)).toArray();
    });
  }
  return fingers;
}

// frames: finished frames ({ hands: { left, right } } with fingers by bone name);
// rigFor(side): a HandRig, for the bones' rest turns. Changes the frames' hands
// in place (copies of the finger maps) and returns the frames.
export function clampBack(frames, rigFor) {
  const rigs = { left: rigFor('left'), right: rigFor('right') };
  for (const f of frames) {
    for (const side of ['left', 'right']) {
      const h = f.hands && f.hands[side];
      if (!h || !h.fingers) continue;
      const fingers = handBack(h, side, rigs[side]);
      if (fingers) f.hands[side] = { ...h, fingers };
    }
  }
  return frames;
}
