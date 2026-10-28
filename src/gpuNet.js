// The picture networks' convolutions (palmFace.js conv: 3x3, stride 2,
// 'SAME' padding for an even size, ReLU) on the phone's GPU through WebGL2:
// one draw per layer into a float texture, 4 channels per texel, the next
// layer reading it. Only the last small grid comes back to the CPU. No
// download (a few shaders written here). null where WebGL2 or float render
// targets are missing; the caller then keeps the plain JS loops.
//
// Layout: a layer's output of size os x os with co channels is a texture of
// (os * co/4) x os texels; texel (g * os + x, y) holds channels 4g..4g+3 of
// pixel (x, y). Weights per layer: a float texture (co/4) x (9 * ci4 * 4),
// texel (g, (k * ci4 + j) * 4 + i) = the 4 output weights of input channel
// 4j+i at kernel tap k, for output channels 4g..4g+3 (ci4 = ceil(ci / 4),
// missing input channels 0).

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = (ci4) => `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D x;
uniform highp sampler2D w;
uniform highp sampler2D b;
uniform int size;
uniform int os;
out vec4 o;
void main() {
  int gx = int(gl_FragCoord.x);
  int oy = int(gl_FragCoord.y);
  int g = gx / os;
  int ox = gx - g * os;
  vec4 acc = texelFetch(b, ivec2(g, 0), 0);
  for (int ky = 0; ky < 3; ky++) {
    int iy = oy * 2 + ky;
    if (iy >= size) continue;
    for (int kx = 0; kx < 3; kx++) {
      int ix = ox * 2 + kx;
      if (ix >= size) continue;
      int k = ky * 3 + kx;
      for (int j = 0; j < ${ci4}; j++) {
        vec4 v = texelFetch(x, ivec2(j * size + ix, iy), 0);
        int r = (k * ${ci4} + j) * 4;
        acc += v.x * texelFetch(w, ivec2(g, r), 0);
        acc += v.y * texelFetch(w, ivec2(g, r + 1), 0);
        acc += v.z * texelFetch(w, ivec2(g, r + 2), 0);
        acc += v.w * texelFetch(w, ivec2(g, r + 3), 0);
      }
    }
  }
  o = max(acc, 0.0);
}`;

let shared = null; // one WebGL2 context for every network

function context() {
  if (shared !== null) return shared;
  shared = false;
  try {
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1);
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, preserveDrawingBuffer: false });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return false;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    shared = { gl, buf, programs: new Map() };
  } catch {
    shared = false;
  }
  return shared;
}

function program(ctx, ci4) {
  if (ctx.programs.has(ci4)) return ctx.programs.get(ci4);
  const { gl } = ctx;
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS(ci4)));
  gl.bindAttribLocation(p, 0, 'p');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = (n) => gl.getUniformLocation(p, n);
  const prog = { p, x: u('x'), w: u('w'), b: u('b'), size: u('size'), os: u('os') };
  ctx.programs.set(ci4, prog);
  return prog;
}

function texture(gl, w, h, data) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
  return t;
}

// layers: [{ ci, co, w, b }] as palmFace.js conv takes them (w in HWIO order,
// co a multiple of 4); size: the input crop's side. Returns
// run(x: Float32Array size*size*3, HWC) -> the last layer's output in the
// same HWC order as the JS loops, or null when the GPU path is unavailable.
export function gpuConvs(layers, size) {
  const ctx = context();
  if (!ctx) return null;
  const { gl } = ctx;
  try {
    let s = size;
    const steps = layers.map(({ ci, co, w, b }) => {
      const ci4 = Math.ceil(ci / 4);
      const g4 = co / 4;
      const wt = new Float32Array(g4 * 9 * ci4 * 4 * 4);
      for (let k = 0; k < 9; k++) {
        for (let i = 0; i < ci; i++) {
          const row = (k * ci4 + (i >> 2)) * 4 + (i & 3);
          for (let c = 0; c < co; c++) wt[(row * g4 + (c >> 2)) * 4 + (c & 3)] = w[(k * ci + i) * co + c];
        }
      }
      const os = s / 2;
      const out = texture(gl, os * g4, os, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('float target');
      const step = { ci4, g4, size: s, os, prog: program(ctx, ci4), w: texture(gl, g4, 9 * ci4 * 4, wt), b: texture(gl, g4, 1, new Float32Array(b)), out, fb };
      s = os;
      return step;
    });
    const input = texture(gl, size, size, null);
    const last = steps[steps.length - 1];
    const read = new Float32Array(last.os * last.g4 * last.os * 4);
    const co = layers[layers.length - 1].co;
    return (x) => {
      const rgba = new Float32Array(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        rgba[i * 4] = x[i * 3];
        rgba[i * 4 + 1] = x[i * 3 + 1];
        rgba[i * 4 + 2] = x[i * 3 + 2];
      }
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGBA, gl.FLOAT, rgba);
      gl.bindBuffer(gl.ARRAY_BUFFER, ctx.buf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      let src = input;
      for (const st of steps) {
        gl.useProgram(st.prog.p);
        gl.bindFramebuffer(gl.FRAMEBUFFER, st.fb);
        gl.viewport(0, 0, st.os * st.g4, st.os);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, st.w);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, st.b);
        gl.uniform1i(st.prog.x, 0);
        gl.uniform1i(st.prog.w, 1);
        gl.uniform1i(st.prog.b, 2);
        gl.uniform1i(st.prog.size, st.size);
        gl.uniform1i(st.prog.os, st.os);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = st.out;
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.readPixels(0, 0, last.os * last.g4, last.os, gl.RGBA, gl.FLOAT, read);
      // Back to HWC: pixel (x, y), channel c.
      const os = last.os;
      const y = new Float32Array(os * os * co);
      for (let py = 0; py < os; py++) {
        for (let px = 0; px < os; px++) {
          for (let c = 0; c < co; c++) y[(py * os + px) * co + c] = read[(py * os * last.g4 + (c >> 2) * os + px) * 4 + (c & 3)];
        }
      }
      return y;
    };
  } catch (err) {
    console.warn('picture models: GPU path off,', err.message);
    return null;
  }
}
