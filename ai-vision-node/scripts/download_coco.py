"""Download COCO 2017 images for the 3-class detector: person (0), animal (1), potted plant (2).

Only the train2017 instances JSON is extracted from the annotation zip; images are fetched one by
one, so nothing close to the full 18 GB is downloaded. COCO labels every instance of its 80
classes, so person and plant boxes are complete in every image we take.

Selection, in this order (already-downloaded images are reused):
  1. animals: per-class caps over the 10 COCO animals
  2. people next to plants: photos with a person AND a potted plant, the closest COCO match
     to a visitor at a protected plant, topped up with person-only photos (--people-plants)
  3. extra plants: potted-plant photos, people first (--plants)
  4. extra people: person photos without plants (--people)
Images with crowd regions for any kept class are dropped: crowds have no per-person boxes.

    python scripts/download_coco.py
"""
import argparse
import json
import random
import zipfile
from collections import defaultdict

from fg_common import ANIMAL, PERSON, PLANT, RAW, STAGING, fetch_file, run_downloads, split_for, write_manifest, yolo_line

ANN_URL = "http://images.cocodataset.org/annotations/annotations_trainval2017.zip"
IMG_URL = "http://images.cocodataset.org/train2017/{}"
# images per animal class: forest-relevant classes get more, savannah/farm classes fewer
CAPS = {"bird": 700, "cat": 450, "dog": 450, "bear": 300, "horse": 200, "sheep": 200,
        "cow": 200, "elephant": 150, "zebra": 100, "giraffe": 100}


def class_of(n):
    return PERSON if n == "person" else PLANT if n == "potted plant" else ANIMAL if n in CAPS else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--people-plants", type=int, default=800)
    ap.add_argument("--plants", type=int, default=1800)
    ap.add_argument("--people", type=int, default=800)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    jpath = RAW / "coco" / "instances_train2017.json"
    if not jpath.exists():
        z = fetch_file(ANN_URL, RAW / "coco" / "annotations_trainval2017.zip")
        with zipfile.ZipFile(z) as zf, open(jpath, "wb") as f:
            f.write(zf.read("annotations/instances_train2017.json"))
    meta = json.loads(jpath.read_text(encoding="utf-8"))
    name = {c["id"]: c["name"] for c in meta["categories"]}
    images = {im["id"]: im for im in meta["images"]}
    anns = defaultdict(list)
    for an in meta["annotations"]:
        anns[an["image_id"]].append(an)
    names_in = {i: {name[x["category_id"]] for x in al} for i, al in anns.items()}

    rng = random.Random(a.seed)
    by_cls = defaultdict(list)
    for iid, al in anns.items():
        animals = [x for x in al if name[x["category_id"]] in CAPS]
        if any(x["iscrowd"] for x in animals):
            continue  # crowd regions have no individual boxes
        for n in {name[x["category_id"]] for x in animals}:
            by_cls[n].append(iid)

    chosen = set()
    for n, cap in CAPS.items():
        ids = by_cls[n]
        rng.shuffle(ids)
        chosen.update(ids[:cap])

    def no_animal(i, need_plant):
        ns = names_in[i]
        return "person" in ns and not ns & set(CAPS) and (not need_plant or "potted plant" in ns)

    pp = [i for i in anns if no_animal(i, True)]
    p_only = [i for i in anns if no_animal(i, False) and i not in set(pp)]
    rng.shuffle(pp)
    rng.shuffle(p_only)
    chosen.update((pp + p_only)[:a.people_plants])

    # extra plants and people use their own generator so steps 1-2 pick the same images as before
    rng2 = random.Random(a.seed + 1)
    plant_people = [i for i in anns if "potted plant" in names_in[i] and "person" in names_in[i] and i not in chosen]
    plant_alone = [i for i in anns if "potted plant" in names_in[i] and "person" not in names_in[i] and i not in chosen]
    rng2.shuffle(plant_people)
    rng2.shuffle(plant_alone)
    half = a.plants // 2
    extra_plants = plant_people[:half] + plant_alone[:a.plants - min(half, len(plant_people))]
    chosen.update(extra_plants)
    people = [i for i in p_only if i not in chosen]
    rng2.shuffle(people)
    chosen.update(people[:a.people])

    crowd = {i for i in chosen if any(x["iscrowd"] and class_of(name[x["category_id"]]) is not None for x in anns[i])}
    chosen -= crowd
    print(f"dropped {len(crowd)} images with crowd regions")

    jobs, counts = [], defaultdict(int)
    for iid in chosen:
        im = images[iid]
        lines = []
        for x in anns[iid]:
            c = class_of(name[x["category_id"]])
            l = None if c is None else yolo_line(c, *x["bbox"], im["width"], im["height"])
            if l:
                lines.append(l)
                counts[c] += 1
        stem = f"coco_{iid:012d}"
        kept = sorted({n for n in names_in[iid] if class_of(n) is not None})
        row = {"stem": stem, "source": "coco", "group": iid, "split": split_for(stem), "n_boxes": len(lines),
               "note": "+".join(kept) or "background"}
        jobs.append((IMG_URL.format(im["file_name"]), STAGING / "coco" / "images" / f"{stem}.jpg", lines, row))

    print(f"chosen {len(jobs)} images; boxes person {counts[PERSON]}, animal {counts[ANIMAL]}, plant {counts[PLANT]}")
    if a.dry_run:
        return
    rows = run_downloads(jobs, a.workers, "COCO")
    write_manifest(STAGING / "coco" / "manifest.csv", rows)


if __name__ == "__main__":
    main()
