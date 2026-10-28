// The existing web app is the renderer/solver/recorder. Only detection input
// and Android document-picker output differ. No alternate retargeter exists.
import './main.js';
import { HandTracker } from './tracker.js';
import { nativeResult } from './nativeResult.js';

const $ = id => document.getElementById(id);
const app = window.__hms;
const hooks = app.native;
const tracker = new HandTracker({});
tracker.delegate = 'native GPU';
hooks.setTracker(tracker);
let queued = null, active = true, epoch = null, lastTimestamp = -Infinity;
let previousSides = new Set();
function reset() { queued = null; previousSides = new Set(); hooks.reset(); }
function pause() { if (app.rec.on) app.stopRecording(); reset(); }
hooks.input.consume = now => {
  const packet = queued; queued = null;
  if (!packet || app.state.frozen) return null;
  hooks.input.width = packet.width; hooks.input.height = packet.height;
  tracker.delegate = `native ${packet.backend || 'GPU'}`;
  const result = nativeResult(packet);
  // A disappearing side resets solver/filters before another hand may inherit them.
  const sides = new Set((packet.hands || []).map(h => h.label));
  if ([...previousSides].some(s => !sides.has(s))) hooks.reset();
  previousSides = sides;
  const hands = tracker.acceptResult(result, { swapHandedness:app.state.swap, rightOnImageRight:true, firstPerson:true, trackMs:now, aspect:packet.width/packet.height });
  if (app.rec.on) {
    const t = now/1000;
    const raw = { t, hands:tracker.lastRaw, nativeTimestampMs:packet.tMs, captureTimestampNs:packet.captureTimestampNs };
    app.rec.lastRaw = raw; app.rec.raw.push(raw);
    app.rec.rawMeta = { aspect:packet.width/packet.height, firstPerson:true, swap:app.state.swap, rightOnImageRight:true, offline:false, pipeline:'existing-web-native-input-v1', backend:packet.backend, maxHands:packet.maxHands };
  }
  return hands;
};
async function saveFile(bytes, filename) {
  const bridge = window.HMSAndroid;
  if (!bridge) throw new Error('Android 저장 연결이 없습니다.');
  const token = bridge.beginExport(filename, bytes.byteLength);
  if (!token) throw new Error('다른 파일 저장 중이거나 파일이 너무 큽니다.');
  try {
    for (let i=0;i<bytes.length;i+=24576) {
      let binary=''; for (const b of bytes.subarray(i,i+24576)) binary+=String.fromCharCode(b);
      if (!bridge.appendExport(token,btoa(binary))) throw new Error('파일 전달 실패');
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    if (!bridge.finishExport(token)) throw new Error('파일 저장을 시작하지 못했습니다.');
  } catch(e) { bridge.cancelExport(token); throw e; }
}
window.HMSNative = {
  receive(packet) {
    if (!active || !packet || !Number.isFinite(packet.tMs) || !(packet.width>0 && packet.height>0)) return;
    if (epoch !== packet.session) { if (epoch !== null) pause(); else reset(); epoch=packet.session; lastTimestamp=-Infinity; }
    if (packet.tMs <= lastTimestamp) return;
    lastTimestamp=packet.tMs; queued=packet;
  },
  pause,
  setActive(on) { active=!!on; hooks.input.active=active; if (!active) pause(); },
  saveFile,
  exportResult(ok,message) { hooks.toast(message || (ok?'저장 완료':'저장 취소')); },
};
app.state.source = 'native';
$('start').hidden = true;
$('ar').checked = false;
for (const id of ['src-demo','src-camera','src-video','camera-opts','live-row','video-pick','video-fp-row','preview','ar-btn']) $(id).hidden=true;
for (const id of ['ar','save-crops']) { $(id).disabled=true; $(id).closest('label')?.setAttribute('hidden',''); }
$('engine-status').textContent='네이티브 MediaPipe · 기존 웹 엔진';
$('slow-hint').hidden=true;
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
await hooks.handModelsReady;
reset();
hooks.setStatus('네이티브 입력 · 기존 웹 손·손목·팔 처리');
window.HMSAndroid?.ready();
