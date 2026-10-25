// Options panel: per-finger range of motion. Edits apply to the solver at once
// and are remembered in this browser.
import { FINGERS, LIMITS, DEFAULT_LIMITS, setLimits } from './skeleton.js';

const KEY = 'hms.rom.v2';
const THUMB_JOINTS = ['CMC', 'MCP', 'IP'];

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) setLimits(JSON.parse(raw));
  } catch {
    // Private mode or bad data: keep the defaults.
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(LIMITS));
  } catch {
    // Not remembered, but still applied for this session.
  }
}

export function initRomPanel(root, onChange = () => {}) {
  load();
  const render = () => {
    root.textContent = '';
    for (const finger of FINGERS) {
      const box = document.createElement('details');
      box.className = 'rom';
      const sum = document.createElement('summary');
      sum.textContent = finger.label;
      box.append(sum);
      const table = document.createElement('table');
      table.innerHTML = '<thead><tr><th></th><th>굽힘 최소</th><th>굽힘 최대</th><th>벌림 최소</th><th>벌림 최대</th></tr></thead>';
      const body = document.createElement('tbody');
      const names = finger.key === 'thumb' ? THUMB_JOINTS : finger.jointNames;
      LIMITS[finger.key].forEach((row, k) => {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.textContent = names[k];
        tr.append(th);
        row.forEach((v, j) => {
          const td = document.createElement('td');
          const input = document.createElement('input');
          input.type = 'number';
          input.step = '1';
          input.min = '-180';
          input.max = '180';
          input.value = String(v);
          input.setAttribute('aria-label', `${finger.label} ${names[k]} ${['굽힘 최소', '굽힘 최대', '벌림 최소', '벌림 최대'][j]}`);
          input.onchange = () => {
            const x = Number(input.value);
            if (!Number.isFinite(x)) {
              input.value = String(LIMITS[finger.key][k][j]);
              return;
            }
            const r = LIMITS[finger.key][k];
            r[j] = x;
            // Keep min <= max in each pair.
            const lo = j < 2 ? 0 : 2;
            if (r[lo] > r[lo + 1]) [r[lo], r[lo + 1]] = [r[lo + 1], r[lo]];
            save();
            render();
            root.querySelectorAll('details.rom')[FINGERS.indexOf(finger)].open = true;
            onChange();
          };
          td.append(input);
          tr.append(td);
        });
        body.append(tr);
      });
      table.append(body);
      box.append(table);
      root.append(box);
    }
  };
  render();
  return {
    reset() {
      setLimits(DEFAULT_LIMITS);
      save();
      render();
      onChange();
    },
  };
}
