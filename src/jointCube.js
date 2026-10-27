// Joint cubes read from the hand's pixels (user idea 2026-10-27: each rig
// point a small cube with faces on the real hand, nail side up, pad side
// down): for the 15 finger joints (thumb CMC/MCP/IP, then MCP/PIP/DIP of
// index..pinky) how much the bone points at the camera and how much its
// nail side faces the camera (-1..1), each with the network's own spread.
// A finger curled toward the palm and one pointing at the camera look alike
// in MediaPipe's points, not in these. Trained on renders
// (tools/palm/train_cube.py), same crop as the palm/back model.
import { pictureNet } from './fingerCurl.js';

const J = 15;
const KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const net = pictureNet('vendor/models/joint_cube.bin', 2 * J);

// Loads the weights once (about 210 KB).
export const loadJointCube = net.load;
export const jointCubeReady = net.ready;

// rgba: the 64x64 crop (palmFace.js cutHand). Returns { thumb: [{ along,
// asd, nail, nsd } x3], ... } or null before the weights have loaded.
// along: the cosine between the bone (this joint to the next) and the line
// from this joint to the camera (1 = points straight at the camera); nail:
// the same for the bone's back-of-finger axis (tools/palm/crops_cube.py).
export function jointCube(rgba) {
  const o = net.run(rgba);
  if (!o) return null;
  const sd = (v) => Math.exp(Math.min(2, Math.max(-4, v)));
  const out = {};
  KEYS.forEach((k, f) => {
    out[k] = [0, 1, 2].map((i) => ({
      along: o[f * 3 + i],
      asd: sd(o[2 * J + f * 3 + i]),
      nail: o[J + f * 3 + i],
      nsd: sd(o[3 * J + f * 3 + i]),
    }));
  });
  return out;
}

// The curl and cube readings of one hand as the solver's picture input, with
// view: the line of sight in the solver's axes, which along is measured on
// (fit.js).
export function withCubes(picture, cubes, view = null) {
  if (!cubes) return picture;
  return Object.fromEntries(KEYS.map((k) => [k, [0, 1, 2].map((i) => ({ ...(picture ? picture[k][i] : {}), ...cubes[k][i], view }))]));
}
