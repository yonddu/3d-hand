# Palm or back of the hand toward the camera, from the hand's pixels: a small
# network trained on the painted synthetic renders (tools/synthSkin.js,
# tools/palm/crops.py). Weights go to vendor/models/palm_face.bin, which the
# app runs in plain JS (src/palmFace.js).
#
#   python3 -I tools/palm/train.py <train.npz[,more.npz]> <score-only.npz[,more.npz]> [out.bin] [steps]
#
# The score-only crops (regress-split.json syntheticHoldout) only report the
# final accuracy; nothing is chosen on them.
import sys, json, time
import io
import numpy as np
from PIL import Image
import jax, jax.numpy as jnp

LAYERS = [(3, 16), (16, 32), (32, 48), (48, 64)]  # 3x3, stride 2: 64 -> 4
EDGE = 0.3  # |facing| below this: the hand is edge on, the label counts less


def init(key):
    p = []
    for cin, cout in LAYERS:
        key, k = jax.random.split(key)
        p.append((jax.random.normal(k, (3, 3, cin, cout)) * np.sqrt(2 / (9 * cin)), jnp.zeros(cout)))
    key, k = jax.random.split(key)
    p.append((jax.random.normal(k, (LAYERS[-1][1], 1)) * 0.05, jnp.zeros(1)))
    return p


def forward(p, x):
    # x: N,64,64,3 in 0..1
    h = x - 0.5
    for w, b in p[:-1]:
        h = jax.lax.conv_general_dilated(h, w, (2, 2), 'SAME', dimension_numbers=('NHWC', 'HWIO', 'NHWC')) + b
        h = jax.nn.relu(h)
    h = h.mean(axis=(1, 2))
    w, b = p[-1]
    return (h @ w + b)[:, 0]


def loss(p, x, y, wt):
    z = forward(p, x)
    t = (y > 0).astype(jnp.float32)
    return jnp.sum(wt * (jax.nn.softplus(z) - t * z)) / jnp.sum(wt)


def augment(rng, x):
    n = len(x)
    x = x.astype(np.float32) / 255
    flip = rng.random(n) < 0.5  # a mirrored hand faces the same way
    x[flip] = x[flip, :, ::-1]
    # Shift by up to 4 px (the app's crop follows MediaPipe's points, which wander).
    pad = np.pad(x, ((0, 0), (4, 4), (4, 4), (0, 0)), mode='edge')
    dx, dy = rng.integers(0, 9, n), rng.integers(0, 9, n)
    x = np.stack([pad[i, dy[i]:dy[i] + 64, dx[i]:dx[i] + 64] for i in range(n)])
    # Out of focus, motion smear (a moving hand at phone shutter speeds), and
    # phone video compression, each on some of the crops.
    for i in range(n):
        r = rng.random()
        if r < 0.25:
            k = int(rng.integers(1, 3))
            for _ in range(k):  # box blur passes ~ gaussian
                x[i] = (x[i] + np.roll(x[i], 1, 0) + np.roll(x[i], -1, 0)) / 3
                x[i] = (x[i] + np.roll(x[i], 1, 1) + np.roll(x[i], -1, 1)) / 3
        elif r < 0.5:
            a = rng.uniform(0, np.pi)
            L = int(rng.integers(2, 7))
            acc = np.zeros_like(x[i])
            for j in range(L):
                acc += np.roll(x[i], (int(round(j * np.sin(a))), int(round(j * np.cos(a)))), (0, 1))
            x[i] = acc / L
        if rng.random() < 0.4:
            buf = io.BytesIO()
            Image.fromarray((np.clip(x[i], 0, 1) * 255).astype(np.uint8)).save(buf, 'JPEG', quality=int(rng.integers(30, 85)))
            x[i] = np.asarray(Image.open(buf), np.float32) / 255
    # Light, colour, contrast, sensor noise.
    gain = rng.uniform(0.6, 1.4, (n, 1, 1, 1)) * rng.uniform(0.85, 1.15, (n, 1, 1, 3))
    mean = x.mean(axis=(1, 2, 3), keepdims=True)
    x = (x - mean) * rng.uniform(0.7, 1.3, (n, 1, 1, 1)) + mean
    x = x * gain + rng.normal(0, rng.uniform(0, 0.04, (n, 1, 1, 1)), x.shape)
    return np.clip(x, 0, 1)


def adam(p, g, m, v, t, lr):
    out_p, out_m, out_v = [], [], []
    for (pw, pb), (gw, gb), (mw, mb), (vw, vb) in zip(p, g, m, v):
        new = []
        for a, ga, ma, va in ((pw, gw, mw, vw), (pb, gb, mb, vb)):
            ma = 0.9 * ma + 0.1 * ga
            va = 0.999 * va + 0.001 * ga * ga
            a = a - lr * (ma / (1 - 0.9 ** t)) / (jnp.sqrt(va / (1 - 0.999 ** t)) + 1e-8)
            new.append((a, ma, va))
        out_p.append((new[0][0], new[1][0]))
        out_m.append((new[0][1], new[1][1]))
        out_v.append((new[0][2], new[1][2]))
    return out_p, out_m, out_v


def report(p, d, name):
    z = np.concatenate([np.asarray(forward(p, jnp.asarray(d['x'][i:i + 256].astype(np.float32) / 255))) for i in range(0, len(d['x']), 256)])
    y = d['y']
    clear = np.abs(y) >= EDGE
    ok = (z > 0) == (y > 0)
    sure = np.abs(z) > 2.0  # probability above 0.88 either way
    print(f'{name}: {len(y)} crops, right {ok[clear].mean() * 100:.1f}% of clearly turned hands ({clear.sum()}), all {ok.mean() * 100:.1f}%;'
          f' sure on {sure[clear].mean() * 100:.0f}% of clear ones, right {ok[clear & sure].mean() * 100:.1f}% of those')
    return z


if __name__ == '__main__':
    parts = [np.load(p) for p in sys.argv[1].split(',')]
    tr = {k: np.concatenate([p[k] for p in parts]) for k in ('x', 'y')}
    scores = [(p, np.load(p)) for p in sys.argv[2].split(',')]
    out = sys.argv[3] if len(sys.argv) > 3 else 'vendor/models/palm_face.bin'
    rng = np.random.default_rng(1)
    # Hold back a tenth of the training crops to watch overfitting (not the score).
    idx = rng.permutation(len(tr['y']))
    nv = len(idx) // 10
    val = {k: tr[k][idx[:nv]] for k in ('x', 'y')}
    X, Y = tr['x'][idx[nv:]], tr['y'][idx[nv:]]
    W = np.clip(np.abs(Y) / EDGE, 0.15, 1).astype(np.float32)
    p = init(jax.random.PRNGKey(0))
    zeros = lambda: [(jnp.zeros_like(a), jnp.zeros_like(b)) for a, b in p]
    m, v = zeros(), zeros()
    grad = jax.jit(jax.value_and_grad(loss))
    steps = int(sys.argv[4]) if len(sys.argv) > 4 else 6000
    t0 = time.time()
    for t in range(1, steps + 1):
        b = rng.integers(0, len(Y), 64)
        l, g = grad(p, jnp.asarray(augment(rng, X[b])), jnp.asarray(Y[b]), jnp.asarray(W[b]))
        lr = 2e-3 * (0.5 * (1 + np.cos(np.pi * t / steps)))
        p, m, v = adam(p, g, m, v, t, lr)
        if t % 1000 == 0:
            print(f'step {t} loss {float(l):.3f} ({time.time() - t0:.0f} s)')
            report(p, val, '  held back')
    for name, sc in scores:
        report(p, sc, f'SCORE-ONLY {name.split("/")[-1]}')
    # float16, layer by layer: conv weights HWIO then bias, then the last layer.
    flat = np.concatenate([np.asarray(a, np.float32).ravel() for wb in p for a in wb]).astype(np.float16)
    flat.tofile(out)
    print(f'{flat.size} weights -> {out} ({flat.nbytes / 1024:.0f} KB)')
