"""Fetch every HICO-DET image with a person / potted-plant pair, for the touch classifier.

HICO-DET (47,776 images, 600 human-object interactions) labels each person-plant pair with
carry, hold, hose or no_interaction. carry and hold mean the hand is on the plant (touch);
no_interaction pairs are people near a plant without touching it (the hard negatives).
hose (watering from a distance) is kept in the json but not used as either label.

The Hugging Face copy (zhimeng/hico_det) is paged through the dataset-viewer /rows API, so only
the plant images are downloaded, not the 8 GB parquet.

    python scripts/download_hico_plants.py
-> data/raw/hico/images/*.jpg + data/raw/hico/pairs.json
"""
import ast
import csv
import json
import time
from concurrent.futures import ThreadPoolExecutor

from tqdm import tqdm

from fg_common import RAW, fetch_image, session

ROWS = "https://datasets-server.huggingface.co/rows"
DATASET = dict(dataset="zhimeng/hico_det", config="default")
OUT = RAW / "hico"


def page(split, offset):
    for attempt in range(10):
        try:
            r = session().get(ROWS, params=dict(DATASET, split=split, offset=offset, length=100), timeout=120)
            r.raise_for_status()
            return r.json()["rows"]
        except Exception:
            if attempt == 9:
                raise
            time.sleep(min(120, 5 * 2 ** attempt))  # the API rate-limits bursts with 429


def main():
    acts = list(csv.reader(open(OUT / "list_action.csv", encoding="utf-8")))
    # row i of list_action.csv (header = row 0) is HOI id i, the id used in `objects`
    plant_hoi = {i: r[1] for i, r in enumerate(acts) if r[0] == "potted_plant"}
    print("potted-plant interactions:", plant_hoi)

    found = []
    for split, total in (("train", 38118), ("test", 9658)):
        with ThreadPoolExecutor(3) as ex:
            pages = list(tqdm(ex.map(lambda o: page(split, o), range(0, total, 100)),
                              total=(total + 99) // 100, desc=f"scan {split}"))
        for rows in pages:
            for r in rows:
                row = r["row"]
                objs = [o for o in ast.literal_eval(row["objects"]) if o["id"] in plant_hoi]
                if not objs:
                    continue
                pairs = [{"verb": plant_hoi[o["id"]], "human": o["bbox_human"], "plant": o["bbox_object"],
                          "invis": o["invis"]} for o in objs]
                found.append({"stem": f"hico_{split}_{r['row_idx']:05d}", "split": split, "url": row["image"]["src"],
                              "w": row["image"]["width"], "h": row["image"]["height"], "pairs": pairs})
    print(f"{len(found)} images with person-plant pairs")

    def get(f):
        # keep full size: crops around the plant need the detail, and these images are small
        return f if fetch_image(f["url"], OUT / "images" / f"{f['stem']}.jpg", max_side=4096) else None

    with ThreadPoolExecutor(16) as ex:
        ok = [f for f in tqdm(ex.map(get, found), total=len(found), desc="images") if f]
    for f in ok:
        f.pop("url")
    (OUT / "pairs.json").write_text(json.dumps(ok, indent=1))
    verbs = {}
    for f in ok:
        for p in f["pairs"]:
            verbs[p["verb"]] = verbs.get(p["verb"], 0) + 1
    print(f"saved {len(ok)} images, pairs by verb: {verbs}")


if __name__ == "__main__":
    main()
