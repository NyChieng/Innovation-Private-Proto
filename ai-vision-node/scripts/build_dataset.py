"""Merge the staged sources into one YOLO dataset: data/floraguard_det/{images,labels}/{train,val,test}.

Files are hard-linked (same drive, no extra space); the split comes from each source's manifest
(SWG by camera location, photo sets by image id). Writes data.yaml with classes person, animal, plant.

    python scripts/build_dataset.py --sources swg coco openimages
"""
import argparse
import csv
import os
import shutil
from collections import Counter
from pathlib import Path

from fg_common import CLASSES, DATA, STAGING


def link(src, dst):
    if dst.exists():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", nargs="+", default=["swg", "coco", "openimages"])
    ap.add_argument("--out", default=str(DATA / "floraguard_det"))
    a = ap.parse_args()

    out = Path(a.out)
    if out.exists():
        shutil.rmtree(out)
    stats = Counter()
    rows_all = []
    for src in a.sources:
        man = STAGING / src / "manifest.csv"
        if not man.exists():
            print(f"skip {src}: no manifest (run its download script first)")
            continue
        with open(man, encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        for r in rows:
            img = STAGING / src / "images" / f"{r['stem']}.jpg"
            lab = STAGING / src / "labels" / f"{r['stem']}.txt"
            if not img.exists() or not lab.exists():
                continue
            for sub, s, ext in (("images", img, ".jpg"), ("labels", lab, ".txt")):
                d = out / sub / r["split"]
                d.mkdir(parents=True, exist_ok=True)
                link(s, d / f"{r['stem']}{ext}")
            stats[(src, r["split"], "img")] += 1
            stats[(src, r["split"], "box")] += int(r["n_boxes"])
            stats[(src, r["split"], "neg")] += int(r["n_boxes"]) == 0
            for line in lab.read_text().splitlines():
                if line.strip():
                    stats[(src, r["split"], CLASSES[int(line.split()[0])])] += 1
            rows_all.append(r)

    names = "".join(f"  {i}: {n}\n" for i, n in enumerate(CLASSES))
    (out / "data.yaml").write_text(
        f"path: {out.as_posix()}\ntrain: images/train\nval: images/val\ntest: images/test\n\nnames:\n{names}")
    with open(out / "manifest.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows_all[0].keys()))
        w.writeheader()
        w.writerows(rows_all)

    cls_hdr = " ".join(f"{c:>7}" for c in CLASSES)
    print(f"{'source':12} {'split':6} {'images':>7} {'boxes':>7} {'empty':>7} {cls_hdr}")
    for src in a.sources:
        for sp in ("train", "val", "test"):
            if stats[(src, sp, "img")]:
                per = " ".join(f"{stats[(src, sp, c)]:7}" for c in CLASSES)
                print(f"{src:12} {sp:6} {stats[(src, sp, 'img')]:7} {stats[(src, sp, 'box')]:7} {stats[(src, sp, 'neg')]:7} {per}")
    for sp in ("train", "val", "test"):
        tot = lambda k: sum(stats[(s, sp, k)] for s in a.sources)  # noqa: E731
        per = " ".join(f"{tot(c):7}" for c in CLASSES)
        print(f"{'TOTAL':12} {sp:6} {tot('img'):7} {tot('box'):7} {tot('neg'):7} {per}")
    print(f"-> {out / 'data.yaml'}")


if __name__ == "__main__":
    main()
