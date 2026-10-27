"""Fetch a few hundred HaGRID photos per gesture without downloading the
whole dataset: the per-gesture zips (30-45 GB each) are read with HTTP range
requests, so only the zip's file list and the chosen photos come over.
Validation only (tools/hagrid/eval.mjs): nothing from HaGRID goes into the
app or into training.

  python3 -I tools/hagrid/fetch-images.py <out dir> [per gesture, default 200] [gesture ...]

Writes <out>/<gesture>/<image id>.jpg (long side 1280) and <out>/<gesture>.json (each photo's
boxes, labels and leading hand from HaGRID v2's annotations).
"""
import io
import json
import os
import random
import sys
import urllib.request
import zipfile

from PIL import Image

BASE = 'https://rndml-team-cv.obs.ru-moscow-1.hc.sbercloud.ru/datasets/'
ANN = BASE + 'hagrid_v2/annotations_with_landmarks/annotations.zip'
V1 = {'call', 'dislike', 'fist', 'four', 'like', 'mute', 'ok', 'one', 'palm', 'peace', 'peace_inverted', 'rock', 'stop', 'stop_inverted', 'three', 'three2', 'two_up', 'two_up_inverted'}


def zip_url(g):
    return BASE + ('hagrid/hagrid_dataset_new_554800/hagrid_dataset/' if g in V1 else 'hagrid_v2/hagrid_v2_zip/') + g + '.zip'


class RangeFile(io.RawIOBase):
    """A remote file read with HTTP range requests, seekable for zipfile."""

    def __init__(self, url):
        self.url, self.pos = url, 0
        for attempt in range(5):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=60) as r:
                    self.size = int(r.headers['Content-Length'])
                break
            except OSError:
                if attempt == 4:
                    raise

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b''
        for attempt in range(5):
            try:
                req = urllib.request.Request(self.url, headers={'Range': f'bytes={self.pos}-{self.pos + n - 1}'})
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = r.read()
                break
            except OSError:
                if attempt == 4:
                    raise
        self.pos += len(data)
        return data

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


def main():
    out = sys.argv[1]
    per = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    gestures = sys.argv[3:] or ['fist', 'like', 'dislike', 'palm', 'stop', 'one', 'peace', 'four', 'rock', 'call', 'little_finger', 'two_up']
    ann = zipfile.ZipFile(io.BufferedReader(RangeFile(ANN), 1 << 20))
    names = ann.namelist()
    for g in gestures:
        os.makedirs(os.path.join(out, g), exist_ok=True)
        # The test split: photos HaGRID's own models were not trained on.
        a = [n for n in names if n.endswith(f'test/{g}.json')] or [n for n in names if n.endswith(f'/{g}.json')]
        boxes = json.loads(ann.read(a[0]))
        ids = sorted(k for k, v in boxes.items() if g in v.get('labels', []))
        random.Random(1).shuffle(ids)
        z = zipfile.ZipFile(io.BufferedReader(RangeFile(zip_url(g)), 1 << 20))
        files = {os.path.splitext(os.path.basename(n))[0]: n for n in z.namelist() if n.endswith('.jpg')}
        keep = {}
        for k in ids:
            if len(keep) >= per:
                break
            if k not in files:
                continue
            dst = os.path.join(out, g, k + '.jpg')
            if not os.path.exists(dst):
                # Long side 1280 (about 200 KB, not 1-2 MB): MediaPipe looks
                # at a 192-224 pixel picture and the crop is 64x64 anyway.
                im = Image.open(io.BytesIO(z.read(files[k]))).convert('RGB')
                im.thumbnail((1280, 1280))
                im.save(dst, quality=90)
            keep[k] = boxes[k]
        with open(os.path.join(out, g + '.json'), 'w') as f:
            json.dump(keep, f)
        print(g, len(keep), 'photos from', a[0], flush=True)


if __name__ == '__main__':
    main()
