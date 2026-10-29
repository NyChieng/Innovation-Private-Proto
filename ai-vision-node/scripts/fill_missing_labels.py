"""Find people and potted plants the source labels missed, and add them as pseudo-labels.

COCO labels every instance; Open Images labels only classes verified for each photo, and SWG has
no person or plant labels at all. An unlabelled person teaches the detector that people are
background, so the COCO-pretrained YOLO26s looks for confident person / potted-plant boxes that
match no existing label of that class. Boxes at conf >= --add are written into the staged label
file; the rest of the candidates are only counted. Re-running is safe: added boxes then match.

    python scripts/fill_missing_labels.py --sources openimages swg [--dry-run]
"""
import argparse
import csv
from collections import Counter

import numpy as np
from ultralytics import YOLO

from fg_common import DATA, PERSON, PLANT, ROOT, STAGING

COCO_TO_OURS = {0: PERSON, 58: PLANT}  # COCO person, potted plant


def iou(a, b):
    """a: (4,), b: (n, 4) in xyxy -> (n,)"""
    ix = np.clip(np.minimum(a[2], b[:, 2]) - np.maximum(a[0], b[:, 0]), 0, None)
    iy = np.clip(np.minimum(a[3], b[:, 3]) - np.maximum(a[1], b[:, 1]), 0, None)
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1]) - inter + 1e-9)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", nargs="+", default=["openimages", "swg"])
    ap.add_argument("--add", type=float, default=0.6, help="write boxes at or above this confidence")
    ap.add_argument("--look", type=float, default=0.35, help="count candidates at or above this confidence")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    model = YOLO(str(ROOT / "models/yolo26s.pt"))
    report = []
    for src in a.sources:
        with open(STAGING / src / "manifest.csv", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        stats = Counter()
        for i in range(0, len(rows), 32):
            chunk = rows[i:i + 32]
            imgs = [str(STAGING / src / "images" / f"{r['stem']}.jpg") for r in chunk]
            for r, res in zip(chunk, model.predict(imgs, conf=a.look, classes=list(COCO_TO_OURS), imgsz=640,
                                                   device=0, half=True, verbose=False)):
                lp = STAGING / src / "labels" / f"{r['stem']}.txt"
                lines = [l for l in lp.read_text().splitlines() if l.strip()]
                lab = np.array([[float(v) for v in l.split()[:5]] for l in lines]).reshape(-1, 5)
                xyxy = np.c_[lab[:, 0], lab[:, 1] - lab[:, 3] / 2, lab[:, 2] - lab[:, 4] / 2,
                             lab[:, 1] + lab[:, 3] / 2, lab[:, 2] + lab[:, 4] / 2]
                added = []
                for box, c, conf in zip(res.boxes.xyxyn.cpu().numpy(), res.boxes.cls.int().tolist(),
                                        res.boxes.conf.tolist()):
                    ours = COCO_TO_OURS[c]
                    same = xyxy[xyxy[:, 0] == ours][:, 1:]
                    if len(same) and iou(box, same).max() >= 0.3:
                        continue
                    name = ["person", "animal", "plant"][ours]
                    stats[f"{name} candidates"] += 1
                    if conf >= a.add:
                        stats[f"{name} added"] += 1
                        x0, y0, x1, y1 = box
                        added.append(f"{ours} {(x0 + x1) / 2:.6f} {(y0 + y1) / 2:.6f} {x1 - x0:.6f} {y1 - y0:.6f}")
                        report.append((src, r["stem"], name, round(conf, 2)))
                if added:
                    stats["images changed"] += 1
                    if not a.dry_run:
                        lp.write_text("\n".join(lines + added) + "\n")
                        r["n_boxes"] = str(len(lines) + len(added))
        if not a.dry_run:
            with open(STAGING / src / "manifest.csv", "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                w.writeheader()
                w.writerows(rows)
        print(src, len(rows), "images:", dict(stats))
    out = DATA / "checks" / "pseudo_labels.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows([("source", "stem", "class", "conf"), *report])
    print("->", out)


if __name__ == "__main__":
    main()
