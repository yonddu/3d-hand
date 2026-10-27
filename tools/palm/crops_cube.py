# Hand crops for the joint cube model (tools/palm/train_cube.py): the same
# 64x64 crop as the palm and curl models (crops.py), labelled with each finger
# joint's cube (tools/synth-render.mjs truth.cubes, the drawn model's joint
# turn in camera space): how much the bone points at the camera and how much
# its nail side (back of the finger) faces the camera, -1..1, for the 15
# joints thumb CMC/MCP/IP, then MCP/PIP/DIP of index..pinky. A finger curled
# toward the palm and one pointing at the camera look alike in MediaPipe's
# points; their nail sides face the camera differently.
#
#   python3 -I tools/palm/crops_cube.py <synthetic folder> <file.jsonl> <out.npz>
import json, sys, os
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crops import cut

JOINTS = [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15, 17, 18, 19]


def rotate(q, v):
    x, y, z, w = q
    u = np.array([x, y, z])
    return v + 2 * np.cross(u, np.cross(u, v) + w * v)


def cube_labels(t):
    J = np.array(t['joints'])
    along, nail = [], []
    for j in JOINTS:
        to_cam = -J[j] / np.linalg.norm(J[j])
        q = t['cubes'][j]
        along.append(float(rotate(q, np.array([0, 0, -1.0])) @ to_cam))  # WebXR joints: -z along the bone
        nail.append(float(rotate(q, np.array([0, 1.0, 0])) @ to_cam))  # +y out of the back of the finger
    return along + nail


if __name__ == '__main__':
    D, f, out = sys.argv[1:4]
    X, ids, cube = [], [], []
    for line in open(D + f):
        try:
            r = json.loads(line)
        except ValueError:  # a line cut short on the shared folder
            continue
        t = r['truth']
        if 'cubes' not in t:
            continue
        tw = t['image'][0]
        hits = sorted(r['mp'], key=lambda h: np.hypot(h['lm'][0][0] - tw[0], h['lm'][0][1] - tw[1]))
        if not hits or np.hypot(hits[0]['lm'][0][0] - tw[0], hits[0]['lm'][0][1] - tw[1]) > 0.1:
            continue
        im = Image.open(D + 'img/' + r['id']).convert('RGB')
        X.append(cut(im, hits[0]['lm']))
        ids.append(r['id'])
        cube.append(cube_labels(t))
    np.savez_compressed(out, x=np.array(X, np.uint8), ids=np.array(ids), cube=np.array(cube, np.float32))
    print(len(X), 'crops ->', out)
