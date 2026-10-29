"""Shared helpers for the FloraGuard data kit: paths, downloads, resizing, YOLO labels."""
import csv
import hashlib
import io
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np
import requests
from tqdm import tqdm

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RAW = DATA / "raw"
STAGING = DATA / "staging"
MAX_SIDE = 1024  # images are stored at most this size; YOLO trains at 640
CLASSES = ["person", "animal", "plant"]  # detector class ids
PERSON, ANIMAL, PLANT = range(3)

_session = None


def session():
    global _session
    if _session is None:
        s = requests.Session()
        a = requests.adapters.HTTPAdapter(pool_connections=32, pool_maxsize=32, max_retries=3)
        s.mount("http://", a)
        s.mount("https://", a)
        _session = s
    return _session


def fetch_file(url, dest, chunk=1 << 20):
    """Download url to dest (skipped if dest exists). Returns dest."""
    dest = Path(dest)
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with session().get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        with open(tmp, "wb") as f, tqdm(total=total, unit="B", unit_scale=True, desc=dest.name) as bar:
            for b in r.iter_content(chunk):
                f.write(b)
                bar.update(len(b))
    tmp.replace(dest)
    return dest


def fetch_image(url, dest, max_side=MAX_SIDE, retries=3):
    """Download an image, shrink it so its longer side is <= max_side, save as JPEG.
    Returns (width, height) of the ORIGINAL image, or None on failure."""
    dest = Path(dest)
    if dest.exists() and dest.stat().st_size > 0:
        im = cv2.imread(str(dest))
        return None if im is None else (im.shape[1], im.shape[0])
    for attempt in range(retries):
        try:
            r = session().get(url, timeout=60)
            r.raise_for_status()
            im = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
            if im is None:
                return None
            h, w = im.shape[:2]
            s = max_side / max(h, w)
            if s < 1:
                im = cv2.resize(im, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
            dest.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(dest), im, [cv2.IMWRITE_JPEG_QUALITY, 90])
            return (w, h)
        except Exception:
            if attempt == retries - 1:
                return None
            time.sleep(1 + attempt * 2)


def yolo_line(cls, x, y, w, h, img_w, img_h):
    """COCO-style pixel box [x, y, w, h] -> normalised YOLO line, clipped to the image."""
    x0, y0 = max(0.0, x), max(0.0, y)
    x1, y1 = min(float(img_w), x + w), min(float(img_h), y + h)
    if x1 <= x0 or y1 <= y0:
        return None
    cx, cy = (x0 + x1) / 2 / img_w, (y0 + y1) / 2 / img_h
    return f"{cls} {cx:.6f} {cy:.6f} {(x1 - x0) / img_w:.6f} {(y1 - y0) / img_h:.6f}"


def split_for(key, val=0.1, test=0.1):
    """Deterministic train/val/test assignment from a group key (location, image id...)."""
    v = int(hashlib.md5(str(key).encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return "test" if v < test else "val" if v < test + val else "train"


def run_downloads(jobs, workers=16, desc="images"):
    """jobs: list of (url, dest, label_lines, row). Writes image + label for each success.
    Returns the rows whose download succeeded."""
    ok = []

    def work(job):
        url, dest, lines, row = job
        if fetch_image(url, dest) is None:
            return None
        lab =Path(str(dest).replace(os.sep + "images" + os.sep, os.sep + "labels" + os.sep)).with_suffix(".txt")
        lab.parent.mkdir(parents=True, exist_ok=True)
        lab.write_text("\n".join(lines) + ("\n" if lines else ""))
        return row

    with ThreadPoolExecutor(workers) as ex:
        futs = [ex.submit(work, j) for j in jobs]
        for f in tqdm(as_completed(futs), total=len(futs), desc=desc):
            r = f.result()
            if r is not None:
                ok.append(r)
    return ok


def write_manifest(path, rows):
    """rows: dicts with stem, source, group, split, n_boxes, note."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = ["stem", "source", "group", "split", "n_boxes", "note"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in sorted(rows, key=lambda r: r["stem"]):
            w.writerow({k: r.get(k, "") for k in fields})
    print(f"wrote {len(rows)} rows -> {path}")
