// Reuse the Studio layout and licensed Quest-style skins, without web tracking assets.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
const out = 'dist/native';
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['src/nativeStudio.js'], bundle: true, format: 'esm', minify: true, outfile: `${out}/studio.js` });
const body = readFileSync('app.html', 'utf8').replace(/<link[^>]+https:\/\/fonts\.googleapis\.com[^>]*>/g, '');
writeFileSync(`${out}/index.html`, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>${body}<script type="module" src="studio.js"></script></body></html>`);
for (const side of ['left', 'right']) copyFileSync(`vendor/models/hand-${side}.glb`, `${out}/hand-${side}.glb`);
copyFileSync('vendor/three/LICENSE', `${out}/THREE-LICENSE.txt`);
copyFileSync('vendor/models/LICENSE-webxr-input-profiles.txt', `${out}/WEBXR-LICENSE.txt`);
for (const f of ['index.html', 'studio.js', 'hand-left.glb', 'hand-right.glb']) console.log(`${f}: ${statSync(`${out}/${f}`).size} bytes`);
