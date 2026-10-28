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
// And on the finished motion (arm added, both-way grips, cleanTake), what
// ends up in the saved GLB:
//   fjump  finger bones turning more than 15 deg in one frame
//   fflip  the hand turning more than 45 deg in one frame
//   asnap  the forearm turning more than 20 deg in one frame with the wrist still
//   topen  (marks only, for regress.mjs issues) frames where the thumb looks open
//   wdis   (marks only) frames whose palm faces the other way from MediaPipe's world reading
//   bentpic (marks only) fingers straight and full length in the picture but bent
//          past 60 deg (middle + end joints) in the solved hand: a bend the picture rules out
//   openpic (marks only) fingers whose tip lies back past the knuckle toward the wrist in
//          the picture but bent under 60 deg (middle + end joints): only a folded finger does that
//   pstill (marks only) a finger's middle + end joints changing more than 60 deg in
//          one frame while the finger holds still in the picture: a depth misread
//   unsure frames the tracker had to guess, by reason, each kept with where the
//          hand was so the guesses say what data to collect next (--unsure):
//            facing   both mirror poses of the palm fit and no rule decided (lift.js)
//            hidden   fingers hidden and no grip shape fits the seen ones (gripPrior.js)
//            arm      no elbow seen and no arm pose near this hand (armPrior.js)
//            together a hand hidden behind the other, placed from the frames around (togetherPass.js)
// --live replays with the grip chosen frame by frame only, as the live view does;
// by default the take is replayed twice, the second time with the grips chosen
// over the whole take (gripPrior.js planGrips), as a filmed take is.
import fs from 'fs';
import path from 'path';
import { overlaps, palmFrame, palmDepth, RADIUS } from '../src/collide.js';
import { BODY, bodyPoints, separateThumb, separateFrames, separateHands, handsDepth } from '../src/handBody.js';
import * as THREE from 'three';
import { HandTracker, chirality, dedupe, resolveSides, insideBox, INSIDE } from '../src/tracker.js';
import { liftToPicture } from '../src/lift.js';
import { clampBack, handBack } from '../src/clampBack.js';
import { objectForHand, objectOcclusion, HeldObject } from '../src/objects.js';
import { HandRig, handFrameQuat } from '../src/handRig.js';
import { HandSolver } from '../src/solver.js';
import { ArmRig } from '../src/arm.js';
import { cleanTake } from '../src/cleanTake.js';
import { restLandmarks } from '../src/skeleton.js';
import { expandPose, poseElbowAR, lineElbow } from '../src/elbowHint.js';
import { planGrips, objectSize, heldFamily, GraspPrior, HIDDEN_MIN, FIT_MAX } from '../src/gripPrior.js';
import { planMirrors } from '../src/mirrorPlan.js';
import { unpackPicture } from '../src/jointCube.js';

const FLIP = (45 * Math.PI) / 180;
const JUMP = 30;
const NEAR = 0.15; // wrist distance in the picture that still counts as the same hand
const F_JUMP = 15;
const F_FLIP = 45;
const A_SNAP = 20;
const A_STILL = 0.03;
const PIERCE = 0.008;
// pierce and ppierce are counted on the drawn and saved model's bones (handBody.js).
const BODY_SIZE = Math.hypot(...BODY.right.base.middle) / 0.09; // m of two fingers' bones inside each other: one passing through the other
const P_STILL = 60; // degrees of middle + end joint change in one frame...
const P_STILL_PIC = 0.12; // ...with the finger's middle joint and tip moving under this (palm lengths) in the picture
const BENT_PIC = 60; // degrees of middle + end joint bend a finger straight in the picture cannot have
const STRAIGHT = 0.95; // picture chain this close to a line...
const FULL = 0.8; // ...and this long against the palm (not pointing at the camera)
const FINGERS4 = { index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };
// Fingers the picture shows straight: [finger, 1] for each.
function straightInPicture(lm, aspect) {
  const p = (i) => [lm[i].x * aspect, lm[i].y];
  const d = (a, b) => Math.hypot(p(a)[0] - p(b)[0], p(a)[1] - p(b)[1]);
  const palm = d(0, 9);
  const out = [];
  for (const [key, c] of Object.entries(FINGERS4)) {
    const path = d(c[0], c[1]) + d(c[1], c[2]) + d(c[2], c[3]);
    const line = d(c[0], c[3]);
    if (line > STRAIGHT * path && line > FULL * palm) out.push([key, 1]);
  }
  return out;
}
const BEHIND = 0.05; // palm lengths the tip must lie back past the knuckle
// Fingers the picture shows folded: the tip back past the knuckle, toward the wrist.
// Each finger's middle joint and tip in the picture, from the wrist, in palm lengths.
function pictureFingers(lm, aspect) {
  const p = (i) => [lm[i].x * aspect, lm[i].y];
  const palm = Math.hypot(p(9)[0] - p(0)[0], p(9)[1] - p(0)[1]) || 1;
  return [[6, 8], [10, 12], [14, 16], [18, 20]].map((js) => js.map((j) => [(p(j)[0] - p(0)[0]) / palm, (p(j)[1] - p(0)[1]) / palm]));
}

function foldedInPicture(lm, aspect) {
  const p = (i) => [lm[i].x * aspect, lm[i].y];
  const palm = Math.hypot(p(9)[0] - p(0)[0], p(9)[1] - p(0)[1]);
  const out = [];
  for (const [key, c] of Object.entries(FINGERS4)) {
    const a = [p(c[0])[0] - p(0)[0], p(c[0])[1] - p(0)[1]];
    const la = Math.hypot(...a) || 1;
    const s = ((p(c[3])[0] - p(c[0])[0]) * a[0] + (p(c[3])[1] - p(c[0])[1]) * a[1]) / la;
    if (la > 0.5 * palm && s < -BEHIND * palm) out.push(key);
  }
  return out;
}
const ARM_TRUST = 0.1; // arm-pose prior trust below this, with no elbow seen, is a guess
const GRASP = new GraspPrior();

// Where a hand is and which way its palm faces, in words, for the unsure list.
const facing = (n) => {
  const [x, y, z] = n;
  const a = [Math.abs(x), Math.abs(y), Math.abs(z)];
  const i = a.indexOf(Math.max(...a));
  return i === 0 ? (x > 0 ? 'palm-right' : 'palm-left') : i === 1 ? (y > 0 ? 'palm-up' : 'palm-down') : z > 0 ? 'palm-to-face' : 'palm-away';
};
const where = (p) => `${Math.round(p.x * 10) * 10}x ${Math.round(p.y * 10) * 10}y ${Math.round(-p.z * 10) * 10}fwd cm`;

// Where the app puts the wrist in first person (main.js fromMediaPipe, AR):
// on its camera ray, at the distance where the model's palm covers the hand.
const LONG_FOV = (66 * Math.PI) / 180;
const focalW = (aspect) => (Math.max(1, 1 / aspect) * 0.5) / Math.tan(LONG_FOV / 2);
const SEGS = [[0, 5], [0, 9], [0, 17], [5, 17], [5, 9], [9, 17]];
const REST = restLandmarks('right');
const MODEL_PALM = Object.fromEntries(SEGS.map(([i, j]) => [`${i}-${j}`, Math.hypot(...[0, 1, 2].map((c) => REST[i][c] - REST[j][c]))]));
function anchorOf(h, aspect) {
  const F = focalW(aspect);
  let z = Infinity;
  for (const [i, j] of SEGS) {
    const a = h.landmarks[i];
    const c = h.landmarks[j];
    z = Math.min(z, (F * MODEL_PALM[`${i}-${j}`]) / Math.max(Math.hypot(c.x - a.x, (c.y - a.y) / aspect), 1e-3));
  }
  z = THREE.MathUtils.clamp(z, 0.18, 1.2);
  const ray = (p) => new THREE.Vector3((p.x - 0.5) / F, -((p.y - 0.5) / aspect) / F, -1);
  return { anchor: ray(h.landmarks[0]).multiplyScalar(z), z, ray };
}
const qangle = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])))) * (180 / Math.PI);

export function readTake(file) {
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

export function replay(take, { live = false, keep = false } = {}) {
  if (live) return pass(take, null, null, keep);
  const logs = { left: [], right: [], mirror: { left: [], right: [] } };
  pass(take, null, logs);
  const plans = { left: planGrips(logs.left), right: planGrips(logs.right) };
  // Palm facing, chosen over the whole take as a filmed take is (mirrorPlan.js).
  plans.mirror = { left: planMirrors(fill(logs.mirror.left, take)), right: planMirrors(fill(logs.mirror.right, take)) };
  return pass(take, plans, null, keep);
}

const fill = (a, take) => take.frames.map((_, i) => a[i] || null);

function pass(take, plans, logs = null, keep = false) {
  const tracker = Object.create(HandTracker.prototype);
  tracker.tracks = [];
  const solvers = { left: new HandSolver(new HandRig('left')), right: new HandSolver(new HandRig('right')) };
  const memory = { left: {}, right: {} };
  const held = { left: new HeldObject(), right: new HeldObject() };
  const last = { left: null, right: null };
  const stillPic = {};
  const arms = { left: new ArmRig('left'), right: new ArmRig('right') };
  arms.left.follow = arms.right.follow = true;
  const made = take.frames.map((f) => ({ t: f.t, hands: { left: null, right: null } }));
  const out = { frames: 0, swap: 0, flip: 0, jump: 0, grip: 0, gsw: 0, gjump: 0, fjump: 0, fflip: 0, asnap: 0, unsure: { facing: 0, hidden: 0, arm: 0, together: 0 }, guesses: [], events: [], marks: [] };
  const guess = (t, side, reason, about, extra = null) => {
    out.unsure[reason]++;
    out.guesses.push({ t, side, reason, about, ...extra });
    out.marks.push({ t, side, kind: 'unsure', n: 1 });
  };
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
    dedupe(hands);
    tracker.keepSides(hands, t * 1000, take.swap, take.firstPerson ? take.aspect : 0);
    resolveSides(hands, take.rightOnImageRight !== take.swap);
    if (hands.length) out.frames++;
    // inside (marks only): a hand kept although its picture box lies within
    // the other hand's box, as a second reading of one hand does (user GLB
    // 2026-10-27 20:47, a "left" hand read on top of the right one).
    if (hands.length === 2 && insideBox(hands[0].landmarks, hands[1].landmarks) >= INSIDE) out.marks.push({ t, side: 'both', kind: 'inside', n: 1 });
    for (const h of hands) {
      const w = h.landmarks[0];
      const before = prevHands.find((p) => Math.hypot(p.x - w.x, p.y - w.y) < NEAR);
      if (before && before.side !== h.side) {
        out.swap++;
        out.events.push(`${t.toFixed(2)}s swap ${before.side}->${h.side}`);
        out.marks.push({ t, side: h.side, kind: 'swap', n: 1 });
      }
    }
    const seen = new Set();
    for (const h of hands) {
      const side = h.side;
      if (seen.has(side)) continue;
      seen.add(side);
      memory[side].want = (plans && plans.mirror && plans.mirror[side][fi]) || null;
      const raw = liftToPicture(h.world, h.landmarks, take.aspect, side, memory[side], take.firstPerson);
      if (logs) logs.mirror[side][fi] = raw.mirror || null;
      const P = raw.map((p) => new THREE.Vector3(p.x, -p.y, -p.z));
      // wdis (marks only): the palm placed facing the other way from the
      // world reading, for issues about the palm bouncing back while it turns.
      const wv = (i) => new THREE.Vector3(h.world[i].x, h.world[i].y, h.world[i].z);
      const rv = (i) => new THREE.Vector3(raw[i].x, raw[i].y, raw[i].z);
      const nW = wv(5).sub(wv(0)).cross(wv(17).sub(wv(0)));
      const nR = rv(5).sub(rv(0)).cross(rv(17).sub(rv(0)));
      if (nW.dot(nR) < 0) out.marks.push({ t, side, kind: 'wdis', n: 1 });
      // The same object handling as main.js fromMediaPipe.
      const vision = held[side].update(objectForHand(f.objects, h, take.aspect), t);
      const occluded = vision && vision.box ? objectOcclusion(h.landmarks, vision.box, raw.occluded) : raw.occluded || null;
      const prev = last[side];
      if (!prev || t - prev.t > 0.6) solvers[side].reset();
      const opts = { limits: true, fit: true, occluded, cup: raw.cup || 0, held: heldFamily(vision), heldSize: objectSize(vision), smoothing: false };
      if (plans) opts.plan = plans[side][fi] || null;
      // The app's picture model readings, kept in takes from v93 on.
      if (f.picture && f.picture[side] && !process.env.NOPIC) opts.picture = unpackPicture(f.picture[side]);
      const res = solvers[side].solve(P, opts);
      // As the app's drawn hand does after its contact passes (realHand.js).
      if (!process.env.NOSEP) separateThumb(solvers[side].rig);
      if (logs) logs[side][fi] = solvers[side].gripIn;
      const gin = solvers[side].gripIn;
      if (!logs && gin) {
        const hid = Object.keys(gin.hidden).filter((k) => Math.max(...gin.hidden[k]) >= HIDDEN_MIN);
        const g = plans && plans[side][fi];
        const off = g ? GRASP.misfit(g, gin.reading, gin.hidden) : Infinity;
        if (hid.length && !(off <= FIT_MAX)) {
          // The nearest shape in the data, to say what shape is missing.
          let near = g;
          let d = off;
          if (!g) for (const c of GRASP.family(gin.shape)) {
            const m = GRASP.misfit(c, gin.reading, gin.hidden);
            if (m < d) [near, d] = [c, m];
          }
          // The seen fingers in words: the shape the data lacks.
          const seenF = Object.keys(gin.hidden).filter((k) => !hid.includes(k)).map((k) => {
            const a = gin.reading[k];
            const bend = k === 'thumb' ? (a[3] + a[6]) / 2 : (a[0] + a[3] + a[4]) / 3;
            return `${k} ${bend < 25 ? 'straight' : bend < 60 ? 'bent' : 'curled'}`;
          });
          guess(t, side, 'hidden', `${hid.join('+')} hidden; seen ${seenF.join(', ') || 'none'}${gin.shape ? `; holding ${gin.shape}` : ''}${near ? `; nearest ${near.id} ${Math.round(d)} deg off` : ''}`, { reading: gin.reading, hidden: gin.hidden, near: near && near.id });
        }
      }
      const rig = solvers[side].rig;
      const { anchor, z, ray } = anchorOf(h, take.aspect);
      rig.group.position.copy(anchor);
      // The elbow the app saw: pose model, else the forearm's line (takes from v65 keep both).
      const lines = f.lines && f.lines[side];
      const elbow = poseElbowAR(expandPose(f.pose), h, z, ray) || (lines ? lineElbow(lines, h, P, anchor, ray, take.aspect, arms[side]) : null);
      arms[side].update(anchor, rig.wrist.quaternion, elbow);
      const m = arms[side].measure(rig.wrist.quaternion);
      // The palm as placed, and its mirror in depth (the other pose the picture fits).
      const palmN = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.wrist.quaternion).toArray();
      if (!logs && raw.mirror && raw.mirror.unsure) guess(t, side, 'facing', `${where(anchor)}, ${facing(palmN)} or ${facing([palmN[0], palmN[1], -palmN[2]])}`);
      if (!logs && !elbow && arms[side].priorTrust < ARM_TRUST) guess(t, side, 'arm', `${where(anchor)}, ${facing(palmN)}`);
      made[fi].hands[side] = { wrist: anchor.toArray(), handQ: rig.wrist.quaternion.toArray(), upperQ: m.upperArmQuat, foreQ: m.forearmQuat, elbow: m.elbow, shoulder: m.shoulder, fingers: rig.getPose().bones, cup: [rig.cup || 0] };
      for (const [key, n] of straightInPicture(h.landmarks, take.aspect)) {
        const a = res.angles[key];
        if (a[1].flex + a[2].flex > BENT_PIC) out.marks.push({ t, side, kind: 'bentpic', n });
      }
      for (const key of foldedInPicture(h.landmarks, take.aspect)) {
        const a = res.angles[key];
        if (a[1].flex + a[2].flex < BENT_PIC) out.marks.push({ t, side, kind: 'openpic', n: 1 });
      }
      // pstill (marks only): a bend change the picture does not show.
      {
        const pic = pictureFingers(h.landmarks, take.aspect);
        const lp = last[side];
        if (lp && lp.pic && t - lp.t < 0.05) {
          for (const [n, key] of ['index', 'middle', 'ring', 'pinky'].entries()) {
            const a = res.angles[key];
            const bend = a[1].flex + a[2].flex;
            const moved = Math.max(...pic[n].map((v, i) => Math.hypot(v[0] - lp.pic[n][i][0], v[1] - lp.pic[n][i][1])));
            if (Math.abs(bend - lp.bends[n]) > P_STILL && moved < P_STILL_PIC) out.marks.push({ t, side, kind: 'pstill', n: 1, about: `${key} ${Math.round(lp.bends[n])} -> ${Math.round(bend)}${lp.grip !== (solvers[side].gripName || '') ? ' grip changed' : ''}${(lp.label || '') !== ((vision && (vision.label || vision.type)) || '') ? ' object changed' : ''}${vision ? ' object ' + (vision.label || vision.type) : ''}` });
          }
        }
        stillPic[side] = { pic, bends: ['index', 'middle', 'ring', 'pinky'].map((key) => res.angles[key][1].flex + res.angles[key][2].flex) };
      }
      // pierce (marks only): fingers of the solved hand inside each other.
      {
        // ppierce (marks only): a finger sunk into the palm.
        const L = bodyPoints(rig).map((v) => v.toArray());
        const toPalm = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.wrist.quaternion).toArray();
        const pf = palmFrame(L[0], L[5], L[17], L[9], toPalm);
        for (const [key, idx] of [['thumb', [3, 4]], ['index', [7, 8]], ['middle', [11, 12]], ['ring', [15, 16]], ['pinky', [19, 20]]]) {
          const deep = Math.max(...idx.map((i) => palmDepth(L[i], RADIUS[key] * BODY_SIZE, pf, BODY_SIZE)));
          if (deep > PIERCE) out.marks.push({ t, side, kind: 'ppierce', n: 1, about: `${key} ${Math.round(deep * 1000)}mm` });
        }
      }
      for (const o of overlaps(bodyPoints(rig), BODY_SIZE, PIERCE)) out.marks.push({ t, side, kind: 'pierce', n: 1, about: `${o.a}-${o.b} ${Math.round(o.depth * 1000)}mm bones ${o.bones.join('/')}` });
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
      last[side] = { t, q, flex, grip, label: (vision && (vision.label || vision.type)) || '', ...stillPic[side] };
    }
    prevHands = hands.map((h) => ({ x: h.landmarks[0].x, y: h.landmarks[0].y, side: h.side }));
  });
  if (logs) for (const side of ['left', 'right']) for (let i = 0; i < take.frames.length; i++) logs[side][i] ||= null;
  else {
    let motion = process.env.NOSEP ? cleanTake(made) : separateFrames(cleanTake(made), (side) => new HandRig(side));
    if (!process.env.NOHANDS) motion = Object.assign(separateHands(motion, (side) => new HandRig(side)), { together: motion.together });
    motion = Object.assign(clampBack(motion, (side) => new HandRig(side)), { together: motion.together });
    out.together = motion.together;
    for (const t of motion.together.times) guess(t, 'both', 'together', 'one hand behind the other');
    finished(motion, out);
    if (keep) out.motion = motion; // the finished frames, for a closer look at one take
  }
  return out;
}

// Counts on the finished motion; each event is also kept with its time (marks)
// so a known problem can be checked in its own stretch of a take (regress.mjs).
const T_OPEN = 0.45; // thumb tip this many palm lengths off the index knuckle looks open
const thumbRigs = {};
function thumbGap(side, fingers) {
  const rig = (thumbRigs[side] ||= new HandRig(side));
  for (const chain of Object.values(rig.chains)) for (const l of chain) if (fingers[l.bone.name]) l.bone.quaternion.fromArray(fingers[l.bone.name]);
  const L = rig.landmarkPositions();
  return L[4].distanceTo(L[5]) / L[0].distanceTo(L[9]);
}

const handRigs = {};
function finished(frames, out) {
  // hpierce (marks only): one hand inside the other on the drawn model by
  // more than PIERCE.
  handRigs.left ||= new HandRig('left');
  handRigs.right ||= new HandRig('right');
  for (const f of frames) {
    const { left, right } = f.hands;
    if (!left || !right || !left.fingers || !right.fingers) continue;
    const r = handsDepth(handRigs, left, right);
    if (r.depth > PIERCE) out.marks.push({ t: f.t, side: 'both', kind: 'hpierce', n: 1, about: `${Math.round(r.depth * 1000)}mm` });
  }
  // back (marks only): a finger joint past its backward limit in the
  // finished take (clampBack.js runs last, so any is a bug).
  for (const f of frames) for (const side of ['left', 'right']) {
    const h = f.hands[side];
    if (h && h.fingers && handBack(h, side, handRigs[side])) out.marks.push({ t: f.t, side, kind: 'back', n: 1 });
  }
  // topen (marks only): frames whose thumb looks open, for issues about a
  // folded thumb shown open in one stretch of a take.
  for (const f of frames) for (const side of ['left', 'right']) {
    const h = f.hands[side];
    if (h && thumbGap(side, h.fingers) > T_OPEN) out.marks.push({ t: f.t, side, kind: 'topen', n: 1 });
  }
  for (let i = 1; i < frames.length; i++) {
    for (const side of ['left', 'right']) {
      const a = frames[i - 1].hands[side];
      const b = frames[i].hands[side];
      if (!a || !b) continue;
      const t = frames[i].t;
      let n = 0;
      for (const k of Object.keys(b.fingers)) if (a.fingers[k] && qangle(a.fingers[k], b.fingers[k]) > F_JUMP) n++;
      if (n) out.marks.push({ t, side, kind: 'fjump', n });
      out.fjump += n;
      if (qangle(a.handQ, b.handQ) > F_FLIP) {
        out.fflip++;
        out.marks.push({ t, side, kind: 'fflip', n: 1 });
      }
      const still = Math.hypot(...a.wrist.map((v, c) => v - b.wrist[c])) < A_STILL;
      if (still && Math.max(qangle(a.foreQ, b.foreQ), qangle(a.upperQ, b.upperQ)) > A_SNAP) {
        out.asnap++;
        out.marks.push({ t, side, kind: 'asnap', n: 1 });
      }
    }
  }
}

export function files(args) {
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
  const showUnsure = args.includes('--unsure');
  const live = args.includes('--live');
  const total = { takes: 0, frames: 0, swap: 0, flip: 0, jump: 0, grip: 0, gsw: 0, gjump: 0, fjump: 0, fflip: 0, asnap: 0, unsure: { facing: 0, hidden: 0, arm: 0, together: 0 } };
  const wanted = {};
  // Score-only takes stay out of the data list (choosing data from them would
  // tune on them), and a clip replayed under several file names counts once.
  const splitFile = path.join(path.dirname(new URL(import.meta.url).pathname), 'regress-split.json');
  const split = fs.existsSync(splitFile) ? JSON.parse(fs.readFileSync(splitFile, 'utf8')) : {};
  const holdout = new Set(split.holdout || []);
  const copies = {};
  for (const names of Object.values(split.videos || {})) for (const n of names) copies[n] = names.length;
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
    for (const k of ['frames', 'swap', 'flip', 'jump', 'grip', 'gsw', 'gjump', 'fjump', 'fflip', 'asnap']) total[k] += r[k];
    for (const k of Object.keys(total.unsure)) total.unsure[k] += r.unsure[k];
    if (!holdout.has(path.basename(file))) for (const g of r.guesses) {
      const key = `${g.reason}: ${g.side} ${dataKey(g)}`;
      wanted[key] = (wanted[key] || 0) + 1 / (copies[path.basename(file)] || 1);
    }
    if (!asJson) {
      console.log(`${path.basename(file).padEnd(28)} frames ${String(r.frames).padStart(5)}  swap ${String(r.swap).padStart(3)}  flip ${String(r.flip).padStart(4)}  jump ${String(r.jump).padStart(5)}  grip ${String(r.grip).padStart(4)}  gsw ${String(r.gsw).padStart(4)}  gjump ${String(r.gjump).padStart(4)} | out fjump ${String(r.fjump).padStart(5)}  fflip ${String(r.fflip).padStart(3)}  asnap ${String(r.asnap).padStart(3)}`);
      if (showEvents) for (const e of r.events) console.log(`    ${e}`);
      if (showUnsure) for (const g of stretches(r.guesses)) console.log(`    unsure ${g.from.toFixed(2)}-${g.to.toFixed(2)}s ${g.side} ${g.reason} (${g.n} frames): ${g.about}`);
    }
  }
  if (asJson) console.log(JSON.stringify({ total, rows: rows.map(({ events, marks, ...r }) => r) }, null, 1));
  else {
    console.log(`TOTAL ${total.takes} takes  frames ${total.frames}  swap ${total.swap}  flip ${total.flip}  jump ${total.jump}  grip ${total.grip}  gsw ${total.gsw}  gjump ${total.gjump} | out fjump ${total.fjump}  fflip ${total.fflip}  asnap ${total.asnap}`);
    console.log(`UNSURE hand-frames  ` + Object.entries(total.unsure).map(([k, v]) => `${k} ${v}`).join('  '));
    if (showUnsure) {
      console.log('data to collect next (most guessed first, dev takes only, frames per clip):');
      for (const [k, n] of Object.entries(wanted).sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${String(Math.round(n)).padStart(5)}  ${k}`);
    }
  }
}

// Unsure frames in a row (same hand, reason and description) as one stretch.
function stretches(guesses) {
  const out = [];
  for (const g of guesses) {
    const o = out.findLast((x) => x.side === g.side && x.reason === g.reason);
    if (o && g.t - o.to < 0.2 && dataKey(o) === dataKey(g)) {
      o.to = g.t;
      o.n++;
    } else out.push({ ...g, from: g.t, to: g.t, n: 1 });
  }
  return out.sort((a, b) => a.from - b.from);
}

// The part of a guess's description that names the missing data: for hidden
// fingers the nearest shape, else where the hand was and which way it faced.
function dataKey(g) {
  if (g.reason === 'hidden') return g.about.replace(/; nearest .*$/, '');
  return g.about;
}
