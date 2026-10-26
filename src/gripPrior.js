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

export const GRASPS = GESTURES.filter((g) => CATS.has(g.category));

// Grips that fit each object shape the detector can name (objects.js). With
// an object in hand only its family is compared, so a cup is not taken for a
// pen grip just because the seen fingers fit both.
const FAMILY_IDS = {
  cylinder: ['grip-power', 'gt-01', 'gt-02', 'gt-03', 'gt-04', 'gt-05', 'gt-29', 'ob-bottleBody', 'ob-bottleNeck', 'ob-can', 'ob-mugHandle', 'ob-railing', 'ob-umbrella', 'ob-barbell', 'ob-racket', 'ob-ropePull', 'dl-cup', 'dl-mug', 'dl-flashlight', 'dl-flashlightOn', 'dl-candle', 'dl-rail', 'dl-rung', 'dl-rope', 'ob2-paperCup', 'ob2-shotGlass', 'ob2-pillBottle', 'ob-spray'],
  sphere: ['grip-sphere', 'gt-10', 'gt-11', 'gt-13', 'gt-26', 'gt-28', 'ob-egg', 'ob-eggHold', 'ob-tennis', 'ob-baseballHold', 'ob-golfBall', 'ob-apple', 'ob-orange', 'ob-ballSmall', 'ob-doorKnob', 'ob-lid', 'dl-knob', 'ob2-pingBall', 'tl-bowlingBall'],
  box: ['gt-06', 'gt-07', 'gt-08', 'gt-18', 'gt-22', 'ob-phoneSide', 'ob-phoneTwo', 'ob-book', 'ob-remote', 'ob-mouse', 'ob-card', 'dl-phoneHold', 'dl-phoneTap', 'dl-phoneLand', 'dl-phoneCall', 'dl-keyFob', 'dl-card', 'dl-gamepadL', 'dev-mousePalm', 'dev-mouseClaw', 'dev-mouseTip', 'dev-phoneThumb', 'dev-remoteBtn', 'dev-padStick', 'dev-padTrigger', 'dev-padBumper'],
  rod: ['grip-tripod', 'gt-02', 'gt-14', 'gt-17', 'gt-19', 'gt-20', 'gt-21', 'gt-29', 'ob-pen', 'ob-penClick', 'ob-toothbrush', 'ob-spoonHold', 'ob-fork', 'ob-knife', 'ob-scissorsHold', 'ob-wineStem', 'ob-umbrella', 'ob-racket', 'ob-chopOne', 'ob-brushPaint', 'dl-spoon', 'dl-chopsticks', 'dl-match', 'tl-lateralTripod', 'tl-quadrupod', 'tl-chopOpen', 'tl-chopClose', 'tl-scissorOpen', 'tl-scissorClose', 'tl-knifeSpine', 'tl-knifePinch', 'tl-dartGrip', 'tl-paintbrush', 'tl-tweezers', 'tl-screwdriverTip', 'ob2-chalk', 'ob2-lipstick', 'ob2-ladle'],
};
// The size-graded grips (gestures.js v53) join their family by id prefix.
const FAMILY_PREFIX = { cylinder: ['cyl-', 'mug-'], sphere: ['sph-'], box: ['box-'], rod: ['rod-'] };
export const FAMILIES = Object.fromEntries(Object.entries(FAMILY_IDS).map(([k, ids]) => [k, GRASPS.filter((g) => ids.includes(g.id) || FAMILY_PREFIX[k].some((p) => g.id.startsWith(p)))]));

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
  // shape: the held object's shape (objects.js), when the camera names one.
  update(reading, hidden, shape = null) {
    if (!KEYS.some((k) => Math.max(...hidden[k]) >= HIDDEN_MIN)) {
      this.reset();
      return null;
    }
    const family = shape && this.shapes === GRASPS && FAMILIES[shape] && FAMILIES[shape].length ? FAMILIES[shape] : this.shapes;
    let best = null;
    let bestFit = Infinity;
    for (const g of family) {
      const f = this.misfit(g, reading, hidden);
      if (f < bestFit) {
        bestFit = f;
        best = g;
      }
    }
    const held = this.current ? this.misfit(this.current, reading, hidden) : Infinity;
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
    if (!this.current) return null;
    const g = this.current;
    const out = {};
    for (const key of KEYS) {
      // Side bend stays as read (spread is seen well even on hidden fingers).
      out[key] = key === 'thumb' ? g.h.thumb.slice() : [g.h[key][0], reading[key][1], 0, g.h[key][3], g.h[key][4]];
    }
    return out;
  }
}
