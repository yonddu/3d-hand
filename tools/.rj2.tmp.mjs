import { readTake, replay } from './replay.mjs';
const take = readTake(process.argv[2]); const side = process.argv[3];
const r = replay(take, { keep: true });
const names = ['HandThumb2', 'HandIndex2', 'HandMiddle2'].map((n) => (side === 'right' ? 'Right' : 'Left') + n);
const qa = (a, b) => { let d = 0; for (let k = 0; k < 4; k++) d += a[k] * b[k]; return 2 * Math.acos(Math.min(1, Math.abs(d))) * 57.3; };
const out = {}; let hq = 0, hn = 0;
for (let i = 1; i < r.motion.length; i++) { const a = r.motion[i - 1].hands[side], b = r.motion[i].hands[side]; if (!a || !b) continue; for (const n of names) { (out[n] ||= []).push(qa(a.fingers[n], b.fingers[n])); } hq += qa(a.handQ, b.handQ); hn++; }
for (const [n, v] of Object.entries(out)) console.log(n, 'mean', (v.reduce((s, x) => s + x, 0) / v.length).toFixed(2), 'big5', v.filter((x) => x > 5).length);
console.log('handQ mean', (hq / hn).toFixed(2));
