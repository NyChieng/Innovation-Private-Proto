"""Download a balanced subset of SWG Camera Traps (Vietnam/Laos forest camera traps, LILA BC).

Every species is collapsed into the detector's `animal` class (id 1). Sampling is balanced across species
(--per-category) and, inside each species, round-robin across camera sites, taking one frame per
burst so near-duplicate frames don't pile up. Splits are by camera location, never by frame.
LILA strips frames with people from the public bucket, so person boxes come from COCO and Open Images.

    python scripts/download_swg.py --per-category 150 --empty 800
"""
import argparse
import json
import random
import zipfile
from collections import defaultdict

from fg_common import ANIMAL, RAW, STAGING, fetch_file, run_downloads, split_for, write_manifest, yolo_line

META_URL = ("https://storage.googleapis.com/public-datasets-lila/swg-camera-traps/"
            "swg_camera_traps.bounding_boxes.with_species.zip")
IMG_BASE = "https://storage.googleapis.com/public-datasets-lila/swg-camera-traps/"
NOT_ANIMAL = {"human", "vehicle"}
SKIP_IMAGE = {"insect"}  # tiny, never alert-worthy; leave these frames out entirely


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-category", type=int, default=150)
    ap.add_argument("--human-negatives", type=int, default=0, help="LILA removed these images; kept for reference")
    ap.add_argument("--empty", type=int, default=800, help="frames with nothing in them (wind, light changes)")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true", help="print the sample size, download nothing")
    a = ap.parse_args()

    zpath = fetch_file(META_URL, RAW / "swg" / "swg_camera_traps.bounding_boxes.with_species.zip")
    jpath = zpath.with_suffix(".json")
    if not jpath.exists():
        zipfile.ZipFile(zpath).extractall(zpath.parent)
    meta = json.loads(jpath.read_text(encoding="utf-8"))
    cat_name = {c["id"]: c["name"].replace(" ", "_") for c in meta["categories"]}

    anns = defaultdict(list)
    for an in meta["annotations"]:
        anns[an["image_id"]].append(an)

    # usable = not corrupt, every annotation has a box (otherwise an animal would be unlabelled)
    usable, empty = {}, []
    for im in meta["images"]:
        al = anns.get(im["id"])
        if not im.get("corrupt") and al and all(cat_name[x["category_id"]] == "empty" for x in al):
            usable[im["id"]] = (im, [], {"empty"})
            empty.append(im["id"])
            continue
        if im.get("corrupt") or not al or any("bbox" not in x for x in al):
            continue
        names = {cat_name[x["category_id"]] for x in al}
        if names & SKIP_IMAGE:
            continue
        usable[im["id"]] = (im, al, names)

    rng = random.Random(a.seed)
    by_cat = defaultdict(list)  # species -> images containing it
    for iid, (im, al, names) in usable.items():
        for n in names:
            by_cat[n].append(iid)

    def pick(iids, k):
        """One frame per burst, round-robin over camera locations."""
        seen_seq, by_loc = set(), defaultdict(list)
        ids = list(iids)
        rng.shuffle(ids)
        for iid in ids:
            im = usable[iid][0]
            if im["seq_id"] in seen_seq:
                continue
            seen_seq.add(im["seq_id"])
            by_loc[im["location"]].append(iid)
        out, locs = [], list(by_loc)
        rng.shuffle(locs)
        while len(out) < k and locs:
            for loc in list(locs):
                if by_loc[loc]:
                    out.append(by_loc[loc].pop())
                    if len(out) >= k:
                        break
                else:
                    locs.remove(loc)
        return out

    chosen = set()
    for n, iids in sorted(by_cat.items()):
        if n in NOT_ANIMAL or n == "empty":
            continue
        chosen.update(pick(iids, a.per_category))
    human_only = [i for i in by_cat.get("human", []) if usable[i][2] <= NOT_ANIMAL]
    chosen.update(pick(human_only, a.human_negatives))
    chosen.update(pick(empty, a.empty))

    jobs = []
    for iid in chosen:
        im, al, names = usable[iid]
        lines = [yolo_line(ANIMAL, *x["bbox"], im["width"], im["height"])
                 for x in al if cat_name[x["category_id"]] not in NOT_ANIMAL]
        lines = [l for l in lines if l]
        stem = "swg_" + im["file_name"].replace("public/", "").replace("/", "_").rsplit(".", 1)[0]
        row = {"stem": stem, "source": "swg", "group": im["location"], "split": split_for("swg_" + im["location"]),
               "n_boxes": len(lines), "note": "+".join(sorted(names))}
        jobs.append((IMG_BASE + im["file_name"], STAGING / "swg" / "images" / f"{stem}.jpg", lines, row))

    n_neg = sum(1 for j in jobs if not j[2])
    print(f"usable images {len(usable)}, chosen {len(jobs)} ({n_neg} negatives), "
          f"boxes {sum(len(j[2]) for j in jobs)}, locations {len({j[3]['group'] for j in jobs})}")
    if a.dry_run:
        return
    rows = run_downloads(jobs, a.workers, "SWG")
    write_manifest(STAGING / "swg" / "manifest.csv", rows)


if __name__ == "__main__":
    main()
