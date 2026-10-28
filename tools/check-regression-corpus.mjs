// Fail early if the complete, unchanged regression corpus is unavailable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const external = '/mnt/project-files/hand-motion-studio/takes/';
const folder = process.argv[2] || (fs.existsSync(external) ? external : path.join(root, 'data/takes'));
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tools/regress-baseline.json'), 'utf8'));
const missing = Object.keys(baseline).filter(name => !fs.existsSync(path.join(folder, name)));
if (missing.length) {
  console.error('Incomplete regression corpus: ' + missing.length + ' missing from ' + folder);
  missing.forEach(name => console.error('  ' + name));
  process.exitCode = 1;
} else console.log('All ' + Object.keys(baseline).length + ' baseline take files are present; metric replay is still required.');
