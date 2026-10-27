# Joint cubes from the hand's pixels: for the 15 finger joints (thumb
# CMC/MCP/IP, index..pinky MCP/PIP/DIP), how much the bone points at the
# camera and how much its nail side faces the camera (-1..1, crops_cube.py),
# with how sure the network is of each. Same network as the curl model
# (train_curl.py), 30 outputs.
#
#   python3 -I tools/palm/train_cube.py <train.npz[,more]> <score-only.npz[,more]> [out.bin] [steps]
#
# The score-only crops only report the final error; nothing is chosen on them.
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import jax, jax.numpy as jnp
from train import LAYERS, augment, adam

J = 30
SCALE = 1.0


def init(key):
    p = []
    for cin, cout in LAYERS:
        key, k = jax.random.split(key)
        p.append((jax.random.normal(k, (3, 3, cin, cout)) * np.sqrt(2 / (9 * cin)), jnp.zeros(cout)))
    key, k = jax.random.split(key)
    n = 16 * LAYERS[-1][1]
    p.append((jax.random.normal(k, (n, 2 * J)) * np.sqrt(1 / n), jnp.zeros(2 * J)))
    return p


def forward(p, x):
    h = x - 0.5
    for w, b in p[:-1]:
        h = jax.lax.conv_general_dilated(h, w, (2, 2), 'SAME', dimension_numbers=('NHWC', 'HWIO', 'NHWC')) + b
        h = jax.nn.relu(h)
    h = h.reshape(h.shape[0], -1)  # 4x4x64, row by row, channels last
    w, b = p[-1]
    o = h @ w + b
    return o[:, :J], o[:, J:]  # mean (units of SCALE), log spread


def loss(p, x, y):
    mu, ls = forward(p, x)
    ls = jnp.clip(ls, -4, 2)
    return jnp.mean(0.5 * ((y - mu) * jnp.exp(-ls)) ** 2 + ls)


def predict(p, X):
    out = [forward(p, jnp.asarray(X[i:i + 256].astype(np.float32) / 255)) for i in range(0, len(X), 256)]
    mu = np.concatenate([np.asarray(m) for m, _ in out]) * SCALE
    sd = np.exp(np.clip(np.concatenate([np.asarray(s) for _, s in out]), -4, 2)) * SCALE
    return mu, sd


def report(p, d, name):
    mu, sd = predict(p, d['x'])
    a = d['cube']
    err = np.abs(mu - a)
    sure = sd < 0.2
    # Wrong side: the true value clearly one way (|a| > 0.3), the reading the other.
    wrong = (np.abs(a) > 0.3) & (np.sign(mu) != np.sign(a))
    print(f'{name}: {len(a)} crops, ALONG error {err[:, :15].mean():.3f} wrong side {wrong[:, :15].mean() * 100:.1f}%,'
          f' NAIL error {err[:, 15:].mean():.3f} wrong side {wrong[:, 15:].mean() * 100:.1f}%;'
          f' sure on {sure.mean() * 100:.0f}%, error there {err[sure].mean():.3f}')
    return mu, sd


def load(path):
    flat = np.fromfile(path, np.float16).astype(np.float32)
    p, o = [], 0
    shapes = [((3, 3, ci, co), (co,)) for ci, co in LAYERS] + [((16 * LAYERS[-1][1], 2 * J), (2 * J,))]
    for ws, bs in shapes:
        nw, nb = int(np.prod(ws)), int(np.prod(bs))
        p.append((jnp.asarray(flat[o:o + nw].reshape(ws)), jnp.asarray(flat[o + nw:o + nw + nb])))
        o += nw + nb
    return p


if __name__ == '__main__' and sys.argv[1] == '--predict':
    # --predict <weights.bin> <crops.npz> <out.json>: each crop's reading, by
    # sample id, for tools/synth-eval.mjs --picture.
    import json
    p = load(sys.argv[2])
    d = np.load(sys.argv[3])
    mu, sd = predict(p, d['x'])
    json.dump({i: [m.round(2).tolist(), s.round(2).tolist()] for i, m, s in zip(d['ids'].tolist(), mu, sd)}, open(sys.argv[4], 'w'))
    sys.exit(0)

if __name__ == '__main__':
    parts = [np.load(q) for q in sys.argv[1].split(',')]
    tr = {k: np.concatenate([q[k] for q in parts]) for k in ('x', 'cube')}
    scores = [(q, np.load(q)) for q in sys.argv[2].split(',')]
    out = sys.argv[3] if len(sys.argv) > 3 else 'vendor/models/joint_cube.bin'
    steps = int(sys.argv[4]) if len(sys.argv) > 4 else 8000
    rng = np.random.default_rng(2)
    # Held back by picture: the #left and #right crops of one two-hand render
    # go to the same side of the split (one picture, one hand seen in both).
    ids = np.concatenate([q['ids'] for q in parts])
    pic = np.array([str(i).split('#')[0] for i in ids])
    groups = rng.permutation(np.unique(pic))
    back = set(groups[: len(groups) // 10].tolist())
    held = np.array([g in back for g in pic])
    idx = np.concatenate([np.flatnonzero(held), rng.permutation(np.flatnonzero(~held))])
    nv = int(held.sum())
    val = {'x': tr['x'][idx[:nv]], 'cube': tr['cube'][idx[:nv]]}
    X, A = tr['x'][idx[nv:]], tr['cube'][idx[nv:]] / SCALE
    p = init(jax.random.PRNGKey(1))
    zeros = lambda: [(jnp.zeros_like(a), jnp.zeros_like(b)) for a, b in p]
    m, v = zeros(), zeros()
    grad = jax.jit(jax.value_and_grad(loss))
    t0 = time.time()
    for t in range(1, steps + 1):
        b = rng.integers(0, len(X), 64)
        l, g = grad(p, jnp.asarray(augment(rng, X[b])), jnp.asarray(A[b]))
        lr = 2e-3 * (0.5 * (1 + np.cos(np.pi * t / steps)))
        p, m, v = adam(p, g, m, v, t, lr)
        if t % 1000 == 0:
            print(f'step {t} loss {float(l):.3f} ({time.time() - t0:.0f} s)')
            report(p, val, '  held back')
    for name, sc in scores:
        report(p, sc, f'SCORE-ONLY {name.split("/")[-1]}')
    flat = np.concatenate([np.asarray(a, np.float32).ravel() for wb in p for a in wb]).astype(np.float16)
    flat.tofile(out)
    print(f'{flat.size} weights -> {out} ({flat.nbytes / 1024:.0f} KB)')
