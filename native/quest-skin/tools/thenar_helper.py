"""Add a thenar helper bone to a skinned hand GLB (game-rig style volume keeper).

User 2026-11-14: the triangle between thumb base and wrist went EMPTY when the thumb moved (no
thenar muscle volume). Plain weights can't keep volume: the thenar either swings out with the thumb
metacarpal (hump) or stays on the hand (hollow wedge). Fix used in game rigs: a helper bone at the
thumb metacarpal joint that turns only HALF as much as the thumb metacarpal; the thenar skin is
weighted to it, so it stretches between hand and thumb and fills the wedge.

Adds node "<Side>HandThenar" (child of <Side>Hand, same rest as <Side>HandThumb1) and moves the
Thumb1 weight of thenar vertices (s < S1 along the metacarpal, faded by smoothstep) to it.
The runtime (SkinRig) drives any bone whose name contains "Thenar" at HALF the Thumb1 rotation.

python3 thenar_helper.py in.glb out.glb [S0 S1 [R]]

Also adds "<bone>_half" helpers at the wrist and every finger knuckle (zone +-R bone lengths), driven
at half the joint rotation: keeps knuckles/wrist from thinning (linear-blend-skinning volume loss).
"""
import json, struct, sys
import numpy as np

src, dst = sys.argv[1], sys.argv[2]
S0 = float(sys.argv[3]) if len(sys.argv) > 3 else 0.35
S1 = float(sys.argv[4]) if len(sys.argv) > 4 else 0.9

b = open(src, 'rb').read()
jl = struct.unpack('<I', b[12:16])[0]
g = json.loads(b[20:20 + jl])
blen = struct.unpack('<I', b[20 + jl:24 + jl])[0]
binb = bytearray(b[28 + jl:28 + jl + blen])
CT = {5126: ('<f4', 4), 5121: ('u1', 1), 5123: ('<u2', 2)}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

def acc(i):
    a = g['accessors'][i]; v = g['bufferViews'][a['bufferView']]
    t, sz = CT[a['componentType']]; n = NC[a['type']]
    off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = v.get('byteStride', sz * n)
    return np.ndarray((a['count'], n), dtype=np.dtype(t), buffer=binb, offset=off, strides=(stride, sz))

skin = g['skins'][0]
names = [g['nodes'][k]['name'] for k in skin['joints']]
side = 'Left' if any(n.startswith('Left') for n in names) else 'Right'
ji = {n: i for i, n in enumerate(names)}
h, t1, t2 = ji[side + 'Hand'], ji[side + 'HandThumb1'], ji[side + 'HandThumb2']
ibm_all = acc(skin['inverseBindMatrices']).copy()
bind = np.linalg.inv(ibm_all.reshape(-1, 4, 4).transpose(0, 2, 1))
P1, P2 = bind[t1][:3, 3], bind[t2][:3, 3]

# new node: same local TRS as Thumb1, child of Hand
hand_node = skin['joints'][h]; t1_node = g['nodes'][skin['joints'][t1]]
new = {k: t1_node[k] for k in ('translation', 'rotation', 'scale', 'matrix') if k in t1_node}
new['name'] = side + 'HandThenar'
g['nodes'].append(new)
nid = len(g['nodes']) - 1
g['nodes'][hand_node].setdefault('children', []).append(nid)
skin['joints'].append(nid)
th = len(skin['joints']) - 1

# weights
moved = 0.0; touched = 0
for prim in g['meshes'][0]['primitives']:
    at = prim['attributes']
    pos = acc(at['POSITION']).astype(np.float64); J = acc(at['JOINTS_0']); W = acc(at['WEIGHTS_0'])
    d = P2 - P1
    s = (pos - P1) @ d / (d @ d)
    x = np.clip((s - S0) / (S1 - S0), 0, 1)
    to_helper = 1 - x * x * (3 - 2 * x)
    for v in np.nonzero((J == t1).any(1) & (to_helper > 0.001))[0]:
        k = list(J[v]).index(t1)
        mv = float(W[v, k]) * to_helper[v]
        if mv <= 0:
            continue
        if mv >= W[v, k] - 1e-6:
            J[v, k] = th            # whole slot goes to the helper
        else:
            others = [i for i in range(4) if i != k]
            m = min(others, key=lambda i: W[v, i])
            W[v, k] -= mv
            W[v, m] = mv + (W[v, m] if J[v, m] == th else 0)
            if J[v, m] != th:
                pass
            J[v, m] = th
            W[v] /= W[v].sum()
        moved += mv; touched += 1

# ---- generic half joints (wrist + finger knuckles): helper at the child joint, turns half ----
R = float(sys.argv[5]) if len(sys.argv) > 5 else 0.35     # zone half-width, in bone lengths
extra_ibm = [ibm_all[t1]]
parent_of = {}
for i, nidx in enumerate(skin['joints']):
    for c in g['nodes'][nidx].get('children', []):
        if c in skin['joints']:
            parent_of[skin['joints'].index(c)] = i
child_of = {}
for c, p in parent_of.items():
    child_of.setdefault(p, []).append(c)
pairs = []
for c, p in parent_of.items():
    n = names[c] if c < len(names) else ''
    if n.endswith('Thenar') or n[-1:] == '4' or 'Thumb1' in n:
        continue
    if n == side + 'Hand' or (n.startswith(side + 'Hand') and n[-1:] in '123'):
        pairs.append((p, c))
prims = g['meshes'][0]['primitives']
for p, c in pairs:
    kids = child_of.get(c, [])
    tip = None
    if c == h:
        tip = ji.get(side + 'HandMiddle1')
    elif kids:
        tip = kids[0]
    if tip is None:
        continue
    Pc, Pt, Pp = bind[c][:3, 3], bind[tip][:3, 3], bind[p][:3, 3]
    hn = {k: g['nodes'][skin['joints'][c]][k] for k in ('translation', 'rotation', 'scale', 'matrix') if k in g['nodes'][skin['joints'][c]]}
    hn['name'] = names[c] + '_half'
    g['nodes'].append(hn); nid = len(g['nodes']) - 1
    g['nodes'][skin['joints'][p]].setdefault('children', []).append(nid)
    skin['joints'].append(nid); hj = len(skin['joints']) - 1
    extra_ibm.append(ibm_all[c])
    cnt = 0
    for prim in prims:
        at = prim['attributes']
        pos = acc(at['POSITION']).astype(np.float64); J = acc(at['JOINTS_0']); W = acc(at['WEIGHTS_0'])
        dc = Pt - Pc; dp = Pc - Pp
        sc = (pos - Pc) @ dc / (dc @ dc)                 # >0 on the child side
        sp = (pos - Pc) @ dp / (dp @ dp)                 # <0 on the parent side
        s_ = np.where(sc >= 0, sc, sp)
        x = np.clip(np.abs(s_) / R, 0, 1)
        bell = 0.5 * (1 - x * x * (3 - 2 * x))
        sel = np.nonzero(((J == c) | (J == p)).any(1) & (bell > 0.01))[0]
        for v in sel:
            mv = 0.0
            for k in range(4):
                if J[v, k] in (c, p) and W[v, k] > 0:
                    d = W[v, k] * bell[v]; W[v, k] -= d; mv += d
            if mv <= 0:
                continue
            m = min(range(4), key=lambda i: W[v, i])
            W[v, m] = mv; J[v, m] = hj
            W[v] /= W[v].sum(); cnt += 1
    print(f"half joint {names[c]}_half (parent {names[p]}): {cnt} vertices")

# new IBM accessor (old + helpers), appended to the buffer
ibm_new = np.vstack([ibm_all] + [e[None] for e in extra_ibm]).astype('<f4')
while len(binb) % 4:
    binb.append(0)
off = len(binb); binb += ibm_new.tobytes()
g['bufferViews'].append({'buffer': 0, 'byteOffset': off, 'byteLength': ibm_new.nbytes})
g['accessors'].append({'bufferView': len(g['bufferViews']) - 1, 'componentType': 5126, 'count': len(ibm_new), 'type': 'MAT4'})
skin['inverseBindMatrices'] = len(g['accessors']) - 1
g['buffers'][0]['byteLength'] = len(binb)

js = json.dumps(g, separators=(',', ':')).encode()
while len(js) % 4:
    js += b' '
while len(binb) % 4:
    binb.append(0)
out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binb))
out += struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(binb), 0x004E4942) + bytes(binb)
open(dst, 'wb').write(out)
print(f"{side}: added {side}HandThenar (joint {th}); {touched} vertices, weight {moved:.1f} moved from Thumb1; S0={S0} S1={S1}")
