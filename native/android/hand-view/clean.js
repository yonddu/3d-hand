// Whole-take clean-up of a recorded take, before the model is posed from it (record ->
// analyse -> correct, like the web app's offline pass). Works on the same frames the page is
// fed live: { t, hands: [{ side, cam[63], world[63], palm, elbow? }] } (cam: camera space m,
// world: MediaPipe world points m). Knows the whole take, so it can look ahead:
//   1. hands are linked into tracks by picture position; each track gets ONE side by vote over
//      the whole track (MediaPipe's per-frame left/right flickers while a hand turns over);
//   2. short tracks (a hand MediaPipe saw for a moment, or a second reading of the same hand)
//      are dropped;
//   3. single-frame spikes (a few frames read inside out) are replaced by the median of their
//      neighbours, per point (Hampel filter), only where they stand far off;
//   4. short gaps (MediaPipe lost the hand < GAP_S) are filled by interpolation.
// Rotation smoothing still happens at export (custom.js medianFrames + smoothFrames).

const LINK_S = 0.4; // a hand lost longer than this starts a new track
const LINK_NEAR = 0.25; // picture distance (x/z, y/z) for the same hand
const MIN_TRACK_S = 0.25; const MIN_TRACK_N = 5;
const SPIKE_HALF = 4; // samples each side
const SPIKE_K = 3; // MADs
const SPIKE_MIN_W = 0.012; const SPIKE_MIN_C = 0.025; // m: never touch smaller moves
const GAP_S = 0.3;

const pic = (h) => {
  const c = h.cam; const z1 = c[2]; const z2 = c[9 * 3 + 2];
  if (!(z1 > 0) || !(z2 > 0)) return null;
  return [(c[0] / z1 + c[27] / z2) / 2, (c[1] / z1 + c[28] / z2) / 2];
};

function linkTracks(frames) {
  const tracks = []; let open = [];
  frames.forEach((f, fi) => {
    open = open.filter((tr) => f.t - tr.lastT <= LINK_S);
    const hands = (f.hands || []).map((h, hi) => ({ h, hi, p: h.cam && h.cam.length >= 63 ? pic(h) : null })).filter((x) => x.p);
    const pairs = [];
    for (const x of hands) for (const tr of open) {
      const d = Math.hypot(x.p[0] - tr.lastP[0], x.p[1] - tr.lastP[1]);
      if (d < LINK_NEAR) pairs.push({ x, tr, d });
    }
    pairs.sort((a, b) => a.d - b.d);
    const usedH = new Set(); const usedT = new Set();
    for (const { x, tr } of pairs) {
      if (usedH.has(x) || usedT.has(tr)) continue;
      usedH.add(x); usedT.add(tr);
      tr.items.push({ fi, hand: x.h }); tr.lastT = f.t; tr.lastP = x.p;
    }
    for (const x of hands) {
      if (usedH.has(x)) continue;
      const tr = { items: [{ fi, hand: x.h }], lastT: f.t, lastP: x.p };
      tracks.push(tr); open.push(tr);
    }
  });
  return tracks;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };

// Per value: replace a sample far from its neighbours' median (Hampel). Returns count changed.
function despike(series, key, minDev) {
  const n = series.length; if (n < 3) return 0;
  const len = series[0][key].length;
  const out = series.map((s) => s[key].slice());
  const bad = new Set();
  for (let j = 0; j < len; j++) {
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - SPIKE_HALF); const b = Math.min(n, i + SPIKE_HALF + 1);
      const win = []; for (let k = a; k < b; k++) win.push(series[k][key][j]);
      const m = median(win);
      const mad = 1.4826 * median(win.map((v) => Math.abs(v - m)));
      const dev = Math.abs(series[i][key][j] - m);
      if (dev > Math.max(SPIKE_K * mad, minDev)) { out[i][j] = m; bad.add(i); }
    }
  }
  series.forEach((s, i) => { s[key] = out[i]; });
  return bad.size;
}

export function cleanTake(frames) {
  const stats = { frames: frames.length, tracks: 0, dropped: 0, relabelled: 0, spikes: 0, filled: 0 };
  if (!frames.length) return { frames, stats };
  const tracks = linkTracks(frames);
  stats.tracks = tracks.length;
  // One side per track, by vote (score-weighted when MediaPipe gave one).
  for (const tr of tracks) {
    let l = 0; let r = 0;
    for (const { hand } of tr.items) { const w = hand.score > 0 ? hand.score : 1; if (hand.side === 'left') l += w; else r += w; }
    tr.side = l > r ? 'left' : 'right'; tr.margin = Math.abs(l - r);
    tr.t0 = frames[tr.items[0].fi].t; tr.t1 = frames[tr.items[tr.items.length - 1].fi].t;
  }
  // Drop short tracks.
  let keep = tracks.filter((tr) => tr.items.length >= MIN_TRACK_N && tr.t1 - tr.t0 >= MIN_TRACK_S);
  if (!keep.length && tracks.length) keep = [tracks.reduce((a, b) => (b.items.length > a.items.length ? b : a))];
  stats.dropped = tracks.length - keep.length;
  // Two tracks of one side at the same time: the weaker vote takes the other side, or goes if
  // that side is taken too.
  keep.sort((a, b) => b.items.length - a.items.length);
  const final = [];
  for (const tr of keep) {
    const clash = (side) => final.some((o) => o.side === side && o.t0 <= tr.t1 && tr.t0 <= o.t1);
    if (!clash(tr.side)) { final.push(tr); continue; }
    const other = tr.side === 'left' ? 'right' : 'left';
    if (!clash(other)) { tr.side = other; final.push(tr); } else stats.dropped++;
  }
  // Per track: copy, relabel, despike, fill gaps.
  const out = frames.map((f) => ({ ...f, hands: [] }));
  for (const tr of final) {
    const series = tr.items.map(({ fi, hand }) => {
      if (hand.side !== tr.side) stats.relabelled++;
      return { fi, t: frames[fi].t, h: { ...hand, side: tr.side }, cam: hand.cam.slice(), world: hand.world && hand.world.length >= 63 ? hand.world.slice() : null };
    });
    const withWorld = series.filter((s) => s.world);
    stats.spikes += Math.max(despike(withWorld, 'world', SPIKE_MIN_W), 0);
    stats.spikes += despike(series, 'cam', SPIKE_MIN_C);
    for (const s of series) out[s.fi].hands.push({ ...s.h, cam: s.cam, world: s.world || s.h.world });
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1]; const b = series[i];
      if (b.fi - a.fi < 2 || b.t - a.t > GAP_S || !a.world || !b.world) continue;
      for (let fi = a.fi + 1; fi < b.fi; fi++) {
        const k = (frames[fi].t - a.t) / (b.t - a.t);
        const mix = (x, y) => x.map((v, j) => v + (y[j] - v) * k);
        out[fi].hands.push({ ...a.h, cam: mix(a.cam, b.cam), world: mix(a.world, b.world), palm: a.h.palm + ((b.h.palm || a.h.palm) - a.h.palm) * k, elbow: null, filled: true });
        stats.filled++;
      }
    }
  }
  return { frames: out, stats };
}
