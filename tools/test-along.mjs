// The joint cube's "along" is one quantity from training to the fit:
//   training label (tools/palm/crops_cube.py cube_labels): the cosine between
//     the bone, joint to next joint, and the line from the joint to the
//     camera, in the render camera's space;
//   fit (src/fit.js): the fitted bone's component along view, in the frame
//     lift.js builds: x, y where the picture shows each point, depth along
//     the line of sight. A bone lying along its own line to the camera shows
//     no length in the picture, so in that frame it is all depth: the line of
//     sight is the depth axis at every point, view = +z (-z when main.js turns
//     the hands around for a camera facing the person).
// Why the fit takes the lift's depth axis and not the camera ray: lift.js is
// weak perspective (no camera line per point), so its depth axis IS the line
// of sight wherever the hand is. Checked on the renders (2026-10-27): true
// labels fed to the fit, seed 10 joint angle error 15.44 deg with view +z,
// 15.53 with the bone dotted with the camera ray; real lift output, label vs
// lifted bone z 0.47-0.57 either way. So the ray brings nothing there.
//
// Here, bones in the middle of the picture, at the left, right, top and bottom
// edges and in a corner, for a right and a left hand:
//   - the label (run through the Python code itself) is exactly the bone's
//     cosine with the joint's line to the camera;
//   - the camera's own +z is not (off at the edges), so a solver in camera
//     axes would have to use the ray, not +z;
//   - the turned frame with view -z gives the same value.
//
//   node tools/test-along.mjs
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import { focalW } from '../src/camera.js';

let fails = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) fails++;
};
const ASPECT = 720 / 1280; // the renders (tools/synth-render.mjs), portrait
// The render camera: 66 degrees vertical = across the long side.
const cam = new THREE.PerspectiveCamera(66, ASPECT, 0.01, 10);
cam.updateMatrixWorld();
const project = (p) => {
  const v = new THREE.Vector3(...p).project(cam);
  return [(v.x + 1) / 2, (1 - v.y) / 2];
};
// A joint at picture point (x, y), 40 cm away, and a bone from it.
const place = (x, y, depth = 0.4) => {
  const f = focalW(ASPECT);
  return [((x - 0.5) / f) * depth, (-((y - 0.5) / ASPECT) / f) * depth, -depth];
};
// The bone's turn as the render stores it: WebXR joints, -z along the bone.
const turnFor = (b) => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), new THREE.Vector3(...b).normalize()).toArray();

const spots = { middle: [0.5, 0.5], left: [0.05, 0.5], right: [0.95, 0.5], top: [0.5, 0.04], bottom: [0.5, 0.96], corner: [0.06, 0.94] };
const bones = { 'toward camera': [0.1, -0.2, 1], across: [1, 0.3, 0.1], 'down-away': [0.2, -1, -0.6] };
const cases = [];
for (const side of ['right', 'left']) {
  for (const [sn, [x, y]] of Object.entries(spots)) {
    for (const [bn, b0] of Object.entries(bones)) {
      const b = side === 'left' ? [-b0[0], b0[1], b0[2]] : b0;
      cases.push({ side, sn, bn, x, y, J: place(x, y), b: new THREE.Vector3(...b).normalize().toArray() });
    }
  }
}
// The renderer's projection and the app's camera agree.
const worst = Math.max(...cases.map((c) => Math.hypot(project(c.J)[0] - c.x, project(c.J)[1] - c.y)));
check(worst < 1e-6, `render camera (66 deg vertical) puts each joint where camera.js expects (worst ${worst.toExponential(1)})`);

// Labels through the Python code: truth with joint 5 (index MCP) at J, cube turned along b.
const truths = cases.map((c) => {
  const joints = Array.from({ length: 21 }, () => [0, 0, -0.4]);
  const cubes = Array.from({ length: 21 }, () => [0, 0, 0, 1]);
  joints[5] = c.J;
  cubes[5] = turnFor(c.b);
  return { joints, cubes };
});
const py = `import sys, json; sys.path.insert(0, 'tools/palm'); from crops_cube import cube_labels
print(json.dumps([cube_labels(t)[3] for t in json.load(sys.stdin)]))`;
const labels = JSON.parse(execFileSync('python3', ['-c', py], { input: JSON.stringify(truths) }).toString());

// The camera line of a picture point, in camera axes.
const lineTo = (x, y) => {
  const f = focalW(ASPECT);
  const v = [-(x - 0.5) / f, ((y - 0.5) / ASPECT) / f, 1];
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
};
let worstCam = 0;
let worstLine = 0;
cases.forEach((c, n) => {
  const line = lineTo(c.x, c.y);
  const onLine = c.b[0] * line[0] + c.b[1] * line[1] + c.b[2] * line[2];
  worstLine = Math.max(worstLine, Math.abs(onLine - labels[n]));
  if (c.sn !== 'middle') worstCam = Math.max(worstCam, Math.abs(c.b[2] - labels[n]));
});
check(worstLine < 1e-6, `training label = bone on the joint's line to the camera, every spot, both hands (worst ${worstLine.toExponential(1)})`);
check(worstCam > 0.1, `the camera's own +z is not the label off the middle (off by up to ${worstCam.toFixed(2)})`);

// A camera facing the person: main.js turns the points 180 deg about y for the
// solver and gives view -z; the bone's component on it is the same.
const turned = cases.every((c, n) => {
  const view = [0, 0, -1];
  const bt = [-c.b[0], c.b[1], -c.b[2]];
  return Math.abs(bt[0] * view[0] + bt[1] * view[1] + bt[2] * view[2] - c.b[2]) < 1e-12;
});
check(turned, 'turned around for a camera facing the person, with view -z: same value');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
