// MediaPipe Hand Landmarker wrapper: video frame -> up to two labelled hands.
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

export class HandTracker {
  constructor(config) {
    this.config = config;
    this.landmarker = null;
    this.delegate = null;
    this.lastVideoTime = -1;
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
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('GPU delegate failed, falling back to CPU', err);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
      this.delegate = 'CPU';
    }
    onStatus(`추적 준비됨 (${this.delegate})`);
  }

  // Returns null when the frame was already processed.
  detect(video, nowMs, { swapHandedness = false } = {}) {
    if (!this.landmarker || video.readyState < 2) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;
    const res = this.landmarker.detectForVideo(video, nowMs);
    const hands = res.landmarks.map((lm, i) => {
      const cat = res.handedness[i][0];
      let side = cat.categoryName.toLowerCase();
      // Tasks-vision labels match the person in an unmirrored frame; the toggle covers odd cases.
      if (swapHandedness) side = side === 'left' ? 'right' : 'left';
      return { side, score: cat.score, landmarks: lm, world: res.worldLandmarks[i] };
    });
    return resolveSides(hands, swapHandedness);
  }
}

// Two hands with the same label: keep the more confident label and give the
// other hand the opposite side. In an unmirrored view the person's right hand
// is the one further left in the image.
function resolveSides(hands, swapHandedness) {
  if (hands.length === 2 && hands[0].side === hands[1].side) {
    const [a, b] = hands;
    const aLeftInImage = a.landmarks[0].x < b.landmarks[0].x;
    const leftImageSide = swapHandedness ? 'left' : 'right';
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
