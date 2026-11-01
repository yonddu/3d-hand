// Builds app/src/main/assets/hand.html (one file, everything inline) from main.js.
// Run from this folder: node build.mjs  (needs esbuild and three@0.170.0, see package.json)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const out = await build({ entryPoints: ['main.js'], bundle: true, minify: true, format: 'iife', write: false, loader: { '.glb': 'binary' }, legalComments: 'none' });
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}canvas{position:absolute}</style></head>
<body><canvas id="c"></canvas><script>${js}</script></body></html>`;
mkdirSync('../app/src/main/assets', { recursive: true });
writeFileSync('../app/src/main/assets/hand.html', html);
console.log('hand.html', html.length, 'bytes');
