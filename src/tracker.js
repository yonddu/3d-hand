// MediaPipe Hand Landmarker wrapper: video frame -> up to two labelled hands.
import { FilesetResolver, HandLandmarker, ObjectDetector, PoseLandmarker } from '@mediapipe/tasks-vision';

export class HandTracker {
  constructor(config) {
    this.config = config;
    this.landmarker = null;
    this.delegate = null;
    this.lastVideoTime = -1;
    this.objects = null; // object detector, created after the hand model
    this.lastObjectTime = -1;
    this.pose = null; // body pose, for elbows when they are in view
    this.lastPoseTime = -1;
    this.lastDetectAt = -1;
    this.frameSeq = 0; // camera frames counted by requestVideoFrameCallback, when available
    this.lastFrameSeq = -1;
  }

  // Live camera: some mobile browsers never advance video.currentTime on a
  // MediaStream, so new frames are counted with requestVideoFrameCallback
  // (or, without it, assumed at ~30 fps).
  watchFrames(video) {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
    const tick = () => {
      this.frameSeq++;
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
    this.rvfc = true;
  }

  async init(onStatus = () => {}) {
    const { wasmLoaderPath, wasmBinaryPath, wasmBase, modelPath } = this.config;
    onStatus('추적 엔진 불러오는 중…');
    const fileset = wasmLoaderPath
      ? { wasmLoaderPath, wasmBinaryPath }
      : await FilesetResolver.forVisionTasks(wasmBase);
    // Hosts that only serve text can ship the model base64-encoded.
    const model = this.config.modelBase64Path
      ? { modelAssetBuffer: await fetchBase64(this.config.modelBase64Path) }
      : { modelAssetPath: modelPath };
    const options = (delegate) => ({
      baseOptions: { ...model, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    this.handOptions = options;
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('GPU delegate failed, falling back to CPU', err);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
      this.delegate = 'CPU';
    }
    onStatus(`추적 준비됨 (${this.delegate})`);
    this.fileset = fileset;
  }

  // Some phone GPUs run the model but return no hands; rebuild on the CPU.
  async useCPU() {
    if (this.delegate === 'CPU') return;
    const old = this.landmarker;
    this.landmarker = await HandLandmarker.createFromOptions(this.fileset, this.handOptions('CPU'));
    this.delegate = 'CPU';
    this.lastDetectAt = -1;
    old.close();
  }

  // Object detector for "what is in the hand". Optional: tracking works without it.
  async initObjects(onStatus = () => {}) {
    const { objectModelPath, objectModelBase64Path } = this.config;
    if (!objectModelPath && !objectModelBase64Path) return;
    onStatus('물건 인식 모델 불러오는 중…');
    const model = objectModelBase64Path
      ? { modelAssetBuffer: await fetchBase64(objectModelBase64Path) }
      : { modelAssetPath: objectModelPath };
    const options = (delegate) => ({
      baseOptions: { ...model, delegate },
      runningMode: 'VIDEO',
      scoreThreshold: 0.3,
      maxResults: 6,
    });
    // CPU: the int8 detector is small, runs a few times a second, and leaves
    // the GPU to the hand model and the renderer.
    this.objects = await ObjectDetector.createFromOptions(this.fileset, options('CPU'));
    onStatus(`추적 + 물건 인식 준비됨 (${this.delegate})`);
  }

  async initPose() {
    const { poseModelPath, poseModelBase64Path } = this.config;
    if (!poseModelPath && !poseModelBase64Path) return;
    const model = poseModelBase64Path
      ? { modelAssetBuffer: await fetchBase64(poseModelBase64Path) }
      : { modelAssetPath: poseModelPath };
    const options = (delegate) => ({ baseOptions: { ...model, delegate }, runningMode: 'VIDEO', numPoses: 1 });
    try {
      this.pose = await PoseLandmarker.createFromOptions(this.fileset, options(this.delegate));
    } catch (err) {
      console.warn('pose on', this.delegate, 'failed, trying CPU', err);
      this.pose = await PoseLandmarker.createFromOptions(this.fileset, options('CPU'));
    }
  }

  // { landmarks, world } for one person (MediaPipe pose indices), or null.
  detectPose(video, nowMs) {
    if (!this.pose || video.readyState < 2) return null;
    if (nowMs <= this.lastPoseTime) return null;
    this.lastPoseTime = nowMs;
    const res = this.pose.detectForVideo(video, nowMs);
    if (!res.landmarks.length) return { landmarks: null, world: null };
    return { landmarks: res.landmarks[0], world: res.worldLandmarks[0] };
  }

  // [{ category, score, x, y, w, h }] with the box normalized to the frame.
  detectObjects(video, nowMs) {
    if (!this.objects || video.readyState < 2 || !video.videoWidth) return null;
    if (nowMs <= this.lastObjectTime) return null;
    this.lastObjectTime = nowMs;
    const res = this.objects.detectForVideo(video, nowMs);
    const W = video.videoWidth;
    const H = video.videoHeight;
    return res.detections
      .filter((d) => d.categories[0] && d.categories[0].categoryName !== 'person')
      .map((d) => ({
        category: d.categories[0].categoryName,
        score: d.categories[0].score,
        x: d.boundingBox.originX / W,
        y: d.boundingBox.originY / H,
        w: d.boundingBox.width / W,
        h: d.boundingBox.height / H,
      }));
  }

  // Returns null when the frame was already processed.
  detect(video, nowMs, { swapHandedness = false, rightOnImageRight = true, firstPerson = false } = {}) {
    if (!this.landmarker || video.readyState < 2 || !video.videoWidth) return null;
    if (video.srcObject) {
      if (this.rvfc) {
        if (this.frameSeq === this.lastFrameSeq) return null;
        this.lastFrameSeq = this.frameSeq;
      } else if (nowMs - this.lastDetectAt < 30) return null;
    } else {
      if (video.currentTime === this.lastVideoTime) return null;
      this.lastVideoTime = video.currentTime;
    }
    if (nowMs <= this.lastDetectAt) return null;
    this.lastDetectAt = nowMs;
    const res = this.landmarker.detectForVideo(video, nowMs);
    const hands = res.landmarks.map((lm, i) => {
      const cat = res.handedness[i][0];
      let side = cat.categoryName.toLowerCase();
      // Tasks-vision labels match the person in an unmirrored frame; the toggle covers odd cases.
      if (swapHandedness) side = side === 'left' ? 'right' : 'left';
      return { side, score: cat.score, landmarks: lm, world: res.worldLandmarks[i], chiral: chirality(res.worldLandmarks[i]) };
    });
    dedupe(hands);
    this.lastHands = hands;
    return resolveSides(this.keepSides(hands, nowMs, swapHandedness, firstPerson ? video.videoWidth / video.videoHeight : 0), rightOnImageRight !== swapHandedness);
  }

  // Left or right. Seen from behind (first person), the back of a left hand and
  // the palm of a right hand make the same picture, and the model sometimes
  // takes one for the other, mostly while the wrist turns. Its 3D landmarks
  // then belong to the wrong hand too, so a wrong side twists the whole hand.
  // In first person (aspect > 0) the arm settles it: a forearm runs back
  // toward its own shoulder, the left one below and left of the picture. The
  // landmarks' depth is then mirrored to match. Otherwise the hand's 3D shape
  // (chirality) decides, and when that is unclear too (flat hand) a hand that
  // continues one from the last frames keeps its side unless the new label
  // holds for several frames. In first person a hand keeps the side the arm
  // gave it for as long as it is tracked.
  keepSides(hands, nowMs, swap = false, aspect = 0) {
    const prev = (this.tracks || []).filter((k) => nowMs - k.t < 400);
    this.tracks = hands.map((h) => {
      const x = h.landmarks[0].x;
      const y = h.landmarks[0].y;
      let best = null;
      let bestD = 0.15;
      for (const k of prev) {
        const d = Math.hypot(k.x - x, k.y - y);
        if (d < bestD) {
          best = k;
          bestD = d;
        }
      }
      const shapeSide = (c) => (c > 0 !== swap ? 'right' : 'left');
      const arm = aspect ? armSide(h.landmarks, aspect) : null;
      const chiral = best ? best.chiral * 0.4 + h.chiral * 0.6 : h.chiral;
      let flips = 0;
      let armVotes = 0;
      if (aspect && best) {
        // A tracked hand stays the hand it was: the arm line swings toward
        // the other shoulder as the palm turns over, and following it handed
        // the right hand to the left side for 1.5 s (user GLB 2026-10-26).
        // Only an arm that keeps pointing the other way for ARM_SWITCH
        // frames corrects a side given wrongly at the start.
        h.side = best.side;
        if (arm && arm !== best.side) {
          armVotes = (best.armVotes || 0) + 1;
          if (armVotes >= ARM_SWITCH) {
            h.side = arm;
            armVotes = 0;
          }
        }
      } else if (arm) h.side = arm;
      else if (Math.abs(chiral) > CHIRAL_SURE) h.side = shapeSide(chiral);
      else if (best && best.side !== h.side) {
        flips = best.flips + 1;
        if (flips < SIDE_FLIP_FRAMES) h.side = best.side;
        else flips = 0;
      }
      // Mirror the depth when the shape belongs to the other hand. The shape's
      // own handedness wobbles near zero while the palm turns edge-on, so a
      // tracked hand only changes its mirroring on clear, repeated evidence;
      // otherwise the fingers would curl the other way from one frame to the next.
      let mirrored = false;
      let mirrorVotes = 0;
      if (aspect) {
        const wants = Math.abs(h.chiral) > MIRROR_SURE ? shapeSide(h.chiral) !== h.side : null;
        const was = best && best.side === h.side ? best.mirrored : null;
        if (was === null) mirrored = wants === null ? false : wants;
        else if (wants === null || wants === was) mirrored = was;
        else {
          mirrorVotes = best.mirrorVotes + 1;
          mirrored = mirrorVotes >= MIRROR_FRAMES ? wants : was;
          if (mirrored !== was) mirrorVotes = 0;
        }
        if (mirrored) {
          h.world = h.world.map((p) => ({ x: p.x, y: p.y, z: -p.z }));
          h.chiral = -h.chiral;
          h.mirrored = true;
        }
      }
      return { side: h.side, x, y, t: nowMs, flips, armVotes, mirrored, mirrorVotes, chiral: best ? best.chiral * 0.4 + h.chiral * 0.6 : h.chiral };
    });
    return hands;
  }
}

// First person: which shoulder the forearm line points back to. The line runs
// from the middle knuckle through the wrist; the shoulders sit below the
// picture, out to each side. null when the angles are too close to call.
function armSide(L, aspect) {
  const w = [L[0].x, L[0].y / aspect];
  const d = [L[0].x - L[9].x, (L[0].y - L[9].y) / aspect];
  if (Math.hypot(...d) < 1e-4) return null;
  const bottom = 1 / aspect;
  const angleTo = (sx) => {
    const t = [sx - w[0], bottom + 0.6 - w[1]];
    return Math.acos(Math.max(-1, Math.min(1, (d[0] * t[0] + d[1] * t[1]) / Math.hypot(...d) / Math.hypot(...t))));
  };
  const l = angleTo(-0.35);
  const r = angleTo(1.35);
  if (Math.abs(l - r) < ARM_MARGIN) return null;
  return l < r ? 'left' : 'right';
}

const ARM_MARGIN = (30 * Math.PI) / 180;
const ARM_SWITCH = 90; // frames (3 s)
const MIRROR_SURE = 0.3;
const MIRROR_FRAMES = 3;

// The model sometimes returns one hand twice. Two detections whose palms sit
// on top of each other are the same hand: keep the more confident one.
function dedupe(hands) {
  const box = (L) => {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of L) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    return [x0, y0, x1, y1];
  };
  for (let i = hands.length - 1; i > 0; i--) {
    for (let j = 0; j < i; j++) {
      const a = box(hands[i].landmarks);
      const b = box(hands[j].landmarks);
      const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
      const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
      const inter = ix * iy;
      const small = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])) || 1e-6;
      const L = hands[i].landmarks;
      const M = hands[j].landmarks;
      const wristGap = Math.hypot(L[0].x - M[0].x, L[0].y - M[0].y);
      const palm = Math.hypot(L[0].x - L[9].x, L[0].y - L[9].y);
      if (inter / small > 0.6 || wristGap < 0.5 * palm) {
        if (hands[i].score > hands[j].score) hands[j] = hands[i];
        hands.splice(i, 1);
        break;
      }
    }
  }
  return hands;
}
const SIDE_FLIP_FRAMES = 8;
const CHIRAL_SURE = 0.25;

// Which hand the 3D shape is, independent of the label: fingers and thumb
// curl toward the palm, and the palm normal from (index MCP, pinky MCP) flips
// between a right and a left hand. > 0 looks like a right hand, < 0 a left
// one; near 0 (flat open hand) says nothing.
export function chirality(W) {
  const v = (i) => [W[i].x - W[0].x, W[i].y - W[0].y, W[i].z - W[0].z];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const a = v(5);
  const b = v(17);
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = Math.hypot(...n) || 1;
  const size = Math.hypot(...v(9)) || 1;
  let s = 0;
  for (const [mcp, tip] of [[5, 8], [9, 12], [13, 16], [17, 20], [2, 4]]) s += dot(sub(v(tip), v(mcp)), n) / len / size;
  return s;
}

// Two hands with the same label: keep the more confident label and give the
// other hand the opposite side, by where each hand is in the image. A camera
// behind the hands (looking the way the person looks) has the right hand on
// the image right; a camera facing the person has it on the image left.
function resolveSides(hands, rightOnImageRight) {
  if (hands.length === 2 && hands[0].side === hands[1].side) {
    const [a, b] = hands;
    const aLeftInImage = a.landmarks[0].x < b.landmarks[0].x;
    const leftImageSide = rightOnImageRight ? 'left' : 'right';
    a.side = aLeftInImage ? leftImageSide : opposite(leftImageSide);
    b.side = opposite(a.side);
  }
  return hands;
}

async function fetchBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model fetch failed: ${res.status}`);
  const bin = atob((await res.text()).trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function opposite(s) {
  return s === 'left' ? 'right' : 'left';
}
