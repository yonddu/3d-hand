// Every recorded take, replayed before each release, so a problem fixed once
// stays fixed (user: "how do we stop the same problems coming back?").
//
//   node tools/regress.mjs [takes folder]          check; exit 1 on any failure
//   node tools/regress.mjs [folder] --update       lower the baseline where takes got better
//   node tools/regress.mjs [folder] --accept       take today's numbers as the baseline (after a deliberate trade-off)
//
// Two checks:
//   baseline  per take, every count replay.mjs makes; a count may not grow past
//             its baseline by more than TOL (and a little noise). The baseline
//             only moves down unless --accept is given.
//   issues    each problem the user reported, tied to its take and stretch of
//             time, with the most it may happen (regress-issues.json).
//
// Totals are printed apart for dev takes and score-only takes (regress-split.json).
import fs from 'fs';
import path from 'path';
import { replay, readTake, files } from './replay.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const BASE = path.join(DIR, 'regress-baseline.json');
const ISSUES = path.join(DIR, 'regress-issues.json');
const SPLIT = path.join(DIR, 'regress-split.json'); // score-only takes, reported apart
const METRICS = ['swap', 'flip', 'jump', 'gsw', 'fjump', 'fflip', 'asnap'];
const TOL = 0.05; // 5% ...
const NOISE = 2; // ... plus two events

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--')) || '/mnt/project-files/hand-motion-studio/takes/';
const base = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : {};
const issues = fs.existsSync(ISSUES) ? JSON.parse(fs.readFileSync(ISSUES, 'utf8')) : [];
const holdout = new Set(fs.existsSync(SPLIT) ? JSON.parse(fs.readFileSync(SPLIT, 'utf8')).holdout : []);
const results = {};
for (const file of files([folder])) {
  const take = readTake(file);
  if (!take || !take.frames || !take.frames.length) continue;
  results[path.basename(file)] = replay(take);
}

const fails = [];
const lines = [];
for (const [name, r] of Object.entries(results)) {
  const b = base[name];
  if (!b) {
    lines.push(`${name}: new take, no baseline yet`);
    continue;
  }
  for (const m of METRICS) {
    if (b[m] === undefined) continue;
    const limit = Math.floor(b[m] * (1 + TOL) + NOISE);
    if (r[m] > limit) fails.push(`${name}: ${m} ${r[m]} > ${limit} (baseline ${b[m]})`);
    else if (r[m] < b[m]) lines.push(`${name}: ${m} ${b[m]} -> ${r[m]} (better)`);
  }
}
for (const name of Object.keys(base)) if (!results[name]) fails.push(`${name}: take missing from ${folder}`);

for (const is of issues) {
  const r = results[is.take];
  if (!r) {
    fails.push(`[${is.id}] ${is.take} missing`);
    continue;
  }
  let v;
  if (is.from === undefined) v = r[is.metric];
  else v = r.marks.filter((m) => m.kind === is.metric && m.t >= is.from && m.t <= is.to).reduce((s, m) => s + m.n, 0);
  const where = is.from === undefined ? 'whole take' : `${is.from}-${is.to}s`;
  const line = `[${is.id}] ${is.note} (${is.take}, ${where}): ${is.metric} ${v} / max ${is.max}`;
  if (v > is.max) fails.push(line);
  else lines.push(`ok ${line}`);
}

for (const l of lines) console.log(l);
// dev = takes looked at while tuning; held-out = score only, never tuned on
const sums = { dev: { takes: 0 }, 'held-out': { takes: 0 } };
for (const [name, r] of Object.entries(results)) {
  const s = sums[holdout.has(name) ? 'held-out' : 'dev'];
  s.takes++;
  for (const m of METRICS) s[m] = (s[m] || 0) + r[m];
  s.unsure = (s.unsure || 0) + Object.values(r.unsure).reduce((a, b) => a + b, 0);
}
console.log('');
for (const [k, s] of Object.entries(sums)) console.log(`${k.padEnd(8)} ${s.takes} takes  ` + METRICS.map((m) => `${m} ${s[m] || 0}`).join('  ') + `  | unsure ${s.unsure || 0}`);
if (args.includes('--update') || args.includes('--accept')) {
  const accept = args.includes('--accept');
  for (const [name, r] of Object.entries(results)) {
    const b = base[name] || {};
    for (const m of METRICS) b[m] = accept || b[m] === undefined ? r[m] : Math.min(b[m], r[m]);
    base[name] = b;
  }
  fs.writeFileSync(BASE, JSON.stringify(base, null, 1) + '\n');
  console.log(`baseline ${accept ? 'replaced' : 'updated'}: ${BASE}`);
}
if (fails.length) {
  console.log(`\nFAILED (${fails.length}):`);
  for (const f of fails) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`\nall ${Object.keys(results).length} takes and ${issues.length} known issues pass`);
