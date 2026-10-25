"""Check dictionary hand shapes against real hands from HaGRID.

HaGRID (github.com/hukenovs/hagrid, CC BY-SA 4.0 variant) has photos of real
people making 33 everyday gestures, with MediaPipe hand landmarks. Used here
for validation only: nothing from it is copied into the app.

The photos are 2D and taken from every side, so each hand is compared through
view-independent measures: how straight each finger is (fingertip-to-wrist
distance over the finger's length) and how far the thumb tip sits from the
index knuckle and the little-finger knuckle (over the palm length). The
dictionary shape is seen from many random directions the same way, and the
two distributions are compared per finger.

Usage:
  node tools/hagrid/dict-landmarks.cjs dict_landmarks.json
  python3 tools/hagrid/validate.py dict_landmarks.json <annotations dir> [report.md]
The annotations dir holds HaGRID's per-gesture JSON files (train/val/test
subfolders are searched).
"""
import json
import math
import random
import sys
from pathlib import Path

# HaGRID gesture -> dictionary id
CLASS_TO_ID = {
    'call': 'g-call', 'peace': 'g-peace', 'grabbing': 'g-grabbing', 'dislike': 'g-thumbsDown',
    'peace_inverted': 'g-peaceInv', 'grip': 'g-grip', 'fist': 'hs-S', 'rock': 'g-rock',
    'hand_heart': 'g-heartHalf', 'hand_heart2': 'g-cheekHeart', 'four': 'hs-4', 'stop': 'g-stop',
    'stop_inverted': 'g-stop', 'like': 'g-thumbsUp', 'holy': 'g-holy', 'mute': 'g-mute',
    'three': 'g-three2', 'three2': 'g-three3', 'three3': 'g-three3', 'three_gun': 'g-threeGun',
    'ok': 'g-ok', 'little_finger': 'hs-I', 'middle_finger': 'r-middle', 'one': 'hs-1',
    'two_up': 'g-twoUp', 'two_up_inverted': 'g-twoUp', 'point': 'g-point', 'palm': 'g-palm',
    'take_picture': 'g-picture', 'thumb_index': 'g-thumbIndex', 'thumb_index2': 'g-thumbIndex2',
    'timeout': 'sp-timeout', 'xsign': 'g-xsign',
}
FINGERS = {'thumb': [1, 2, 3, 4], 'index': [5, 6, 7, 8], 'middle': [9, 10, 11, 12], 'ring': [13, 14, 15, 16], 'pinky': [17, 18, 19, 20]}
FEATURES = ['thumb', 'index', 'middle', 'ring', 'pinky', 'thumb-index', 'thumb-pinky']
FLAG = 0.12  # median difference that counts as a mismatch
VIEWS = 400


def d(a, b):
    return math.dist(a, b)


def features(P):
    """P: 21 points (2D). Straightness per finger and thumb-tip reach."""
    palm = d(P[0], P[9]) or 1e-6
    f = {}
    for k, J in FINGERS.items():
        chain = J if k == 'thumb' else [0] + J
        length = sum(d(P[chain[i]], P[chain[i + 1]]) for i in range(len(chain) - 1)) or 1e-6
        f[k] = d(P[chain[0]], P[chain[-1]]) / length
    f['thumb-index'] = d(P[4], P[5]) / palm
    f['thumb-pinky'] = d(P[4], P[17]) / palm
    return f


def random_rotation(rng):
    # Uniform random rotation (Shoemake).
    u1, u2, u3 = rng.random(), rng.random(), rng.random()
    q = (math.sqrt(1 - u1) * math.sin(2 * math.pi * u2), math.sqrt(1 - u1) * math.cos(2 * math.pi * u2),
         math.sqrt(u1) * math.sin(2 * math.pi * u3), math.sqrt(u1) * math.cos(2 * math.pi * u3))
    x, y, z, w = q
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]


def views(lm, n, seed=1):
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        R = random_rotation(rng)
        out.append(features([[sum(R[r][c] * p[c] for c in range(3)) for r in range(2)] for p in lm]))
    return out


def quantiles(vals):
    v = sorted(vals)
    q = lambda t: v[min(len(v) - 1, int(t * len(v)))]
    return q(0.25), q(0.5), q(0.75)


def load_hagrid(root):
    by_class = {}
    for path in Path(root).rglob('*.json'):
        try:
            data = json.loads(path.read_text())
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        for ann in data.values():
            if not isinstance(ann, dict):
                continue
            for label, lm in zip(ann.get('labels', []), ann.get('hand_landmarks', [])):
                if label in CLASS_TO_ID and lm and len(lm) == 21:
                    by_class.setdefault(label, []).append(features(lm))
    return by_class


def main():
    dict_path, root = sys.argv[1], sys.argv[2]
    report = sys.argv[3] if len(sys.argv) > 3 else 'hagrid_report.md'
    shapes = json.loads(Path(dict_path).read_text())
    real = load_hagrid(root)
    lines = ['# HaGRID validation', '', f'Mismatch: median differs by more than {FLAG}.', '']
    lines.append('| HaGRID | dictionary | hands | mismatches (real median / dictionary median) |')
    lines.append('|---|---|---|---|')
    summary = []
    for cls, sid in CLASS_TO_ID.items():
        if cls not in real or sid not in shapes:
            continue
        rv = real[cls]
        dv = views(shapes[sid]['lm'], VIEWS)
        bad = []
        for k in FEATURES:
            rq = quantiles([f[k] for f in rv])
            dq = quantiles([f[k] for f in dv])
            if abs(rq[1] - dq[1]) > FLAG:
                bad.append(f'{k} {rq[1]:.2f}/{dq[1]:.2f}')
        summary.append((cls, sid, len(rv), bad))
        lines.append(f"| {cls} | {sid} ({shapes[sid]['name']}) | {len(rv)} | {', '.join(bad) or 'ok'} |")
    lines.append('')
    print('\n'.join(lines))
    Path(report).write_text('\n'.join(lines))
    ok = sum(1 for s in summary if not s[3])
    print(f'{ok}/{len(summary)} gestures within tolerance -> {report}')


if __name__ == '__main__':
    main()
