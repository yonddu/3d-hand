"""Thumb-base (thenar) weight fix for a skinned hand GLB.

Problem (user 2026-11-14): skin between wrist and thumb is weighted to the thumb metacarpal bone, so
when the thumb metacarpal turns, the thenar muscle is pulled up toward the rig point.
Fix: along the thumb metacarpal (Thumb1 -> Thumb2), the Thumb1 weight fades in from the hand side:
s = position along the bone (0 = Thumb1 joint, 1 = Thumb2 joint); weight kept = smoothstep(S0, S1, s),
the rest moves to the Hand bone. Vertices past S1 are unchanged.

python3 thenar_weights.py in.glb out.glb [S0 S1]
"""
import json, struct, sys
import numpy as np

src, dst = sys.argv[1], sys.argv[2]
S0 = float(sys.argv[3]) if len(sys.argv) > 3 else -0.1
S1 = float(sys.argv[4]) if len(sys.argv) > 4 else 0.75

b = open(src, 'rb').read()
jl = struct.unpack('<I', b[12:16])[0]
g = json.loads(b[20:20 + jl])
bin_off = 20 + jl + 8
binb = bytearray(b[bin_off:bin_off + struct.unpack('<I', b[20 + jl:24 + jl])[0]])

CT = {5126: ('f', 4), 5121: ('B', 1), 5123: ('H', 2)}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

def acc(i):
    a = g['accessors'][i]; v = g['bufferViews'][a['bufferView']]
    t, sz = CT[a['componentType']]; n = NC[a['type']]
    off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = v.get('byteStride', sz * n)
    dt = np.dtype(t)
    arr = np.ndarray((a['count'], n), dtype=dt, buffer=binb, offset=off, strides=(stride, sz))
    return arr

skin = g['skins'][0]
names = [g['nodes'][k]['name'] for k in skin['joints']]
side = 'Left' if any(n.startswith('Left') for n in names) else 'Right'
ji = {n: i for i, n in enumerate(names)}
h, t1, t2 = ji[side + 'Hand'], ji[side + 'HandThumb1'], ji[side + 'HandThumb2']
ibm = acc(skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)  # column-major
bind = np.linalg.inv(ibm)
P1, P2 = bind[t1][:3, 3], bind[t2][:3, 3]

total_moved = 0.0; touched = 0
for prim in g['meshes'][0]['primitives']:
    at = prim['attributes']
    pos = acc(at['POSITION']).astype(np.float64)
    J = acc(at['JOINTS_0']); W = acc(at['WEIGHTS_0'])
    d = P2 - P1
    s = (pos - P1) @ d / (d @ d)
    x = np.clip((s - S0) / (S1 - S0), 0, 1)
    keep = x * x * (3 - 2 * x)
    for v in range(len(pos)):
        slots = list(J[v])
        if t1 not in slots:
            continue
        k = slots.index(t1)
        w1 = float(W[v, k])
        if w1 <= 0 or keep[v] >= 0.999:
            continue
        mv = w1 * (1 - keep[v])
        W[v, k] = w1 - mv
        if h in slots:
            W[v, slots.index(h)] += mv
        else:
            # put the Hand bone into the weakest other slot (its weight goes to Hand too)
            others = [i for i in range(4) if i != k]
            m = min(others, key=lambda i: W[v, i])
            W[v, m] = W[v, m] + mv
            J[v, m] = h
        tot = W[v].sum()
        if tot > 0:
            W[v] /= tot
        total_moved += mv; touched += 1
print(f"{side}: thumb metacarpal weight moved to hand on {touched} vertices (sum {total_moved:.1f}); S0={S0} S1={S1}")
out = bytearray(b[:bin_off]) + binb + b[bin_off + len(binb):]
open(dst, 'wb').write(out)
