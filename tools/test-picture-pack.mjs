// Checks jointCube.js packPicture/unpackPicture: the picture model readings a
// filmed take keeps in its raw record come back as the solver's picture input
// (withCubes), to the 3 decimals kept.
//   node tools/test-picture-pack.mjs
import { packPicture, unpackPicture, withCubes } from '../src/jointCube.js';

const KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const curl = Object.fromEntries(KEYS.map((k, f) => [k, [0, 1, 2].map((i) => ({ flex: 7.12345 * (f + i), sd: 3 + i }))]));
const cubes = Object.fromEntries(KEYS.map((k, f) => [k, [0, 1, 2].map((i) => ({ along: 0.1 * f - 0.05 * i, asd: 0.2, nail: -0.3 + 0.1 * i, nsd: 0.25 }))]));
const fail = [];
const want = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail.push(what); };
const close = (a, b) => KEYS.every((k) => [0, 1, 2].every((i) => Object.keys(a[k][i]).every((n) => (Array.isArray(a[k][i][n]) ? a[k][i][n].join() === b[k][i][n].join() : Math.abs(a[k][i][n] - b[k][i][n]) <= 5e-4))));
for (const view of [[0, 0, 1], [0, 0, -1]]) {
  const back = unpackPicture(JSON.parse(JSON.stringify(packPicture(curl, cubes, view))));
  want(close(withCubes(curl, cubes, view), back), `curl + cubes, view ${view[2]}`);
}
want(close(curl, unpackPicture(packPicture(curl, null, null))), 'curl only (no lift, no cubes)');
want(close(withCubes(null, cubes, [0, 0, 1]), unpackPicture(packPicture(null, cubes, [0, 0, 1]))), 'cubes only (curl weights not loaded)');
want(unpackPicture({}) === null, 'nothing kept: no picture input');
if (fail.length) process.exit(1);
console.log('all picture pack checks pass');
