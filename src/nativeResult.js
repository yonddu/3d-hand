// Preserve MediaPipe axes and units. Axis conversion belongs to main.js,
// exactly as for web detection; never negate or mirror coordinates here.
function unpack(flat) {
  if (!Array.isArray(flat) || flat.length !== 63 || !flat.every(Number.isFinite)) return null;
  return Array.from({ length: 21 }, (_, i) => ({ x: flat[i*3], y: flat[i*3+1], z: flat[i*3+2] }));
}
export function nativeResult(packet) {
  const list = [];
  for (const h of packet.hands || []) {
    const lm=unpack(h.lm), world=unpack(h.world);
    if (lm && world && ['left','right'].includes(h.label)) list.push({h,lm,world});
  }
  return {landmarks:list.map(x=>x.lm),worldLandmarks:list.map(x=>x.world),handedness:list.map(({h})=>[{categoryName:h.label,score:h.score || 0}])};
}
