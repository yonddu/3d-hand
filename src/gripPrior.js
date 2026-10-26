// Hidden fingers on a held object.
//
// A hand closed around a cup, pen or handle hides some fingers behind the
// object or the palm, and the tracker only guesses where they are. The
// fingers still seen say what kind of grip it is: the grip shapes in the
// dictionary (objects, tools, grasp taxonomy) are compared with the seen
// joints, and the best one gives the hidden joints their target. Only hidden
// joints are pulled (fit.js weighs the pull by how hidden each joint is), so
// a seen finger keeps following the camera. A grip, once chosen, is held until
// another one fits clearly better for several frames, so hidden fingers do not
// jump between shapes.
import { GESTURES } from './gestures.js';
import { contactMisfit, contactOver, reachBound } from './gripPhysics.js';

const CATS = new Set(['grip', 'graspTax', 'objects', 'daily']);
const KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
// Joint (0 base, 1 middle, 2 tip) of each angle, as in fit.js layout().
const JOINT = { thumb: [0, 0, 0, 1, 1, 1, 2], finger: [0, 0, 0, 1, 2] };
const ROLL = { thumb: [2, 5], finger: [2] };

const HIDDEN_MIN = 0.3; // a joint at least this hidden makes it worth guessing
const SEEN_MIN = 6; // seen angles (weighted) needed to tell grips apart
const FIT_MAX = 16; // degrees (RMS over seen angles) for a grip to count
const SWITCH = 0.7; // a new grip must fit this much better than the held one
const HOLD = 6; // for this many frames in a row
const SIZE_TOL = 0.25; // log size ratio between grip and object that counts as one unit of mismatch
// A rare shape (gestures.js CATEGORY_WEIGHT) pays this many units of the fit
// limit squared per unit of -ln(weight).
const RARE = 0.5;
const rareCost = (g) => RARE * -Math.log(g.weight || 1);

// Every real hand shape in the dictionary takes part, not only the grips:
// hidden fingers in a sign or a gesture are filled the same way. Over the
// 20 recorded takes this covered 26% more frames and cut finger jumps 3%
// (v58); the grip-only list (CATS) is kept for the object families below.
export const GRASPS = GESTURES.slice();
const GRIPS = GESTURES.filter((g) => CATS.has(g.category));

// Grips that fit each object shape the detector can name (objects.js). With
// an object in hand only its family is compared, so a cup is not taken for a
// pen grip just because the seen fingers fit both.
const FAMILY_IDS = {
  cylinder: ['grip-power', 'gt-01', 'gt-02', 'gt-03', 'gt-04', 'gt-05', 'gt-29', 'ob-bottleBody', 'ob-bottleNeck', 'ob-can', 'ob-mugHandle', 'ob-railing', 'ob-umbrella', 'ob-barbell', 'ob-racket', 'ob-ropePull', 'dl-cup', 'dl-mug', 'dl-flashlight', 'dl-flashlightOn', 'dl-candle', 'dl-rail', 'dl-rung', 'dl-rope', 'ob2-paperCup', 'ob2-shotGlass', 'ob2-pillBottle', 'ob-spray'],
  sphere: ['grip-sphere', 'gt-10', 'gt-11', 'gt-13', 'gt-26', 'gt-28', 'ob-egg', 'ob-eggHold', 'ob-tennis', 'ob-baseballHold', 'ob-golfBall', 'ob-apple', 'ob-orange', 'ob-ballSmall', 'ob-doorKnob', 'ob-lid', 'dl-knob', 'ob2-pingBall', 'tl-bowlingBall'],
  box: ['gt-06', 'gt-07', 'gt-08', 'gt-18', 'gt-22', 'ob-phoneSide', 'ob-phoneTwo', 'ob-book', 'ob-remote', 'ob-mouse', 'ob-card', 'dl-phoneHold', 'dl-phoneTap', 'dl-phoneLand', 'dl-phoneCall', 'dl-keyFob', 'dl-card', 'dl-gamepadL', 'dev-mousePalm', 'dev-mouseClaw', 'dev-mouseTip', 'dev-phoneThumb', 'dev-remoteBtn', 'dev-padStick', 'dev-padTrigger', 'dev-padBumper'],
  book: ['ob-book', 'dl-page', 'dl-card', 'ob-card', 'gt-06', 'gt-07', 'gt-08'],
  rod: ['grip-tripod', 'gt-02', 'gt-14', 'gt-17', 'gt-19', 'gt-20', 'gt-21', 'gt-29', 'ob-pen', 'ob-penClick', 'ob-toothbrush', 'ob-spoonHold', 'ob-fork', 'ob-knife', 'ob-scissorsHold', 'ob-wineStem', 'ob-umbrella', 'ob-racket', 'ob-chopOne', 'ob-brushPaint', 'dl-spoon', 'dl-chopsticks', 'dl-match', 'tl-lateralTripod', 'tl-quadrupod', 'tl-chopOpen', 'tl-chopClose', 'tl-scissorOpen', 'tl-scissorClose', 'tl-knifeSpine', 'tl-knifePinch', 'tl-dartGrip', 'tl-paintbrush', 'tl-tweezers', 'tl-screwdriverTip', 'ob2-chalk', 'ob2-lipstick', 'ob2-ladle'],
};
// The size-graded grips (gestures.js v53) join their family by id prefix.
const FAMILY_PREFIX = { cylinder: ['cyl-', 'mug-'], sphere: ['sph-'], box: ['box-'], rod: ['rod-'], book: ['bk-', 'box-'] };
export const FAMILIES = Object.fromEntries(Object.entries(FAMILY_IDS).map(([k, ids]) => [k, GRIPS.filter((g) => ids.includes(g.id) || FAMILY_PREFIX[k].some((p) => g.id.startsWith(p)))]));

// The held object's size in mm (objects.js measure): a diameter for round
// things. A box's measured width says nothing about how the hand holds it
// (across its thickness), so it gives none.
export function objectSize(vision) {
  if (!vision || vision.shape === 'box') return null;
  return vision.radius ? vision.radius * 2000 : null;
}

// The grip family the held object calls for: a book is a box held thin.
export function heldFamily(vision) {
  if (!vision) return null;
  return vision.category === 'book' ? 'book' : vision.shape;
}

// How badly a grip suits the object, in units of FIT_MAX squared, from what
// the grip's geometry can hold (gripPhysics.js). A 70 mm cup is not held in a
// grip whose fingers curl round 30 mm, however alike the seen fingers look.
// bound: the largest size the reach allows (planGrips), a one-sided limit.
function sizeCost(g, size, shape, bound = null) {
  let c = 0;
  if (size) c += (contactMisfit(g, shape, size) / SIZE_TOL) ** 2 * 0.5;
  if (bound) c += (contactOver(g, shape, bound) / SIZE_TOL) ** 2 * 0.5;
  return Math.min(4, c);
}

export class GraspPrior {
  constructor(shapes = GRASPS) {
    this.shapes = shapes;
    this.reset();
  }

  reset() {
    this.current = null; // the grip in use
    this.next = null; // a grip waiting to take over
    this.count = 0;
  }

  // RMS degrees between a grip and the seen part of the reading.
  misfit(g, reading, hidden) {
    let c = 0;
    let w = 0;
    for (const key of KEYS) {
      const kind = key === 'thumb' ? 'thumb' : 'finger';
      const a = reading[key];
      const b = g.h[key];
      JOINT[kind].forEach((j, i) => {
        if (ROLL[kind].includes(i)) return;
        const s = 1 - hidden[key][j];
        c += s * (a[i] - b[i]) ** 2;
        w += s;
      });
    }
    return w < SEEN_MIN ? Infinity : Math.sqrt(c / w);
  }

  // reading/hidden: per finger, angles as fit.js lays them out and how hidden
  // each joint is (0..1). Returns per-finger target angles for the hidden
  // joints, or null when nothing is hidden or no grip fits.
  // shape: the held object's shape (objects.js), when the camera names one;
  // size: its size in mm (objectSize), when measured.
  update(reading, hidden, shape = null, size = null) {
    if (!KEYS.some((k) => Math.max(...hidden[k]) >= HIDDEN_MIN)) {
      this.reset();
      return null;
    }
    const family = this.family(shape);
    let best = null;
    let bestFit = Infinity;
    for (const g of family) {
      const f = Math.sqrt(this.misfit(g, reading, hidden) ** 2 + FIT_MAX ** 2 * (sizeCost(g, size, shape) + rareCost(g)));
      if (f < bestFit) {
        bestFit = f;
        best = g;
      }
    }
    const held = this.current ? Math.sqrt(this.misfit(this.current, reading, hidden) ** 2 + FIT_MAX ** 2 * (sizeCost(this.current, size, shape) + rareCost(this.current))) : Infinity;
    if (held > FIT_MAX * 1.5) this.current = null; // the hand left that grip
    if (!this.current) {
      this.current = bestFit <= FIT_MAX ? best : null;
      this.next = null;
      this.count = 0;
    } else if (best !== this.current && bestFit < held * SWITCH) {
      this.count = this.next === best ? this.count + 1 : 1;
      this.next = best;
      if (this.count >= HOLD) {
        this.current = best;
        this.next = null;
        this.count = 0;
      }
    } else {
      this.next = null;
      this.count = 0;
    }
    return this.current ? this.targets(this.current, reading) : null;
  }

  family(shape) {
    return shape && this.shapes === GRASPS && FAMILIES[shape] && FAMILIES[shape].length ? FAMILIES[shape] : this.shapes;
  }

  // Target angles a grip gives each finger.
  targets(g, reading) {
    const out = {};
    for (const key of KEYS) {
      // Side bend stays as read (spread is seen well even on hidden fingers).
      out[key] = key === 'thumb' ? g.h.thumb.slice() : [g.h[key][0], reading[key][1], 0, g.h[key][3], g.h[key][4]];
    }
    return out;
  }
}

// Grips for a whole recorded take, chosen with every frame known.
//
// Live, a grip is chosen from the frames so far and held against change, so
// the first frames of a hold get a late or wrong grip, and a grip can switch
// halfway through and back. Once the clip is filmed, the hold can be read
// backward as well: the hand closed on that object, so the grip that fits the
// whole hold (and the object's size) is the one it was making from the first
// frame. The path through the frames that fits best, paying for every switch,
// is found by dynamic programming (Viterbi); the frames just before a hold get
// the same grip, since the hand was already shaping for it on the way in.
// log: per frame { reading, hidden, shape, size } or null (hand not seen).
// Returns per frame the grip to use, or null.
const RUN_GAP = 3; // frames with nothing hidden that do not break a hold
const SWITCH_COST = 32; // a switch costs as much as this many frames at the fit limit
// No grip costs as much as the worst fit counted, so hidden joints always get
// the nearest real hand shape rather than the tracker's guess. Over the 20
// recorded takes, 32 and this cut finger jumps 11% (5384 -> 4793) and grip
// changes 829 -> 137; 4 to 128 and 1 to 8 were tried.
const NONE_COST = 4;
const APPROACH = 8;
const REACH_LOOK = 20; // frames before a hold searched for the hand's widest opening // frames before a hold that already shape for its grip
export function planGrips(log, prior = new GraspPrior()) {
  const plan = log.map(() => null);
  const isHidden = (e) => e && KEYS.some((k) => Math.max(...e.hidden[k]) >= HIDDEN_MIN);
  let i = 0;
  while (i < log.length) {
    if (!isHidden(log[i])) {
      i++;
      continue;
    }
    let e = i;
    for (let j = i + 1; j < log.length && log[j]; j++) {
      if (isHidden(log[j])) e = j;
      else if (j - e > RUN_GAP) break;
    }
    planRun(log, plan, i, e, prior);
    i = e + 1;
  }
  return plan;
}

function planRun(log, plan, s, e, prior) {
  // The object seen in most frames of the hold picks the grip family.
  const votes = {};
  const sizes = [];
  for (let i = s; i <= e; i++) {
    if (log[i].shape) votes[log[i].shape] = (votes[log[i].shape] || 0) + 1;
    if (log[i].size) sizes.push(log[i].size);
  }
  const shape = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0] || null;
  const seen = sizes.length ? sizes.sort((a, b) => a - b)[sizes.length >> 1] : null;
  // Read backward from the hold: the hand opened only so wide on the way in,
  // so the object can be no bigger than that allows (gripPhysics.js). A size
  // from the camera past that limit is cut down to it.
  const openings = [];
  for (let i = Math.max(0, s - REACH_LOOK); i <= Math.min(e, s + 2); i++) openings.push(log[i] ? log[i].aperture : NaN);
  const reach = log[s].aperture ? reachBound(openings, log[s].aperture) : null;
  const size = seen && reach ? Math.min(seen, reach) : seen;
  plan.sizes = plan.sizes || [];
  plan.sizes.push({ s, e, shape, seen, reach, size });
  const C = prior.family(shape);
  const S = C.length + 1; // the last state: no grip
  const T = e - s + 1;
  const back = new Int32Array(T * S);
  let best = new Float64Array(S);
  let next = new Float64Array(S);
  const sc = C.map((g) => sizeCost(g, size, shape, reach) + rareCost(g));
  for (let t = 0; t < T; t++) {
    const f = log[s + t];
    let m = Infinity;
    let mi = 0;
    if (t > 0) for (let k = 0; k < S; k++) if (best[k] < m) [m, mi] = [best[k], k];
    for (let k = 0; k < S; k++) {
      let c = NONE_COST;
      if (k < C.length) {
        const fit = f && KEYS.some((key) => Math.max(...f.hidden[key]) >= HIDDEN_MIN) ? prior.misfit(C[k], f.reading, f.hidden) : Infinity;
        c = (Number.isFinite(fit) ? Math.min(fit, 2 * FIT_MAX) ** 2 / FIT_MAX ** 2 : 1) + sc[k];
      }
      if (t === 0) {
        next[k] = c;
        continue;
      }
      const stay = best[k];
      const move = m + (k === C.length || mi === C.length ? SWITCH_COST / 2 : SWITCH_COST);
      if (stay <= move) {
        next[k] = stay + c;
        back[t * S + k] = k;
      } else {
        next[k] = move + c;
        back[t * S + k] = mi;
      }
    }
    [best, next] = [next, best];
  }
  let k = 0;
  for (let j = 1; j < S; j++) if (best[j] < best[k]) k = j;
  for (let t = T - 1; t >= 0; t--) {
    plan[s + t] = k < C.length ? C[k] : null;
    if (t > 0) k = back[t * S + k];
  }
  // The hand shapes for the grip on the way in and opens out of it on the way out.
  const first = plan[s];
  if (first) for (let i = s - 1; i >= Math.max(0, s - APPROACH) && log[i] && !plan[i]; i--) plan[i] = first;
  const last = plan[e];
  if (last) for (let i = e + 1; i <= Math.min(log.length - 1, e + APPROACH) && log[i] && !plan[i]; i++) plan[i] = last;
}
