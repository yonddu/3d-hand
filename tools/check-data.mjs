// Checks the hand shape and arm pose dictionaries before new entries go in:
//   node tools/check-data.mjs
// Fails (exit 1) on a duplicate id or name, a movement repeating another, a movement using a hand shape that does
// not exist, or a movement key (one-arm or two-hand) outside the joint ranges (the dictionary would
// clamp it silently, distorting the pose). Reports hand shapes that repeat
// another shape exactly without saying so ({ ref }), and arm poses the
// dictionary drops as repeats.
import { GESTURES } from '../src/gestures.js';
import { ARM_POSES, ARM_ROM, RAW_ARM_COUNT } from '../src/armPoses.js';
import { MOTIONS } from '../src/armMotions.js';
import { TWO_HAND_MOTIONS, TWO_HAND_CATEGORIES, TWO_HAND_CONTACTS } from '../src/twoHandMotions.js';

const errors = [];
const warn = [];
const KEYS = ['sFlex', 'sAbd', 'hRot', 'elbow', 'pron', 'wFlex', 'wDev'];
const WRIST = { flex: 70, ext: 60, radial: 20, ulnar: 35 };
const SLACK = 0; // degrees past a range before it counts as an error
// Hand shapes that already repeat another one (different signs, same hand).
// New entries must not add to them.
const KNOWN_REPEATS = 259;

const dup = (list, what) => {
  const seen = new Set();
  for (const id of list) {
    if (seen.has(id)) errors.push(`${what}: id ${id} twice`);
    seen.add(id);
  }
};
dup(GESTURES.map((g) => g.id), 'hand shape');
dup(MOTIONS.map((m) => m[0]), 'movement');
dup(ARM_POSES.map((p) => p.id), 'arm pose');
dup(TWO_HAND_MOTIONS.map((m) => m[0]), 'two-hand movement');
// The same thing twice under another id (2026-10-26: 41 movements and 2
// hand shapes had been added again under new ids): names must be unique, and
// no movement may follow another one within NEAR_MOVE degrees on every key.
const dupName = (list, what) => {
  const seen = new Map();
  for (const [id, name] of list) {
    if (seen.has(name)) errors.push(`${what}: "${name}" is both ${seen.get(name)} and ${id}`);
    else seen.set(name, id);
  }
};
dupName(GESTURES.map((g) => [g.id, g.name]), 'hand shape');
dupName(MOTIONS.map((m) => [m[0], m[1]]), 'movement');
dupName(TWO_HAND_MOTIONS.map((m) => [m[0], m[1]]), 'two-hand movement');
const NEAR_MOVE = 8;
for (let i = 0; i < MOTIONS.length; i++) for (let j = 0; j < i; j++) {
  const a = MOTIONS[i][4];
  const b = MOTIONS[j][4];
  if (a.length === b.length && a.every((k, n) => k.every((v, c) => Math.abs(v - b[n][c]) <= NEAR_MOVE))) errors.push(`movement ${MOTIONS[i][0]} repeats ${MOTIONS[j][0]} (every key within ${NEAR_MOVE} deg)`);
}

const shapes = new Set(GESTURES.map((g) => g.id));
const checkKey = (what, k) => {
  if (k.length !== 7) errors.push(`${what}: ${k.length} angles, not 7`);
  KEYS.forEach((name, i) => {
    const [a, b] = ARM_ROM[name];
    if (k[i] < a - SLACK || k[i] > b + SLACK) errors.push(`${what}: ${name} ${k[i]} outside ${a}..${b}`);
  });
  const [f, d] = [k[5], k[6]];
  const r = Math.hypot(f / (f >= 0 ? WRIST.flex : WRIST.ext), d / (d >= 0 ? WRIST.radial : WRIST.ulnar));
  if (r > 1.15) errors.push(`${what}: wrist ${f}/${d} past its range (${r.toFixed(2)}x)`);
};
for (const [id, , , hand, keys] of MOTIONS) {
  if (!shapes.has(hand)) errors.push(`movement ${id}: hand shape ${hand} does not exist`);
  keys.forEach((k, n) => checkKey(`movement ${id} key ${n + 1}`, k));
}
// Two-hand movements: both arms in range, real hand shapes, known contact, and
// no repeat (same hands, every angle of every key within NEAR_TWO degrees).
const NEAR_TWO = 5;
for (const [id, , cat, contact, right, left, keys] of TWO_HAND_MOTIONS) {
  if (!TWO_HAND_CATEGORIES[cat]) errors.push(`two-hand movement ${id}: category ${cat} unknown`);
  if (!TWO_HAND_CONTACTS[contact]) errors.push(`two-hand movement ${id}: contact ${contact} unknown`);
  for (const h of [right, left]) if (!shapes.has(h)) errors.push(`two-hand movement ${id}: hand shape ${h} does not exist`);
  keys.forEach((k, n) => {
    checkKey(`two-hand movement ${id} key ${n + 1} right`, k[0]);
    checkKey(`two-hand movement ${id} key ${n + 1} left`, k[1]);
  });
}
for (let i = 0; i < TWO_HAND_MOTIONS.length; i++) for (let j = 0; j < i; j++) {
  const [, , , , r1, l1, a] = TWO_HAND_MOTIONS[i];
  const [, , , , r2, l2, b] = TWO_HAND_MOTIONS[j];
  if (r1 !== r2 || l1 !== l2 || a.length !== b.length) continue;
  if (a.every((k, n) => k.every((arm, s) => arm.every((v, c) => Math.abs(v - b[n][s][c]) <= NEAR_TWO)))) errors.push(`two-hand movement ${TWO_HAND_MOTIONS[i][0]} repeats ${TWO_HAND_MOTIONS[j][0]}`);
}

// Hand shapes identical to an earlier one (same angles and cupping).
const sig = new Map();
for (const g of GESTURES) {
  const s = JSON.stringify([g.h, g.cup || 0, g.touch || '']);
  if (sig.has(s)) warn.push(`${g.id} repeats ${sig.get(s)}`);
  else sig.set(s, g.id);
}

console.log(`hand shapes ${GESTURES.length}, movements ${MOTIONS.length}, two-hand movements ${TWO_HAND_MOTIONS.length}, arm poses ${ARM_POSES.length} (${RAW_ARM_COUNT - ARM_POSES.length} repeats dropped)`);
console.log(`hand shapes repeating another exactly: ${warn.length} (signs sharing a shape on purpose use { ref })`);
if (warn.length > KNOWN_REPEATS) errors.push(`${warn.length - KNOWN_REPEATS} new hand shapes repeat an existing one: ${warn.slice(KNOWN_REPEATS).join(', ')}`);
if (errors.length) {
  console.log(errors.join('\n'));
  process.exit(1);
}
console.log('ok');
