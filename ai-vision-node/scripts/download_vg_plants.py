"""Download the Visual Genome images whose person/hand -> plant relationship says touch or no touch.

touch:    holding, touching, tending, arranging, carrying, picking, grabbing, hugging, washing ...
no_touch: near, next to, beside, by, in front of, behind, looking at, walking past ...
Ambiguous predicates (has, with, in, under, wearing) are skipped. Run scan_vg_plants.py first.

    python scripts/download_vg_plants.py
-> data/raw/vg/images/vg_<id>.jpg + data/raw/vg/pairs.json (same layout as the HICO pairs, boxes xyxy)
"""
import json
import re
from collections import Counter, defaultdict

from fg_common import RAW, run_downloads, split_for

VG = RAW / "vg"
TOUCH = re.compile(r"^(?:holding|holds|hold|holding out|holding up|touching|touches|touch|tending|arranging|"
                   r"carrying|carries|picking|picks|grabbing|grabs|hugging|hugs|washing|pruning|trimming|"
                   r"cutting|pulling|feeling|petting|hand on|has hand on|leaning on|leaning against)$")
NO_TOUCH = re.compile(r"^(?:near|near a|next to|beside|by|by a|close to|in front of|in front|behind|behind a|"
                      r"looking at|walking past|walking by|standing near|standing by|standing by a|standing next to|"
                      r"standing in front of|standing behind|standing behind a|sitting next to|sitting near|"
                      r"walking near|stands to right of|stands to left of)$")


def main():
    rels = json.loads((VG / "plant_rels.json").read_text())
    meta = {im["image_id"]: im for im in json.loads((VG / "image_data.json").read_text())}
    by_img = defaultdict(list)
    for r in rels:
        label = "touch" if TOUCH.match(r["predicate"]) else "no_touch" if NO_TOUCH.match(r["predicate"]) else None
        if label:
            hand = r["subj"].lower().split()[-1] in ("hand", "hands", "finger", "fingers", "arm")
            by_img[r["image_id"]].append({"label": label, "verb": r["predicate"], "subject": "hand" if hand else "person",
                                          "human": r["subj_box"], "plant": r["obj_box"]})
    jobs = []
    for iid, pairs in by_img.items():
        im = meta[iid]
        stem = f"vg_{iid}"
        # pairs.json keeps original-pixel boxes; the scale is applied when crops are cut
        row = {"stem": stem, "split": split_for(stem), "w": im["width"], "h": im["height"], "pairs": pairs}
        jobs.append((im["url"], VG / "images" / f"{stem}.jpg", [], row))
    print("pairs by label:", Counter(p["label"] for j in jobs for p in j[3]["pairs"]), "images:", len(jobs))
    rows = run_downloads(jobs, 16, "VG")
    (VG / "pairs.json").write_text(json.dumps(rows, indent=1))
    print(f"saved {len(rows)} images")


if __name__ == "__main__":
    main()
