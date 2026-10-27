import fs from 'fs';
const f = process.argv[2];
const b = fs.readFileSync(f); const jl = b.readUInt32LE(12); const j = JSON.parse(b.subarray(20, 20 + jl).toString()); const binAt = 20 + jl + 8;
const T = { SCALAR: 1, VEC3: 3, VEC4: 4 };
const read = (i) => { const a = j.accessors[i], v = j.bufferViews[a.bufferView]; const off = binAt + (v.byteOffset || 0) + (a.byteOffset || 0); return new Float32Array(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + a.count * T[a.type] * 4)); };
const an = j.animations[0];
const res = {};
for (const c of an.channels) {
  const name = j.nodes[c.target.node].name; const s = an.samplers[c.sampler]; const t = read(s.input), v = read(s.output);
  if (c.target.path === 'rotation') {
    // second difference of angle: jitter = rotation change reversing direction; use mean |delta| and count of >5deg steps
    let sum = 0, big = 0, rev = 0; let prevD = null;
    for (let i = 1; i < t.length; i++) { let d = 0; for (let k = 0; k < 4; k++) d += v[i * 4 + k] * v[(i - 1) * 4 + k]; const ang = 2 * Math.acos(Math.min(1, Math.abs(d))) * 57.3; sum += ang; if (ang > 5) big++; }
    res[name] = { mean: +(sum / (t.length - 1)).toFixed(2), big5: big, n: t.length };
  } else if (c.target.path === 'translation' && /Hand$|Shoulder|ForeArm/.test(name)) {
    let sum = 0; for (let i = 1; i < t.length; i++) sum += Math.hypot(v[i * 3] - v[i * 3 - 3], v[i * 3 + 1] - v[i * 3 - 2], v[i * 3 + 2] - v[i * 3 - 1]);
    res[name + '.pos'] = { meanMm: +(sum / (t.length - 1) * 1000).toFixed(1) };
  }
}
for (const [k, v] of Object.entries(res)) if (!/Left/.test(k) || process.argv[3]) console.log(k.padEnd(24), JSON.stringify(v));
