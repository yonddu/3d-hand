import { readTake, replay } from './replay.mjs';
const tot = {};
for (const f of process.argv.slice(2)) { const take = readTake(f); if (!take || !take.frames) continue; const r = replay(take);
  const c = (k) => r.marks.filter((m) => m.kind === k).reduce((s, m) => s + m.n, 0);
  const row = { pstill: c('pstill'), gsw: r.gsw, jump: r.jump, fjump: r.fjump, pierce: c('pierce'), topen: c('topen') };
  for (const k in row) tot[k] = (tot[k] || 0) + row[k]; }
console.log(JSON.stringify(tot));
