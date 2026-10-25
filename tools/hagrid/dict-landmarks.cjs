// Dump the 21 landmark positions of every dictionary hand shape (right hand,
// hand frame: +Y fingers, +Z out of the palm, metres) for validate.py.
// Needs the app served at http://localhost:8080 (python3 -m http.server 8080).
// Usage: node tools/hagrid/dict-landmarks.cjs [out.json]
const { chromium } = require('playwright');
const out = process.argv[2] || 'dict_landmarks.json';
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await (await b.newContext({ viewport: { width: 320, height: 320 } })).newPage();
  await p.goto('http://localhost:8080/index.html');
  await p.waitForTimeout(1500);
  await p.click('#start-demo');
  await p.waitForTimeout(2000);
  const data = await p.evaluate(() => {
    const H = __hms;
    H.state.frozen = true;
    const rig = H.rigs.right;
    const res = {};
    for (const g of H.GESTURES) {
      H.applyGesture(rig, g);
      rig.group.position.set(0, 0, 0);
      rig.wrist.quaternion.identity();
      res[g.id] = { name: g.name, category: g.category, lm: rig.landmarkPositions().map((v) => [v.x, v.y, v.z].map((x) => +x.toFixed(5))) };
    }
    return res;
  });
  require('fs').writeFileSync(out, JSON.stringify(data));
  console.log(Object.keys(data).length, 'shapes ->', out);
  await b.close();
})();
