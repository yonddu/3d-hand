// Training renders only (tools/synth-render.mjs): paints what tells a palm
// from a back of the hand in a picture onto the app's MIT hand model, which
// has one flat colour: nails, flexion creases at the finger joints, palm
// lines, knuckle wrinkles, and the lighter palm skin.
//
// Colour only, in a separate material on the render's own hand: the mesh is
// not changed, and the app's hands and GLB export never load this file.
import * as THREE from 'three';

const FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const chainNames = (k) =>
  k === 'thumb'
    ? ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip']
    : ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map((n) => `${k}-finger-${n}`);

// Per vertex, from the rest pose: c1 = (nail ellipse distance, signed distance
// along the finger to its nearest bending joint (m), back-of-hand side -1..1,
// on a finger 1 / palm 0); c2 = palm coordinates (0 index side .. 1 pinky
// side, 0 wrist .. 1 middle knuckle).
function cueAttributes(real) {
  const g = real.mesh.geometry;
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const R = real.restPos;
  const side = real.side;
  // Back of the hand: the side the nails are on, away from the palm.
  const back = new THREE.Vector3(0, 0, -1).applyQuaternion(real.restFrame);
  const segs = [];
  for (const k of FINGER_KEYS) {
    const c = chainNames(k).map((n) => R[n]);
    for (let i = 0; i < c.length - 1; i++) segs.push({ k, i, last: i === c.length - 2, a: c[i], b: c[i + 1], first: i === 0 });
  }
  const idx = R['index-finger-phalanx-proximal'];
  const pky = R['pinky-finger-phalanx-proximal'];
  const mid = R['middle-finger-phalanx-proximal'];
  const across = pky.clone().sub(idx);
  const up = mid.clone().sub(R.wrist);
  const c1 = new Float32Array(pos.count * 4);
  const c2 = new Float32Array(pos.count * 2);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const ab = new THREE.Vector3();
  for (let v = 0; v < pos.count; v++) {
    p.fromBufferAttribute(pos, v);
    n.fromBufferAttribute(nrm, v);
    let best = null;
    for (const s of segs) {
      ab.subVectors(s.b, s.a);
      const L = ab.length();
      const t = THREE.MathUtils.clamp(p.clone().sub(s.a).dot(ab) / (L * L), 0, 1);
      const d = p.distanceTo(s.a.clone().addScaledVector(ab, t));
      if (!best || d < best.d) best = { s, t, d, L, ab: ab.clone().normalize() };
    }
    const dorsal = n.dot(back);
    const { s, t, L } = best;
    // Round the finger sideways (0 on the back's middle line, 1 at its sides).
    const sideways = n.dot(best.ab.clone().cross(back).normalize());
    const nail = s.last && dorsal > 0 ? Math.hypot((t - 0.62) / 0.36, sideways / 0.62) : 3;
    // Signed distance to the nearest bending joint along the chain (a
    // segment's ends; the metacarpal only at the knuckle, the tip piece
    // only at its base).
    const along = t * L;
    const jd = s.first ? along - L : s.last ? along : along < L / 2 ? along : along - L;
    c1.set([nail, jd, dorsal, s.first && s.k !== 'thumb' ? 0 : 1], v * 4);
    const q = p.clone().sub(idx);
    c2.set([q.dot(across) / across.lengthSq(), p.clone().sub(R.wrist).dot(up) / up.lengthSq()], v * 2);
  }
  g.setAttribute('cue1', new THREE.BufferAttribute(c1, 4));
  g.setAttribute('cue2', new THREE.BufferAttribute(c2, 2));
}

const FRAG = `
  float dorsal = vCue1.z;
  float palmar = clamp((0.05 - dorsal) / 0.45, 0.0, 1.0);
  float onBack = clamp((dorsal - 0.2) / 0.4, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, uPalmTint, uPalmLight * palmar);
  float jd = abs(vCue1.y);
  // Flexion creases: a double line at each finger joint on the palm side.
  float crease = max(1.0 - smoothstep(0.00035, 0.0009, jd), 1.0 - smoothstep(0.00035, 0.0009, abs(jd - 0.0022)));
  crease *= palmar * vCue1.w;
  // Knuckle wrinkles on the back.
  float wr = (0.5 + 0.5 * cos(vCue1.y * 6.2832 / 0.0016)) * (1.0 - smoothstep(0.0015, 0.0045, jd)) * onBack * vCue1.w;
  // Palm lines (heart, head, life) on the palm.
  vec2 u = vCue2;
  float heart = abs(u.y - (0.80 - 0.12 * (u.x - 0.9) * (u.x - 0.9))) + 1.0 - smoothstep(0.15, 0.4, u.x);
  float head = abs(u.y - (0.66 - 0.16 * u.x)) + smoothstep(0.7, 0.95, u.x);
  float life = abs(length((u - vec2(-0.35, 0.25)) * vec2(1.0, 1.1)) - 0.62) + 1.0 - smoothstep(0.05, 0.25, u.y) + smoothstep(0.6, 0.8, u.y);
  float pl = 1.0 - smoothstep(0.008, 0.022, min(heart, min(head, life)));
  pl *= smoothstep(0.0, 0.15, u.y);
  pl *= palmar * (1.0 - vCue1.w);
  diffuseColor.rgb *= 1.0 - uCrease * max(crease, pl * 0.8) - uCrease * 0.45 * wr;
  float nail = 1.0 - smoothstep(0.86, 1.0, vCue1.x);
  diffuseColor.rgb = mix(diffuseColor.rgb, uNail, nail * uNailAmt);
  vNailF = nail;
`;

// A material for the render's hand: the hand's own (skinning, wrist fade)
// plus the painted cues. vary(rnd) redraws how strong each cue is.
export function paintHand(real) {
  if (!real.mesh.geometry.attributes.cue1) cueAttributes(real);
  const base = real.mesh.material;
  const m = base.clone();
  const prev = base.onBeforeCompile;
  const u = {
    uPalmTint: { value: new THREE.Color(0xf2c9b5) },
    uPalmLight: { value: 0.3 },
    uCrease: { value: 0.35 },
    uNail: { value: new THREE.Color(0xf4d6d0) },
    uNailAmt: { value: 0.6 },
  };
  m.customProgramCacheKey = () => `synth-skin|${prev ? prev.toString() : ''}`;
  m.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute vec4 cue1;\nattribute vec2 cue2;\nvarying vec4 vCue1;\nvarying vec2 vCue2;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCue1 = cue1;\nvCue2 = cue2;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying vec4 vCue1;\nvarying vec2 vCue2;\nuniform vec3 uPalmTint;\nuniform float uPalmLight;\nuniform float uCrease;\nuniform vec3 uNail;\nuniform float uNailAmt;\nfloat vNailF;\n#include <common>')
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.22, vNailF);');
  };
  m.opacity = 1;
  real.mesh.material = m;
  return {
    material: m,
    vary(rnd, skin) {
      m.color.copy(skin);
      // Palms are lighter and pinker than backs, more so on darker skin.
      const dark = 1 - skin.getHSL({}).l;
      u.uPalmTint.value.copy(skin).lerp(new THREE.Color(0xf3cdb8), 0.5 + 0.4 * rnd());
      u.uPalmLight.value = (0.25 + 0.6 * dark) * (0.5 + 0.7 * rnd());
      u.uCrease.value = 0.15 + 0.35 * rnd();
      u.uNail.value.copy(skin).lerp(new THREE.Color(rnd() < 0.15 ? new THREE.Color().setHSL(rnd(), 0.6, 0.5) : 0xf6dcd6), 0.4 + 0.5 * rnd());
      u.uNailAmt.value = 0.5 + 0.5 * rnd();
    },
  };
}
