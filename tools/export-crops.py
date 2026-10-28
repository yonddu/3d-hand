# Hand crops kept in the user's takes (app option 'save-crops': every 5th
# frame, 64x64, wrist at the bottom, middle finger up; tools/palm/crops.py)
# as contact sheets for hand labelling (data/real-labels/README.md).
#   python3 tools/export-crops.py /mnt/project-files/hand-motion-studio/takes/ data/real-labels
import base64, csv, io, json, os, struct, sys
from PIL import Image, ImageDraw

TAKES, OUT = sys.argv[1], sys.argv[2]
SCORE_ONLY = {'pen_grip_02-41.glb', 'thumb_on_index_00-39.glb'}  # labels only for scoring, never for training
TILE, COLS, ROWS = 192, 5, 4
rows, tiles = [], []
for name in sorted(os.listdir(TAKES)):
    if not name.endswith('.glb'):
        continue
    b = open(os.path.join(TAKES, name), 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + n])
    node = next((x for x in j.get('scenes', []) + j.get('nodes', []) if x.get('extras', {}).get('raw')), None)
    if not node:
        continue
    for f in node['extras']['raw']['frames']:
        for h in f['hands']:
            if not h.get('crop'):
                continue
            im = Image.open(io.BytesIO(base64.b64decode(h['crop'].split(',')[1]))).convert('RGB').resize((TILE, TILE), Image.BICUBIC)
            cid = f'c{len(rows) + 1:04d}'
            rows.append({'id': cid, 'take': name, 't': round(f['t'], 3), 'hand': h['label'], 'use': 'score' if name in SCORE_ONLY else 'train'})
            tiles.append((cid, im))
per = COLS * ROWS
for s in range(0, len(tiles), per):
    sheet = Image.new('RGB', (COLS * TILE, ROWS * (TILE + 18)), 'white')
    d = ImageDraw.Draw(sheet)
    for k, (cid, im) in enumerate(tiles[s:s + per]):
        x, y = (k % COLS) * TILE, (k // COLS) * (TILE + 18)
        sheet.paste(im, (x, y + 18))
        d.text((x + 4, y + 3), cid, fill='black')
    sheet.save(os.path.join(OUT, 'sheets', f'sheet_{s // per + 1:03d}.jpg'), quality=88)
for i, r in enumerate(rows):
    r['sheet'] = f'sheet_{i // per + 1:03d}.jpg'
FIELDS = ['id', 'sheet', 'take', 't', 'hand', 'use', 'thumb', 'index', 'middle', 'ring', 'pinky', 'thumb_touch', 'view', 'sure', 'note']
with open(os.path.join(OUT, 'labels.csv'), 'w', newline='') as fh:
    w = csv.DictWriter(fh, fieldnames=FIELDS)
    w.writeheader()
    for r in rows:
        w.writerow({k: r.get(k, '') for k in FIELDS})
print(len(rows), 'crops,', (len(rows) + per - 1) // per, 'sheets')
