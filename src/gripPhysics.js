// What a hand shape can hold, worked out from its geometry.
//
// A grip is not a picture to match but a hand closed on something: fingers
// wrapped round a handle curve with the handle, and a thumb pinching a page
// or a book meets the fingers across its thickness. Each dictionary shape is
// posed on the hand model once and measured:
//   curl  radius (mm) of the circle the bent fingers follow; wrapped round a
//         cylinder or ball, the finger pads lie on it, so the object is about
//         2 * (curl - PAD) across
//   gap   distance (mm) from the thumb tip to the nearest finger pad; an
//         object pinched between them is about gap - PAD thick
// A grip whose fingers would pass through the object, or never touch it, does
// not fit it, however alike the seen fingers look.
//
// The approach bounds the size. Reaching for something, a hand opens wider
// than the object and closes on it; the widest opening grows with the object
// (about 0.8 x its size + 20 mm in reach-to-grasp studies). A hand may open
// wide for a small thing, but never less than the thing it then holds, so the
// widest opening seen on the way in caps the object's size.
import { HandRig } from './handRig.js';
import { applyGesture } from './gestures.js';

const PAD = 8; // mm of finger pad between bone line and object surface (each side ~ half of PAD * 2 for a pinch)
const FIST = 25; // mm: the hollow of a closed hand
const MGA_SLOPE = 0.8;
const MGA_OFFSET = 20; // mm
const REACH_MARGIN = 1.3; // people open wider for some objects than others; only clearly too-big sizes are ruled out
const cache = new Map();
let rig = null;

function circleR(a, b, c) {
  const A = a.distanceTo(b);
  const B = b.distanceTo(c);
  const C = c.distanceTo(a);
  const s = (A + B + C) / 2;
  const area = Math.sqrt(Math.max(1e-12, s * (s - A) * (s - B) * (s - C)));
  return (A * B * C) / (4 * area);
}

function segDist(p, a, b) {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq()));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

// { curl, gap } in mm for a dictionary shape.
export function gripGeometry(g) {
  let geo = cache.get(g.id);
  if (geo) return geo;
  rig ||= new HandRig('right');
  applyGesture(rig, g);
  const P = rig.landmarkPositions();
  const curls = [5, 9, 13].map((m) => Math.min(circleR(P[m], P[m + 1], P[m + 2]), circleR(P[m + 1], P[m + 2], P[m + 3])) * 1000).sort((x, y) => x - y);
  const gap = Math.min(segDist(P[4], P[6], P[7]), segDist(P[4], P[7], P[8]), segDist(P[4], P[10], P[11]), segDist(P[4], P[11], P[12])) * 1000;
  geo = { curl: curls[1], gap };
  cache.set(g.id, geo);
  return geo;
}

// How badly a shape's geometry suits an object of this shape and size (mm),
// in log size ratio; Infinity when the shape cannot hold it at all.
export function contactMisfit(g, shape, size) {
  const { curl, gap } = gripGeometry(g);
  const err = (d) => (d > 0 ? Math.abs(Math.log(d / size)) : Infinity);
  // A closed fist holds anything thinner than its own hollow the same way.
  const dw = 2 * (curl - PAD);
  const wrap = curl >= 90 ? Infinity : dw <= FIST ? Math.max(0, Math.log(size / FIST)) : err(dw);
  const pinch = err(Math.max(1, gap - 2 * PAD * 0.6));
  if (shape === 'box' || shape === 'book') return pinch; // flat: held across its thickness
  return Math.min(wrap, pinch);
}

// How far (log ratio) even the smallest object this shape could hold is
// bigger than `bound` mm: a hand cannot close on something wider than it
// opened for on the way in.
export function contactOver(g, shape, bound) {
  const { curl, gap } = gripGeometry(g);
  const sizes = [Math.max(1, gap - 2 * PAD * 0.6)];
  if (curl < 90 && shape !== 'box' && shape !== 'book') sizes.push(Math.max(1, 2 * (curl - PAD) <= FIST ? 1 : 2 * (curl - PAD)));
  return Math.max(0, Math.log(Math.min(...sizes) / bound));
}

// The largest object (mm) a reach could have been for, from the hand's opening (thumb
// tip to index tip, mm) on the way in; null when the frames show no reach.
export function reachBound(openings, closing) {
  const seen = openings.filter((v) => Number.isFinite(v));
  if (seen.length < 3) return null;
  const widest = Math.max(...seen);
  // Opened wider than it started, then closed on something: a reach. A hand
  // that only closes from rest says nothing about the size.
  if (widest - seen[0] < 10 || widest - closing < 10) return null;
  return Math.max(5, ((widest - MGA_OFFSET) / MGA_SLOPE) * REACH_MARGIN);
}
