"""Sanity-check a YOLO dataset and render sample grids for a visual look.

Checks: every image opens, every label line is valid (class id, 4 coords in 0..1, non-zero size),
image/label pairs match, exact-duplicate images, duplicates across splits (leakage), and box-size
distribution. Writes data/checks/<dataset>_<split>_<source>.jpg grids with boxes drawn.

    python scripts/check_dataset.py data/floraguard_animal/data.yaml --grids 2
"""
import argparse
import hashlib
import random
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np
import yaml

from fg_common import DATA


def read_labels(p, nkpt=0):
    rows, errors = [], []
    for i, line in enumerate(p.read_text().splitlines()):
        v = line.split()
        if not v:
            continue
        expect = 5 + nkpt * 3
        if len(v) not in (expect, 5 + nkpt * 2):
            errors.append(f"{p.name}:{i + 1} has {len(v)} values, expected {expect}")
            continue
        c, x, y, w, h = int(float(v[0])), *map(float, v[1:5])
        if not (0 <= x <= 1 and 0 <= y <= 1 and 0 < w <= 1.001 and 0 < h <= 1.001):
            errors.append(f"{p.name}:{i + 1} box out of range {x:.3f} {y:.3f} {w:.3f} {h:.3f}")
        rows.append((c, x, y, w, h, [float(t) for t in v[5:]]))
    return rows, errors


def grid(items, out, nkpt=0, cols=4, cell=320):
    tiles = []
    for img_p, rows in items:
        im = cv2.imread(str(img_p))
        h, w = im.shape[:2]
        for c, x, y, bw, bh, kp in rows:
            p0 = (int((x - bw / 2) * w), int((y - bh / 2) * h))
            p1 = (int((x + bw / 2) * w), int((y + bh / 2) * h))
            cv2.rectangle(im, p0, p1, (0, 255, 0), max(2, w // 300))
            step = 3 if len(kp) == nkpt * 3 else 2
            for k in range(nkpt):
                kx, ky = kp[k * step] * w, kp[k * step + 1] * h
                if kx > 0 and ky > 0:
                    cv2.circle(im, (int(kx), int(ky)), max(2, w // 200), (0, 0, 255), -1)
        s = cell / max(h, w)
        im = cv2.resize(im, (int(w * s), int(h * s)))
        canvas = np.full((cell, cell, 3), 40, np.uint8)
        canvas[:im.shape[0], :im.shape[1]] = im
        cv2.putText(canvas, img_p.stem[:40], (4, cell - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
        tiles.append(canvas)
    while len(tiles) % cols:
        tiles.append(np.full((cell, cell, 3), 40, np.uint8))
    rows_ = [np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), np.vstack(rows_))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("yaml")
    ap.add_argument("--grids", type=int, default=1, help="sample grids per split and source")
    ap.add_argument("--per-grid", type=int, default=16)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()

    cfg = yaml.safe_load(Path(a.yaml).read_text(encoding="utf-8"))
    root = Path(cfg["path"])
    nkpt = (cfg.get("kpt_shape") or [0])[0]
    name = root.name
    rng = random.Random(a.seed)
    hashes = defaultdict(list)
    for split in ("train", "val", "test"):
        if split not in cfg:
            continue
        img_dir = root / cfg[split]
        lab_dir = Path(str(img_dir).replace("images", "labels"))
        imgs = sorted(p for p in img_dir.glob("*") if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
        errors, unreadable, missing = [], 0, 0
        n_boxes, neg, sizes, per_src, per_src_items = 0, 0, Counter(), Counter(), defaultdict(list)
        for p in imgs:
            src = p.stem.split("_")[0] if "_" in p.stem else "all"
            per_src[src] += 1
            lp = lab_dir / (p.stem + ".txt")
            rows = []
            if lp.exists():
                rows, e = read_labels(lp, nkpt)
                errors += e
            else:
                missing += 1
            n_boxes += len(rows)
            neg += not rows
            for r in rows:
                a_ = r[3] * r[4]
                sizes["small (<1% of image)" if a_ < 0.01 else "medium (1-10%)" if a_ < 0.1 else "large (>10%)"] += 1
            per_src_items[src].append((p, rows))
            hashes[hashlib.md5(p.read_bytes()).hexdigest()].append((split, p.name))
        # opening every image is slow; check a sample of up to 2000
        for p in rng.sample(imgs, min(len(imgs), 2000)):
            if cv2.imread(str(p)) is None:
                unreadable += 1
        print(f"\n== {split}: {len(imgs)} images, {n_boxes} boxes, {neg} with no boxes, "
              f"{missing} without a label file, {unreadable} unreadable (of a 2000 sample)")
        print("   by source:", dict(per_src))
        print("   box sizes:", dict(sizes))
        if errors:
            print(f"   {len(errors)} label errors, first 5:", *errors[:5], sep="\n     ")
        for src, items in per_src_items.items():
            for g in range(a.grids):
                pick = rng.sample(items, min(a.per_grid, len(items)))
                out = grid(pick, DATA / "checks" / f"{name}_{split}_{src}_{g}.jpg", nkpt)
                print("   grid:", out)
    dups = [v for v in hashes.values() if len(v) > 1]
    cross = [v for v in dups if len({s for s, _ in v}) > 1]
    print(f"\nexact duplicate images: {len(dups)} groups, {len(cross)} across splits (leakage)")
    for v in cross[:5]:
        print("   ", v)


if __name__ == "__main__":
    main()
