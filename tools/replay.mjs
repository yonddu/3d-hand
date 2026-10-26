// Replays recorded takes through the tracking pipeline and counts the
// failures the user sees in the review video, so a fix can be judged on every
// take at once instead of one GLB at a time.
//
//   node tools/replay.mjs <take.glb | take.json | folder> ... [--json] [--frames] [--live]
//
// Inputs: a GLB saved by the app (v53+ carries the tracker's raw readings in
// its scene extras), a take JSON, or an older raw dump ([{t, hands:[{side, lm, world}]}]).
// Counts, per take:
//   swap   a tracked hand changing side (left <-> right) from one frame to the next
//   flip   the palm turning more than 45 deg in one frame (1/30 s): a misread, not a motion
//   jump   finger joints bending more than 30 deg in one frame
//   grip   frames where hidden fingers were filled from a grip shape
//   gsw    times the grip changed (to another grip, or on/off) from one frame to the next
// --live replays with the grip chosen frame by frame only, as the live view does;
// by default the take is replayed twice, the second time with the grips chosen
// over the whole take (gripPrior.js planGrips), as a filmed take is.
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import { HandTracker, chirality, resolveSides } from '../src/tracker.js';
import { liftToPicture } from '../src/lift.js';
import { objectForHand, objectOcclusion, HeldObject } from '../src/objects.js';
import { HandRig, handFrameQuat } from '../src/handRig.js';
import { HandSolver } from '../src/solver.js';
import { planGrips, objectSize, heldFamily } from '../src/gripPrior.js';

const FLIP = (45 * Math.PI) / 180;
const JUMP = 30;
const NEAR = 0.15; // wrist distance in the picture that still counts as the same hand

function readTake(file) {
  const buf = fs.readFileSync(file);
  let data;
  if (buf.readUInt32LE(0) === 0x46546c67) {
    const len = buf.readUInt32LE(12);
    const gltf = JSON.parse(buf.slice(20, 20 + len).toString());
    const node = [...(gltf.scenes || []), ...(gltf.nodes || [])].find((n) => n.extras && n.extras.raw);
    if (!node) return null;
    data = node.extras.raw;
  } else {
    data = JSON.parse(buf.toString());
    if (data.raw) data = data.raw;
  }
  if (Array.isArray(data)) {
    // Older dumps: points as [x, y(, z)], first person portrait phone video.
    data = {
      aspect: 0.5625,
      firstPerson: true,
      swap: false,
      rightOnImageRight: true,
      frames: data.filter((f) => f.hands).map((f) => ({ t: f.t, hands: f.hands.map((h) => ({ label: h.side, score: 1, lm: h.lm.flat(), world: h.world.flat(), dims: h.lm[0].length })) })),
    };
  }
  return data;
}

const points = (flat, dims = 3) => {
  const out = [];
  for (let i = 0; i < flat.length; i += dims) out.push({ x: flat[i], y: flat[i + 1], z: dims > 2 ? flat[i + 2] : 0 });
  return out;
};

export function replay(take, { live = false } = {}) {
  if (live) return pass(take, null);
  const logs = { left: [], right: [] };
  pass(take, null, logs);
  const plans = { left: planGrips(logs.left), right: planGrips(logs.right) };
  return pass(take, plans);
}

function pass(take, plans, logs = null) {
  const tracker = Object.create(HandTracker.prototype);
  tracker.tracks = [];
  const solvers = { left: new HandSolver(new HandRig('left')), right: new HandSolver(new HandRig('right')) };
  const memory = { left: {}, right: {} };
  const held = { left: new HeldObject(), right: new HeldObject() };
  const last = { left: null, right: null };
  const out = { frames: 0, swap: 0, flip: 0, jump: 0, grip: 0, gsw: 0, gjump: 0, events: [] };
  let prevHands = [];
  take.frames.forEach((f, fi) => {
    const t = f.t;
    const hands = f.hands.map((h) => ({
      side: h.label,
      score: h.score,
      landmarks: points(h.lm, h.dims || 3),
      world: points(h.world),
    }));
    for (const h of hands) h.chiral = chirality(h.world);
    tracker.keepSides(hands, t * 1000, take.swap, take.firstPerson ? take.aspect : 0);
    resolveSides(hands, take.rightOnImageRight !== take.swap);
    if (hands.length) out.frames++;
    for (const h of hands) {
      const w = h.landmarks[0];
      const before = prevHands.find((p) => Math.hypot(p.x - w.x, p.y - w.y) < NEAR);
      if (before && before.side !== h.side) {
        out.swap++;
        out.events.push(`${t.toFixed(2)}s swap ${before.side}->${h.side}`);
      }
    }
    const seen = new Set();
    for (const h of hands) {
      const side = h.side;
      if (seen.has(side)) continue;
      seen.add(side);
      const raw = liftToPicture(h.world, h.landmarks, take.aspect, side, memory[side], take.firstPerson);
      const P = raw.map((p) => new THREE.Vector3(p.x, -p.y, -p.z));
      // The same object handling as main.js fromMediaPipe.
      const vision = held[side].update(objectForHand(f.objects, h, take.aspect), t);
      const occluded = vision && vision.box ? objectOcclusion(h.landmarks, vision.box, raw.occluded) : raw.occluded || null;
      const prev = last[side];
      if (!prev || t - prev.t > 0.6) solvers[side].reset();
      const opts = { limits: true, fit: true, occluded, cup: raw.cup || 0, held: heldFamily(vision), heldSize: objectSize(vision), smoothing: false };
      if (plans) opts.plan = plans[side][fi] || null;
      const res = solvers[side].solve(P, opts);
      if (logs) logs[side][fi] = solvers[side].gripIn;
      const q = handFrameQuat(P, side);
      const flex = [];
      for (const key of Object.keys(res.angles)) for (const a of res.angles[key]) flex.push(a.flex);
      if (prev && t - prev.t < 0.1) {
        const turn = q.angleTo(prev.q);
        if (turn > FLIP) {
          out.flip++;
          out.events.push(`${t.toFixed(2)}s flip ${side} ${Math.round((turn * 180) / Math.PI)}deg`);
        }
        const jumped = flex.filter((v, i) => Math.abs(v - prev.flex[i]) > JUMP).length;
        out.jump += jumped;
        if (solvers[side].gripName || prev.grip) out.gjump += jumped;
        if (jumped >= 3) out.events.push(`${t.toFixed(2)}s jump ${side} ${jumped} joints`);
      }
      const grip = solvers[side].gripName;
      if (grip) out.grip++;
      if (prev && t - prev.t < 0.1 && grip !== prev.grip) out.gsw++;
      last[side] = { t, q, flex, grip };
    }
    prevHands = hands.map((h) => ({ x: h.landmarks[0].x, y: h.landmarks[0].y, side: h.side }));
  });
  if (logs) for (const side of ['left', 'right']) for (let i = 0; i < take.frames.length; i++) logs[side][i] ||= null;
  return out;
}

function files(args) {
  const list = [];
  for (const a of args) {
    if (fs.statSync(a).isDirectory()) list.push(...fs.readdirSync(a).filter((f) => /\.(glb|json)$/.test(f)).sort().map((f) => path.join(a, f)));
    else list.push(a);
  }
  return list;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const showEvents = args.includes('--frames');
  const live = args.includes('--live');
  const total = { takes: 0, frames: 0, swap: 0, flip: 0, jump: 0, grip: 0, gsw: 0, gjump: 0 };
  const rows = [];
  for (const file of files(args.filter((a) => !a.startsWith('--')))) {
    const take = readTake(file);
    if (!take || !take.frames || !take.frames.length) {
      if (!asJson) console.log(`${path.basename(file)}: no raw readings (saved before v53)`);
      continue;
    }
    const r = replay(take, { live });
    rows.push({ file: path.basename(file), ...r });
    total.takes++;
    for (const k of ['frames', 'swap', 'flip', 'jump', 'grip', 'gsw', 'gjump']) total[k] += r[k];
    if (!asJson) {
      console.log(`${path.basename(file).padEnd(28)} frames ${String(r.frames).padStart(5)}  swap ${String(r.swap).padStart(3)}  flip ${String(r.flip).padStart(4)}  jump ${String(r.jump).padStart(5)}  grip ${String(r.grip).padStart(4)}  gsw ${String(r.gsw).padStart(4)}  gjump ${String(r.gjump).padStart(4)}`);
      if (showEvents) for (const e of r.events) console.log(`    ${e}`);
    }
  }
  if (asJson) console.log(JSON.stringify({ total, rows: rows.map(({ events, ...r }) => r) }, null, 1));
  else console.log(`TOTAL ${total.takes} takes  frames ${total.frames}  swap ${total.swap}  flip ${total.flip}  jump ${total.jump}  grip ${total.grip}  gsw ${total.gsw}  gjump ${total.gjump}`);
}
