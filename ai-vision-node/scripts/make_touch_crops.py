"""Build the touch / no_touch classification set from hand-centred crops (transfer-learning data).

Sources:
  100doh  100 Days of Hands (Shan et al., CVPR 2020): ~100K YouTube frames, every hand boxed with a
          contact state. Portable / fixed object contact -> `touch`; no contact, self contact and
          other-person contact -> `no_touch`. Teaches what a hand in contact looks like in general.
  hico    HICO-DET person-plant pairs: hold / carry -> the wrist on the plant is `touch`;
          no_interaction -> every wrist is `no_touch` (often overlapping the plant in 2D: hard negatives).
  vg      Visual Genome person/hand -> plant relationships (holding, touching, tending ... vs near,
          beside, in front of ...), same rule as HICO, including trees, bushes and leaves outdoors.
  coco    COCO people near potted plants (ground-truth keypoints), `no_touch` only: wrists close to a
          plant box but outside it. Wrists inside a plant outline are skipped (touch or occlusion?).
  user    your crops from the app's recorder (data/touch_user/<label>/*.jpg), split by recording
          session and repeated 3x in train: they match your camera, plant and lighting.

HICO / VG wrists come from the YOLO26s-pose model the live pipeline uses, and every crop is cut
with app/touchcrop.py, so training crops match live crops.

    python scripts/make_touch_crops.py [--doh 30000] [--plant-repeat 8]
-> data/touch/{train,val,test}/{touch,no_touch}/*.jpg  and data/touch/manifest.csv
"""
import argparse
import csv
import json
import random
import re
import shutil
import sys
import zipfile
from collections import Counter, defaultdict

import cv2
import numpy as np

from fg_common import DATA, RAW, ROOT, STAGING, fetch_image, split_for

sys.path.insert(0, str(ROOT / "app"))
from touchcrop import box_dist, cut, hand_box  # noqa: E402

OUT = DATA / "touch"
USER = DATA / "touch_user"
WRISTS = ((9, 7), (10, 8))  # COCO keypoints (wrist, elbow), left and right
KPT_CONF = 0.5
DOH_TOUCH = {"P", "F"}  # 100DOH contact states: N none, S self, O other person, P portable obj, F fixed obj


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9)


def load_pairs():
    """HICO + VG as [(source, stem, split, image path, scale-free pairs)], boxes xyxy in original pixels."""
    out = []
    p = RAW / "hico" / "pairs.json"
    if p.exists():
        for f in json.loads(p.read_text()):
            pairs = []
            for q in f["pairs"]:
                if q["verb"] == "hose" or q["invis"]:
                    continue
                # HICO-DET stores boxes as [x1, x2, y1, y2]
                pairs.append({"label": "touch" if q["verb"] in ("hold", "carry") else "no_touch", "verb": q["verb"],
                              "subject": "person", "human": [q["human"][0], q["human"][2], q["human"][1], q["human"][3]],
                              "plant": [q["plant"][0], q["plant"][2], q["plant"][1], q["plant"][3]]})
            split = "test" if f["split"] == "test" else split_for(f["stem"], val=0.12, test=0)
            out.append(("hico", f["stem"], split, RAW / "hico" / "images" / f"{f['stem']}.jpg", f["w"], pairs))
    p = RAW / "vg" / "pairs.json"
    if p.exists():
        for f in json.loads(p.read_text()):
            out.append(("vg", f["stem"], f["split"], RAW / "vg" / "images" / f"{f['stem']}.jpg", f["w"], f["pairs"]))
    return out


def pairs_crops(rows):
    from ultralytics import YOLO
    pose = YOLO(str(ROOT / "models/yolo26s-pose.pt"))
    for src, stem, split, path, orig_w, pairs in load_pairs():
        img = cv2.imread(str(path))
        if img is None or not pairs:
            continue
        s = img.shape[1] / orig_w  # downloads may be shrunk
        res = pose.predict(img, imgsz=640, conf=0.25, device=0, verbose=False)[0]
        if res.keypoints is None or not len(res.boxes):
            continue
        pboxes = res.boxes.xyxy.cpu().numpy()
        kxy = res.keypoints.xy.cpu().numpy()
        kcf = res.keypoints.conf.cpu().numpy()
        done = {}
        for pi, q in enumerate(pairs):
            hb = [v * s for v in q["human"]]
            ob = [v * s for v in q["plant"]]
            cands = []  # (pose index, side)
            if q["subject"] == "hand":
                pad = 0.5 * max(hb[2] - hb[0], hb[3] - hb[1])
                big = (hb[0] - pad, hb[1] - pad, hb[2] + pad, hb[3] + pad)
                for m in range(len(pboxes)):
                    for side, (wi, _) in enumerate(WRISTS):
                        if kcf[m, wi] >= KPT_CONF and box_dist(kxy[m, wi], big) == 0:
                            cands.append((m, side))
            else:
                m = max(range(len(pboxes)), key=lambda k: iou(hb, pboxes[k]))
                if iou(hb, pboxes[m]) >= 0.5:
                    cands = [(m, 0), (m, 1)]
            for m, side in cands:
                wi, ei = WRISTS[side]
                if kcf[m, wi] < KPT_CONF:
                    continue
                elbow = kxy[m, ei] if kcf[m, ei] >= KPT_CONF else None
                box = hand_box(kxy[m, wi], elbow, pboxes[m][3] - pboxes[m][1])
                r = (box[2] - box[0]) / 2
                d = box_dist(kxy[m, wi], ob)
                if q["label"] == "touch":
                    label = "touch" if d <= 0.25 * r else "no_touch" if d > 1.5 * r and q["subject"] == "person" else None
                else:
                    label = "no_touch"
                if label is None or done.get((m, side)) == "touch":
                    continue  # a wrist that touches in any pair stays touch
                done[(m, side)] = label
                crop = cut(img, box)
                if crop is not None:
                    note = q["verb"] + ("_near" if label == "no_touch" and d <= r else "")
                    rows[f"{stem}_{m}_{side}"] = dict(stem=f"{stem}_{m}_{side}", source=src, split=split,
                                                      label=label, note=note, img=crop)


def doh_crops(rows, rng, cap):
    """100DOH pascal-voc zip, read in place: hand boxes + contact state -> crops."""
    zp = RAW / "100doh" / "pascal_voc_format.zip"
    if not zp.exists():
        print("skip 100doh: no zip")
        return
    with zipfile.ZipFile(zp) as z:
        names = z.namelist()
        ann = {n.rsplit("/", 1)[-1][:-4]: n for n in names if n.endswith(".xml") and "/Annotations/" in n}
        jpg = {n.rsplit("/", 1)[-1][:-4]: n for n in names if n.endswith(".jpg") and "/JPEGImages/" in n}
        split_of = {}
        for n in names:
            m = re.search(r"/ImageSets/Main/(train|val|test)\.txt$", n)
            if m:
                for line in z.read(n).decode().split():
                    split_of[line.strip()] = m.group(1)
        keys = sorted(k for k in ann if k in jpg)
        rng.shuffle(keys)
        per_label = Counter()
        for k in keys:
            if per_label["touch"] >= cap // 2 and per_label["no_touch"] >= cap // 2:
                break
            xml = z.read(ann[k]).decode("utf-8", "ignore")
            hands = []
            for obj in re.findall(r"<object>(.*?)</object>", xml, re.S):
                if re.search(r"<name>\s*hand\s*</name>", obj) is None:
                    continue
                cs = re.search(r"<contactstate>\s*(\d+)\s*</contactstate>", obj)
                bb = [float(re.search(rf"<{t}>\s*([\d.]+)\s*</{t}>", obj).group(1)) for t in ("xmin", "ymin", "xmax", "ymax")]
                hands.append((int(cs.group(1)) if cs else 0, bb))
            if not hands:
                continue
            img = None
            for hi, (state, (x0, y0, x1, y1)) in enumerate(hands):
                # contactstate ids in the release: 0 none, 1 self, 2 other person, 3 portable, 4 fixed
                label = "touch" if state in (3, 4) else "no_touch"
                if per_label[label] >= cap // 2:
                    continue
                if img is None:
                    img = cv2.imdecode(np.frombuffer(z.read(jpg[k]), np.uint8), cv2.IMREAD_COLOR)
                    if img is None:
                        break
                # live crops are ~1.3x the hand size around the hand centre (see touchcrop.hand_box)
                cx, cy, r = (x0 + x1) / 2, (y0 + y1) / 2, 0.65 * 1.3 * max(x1 - x0, y1 - y0)
                if r < 12:
                    continue
                j = rng.uniform(-0.15, 0.15) * r  # live wrist-based centres are not exact either
                crop = cut(img, (cx - r + j, cy - r + j, cx + r + j, cy + r + j))
                if crop is None:
                    continue
                sp = split_of.get(k, "train")
                sp = "val" if sp == "val" else "test" if sp == "test" else "train"
                per_label[label] += 1
                rows[f"doh_{k}_{hi}"] = dict(stem=f"doh_{k}_{hi}", source="100doh", split=sp, label=label,
                                             note=f"state{state}", img=crop)
    print("100doh:", dict(per_label))


def coco_crops(rows, rng, cap):
    # The two annotation files expand to ~6 GB of Python objects; next to a training run that is
    # more than this laptop has, so annotations are filtered while parsing (object_hook drops them).
    plant_id = 64  # potted plant

    def keep_plant(d):
        return None if "category_id" in d and (d["category_id"] != plant_id or d["iscrowd"]) else d

    inst = json.loads((RAW / "coco" / "instances_train2017.json").read_text(encoding="utf-8"), object_hook=keep_plant)
    plants = defaultdict(list)
    for an in inst["annotations"]:
        if an is not None:
            plants[an["image_id"]].append(an)
    del inst

    def keep_person(d):
        if "num_keypoints" in d:
            if d["image_id"] not in plants or d["num_keypoints"] < 5 or d["iscrowd"]:
                return None
            d.pop("segmentation", None)
        elif "file_name" in d and d["id"] not in plants:
            return None
        return d

    meta = json.loads((RAW / "coco" / "annotations" / "person_keypoints_train2017.json").read_text(encoding="utf-8"),
                      object_hook=keep_person)
    people = defaultdict(list)
    for an in meta["annotations"]:
        if an is not None:
            people[an["image_id"]].append(an)
    files = {im["id"]: im for im in meta["images"] if im is not None}
    del meta
    cands = []
    for iid, pl in people.items():
        im = files[iid]
        mask = np.zeros((im["height"], im["width"]), np.uint8)
        for a in plants[iid]:
            for poly in a["segmentation"]:
                cv2.fillPoly(mask, [np.array(poly, np.float32).reshape(-1, 2).astype(np.int32)], 1)
        pboxes = [(a["bbox"][0], a["bbox"][1], a["bbox"][0] + a["bbox"][2], a["bbox"][1] + a["bbox"][3]) for a in plants[iid]]
        for a in pl:
            k = np.array(a["keypoints"], float).reshape(-1, 3)
            for side, (wi, ei) in enumerate(WRISTS):
                if k[wi, 2] < 2:  # 2 = labelled and visible
                    continue
                w = k[wi, :2]
                if mask[min(int(w[1]), im["height"] - 1), min(int(w[0]), im["width"] - 1)]:
                    continue  # on the plant outline: touch or occlusion, can't tell
                box = hand_box(w, k[ei, :2] if k[ei, 2] > 0 else None, a["bbox"][3])
                r = (box[2] - box[0]) / 2
                d = min(box_dist(w, b) for b in pboxes)
                if d <= 2 * r:
                    cands.append((iid, a["id"], side, box, d <= r))
    rng.shuffle(cands)
    cands.sort(key=lambda c: not c[4])  # nearest misses first
    for iid, aid, side, box, near in cands[:cap]:
        im = files[iid]
        path = STAGING / "coco" / "images" / f"coco_{iid:012d}.jpg"
        size = fetch_image(f"http://images.cocodataset.org/train2017/{im['file_name']}", path)
        img = cv2.imread(str(path)) if size else None
        if img is None:
            continue
        s = img.shape[1] / im["width"]  # staged images may be shrunk to 1024 px
        crop = cut(img, [v * s for v in box])
        if crop is not None:
            stem = f"coco_{iid:012d}_{aid}_{side}"
            rows[stem] = dict(stem=stem, source="coco", split=split_for(f"coco_{iid}"), label="no_touch",
                              note="near" if near else "close", img=crop)


def user_crops(rows):
    for label in ("touch", "no_touch"):
        for p in sorted((USER / label).glob("*.jpg")):
            session = p.stem.split("_")[0]  # files are named <session>_<frame>_<hand>.jpg
            img = cv2.imread(str(p))
            if img is not None:
                rows[f"user_{p.stem}"] = dict(stem=f"user_{p.stem}", source="user", split=split_for(f"user_{session}"),
                                              label=label, note=session, img=cv2.resize(img, (224, 224)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doh", type=int, default=30000, help="100DOH crops (half touch, half no_touch)")
    # plant-context crops were ~1,700 no_touch vs ~40 touch, and the first model learned
    # "leaves in the crop -> no touch"; fewer COCO near-misses and repeated plant touches fix the ratio
    ap.add_argument("--coco", type=int, default=400, help="max COCO near-miss crops")
    ap.add_argument("--plant-repeat", type=int, default=8, help="copies of each HICO/VG touch crop in train")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    rows = {}
    pairs_crops(rows)
    print("plant pairs:", Counter((r["source"], r["label"]) for r in rows.values()))
    coco_crops(rows, rng, a.coco)
    doh_crops(rows, rng, a.doh)
    user_crops(rows)

    if OUT.exists():
        shutil.rmtree(OUT)
    for r in rows.values():
        d = OUT / r["split"] / r["label"]
        d.mkdir(parents=True, exist_ok=True)
        copies = 1
        if r["split"] == "train" and r["source"] == "user":
            copies = 3
        elif r["split"] == "train" and r["source"] in ("hico", "vg") and r["label"] == "touch":
            copies = a.plant_repeat
        for c in range(copies):
            cv2.imwrite(str(d / f"{r['stem']}{'_x' + str(c) if c else ''}.jpg"), r["img"], [cv2.IMWRITE_JPEG_QUALITY, 95])
    with open(OUT / "manifest.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["stem", "source", "split", "label", "note"])
        w.writeheader()
        w.writerows({k: r[k] for k in w.fieldnames} for r in rows.values())
    c = Counter((r["split"], r["source"], r["label"]) for r in rows.values())
    for k in sorted(c):
        print(f"{k[0]:6} {k[1]:7} {k[2]:9} {c[k]}")
    print("->", OUT)


if __name__ == "__main__":
    main()
