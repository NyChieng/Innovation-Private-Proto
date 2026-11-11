"""Download Open Images V7 photos (validation + test splits) for the 3-class detector.

Animals (class 1) keep land animals, birds, reptiles and frogs (the Animal subtree minus invertebrates, fish,
shellfish, marine mammals, dinosaurs and teddy bears). Images that contain any excluded animal,
a group-of box or a depiction (drawing, toy, statue) are skipped so no animal goes unlabelled.
Parent and child labels often box the same animal twice (Bird + Parrot), so near-identical
boxes are merged.
People (class 0: Person, Man, Woman, Boy, Girl) and houseplants (class 2) in the same photos are
labelled too, and --plants extra Houseplant photos are added. OI's broad `Plant`/`Tree`/`Flower`
classes are left out: they box whole hedges and forests, not a plant someone could touch.
Images with a group-of person or plant box are skipped; depicted people (posters, statues) stay
unlabelled, which is what the detector should learn.

    python scripts/download_openimages.py --total 4500
"""
import argparse
import csv
import json
import random
from collections import defaultdict

from fg_common import ANIMAL, PERSON, PLANT, RAW, STAGING, fetch_file, run_downloads, split_for, write_manifest

BASE = "https://storage.googleapis.com/openimages/"
FILES = {
    "hierarchy": "2018_04/bbox_labels_600_hierarchy.json",
    "classes": "v7/oidv7-class-descriptions-boxable.csv",
    "validation": "v5/validation-annotations-bbox.csv",
    "test": "v5/test-annotations-bbox.csv",
}
IMG_URL = "https://open-images-dataset.s3.amazonaws.com/{}/{}.jpg"
EXCLUDE_SUBTREES = {"Invertebrate", "Fish", "Shellfish", "Marine mammal", "Dinosaur", "Teddy bear"}
# images per class; forest-relevant classes get more
CAPS = {"Monkey": 500, "Squirrel": 400, "Lizard": 400, "Snake": 400, "Frog": 300, "Bird": 500,
        "Deer": 300, "Tortoise": 200, "Turtle": 200, "Mouse": 200, "Rabbit": 200, "Porcupine": 150,
        "Hedgehog": 150, "Otter": 150, "Raccoon": 150, "Fox": 150, "Pig": 150, "Bat (Animal)": 150,
        "Cat": 200, "Dog": 200, "Owl": 150, "Parrot": 150, "Leopard": 100, "Tiger": 100, "Bear": 100}
DEFAULT_CAP = 60


def iou(a, b):
    ix = max(0, min(a[1], b[1]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[2], b[2]))
    inter = ix * iy
    return inter / ((a[1] - a[0]) * (a[3] - a[2]) + (b[1] - b[0]) * (b[3] - b[2]) - inter + 1e-9)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--total", type=int, default=4500)
    ap.add_argument("--plants", type=int, default=1500)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    d = RAW / "openimages"
    paths = {k: fetch_file(BASE + v, d / v.split("/")[-1]) for k, v in FILES.items()}
    names = {}
    with open(paths["classes"], encoding="utf-8") as f:
        for row in csv.reader(f):
            names[row[0]] = row[1]

    def walk(node, out):
        out.add(node["LabelName"])
        for c in node.get("Subcategory", []):
            walk(c, out)
        return out

    def find(node, label):
        if names.get(node["LabelName"]) == label:
            return node
        for c in node.get("Subcategory", []):
            r = find(c, label)
            if r:
                return r

    tree = json.loads(paths["hierarchy"].read_text())
    animal_ids = walk(find(tree, "Animal"), set())
    excluded = set()
    for lab in EXCLUDE_SUBTREES:
        excluded |= walk(find(tree, lab), set())
    keep_ids = animal_ids - excluded
    person_ids = walk(find(tree, "Person"), set())
    plant_ids = {k for k, v in names.items() if v == "Houseplant"}

    boxes = defaultdict(list)  # (split, image) -> [(label, xmin, xmax, ymin, ymax)]
    other = defaultdict(list)  # (split, image) -> [(class, xmin, xmax, ymin, ymax)] people and plants
    bad, plant_imgs = set(), set()
    for split in ("validation", "test"):
        with open(paths[split], encoding="utf-8") as f:
            for r in csv.DictReader(f):
                lab = r["LabelName"]
                key = (split, r["ImageID"])
                if lab in person_ids or lab in plant_ids:
                    if r["IsGroupOf"] == "1":
                        bad.add(key)
                    elif r["IsDepiction"] != "1":
                        c = PERSON if lab in person_ids else PLANT
                        other[key].append((c, float(r["XMin"]), float(r["XMax"]), float(r["YMin"]), float(r["YMax"])))
                        if c == PLANT:
                            plant_imgs.add(key)
                    continue
                if lab not in animal_ids:
                    continue
                if lab in excluded or r["IsGroupOf"] == "1" or r["IsDepiction"] == "1":
                    bad.add(key)
                    continue
                boxes[key].append((names[lab], float(r["XMin"]), float(r["XMax"]), float(r["YMin"]), float(r["YMax"])))
    animal_bad = {k for k in bad if k in boxes}
    for k in bad:
        boxes.pop(k, None)

    rng = random.Random(a.seed)
    by_cls = defaultdict(list)
    for key, bl in boxes.items():
        for n in {b[0] for b in bl}:
            by_cls[n].append(key)
    chosen = []
    seen = set()
    # forest-relevant classes first, then everything else at the default cap
    order = list(CAPS) + sorted(set(by_cls) - set(CAPS))
    for n in order:
        ids = sorted(by_cls.get(n, []))
        rng.shuffle(ids)
        taken = 0
        for k in ids:
            if taken >= CAPS.get(n, DEFAULT_CAP) or len(chosen) >= a.total:
                break
            if k not in seen:
                seen.add(k)
                chosen.append(k)
                taken += 1

    # extra houseplant photos: no excluded animal, no group-of box
    plants = sorted(k for k in plant_imgs if k not in seen and k not in bad and k not in animal_bad)
    rng.shuffle(plants)
    chosen += plants[:a.plants]
    chosen = [k for k in chosen if k not in bad]

    def merge(bl):
        """bl: [(cls, x0, x1, y0, y1)] -> one box per object (parent + child labels overlap)."""
        merged = []
        for b in sorted(bl, key=lambda b: -(b[2] - b[1]) * (b[4] - b[3])):
            if all(m[0] != b[0] or iou(b[1:], m[1:]) < 0.85 for m in merged):
                merged.append(b)
        return merged

    jobs, counts = [], defaultdict(int)
    for split, iid in chosen:
        key = (split, iid)
        merged = merge([(ANIMAL, *b[1:]) for b in boxes.get(key, [])] + other.get(key, []))
        lines = []
        for c, x0, x1, y0, y1 in merged:
            if x1 > x0 and y1 > y0:
                lines.append(f"{c} {(x0 + x1) / 2:.6f} {(y0 + y1) / 2:.6f} {x1 - x0:.6f} {y1 - y0:.6f}")
                counts[c] += 1
        stem = f"oi_{iid}"
        note = "+".join(sorted({b[0] for b in boxes.get(key, [])} | {["person", "", "Houseplant"][b[0]] for b in other.get(key, [])}))
        row = {"stem": stem, "source": "openimages", "group": iid, "split": split_for(stem),
               "n_boxes": len(lines), "note": note}
        jobs.append((IMG_URL.format(split, iid), STAGING / "openimages" / "images" / f"{stem}.jpg", lines, row))

    print(f"candidate animal images {len(boxes)}, houseplant images {len(plant_imgs)}, chosen {len(jobs)}; "
          f"boxes person {counts[PERSON]}, animal {counts[ANIMAL]}, plant {counts[PLANT]}")
    if a.dry_run:
        return
    rows = run_downloads(jobs, a.workers, "OpenImages")
    write_manifest(STAGING / "openimages" / "manifest.csv", rows)


if __name__ == "__main__":
    main()
