"""Large qualitative + quantitative detector study on images the detector never saw.

Three independent image sets, all downloaded from their public sources:

    coco        every COCO val2017 image with a person, one of the 10 animals or a potted plant
                (training used train2017 only), plus empty images
    openimages  Open Images V7 validation/test photos that are NOT in the detector's train/val split
                (animals balanced across species, forest species first, plus houseplants)
    swg         SWG camera-trap frames (Vietnam/Laos forest) from camera LOCATIONS held out of
                training, day and night (IR), balanced across species, one frame per burst, plus empty

Models on the same images: the deployed ONNX (OpenVINO, what the app runs), det_B .pt at 640,
and the stock yolo26n / yolo26s COCO models mapped to the app's 3 classes.

Reported: mAP per set and model (pycocotools, 5-fold spread), then for the deployed model at the
app's own thresholds:
  slices      recall by object size, crowding, cut by the frame edge, lighting, night IR, species
  errors      every false box classed as background / wrong class / poor box / duplicate,
              every missed object as missed / found as wrong class / poor box
  galleries   random (not cherry-picked) samples per slice and the worst cases per error type,
              and the deployed model next to the stock model on the same pictures

    python scripts/eval_det_big.py --out reports/det_big
    python scripts/eval_det_big.py --dry-run          # just count what would be downloaded
"""
import argparse
import csv
import json
import random
import sys
import time
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import eval_det_coco as E  # noqa: E402  (runners, coco_eval, iou, NAMES, APP_CONF, STOCK_MAP)
from fg_common import fetch_file, fetch_image, split_for  # noqa: E402

BIG = ROOT / "data" / "raw" / "eval_big"
NAMES, APP_CONF = E.NAMES, E.APP_CONF
OI_BASE = "https://storage.googleapis.com/openimages/"
OI_FILES = {"hierarchy": "2018_04/bbox_labels_600_hierarchy.json", "classes": "v7/oidv7-class-descriptions-boxable.csv",
            "validation": "v5/validation-annotations-bbox.csv", "test": "v5/test-annotations-bbox.csv"}
OI_IMG = "https://open-images-dataset.s3.amazonaws.com/{}/{}.jpg"
OI_EXCLUDE = {"Invertebrate", "Fish", "Shellfish", "Marine mammal", "Dinosaur", "Teddy bear"}
OI_FOREST = ["Monkey", "Squirrel", "Lizard", "Snake", "Frog", "Bird", "Deer", "Tortoise", "Turtle", "Mouse",
             "Rabbit", "Porcupine", "Hedgehog", "Otter", "Raccoon", "Fox", "Pig", "Bat (Animal)", "Owl",
             "Parrot", "Leopard", "Tiger", "Bear", "Cat", "Dog"]
SWG_META = ("https://storage.googleapis.com/public-datasets-lila/swg-camera-traps/"
            "swg_camera_traps.bounding_boxes.with_species.zip")
SWG_IMG = "https://storage.googleapis.com/public-datasets-lila/swg-camera-traps/"
SET_LABEL = {"coco": "COCO val2017 (everyday photos)", "openimages": "Open Images (web photos, wide species range)",
             "swg": "SWG camera traps (forest, held-out sites)"}


# --------------------------------------------------------------------------- image sets
# Each record: id, set, url, file, gt = [(x0, y0, x1, y1 normalised, cls, tag)], note

def coco_records(n_empty, rnd):
    meta = E.load_val()
    cat = {c["id"]: c["name"] for c in meta["categories"]}
    anns = defaultdict(list)
    for a in meta["annotations"]:
        anns[a["image_id"]].append(a)
    out, empty = [], []
    for im in meta["images"]:
        al = anns.get(im["id"], [])
        rel = [a for a in al if E.class_of(cat[a["category_id"]]) is not None]
        if any(a["iscrowd"] for a in rel):
            continue  # crowd regions have no per-object boxes
        w, h = im["width"], im["height"]
        gt = [(a["bbox"][0] / w, a["bbox"][1] / h, (a["bbox"][0] + a["bbox"][2]) / w, (a["bbox"][1] + a["bbox"][3]) / h,
               E.class_of(cat[a["category_id"]]), cat[a["category_id"]]) for a in rel]
        rec = {"set": "coco", "url": E.IMG_URL.format(im["file_name"]), "file": E.RAW / "val2017" / im["file_name"],
               "gt": gt, "note": f"coco {im['id']}"}
        if gt:
            out.append(rec)
        elif al:  # annotated (so it is a real photo) but nothing of ours in it
            empty.append(rec)
    rnd.shuffle(empty)
    return out + empty[:n_empty]


def oi_records(n_animals, n_plants, per_class, rnd):
    d = BIG / "openimages"
    paths = {k: fetch_file(OI_BASE + v, d / v.split("/")[-1]) for k, v in OI_FILES.items()}
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
    for lab in OI_EXCLUDE:
        excluded |= walk(find(tree, lab), set())
    person_ids = walk(find(tree, "Person"), set())
    plant_ids = {k for k, v in names.items() if v == "Houseplant"}

    # images the detector trained or validated on are left out
    with open(ROOT / "data" / "floraguard_det" / "manifest.csv", encoding="utf-8") as f:
        seen = {r["stem"][3:] for r in csv.DictReader(f) if r["source"] == "openimages" and r["split"] != "test"}

    boxes, bad, plant_imgs = defaultdict(list), set(), set()
    for split in ("validation", "test"):
        with open(paths[split], encoding="utf-8") as f:
            for r in csv.DictReader(f):
                lab, key = r["LabelName"], (split, r["ImageID"])
                if r["ImageID"] in seen:
                    continue
                box = (float(r["XMin"]), float(r["YMin"]), float(r["XMax"]), float(r["YMax"]))
                if lab in person_ids or lab in plant_ids:
                    if r["IsGroupOf"] == "1":
                        bad.add(key)
                    elif r["IsDepiction"] != "1":
                        c = 0 if lab in person_ids else 2
                        boxes[key].append((*box, c, "person" if c == 0 else "Houseplant"))
                        if c == 2:
                            plant_imgs.add(key)
                    continue
                if lab not in animal_ids:
                    continue
                if lab in excluded or r["IsGroupOf"] == "1" or r["IsDepiction"] == "1":
                    bad.add(key)
                    continue
                boxes[key].append((*box, 1, names[lab]))
    for k in bad:
        boxes.pop(k, None)
    plant_imgs -= bad

    def merge(bl):  # parent + child labels box the same animal twice (Bird + Parrot): keep the specific one
        merged = []
        for b in sorted(bl, key=lambda b: (b[2] - b[0]) * (b[3] - b[1])):
            if all(m[4] != b[4] or E.iou(b[:4], m[:4]) < 0.85 for m in merged):
                merged.append(b)
        return merged

    by_cls = defaultdict(list)
    for key, bl in boxes.items():
        for n in {b[5] for b in bl if b[4] == 1}:
            by_cls[n].append(key)
    order = [n for n in OI_FOREST if n in by_cls] + sorted(set(by_cls) - set(OI_FOREST))
    chosen, taken = [], set()
    queues = {n: rnd.sample(sorted(by_cls[n]), len(by_cls[n])) for n in order}
    count = Counter()
    while len(chosen) < n_animals and any(queues.values()):  # round-robin across species
        for n in order:
            q = queues[n]
            while q and (q[-1] in taken):
                q.pop()
            if q and count[n] < per_class and len(chosen) < n_animals:
                k = q.pop()
                taken.add(k)
                chosen.append(k)
                count[n] += 1
            elif q and count[n] >= per_class:
                q.clear()
    plants = sorted(plant_imgs - taken)
    rnd.shuffle(plants)
    chosen += plants[:n_plants]
    out = []
    for split, iid in chosen:
        out.append({"set": "openimages", "url": OI_IMG.format(split, iid), "file": d / "images" / f"{iid}.jpg",
                    "gt": merge(boxes[(split, iid)]), "note": f"oi {iid}"})
    return out


def swg_records(per_species, n_empty, rnd):
    d = BIG / "swg"
    z = fetch_file(SWG_META, d / "swg_meta.zip")
    j = d / "swg_camera_traps.bounding_boxes.with_species.json"
    if not j.exists():
        zipfile.ZipFile(z).extractall(d)
    meta = json.loads(next(d.glob("*.json")).read_text(encoding="utf-8"))
    cat = {c["id"]: c["name"] for c in meta["categories"]}
    anns = defaultdict(list)
    for a in meta["annotations"]:
        anns[a["image_id"]].append(a)
    usable, empty = {}, []
    for im in meta["images"]:
        if im.get("corrupt") or split_for("swg_" + im["location"]) != "test":
            continue  # only camera sites that were held out of training
        al = anns.get(im["id"])
        if not al:
            continue
        names = {cat[a["category_id"]] for a in al}
        if names == {"empty"}:
            usable[im["id"]] = (im, [])
            empty.append(im["id"])
            continue
        if any("bbox" not in a for a in al) or names & {"insect", "human", "vehicle"}:
            continue
        usable[im["id"]] = (im, al)
    by_sp = defaultdict(list)
    for iid, (im, al) in usable.items():
        for a in al:
            by_sp[cat[a["category_id"]]].append(iid)

    def pick(iids, k):  # one frame per burst, round-robin across locations
        seen_seq, by_loc = set(), defaultdict(list)
        ids = sorted(set(iids))
        rnd.shuffle(ids)
        for iid in ids:
            im = usable[iid][0]
            if im["seq_id"] not in seen_seq:
                seen_seq.add(im["seq_id"])
                by_loc[im["location"]].append(iid)
        out, locs = [], sorted(by_loc)
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
    for sp, iids in sorted(by_sp.items()):
        chosen.update(pick(iids, per_species))
    chosen.update(pick(empty, n_empty))
    out = []
    for iid in sorted(chosen):
        im, al = usable[iid]
        W, H = im["width"], im["height"]
        gt = [(a["bbox"][0] / W, a["bbox"][1] / H, (a["bbox"][0] + a["bbox"][2]) / W, (a["bbox"][1] + a["bbox"][3]) / H,
               1, cat[a["category_id"]]) for a in al]
        stem = im["file_name"].replace("public/", "").replace("/", "_").rsplit(".", 1)[0]
        out.append({"set": "swg", "url": SWG_IMG + im["file_name"], "file": d / "images" / f"{stem}.jpg", "gt": gt,
                    "note": f"swg {im['location']}"})
    return out


def download(recs, workers=24):
    def one(r):
        return fetch_image(r["url"], r["file"]) is not None
    with ThreadPoolExecutor(workers) as ex:
        ok = list(ex.map(one, recs))
    got = [r for r, k in zip(recs, ok) if k]
    print(f"downloaded/available {len(got)}/{len(recs)}", flush=True)
    return got


# --------------------------------------------------------------------------- analysis

def outcomes(recs, preds):
    """Classify every box the app would draw, and every true object, at the app's thresholds."""
    dets_out, gts_out, per_img = [], [], {}
    for r in recs:
        gts = r["gt_px"]
        dets = sorted([d for d in preds[r["id"]] if d[1] >= APP_CONF[d[2]]], key=lambda d: -d[1])
        matched = set()
        kinds = []
        for b, s, c in dets:
            ious = [E.iou(b, g[0]) for g in gts]
            cand = [(ious[j], j) for j, g in enumerate(gts) if g[1] == c and j not in matched]
            best = max(cand, default=(0, None))
            if best[0] >= 0.5:
                matched.add(best[1])
                kind = "correct"
            else:
                same = max([ious[j] for j, g in enumerate(gts) if g[1] == c], default=0)
                other = max([ious[j] for j, g in enumerate(gts) if g[1] != c], default=0)
                kind = ("duplicate" if same >= 0.5 else "wrong class" if other >= 0.5 else
                        "poor box" if same >= 0.1 else "wrong class + poor box" if other >= 0.1 else "background")
            kinds.append(kind)
            dets_out.append({"img": r["id"], "set": r["set"], "cls": NAMES[c], "score": s, "kind": kind, "box": b})
        for j, (g, c, tag) in enumerate(gts):
            if j in matched:
                res = "found"
            else:
                so = max([E.iou(d[0], g) for d in dets if d[2] != c], default=0)
                ss = max([E.iou(d[0], g) for d in dets if d[2] == c], default=0)
                res = "found as wrong class" if so >= 0.5 else "poor box" if ss >= 0.1 else "missed"
            area = (g[2] - g[0]) * (g[3] - g[1])
            W, H = r["size"]
            edge = g[0] <= 2 or g[1] <= 2 or g[2] >= W - 2 or g[3] >= H - 2
            gts_out.append({"img": r["id"], "set": r["set"], "cls": NAMES[c], "tag": tag, "result": res,
                            "size": "small" if area < 32 ** 2 else "medium" if area < 96 ** 2 else "large",
                            "crowd": "1 object" if len(gts) == 1 else "2-4 objects" if len(gts) <= 4 else "5+ objects",
                            "edge": "cut by frame edge" if edge else "fully in frame",
                            "light": r["light"], "colour": r["colour"], "box": g})
        per_img[r["id"]] = {"false": sum(k != "correct" for k in kinds),
                            "missed": sum(1 for j in range(len(gts)) if j not in matched), "kinds": kinds}
    return dets_out, gts_out, per_img


def recall_table(gts, key, min_n=15):
    t = defaultdict(Counter)
    for g in gts:
        t[g[key]][g["result"]] += 1
    out = {}
    for k, c in sorted(t.items(), key=lambda kv: -sum(kv[1].values())):
        n = sum(c.values())
        if n >= min_n:
            out[k] = {"objects": n, "recall": c["found"] / n, **{x: c[x] for x in
                      ("found", "missed", "found as wrong class", "poor box")}}
    return out


def img_attrs(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    m = float(g.mean())
    b, gr, r = [img[..., i].astype(np.int16) for i in range(3)]
    grey = float((np.abs(b - gr).mean() + np.abs(gr - r).mean()) / 2) < 2.5
    return ("dark" if m < 70 else "bright" if m > 170 else "normal"), ("greyscale (night IR)" if grey else "colour")


# --------------------------------------------------------------------------- pictures

COL = {0: (0, 90, 255), 1: (255, 120, 0), 2: (200, 0, 200)}


def draw(img, gts, dets, label, focus=None, h=300):
    im = img.copy()
    t = max(2, int(round(img.shape[0] / 300)))
    for b, c, _ in gts:
        cv2.rectangle(im, tuple(map(int, b[:2])), tuple(map(int, b[2:])), (60, 200, 60), t)
    for b, s, c in dets:
        if s < APP_CONF[c]:
            continue
        cv2.rectangle(im, tuple(map(int, b[:2])), tuple(map(int, b[2:])), COL[c], t)
        cv2.putText(im, f"{NAMES[c]} {s:.2f}", (int(b[0]) + 2, max(14, int(b[1]) - 4)), cv2.FONT_HERSHEY_SIMPLEX,
                    0.45 * t, COL[c], max(1, t // 2), cv2.LINE_AA)
    if focus is not None:
        b = focus
        cv2.rectangle(im, (int(b[0]) - t * 2, int(b[1]) - t * 2), (int(b[2]) + t * 2, int(b[3]) + t * 2), (0, 255, 255), t * 2)
    im = cv2.resize(im, (int(im.shape[1] * h / im.shape[0]), h), interpolation=cv2.INTER_AREA)
    im = cv2.copyMakeBorder(im, 24, 0, 0, 0, cv2.BORDER_CONSTANT, value=(255, 255, 255))
    cv2.putText(im, label[:64], (4, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1, cv2.LINE_AA)
    return im


def grid(tiles, path, title, cols=4, w=340):
    if not tiles:
        return False
    tiles = [cv2.resize(t, (w, int(t.shape[0] * w / t.shape[1])), interpolation=cv2.INTER_AREA) for t in tiles]
    h = max(t.shape[0] for t in tiles)
    tiles = [cv2.copyMakeBorder(t, 0, h - t.shape[0], 0, 0, cv2.BORDER_CONSTANT, value=(255, 255, 255)) for t in tiles]
    while len(tiles) % cols:
        tiles.append(np.full_like(tiles[0], 255))
    g = np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)])
    head = np.full((40, g.shape[1], 3), 255, np.uint8)
    cv2.putText(head, title, (8, 27), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (0, 0, 0), 2, cv2.LINE_AA)
    cv2.imwrite(str(path), np.vstack([head, g]), [cv2.IMWRITE_JPEG_QUALITY, 78])
    return True


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "reports" / "det_big"))
    ap.add_argument("--coco-empty", type=int, default=500)
    ap.add_argument("--oi-animals", type=int, default=1600)
    ap.add_argument("--oi-per-class", type=int, default=60)
    ap.add_argument("--oi-plants", type=int, default=500)
    ap.add_argument("--swg-per-species", type=int, default=80)
    ap.add_argument("--swg-empty", type=int, default=300)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rnd = random.Random(a.seed)

    recs = (coco_records(a.coco_empty, rnd) + oi_records(a.oi_animals, a.oi_plants, a.oi_per_class, rnd)
            + swg_records(a.swg_per_species, a.swg_empty, rnd))
    for s in SET_LABEL:
        sub = [r for r in recs if r["set"] == s]
        c = Counter(g[4] for r in sub for g in r["gt"])
        print(f"{s:11s} {len(sub):5d} images, {sum(1 for r in sub if not r['gt'])} empty, boxes "
              + ", ".join(f"{NAMES[k]} {v}" for k, v in sorted(c.items())), flush=True)
    if a.dry_run:
        return
    recs = download(recs)

    # read every image once: size, lighting, and the ground truth in pixels
    for i, r in enumerate(recs, 1):
        r["id"] = i
    from pycocotools.coco import COCO
    import contextlib
    import io
    gt = {"images": [], "categories": [{"id": i + 1, "name": n} for i, n in enumerate(NAMES)], "annotations": []}
    variants = [("deployed ONNX 640x384 (OpenVINO, what the app runs)", lambda: E.onnx_runner("openvino"), "CPU 4 threads"),
                ("det_B .pt 640 (ours)", lambda: E.ultra_runner(ROOT / "runs/detect/det_B/weights/best.pt", 640), "GPU"),
                ("yolo26n stock COCO-80 -> 3", lambda: E.ultra_runner(ROOT / "models/yolo26n.pt", 640, E.STOCK_MAP), "GPU"),
                ("yolo26s stock COCO-80 -> 3", lambda: E.ultra_runner(ROOT / "models/yolo26s.pt", 640, E.STOCK_MAP), "GPU")]
    runners = [(n, mk(), dev) for n, mk, dev in variants]
    preds = {n: {} for n, _, _ in runners}
    secs = Counter()
    t_all = time.perf_counter()
    for k, r in enumerate(recs):
        img = cv2.imread(str(r["file"]))
        H, W = img.shape[:2]
        r["size"] = (W, H)
        r["light"], r["colour"] = img_attrs(img)
        r["gt_px"] = [([x0 * W, y0 * H, x1 * W, y1 * H], c, tag) for x0, y0, x1, y1, c, tag in r["gt"]]
        gt["images"].append({"id": r["id"], "width": W, "height": H, "file_name": str(r["file"].name)})
        for b, c, _ in r["gt_px"]:
            gt["annotations"].append({"id": len(gt["annotations"]) + 1, "image_id": r["id"], "category_id": c + 1,
                                      "bbox": [b[0], b[1], b[2] - b[0], b[3] - b[1]],
                                      "area": (b[2] - b[0]) * (b[3] - b[1]), "iscrowd": 0})
        for n, run, _ in runners:
            t0 = time.perf_counter()
            preds[n][r["id"]] = run(img)
            secs[n] += time.perf_counter() - t0
        if k % 500 == 0:
            print(f"  inference {k}/{len(recs)}  {time.perf_counter() - t_all:.0f}s", flush=True)
    with contextlib.redirect_stdout(io.StringIO()):
        gt_coco = COCO()
        gt_coco.dataset = gt
        gt_coco.createIndex()

    res = {"sets": {}, "models": {}, "app_conf": {NAMES[k]: v for k, v in APP_CONF.items()},
           "note": "box area (not mask area) is used for the small/medium/large split in every set"}
    for s, lab in SET_LABEL.items():
        sub = [r for r in recs if r["set"] == s]
        c = Counter(NAMES[g[1]] for r in sub for g in r["gt_px"])
        res["sets"][s] = {"label": lab, "images": len(sub), "empty_images": sum(1 for r in sub if not r["gt_px"]),
                          "boxes": dict(c), "night_ir_images": sum(r["colour"] != "colour" for r in sub)}
    set_ids = {s: [r["id"] for r in recs if r["set"] == s] for s in SET_LABEL}
    set_ids["all"] = [r["id"] for r in recs]
    rng = np.random.default_rng(a.seed)
    for n, _, dev in runners:
        dets = [{"image_id": i, "category_id": c + 1, "score": s, "bbox": [float(b[0]), float(b[1]), float(b[2] - b[0]), float(b[3] - b[1])]}
                for i, p in preds[n].items() for b, s, c in p]
        m = {"device": dev, "ms_per_image": 1000 * secs[n] / len(recs), "by_set": {}}
        for s, ids in set_ids.items():
            ids_s, idset = ids, set(ids)
            e = E.coco_eval(gt_coco, dets, ids_s)
            folds = [E.coco_eval(gt_coco, dets, [int(x) for x in f])["mAP50"] for f in np.array_split(rng.permutation(ids_s), a.folds)]
            e["fold_mAP50_mean"], e["fold_mAP50_std"] = float(np.mean(folds)), float(np.std(folds))
            sub = [r for r in recs if r["id"] in idset]
            d_out, g_out, per_img = outcomes(sub, preds[n])
            nf = Counter(d["kind"] for d in d_out)
            tp = nf["correct"]
            e["at_app_thresholds"] = {"precision": tp / max(1, len(d_out)), "recall": tp / max(1, len(g_out)),
                                      "boxes_drawn": len(d_out), "objects": len(g_out)}
            emp = [r["id"] for r in sub if not r["gt_px"]]
            e["empty_images_with_false_alarm"] = {"images": len(emp), "with_any_box": sum(1 for i in emp if per_img[i]["false"])}
            m["by_set"][s] = e
        res["models"][n] = m
        print(f"{n:52s} " + "  ".join(f"{s} mAP50 {m['by_set'][s]['mAP50']:.3f}" for s in set_ids)
              + f"  {m['ms_per_image']:.1f} ms", flush=True)

    # ---- deep dive on the deployed model
    dep = runners[0][0]
    d_out, g_out, per_img = outcomes(recs, preds[dep])
    res["deployed"] = dep
    res["slices"] = {
        "set": recall_table(g_out, "set"),
        "class": recall_table(g_out, "cls"),
        "object size": recall_table(g_out, "size"),
        "crowding": recall_table(g_out, "crowd"),
        "frame edge": recall_table(g_out, "edge"),
        "lighting": recall_table(g_out, "light"),
        "colour": recall_table(g_out, "colour"),
        "camera trap: day vs night": recall_table([g for g in g_out if g["set"] == "swg"], "colour"),
        "animal species (all sets, >=15 objects)": recall_table([g for g in g_out if g["cls"] == "animal"], "tag"),
        "set x class": recall_table([dict(g, sc=f"{g['set']} / {g['cls']}") for g in g_out], "sc"),
        "size x class": recall_table([dict(g, sc=f"{g['size']} {g['cls']}") for g in g_out], "sc"),
    }
    errs = defaultdict(Counter)
    for d in d_out:
        errs[d["set"]][d["kind"]] += 1
        errs["all"][d["kind"]] += 1
    res["false_box_types"] = {s: dict(c) for s, c in errs.items()}
    miss = defaultdict(Counter)
    for g in g_out:
        miss[g["set"]][g["result"]] += 1
        miss["all"][g["result"]] += 1
    res["object_outcomes"] = {s: dict(c) for s, c in miss.items()}
    by_cls_err = defaultdict(Counter)
    for d in d_out:
        if d["kind"] != "correct":
            by_cls_err[d["cls"]][d["kind"]] += 1
    res["false_box_types_by_class"] = {k: dict(v) for k, v in by_cls_err.items()}
    # confusion at IoU 0.5: rows = truth, cols = predicted
    conf = np.zeros((4, 4), int)  # last row/col = nothing
    for r in recs:
        dets = [d for d in preds[dep][r["id"]] if d[1] >= APP_CONF[d[2]]]
        used = set()
        for b, c, _ in r["gt_px"]:
            best, bj = 0.5, None
            for j, (db, s, dc) in enumerate(dets):
                if j not in used and E.iou(b, db) >= best:
                    best, bj = E.iou(b, db), j
            if bj is None:
                conf[c, 3] += 1
            else:
                used.add(bj)
                conf[c, dets[bj][2]] += 1
        for j, (db, s, dc) in enumerate(dets):
            if j not in used:
                conf[3, dc] += 1
    res["confusion_iou50"] = {"rows_truth_cols_predicted": NAMES + ["nothing"], "matrix": conf.tolist()}

    # ---- pictures (random samples are seeded and not cherry-picked)
    by_id = {r["id"]: r for r in recs}
    pr = random.Random(a.seed)
    img_cache = {}

    def load(i):
        if i not in img_cache:
            if len(img_cache) > 64:
                img_cache.clear()
            img_cache[i] = cv2.imread(str(by_id[i]["file"]))
        return img_cache[i]

    def tile(i, model=dep, label=None, focus=None):
        r = by_id[i]
        pi = per_img[i] if model == dep else outcomes([r], preds[model])[2][i]
        lab = label or f"{r['note']}: {len(r['gt_px'])} true, {pi['false']} false, {pi['missed']} missed"
        return draw(load(i), r["gt_px"], preds[model][i], lab, focus)

    galleries = []

    def save(name, tiles, title, cols=4):
        if grid(tiles, out / f"{name}.jpg", title, cols):
            galleries.append({"file": f"{name}.jpg", "title": title})

    def sample(ids, k):
        ids = sorted(set(ids))
        return pr.sample(ids, min(k, len(ids)))

    # random samples per slice
    slices = [
        ("slice_coco", [r["id"] for r in recs if r["set"] == "coco" and r["gt_px"]], "COCO val2017, random sample"),
        ("slice_oi_animals", [r["id"] for r in recs if r["set"] == "openimages" and any(g[1] == 1 for g in r["gt_px"])], "Open Images animals, random sample"),
        ("slice_oi_plants", [r["id"] for r in recs if r["set"] == "openimages" and any(g[1] == 2 for g in r["gt_px"])], "Open Images houseplants, random sample"),
        ("slice_swg_day", [r["id"] for r in recs if r["set"] == "swg" and r["gt_px"] and r["colour"] == "colour"], "Camera trap, daytime colour, random sample"),
        ("slice_swg_night", [r["id"] for r in recs if r["set"] == "swg" and r["gt_px"] and r["colour"] != "colour"], "Camera trap, night infrared, random sample"),
        ("slice_swg_empty", [r["id"] for r in recs if r["set"] == "swg" and not r["gt_px"]], "Camera trap with nothing in it (wind, light), random sample"),
        ("slice_dark", [r["id"] for r in recs if r["light"] == "dark" and r["colour"] == "colour" and r["gt_px"]], "Dark colour photos, random sample"),
        ("slice_crowded", [r["id"] for r in recs if len(r["gt_px"]) >= 5], "Crowded scenes (5+ objects), random sample"),
        ("slice_small", sorted({g["img"] for g in g_out if g["size"] == "small" and g["cls"] == "animal"}), "Pictures with small animals, random sample"),
        ("slice_edge", sorted({g["img"] for g in g_out if g["edge"] == "cut by frame edge" and g["cls"] == "animal"}), "Animals cut by the frame edge, random sample"),
    ]
    for name, ids, title in slices:
        save(name, [tile(i) for i in sample(ids, 12)], title + "  (green = truth, colour = detected)")
    # worst cases per error type: the most confident false box of each kind, one per picture
    for kind in ("background", "wrong class", "poor box", "duplicate"):
        seen, tiles = set(), []
        for d in sorted([d for d in d_out if d["kind"] == kind], key=lambda d: -d["score"]):
            if d["img"] in seen:
                continue
            seen.add(d["img"])
            tiles.append(tile(d["img"], label=f"{by_id[d['img']]['note']}: {d['cls']} {d['score']:.2f} = {kind}", focus=d["box"]))
            if len(tiles) == 12:
                break
        save(f"err_{kind.replace(' ', '_')}", tiles, f"False boxes: {kind} (most confident first, yellow = the box in question)")
    for what, filt in (("large", lambda g: g["size"] == "large"), ("small", lambda g: g["size"] == "small")):
        seen, tiles = set(), []
        ms = [g for g in g_out if g["result"] == "missed" and filt(g)]
        for g in sorted(ms, key=lambda g: -(g["box"][2] - g["box"][0]) * (g["box"][3] - g["box"][1]))[:200]:
            if g["img"] in seen:
                continue
            seen.add(g["img"])
            tiles.append(tile(g["img"], label=f"{by_id[g['img']]['note']}: missed {g['tag']}", focus=g["box"]))
            if len(tiles) == 12:
                break
        save(f"err_missed_{what}", tiles, f"Missed {what} objects (largest first, yellow = the missed object)")
    # ours vs stock on the same pictures, per set
    stock = runners[3][0]
    for s in SET_LABEL:
        ids = sample([r["id"] for r in recs if r["set"] == s and r["gt_px"]], 4)
        tiles = []
        for i in ids:
            tiles += [tile(i, dep, f"{by_id[i]['note']}: ours (deployed)"), tile(i, stock, f"{by_id[i]['note']}: yolo26s stock")]
        save(f"cmp_{s}", tiles, f"{SET_LABEL[s]}: ours (left) vs stock yolo26s (right), random pictures")
    res["galleries"] = galleries

    # ---- charts
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    names = list(res["models"])
    fig, ax = plt.subplots(figsize=(12, 4.6))
    sets = list(SET_LABEL) + ["all"]
    w = 0.8 / len(names)
    for k, n in enumerate(names):
        v = [res["models"][n]["by_set"][s]["mAP50"] for s in sets]
        er = [res["models"][n]["by_set"][s]["fold_mAP50_std"] for s in sets]
        ax.bar(np.arange(len(sets)) + k * w - 0.4 + w / 2, v, w, yerr=er, capsize=3, label=n)
    ax.set_xticks(range(len(sets)), ["COCO val", "Open Images", "Camera traps", "All"])
    ax.set(ylim=(0, 1), ylabel="mAP50", title="Detector variants on three unseen image sets (error bar = spread over 5 folds)")
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(out / "big_map_by_set.png", dpi=105)
    plt.close(fig)

    keys = ["object size", "crowding", "frame edge", "lighting", "colour", "class"]
    fig, axs = plt.subplots(1, len(keys), figsize=(18, 4), sharey=True)
    for ax, k in zip(axs, keys):
        t = res["slices"][k]
        ax.bar(range(len(t)), [v["recall"] for v in t.values()], color="#2a7d4f")
        ax.set_xticks(range(len(t)), [f"{x}\n(n={v['objects']})" for x, v in t.items()], fontsize=7, rotation=20)
        ax.set_title(k)
    axs[0].set(ylim=(0, 1), ylabel="share of objects found (app thresholds)")
    fig.suptitle("Deployed detector: recall by kind of example")
    fig.tight_layout()
    fig.savefig(out / "big_recall_slices.png", dpi=105)
    plt.close(fig)

    sp = res["slices"]["animal species (all sets, >=15 objects)"]
    top = sorted(sp.items(), key=lambda kv: kv[1]["recall"])[:30]
    fig, ax = plt.subplots(figsize=(8, max(4, 0.26 * len(top))))
    ax.barh(range(len(top)), [v["recall"] for _, v in top], color="#d68910")
    ax.set_yticks(range(len(top)), [f"{k} (n={v['objects']})" for k, v in top], fontsize=7)
    ax.set(xlim=(0, 1), xlabel="share found", title="Animal species found least often (deployed, 30 lowest)")
    fig.tight_layout()
    fig.savefig(out / "big_species.png", dpi=105)
    plt.close(fig)

    kinds = ["background", "wrong class", "poor box", "wrong class + poor box", "duplicate"]
    fig, ax = plt.subplots(figsize=(8, 3.8))
    left = np.zeros(4)
    for kd, colr in zip(kinds, ["#c0392b", "#8e44ad", "#d68910", "#7f8c8d", "#2471a3"]):
        v = np.array([res["false_box_types"].get(s, {}).get(kd, 0) for s in sets])
        ax.barh(range(4), v, left=left, label=kd, color=colr)
        left += v
    ax.set_yticks(range(4), ["COCO val", "Open Images", "Camera traps", "All"])
    ax.set(xlabel="false boxes drawn at app thresholds", title="What the false boxes are")
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(out / "big_error_types.png", dpi=105)
    plt.close(fig)

    with open(out / "per_object.csv", "w", newline="", encoding="utf-8") as f:
        wr = csv.writer(f)
        wr.writerow(["image", "set", "class", "tag", "result", "size", "crowd", "edge", "light", "colour"])
        for g in g_out:
            wr.writerow([by_id[g["img"]]["note"], g["set"], g["cls"], g["tag"], g["result"], g["size"], g["crowd"], g["edge"], g["light"], g["colour"]])
    (out / "det_big.json").write_text(json.dumps(res, indent=2, default=float))
    print(json.dumps({"sets": res["sets"], "false_box_types": res["false_box_types"], "object_outcomes": res["object_outcomes"]}, indent=1))
    print("saved", out / "det_big.json")


if __name__ == "__main__":
    main()
