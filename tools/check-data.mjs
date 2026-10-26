// Checks the hand shape and arm pose dictionaries before new entries go in:
//   node tools/check-data.mjs
// Fails (exit 1) on a duplicate id, a movement using a hand shape that does
// not exist, or a movement key outside the joint ranges (the dictionary would
// clamp it silently, distorting the pose). Reports hand shapes that repeat
// another shape exactly without saying so ({ ref }), and arm poses the
// dictionary drops as repeats.
import { GESTURES } from '../src/gestures.js';
import { ARM_POSES, ARM_ROM, RAW_ARM_COUNT } from '../src/armPoses.js';
import { MOTIONS } from '../src/armMotions.js';

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

const shapes = new Set(GESTURES.map((g) => g.id));
for (const [id, , , hand, keys] of MOTIONS) {
  if (!shapes.has(hand)) errors.push(`movement ${id}: hand shape ${hand} does not exist`);
  keys.forEach((k, n) => {
    if (k.length !== 7) errors.push(`movement ${id} key ${n + 1}: ${k.length} angles, not 7`);
    KEYS.forEach((name, i) => {
      const [a, b] = ARM_ROM[name];
      if (k[i] < a - SLACK || k[i] > b + SLACK) errors.push(`movement ${id} key ${n + 1}: ${name} ${k[i]} outside ${a}..${b}`);
    });
    const [f, d] = [k[5], k[6]];
    const r = Math.hypot(f / (f >= 0 ? WRIST.flex : WRIST.ext), d / (d >= 0 ? WRIST.radial : WRIST.ulnar));
    if (r > 1.15) errors.push(`movement ${id} key ${n + 1}: wrist ${f}/${d} past its range (${r.toFixed(2)}x)`);
  });
}

// Hand shapes identical to an earlier one (same angles and cupping).
const sig = new Map();
for (const g of GESTURES) {
  const s = JSON.stringify([g.h, g.cup || 0, g.touch || '']);
  if (sig.has(s)) warn.push(`${g.id} repeats ${sig.get(s)}`);
  else sig.set(s, g.id);
}

console.log(`hand shapes ${GESTURES.length}, movements ${MOTIONS.length}, arm poses ${ARM_POSES.length} (${RAW_ARM_COUNT - ARM_POSES.length} repeats dropped)`);
console.log(`hand shapes repeating another exactly: ${warn.length} (signs sharing a shape on purpose use { ref })`);
if (warn.length > KNOWN_REPEATS) errors.push(`${warn.length - KNOWN_REPEATS} new hand shapes repeat an existing one: ${warn.slice(KNOWN_REPEATS).join(', ')}`);
if (errors.length) {
  console.log(errors.join('\n'));
  process.exit(1);
}
console.log('ok');
