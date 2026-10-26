# Hand crops for the palm/back model (tools/palm/train.py): each sample's
# MediaPipe hand cut out of the picture the same way the app does
# (src/palmFace.js): turned so the wrist-to-middle-knuckle line points up,
# square, 1.2x the hand's reach, 64x64.
#
#   python3 -I tools/palm/crops.py <synthetic folder> <file.jsonl> <out.npz>
#
# Labels: how much the palm faces the camera (-1 back .. 1 palm), from the
# drawn hand's true joints, and the 15 joint flexions the hand was posed with
# (degrees; thumb CMC/MCP/IP, then MCP/PIP/DIP of index..pinky, as
# tools/synth-eval.mjs compares them) for the finger curl model.
import json, sys
import numpy as np
from PIL import Image

S = 64


def crop_box(lm, W, H):
    """Corner points (top-left, top-right, bottom-left) in pixels of the turned square."""
    p = np.array([[q[0] * W, q[1] * H] for q in lm])
    up = p[9] - p[0]
    up /= np.linalg.norm(up) + 1e-9
    right = np.array([-up[1], up[0]])  # picture y runs down
    # In the turned frame: x along right, y along up.
    u = p @ right
    v = p @ up
    cu, cv = (u.min() + u.max()) / 2, (v.min() + v.max()) / 2
    h = max(u.max() - u.min(), v.max() - v.min()) * 0.6
    c = cu * right + cv * up
    return c - h * right + h * up, c + h * right + h * up, c - h * right - h * up


def cut(im, lm):
    W, H = im.size
    tl, tr, bl = crop_box(lm, W, H)
    # PIL affine: output pixel (x, y) -> input tl + x/S (tr-tl) + y/S (bl-tl).
    a = (tr - tl) / S
    b = (bl - tl) / S
    return np.asarray(im.transform((S, S), Image.AFFINE, (a[0], b[0], tl[0], a[1], b[1], tl[1]), resample=Image.BILINEAR))


def facing(t):
    J = np.array(t['joints'])
    n = np.cross(J[5] - J[0], J[17] - J[0])
    n /= np.linalg.norm(n)
    to_cam = -(J[0] + J[9]) / 2
    to_cam /= np.linalg.norm(to_cam)
    c = float(n @ to_cam)
    return c if t['side'] == 'right' else -c


if __name__ == '__main__':
    D, f, out = sys.argv[1:4]
    X, Y, side, ids, ang = [], [], [], [], []
    for line in open(D + f):
        r = json.loads(line)
        t = r['truth']
        tw = t['image'][0]
        hits = sorted(r['mp'], key=lambda h: np.hypot(h['lm'][0][0] - tw[0], h['lm'][0][1] - tw[1]))
        if not hits or np.hypot(hits[0]['lm'][0][0] - tw[0], hits[0]['lm'][0][1] - tw[1]) > 0.1:
            continue
        im = Image.open(D + 'img/' + r['id']).convert('RGB')
        X.append(cut(im, hits[0]['lm']))
        Y.append(facing(t))
        side.append(t['side'] == 'right')
        ids.append(r['id'])
        h = t['h']
        ang.append([h['thumb'][i] for i in (0, 3, 6)] + [h[k][i] for k in ('index', 'middle', 'ring', 'pinky') for i in (0, 3, 4)])
    np.savez_compressed(out, x=np.array(X, np.uint8), y=np.array(Y, np.float32), right=np.array(side), ids=np.array(ids), ang=np.array(ang, np.float32))
    print(len(X), 'crops ->', out, 'palm-facing share', float((np.array(Y) > 0).mean()))
