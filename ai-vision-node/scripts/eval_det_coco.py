"""Independent detector test on COCO val2017, plus a comparison of model variants.

The FloraGuard detector was trained on COCO *train2017* (with Open Images and SWG camera traps),
so COCO *val2017* is images it has never seen. This script downloads a sample of them, maps
COCO's labels to the app's three classes the same way training did (person; the 10 COCO animals;
potted plant), and scores, on the very same images:

    det_B .pt     our trained detector, PyTorch on the GPU, at 640 / 480 / 320 px input
    det_B ONNX    the file the app actually runs, at the app's 640x384, on OpenVINO and ONNX Runtime
    yolo26n/s     the stock Ultralytics COCO models (80 classes, mapped to our 3)

Reported per model: COCO mAP50-95 / mAP50 / per-class AP50 / small-medium-large (pycocotools),
precision and recall at the app's own confidence thresholds, false alarms on empty images,
speed, and the spread of mAP50 over 5 random folds of the images.

    python scripts/eval_det_coco.py --out reports/det_coco
Needs: pip install pycocotools. Downloads ~250 MB the first time (data/raw/coco, not committed).
"""
import argparse
import contextlib
import io
import json
import random
import sys
import time
import types
import urllib.request
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
from engine import EXPORT, Models, Net, available_backends  # noqa: E402

RAW = ROOT / "data" / "raw" / "coco"
ANN_URL = "http://images.cocodataset.org/annotations/annotations_trainval2017.zip"
IMG_URL = "http://images.cocodataset.org/val2017/{}"
NAMES = ["person", "animal", "plant"]
ANIMALS = ["bird", "cat", "dog", "bear", "horse", "sheep", "cow", "elephant", "zebra", "giraffe"]  # as download_coco.py
APP_CONF = {0: 0.4, 1: 0.35, 2: 0.35}  # conf_person / conf_animal / conf_plant in app/pipeline.py DEFAULTS
# Ultralytics COCO-80 class index -> our class
STOCK_MAP = {0: 0, 14: 1, 15: 1, 16: 1, 17: 1, 18: 1, 19: 1, 20: 1, 21: 1, 22: 1, 23: 1, 58: 2}


def class_of(name):
    return 0 if name == "person" else 2 if name == "potted plant" else 1 if name in ANIMALS else None


# --------------------------------------------------------------------------- data

def load_val():
    j = RAW / "instances_val2017.json"
    if not j.exists():
        z = RAW / "annotations_trainval2017.zip"
        if not z.exists():
            RAW.mkdir(parents=True, exist_ok=True)
            print("downloading COCO annotations (241 MB)...")
            urllib.request.urlretrieve(ANN_URL, z)
        with zipfile.ZipFile(z) as zf:
            j.write_bytes(zf.read("annotations/instances_val2017.json"))
    return json.loads(j.read_text())


def select(meta, n_animal, n_person, n_empty, seed):
    cat = {c["id"]: class_of(c["name"]) for c in meta["categories"]}
    anns = defaultdict(list)
    for a in meta["annotations"]:
        anns[a["image_id"]].append(a)
    keep_cls, crowd, any_ann = defaultdict(set), set(), set()
    for iid, al in anns.items():
        for a in al:
            any_ann.add(iid)
            c = cat[a["category_id"]]
            if c is None:
                continue
            if a["iscrowd"]:
                crowd.add(iid)  # crowd regions have no per-object boxes: dropped, as in training
            keep_cls[iid].add(c)
    ok = [i for i in keep_cls if i not in crowd]
    rnd = random.Random(seed)
    plants = sorted(i for i in ok if 2 in keep_cls[i])
    animals = sorted(i for i in ok if 1 in keep_cls[i] and i not in plants)
    people = sorted(i for i in ok if keep_cls[i] == {0})
    rnd.shuffle(animals)
    rnd.shuffle(people)
    empty = sorted(im["id"] for im in meta["images"] if im["id"] not in keep_cls and im["id"] in any_ann)
    rnd.shuffle(empty)
    chosen = {"plant": plants, "animal": animals[:n_animal], "person_only": people[:n_person], "empty": empty[:n_empty]}
    return chosen, cat, anns


def download(images, workers=16):
    d = RAW / "val2017"
    d.mkdir(parents=True, exist_ok=True)

    def one(im):
        p = d / im["file_name"]
        if p.exists() and p.stat().st_size > 0:
            return True
        for attempt in range(3):
            try:
                tmp = p.with_suffix(".part")
                urllib.request.urlretrieve(IMG_URL.format(im["file_name"]), tmp)
                tmp.replace(p)
                return True
            except Exception:
                time.sleep(1 + attempt)
        return False

    with ThreadPoolExecutor(workers) as ex:
        ok = list(ex.map(one, images))
    print(f"images: {sum(ok)}/{len(images)} available")
    return [im for im, k in zip(images, ok) if k]


def build_gt(images, cat, anns):
    gt = {"images": images, "categories": [{"id": i + 1, "name": n} for i, n in enumerate(NAMES)], "annotations": []}
    k = 1
    for im in images:
        for a in anns.get(im["id"], []):
            c = cat[a["category_id"]]
            if c is None or a["iscrowd"]:
                continue
            gt["annotations"].append({"id": k, "image_id": im["id"], "category_id": c + 1, "bbox": a["bbox"],
                                      "area": a["area"], "iscrowd": 0})
            k += 1
    return gt


# --------------------------------------------------------------------------- models

def nms_per_class(dets, iou=0.7):
    out = []
    for c in {d[2] for d in dets}:
        ds = [d for d in dets if d[2] == c]
        boxes = [[b[0], b[1], b[2] - b[0], b[3] - b[1]] for b, _, _ in ds]
        keep = np.asarray(cv2.dnn.NMSBoxes(boxes, [s for _, s, _ in ds], 0.0, iou), int).reshape(-1)
        out += [ds[i] for i in keep]
    return out


def ultra_runner(weights, imgsz, mapping=None):
    from ultralytics import YOLO
    m = YOLO(str(weights))

    def run(img):
        r = m.predict(img, imgsz=imgsz, conf=0.001, iou=0.7, max_det=300, device=0, verbose=False,
                      classes=list(mapping) if mapping else None)[0]
        b = r.boxes
        dets = [(bb, float(s), int(c)) for bb, s, c in zip(b.xyxy.cpu().numpy(), b.conf.cpu().numpy(), b.cls.cpu().numpy())]
        if mapping:
            dets = nms_per_class([(bb, s, mapping[c]) for bb, s, c in dets])
        return dets
    return run


def onnx_runner(backend):
    spec = json.loads((EXPORT / "models.json").read_text())["det"]
    ns = types.SimpleNamespace(det=Net(spec, backend, 4))
    return lambda img: Models.detect(ns, img, 0.001)


# --------------------------------------------------------------------------- scoring

def coco_eval(gt_coco, dets, img_ids=None):
    from pycocotools.cocoeval import COCOeval
    if not dets:
        return None
    with contextlib.redirect_stdout(io.StringIO()):
        dt = gt_coco.loadRes(dets)
        e = COCOeval(gt_coco, dt, "bbox")
        if img_ids is not None:
            e.params.imgIds = img_ids
        e.evaluate()
        e.accumulate()
        e.summarize()
    st = e.stats
    prec = e.eval["precision"]  # T x R x K x A x M
    per = {}
    for k, n in enumerate(NAMES):
        p50 = prec[0, :, k, 0, -1]
        p = prec[:, :, k, 0, -1]
        per[n] = {"AP50": float(p50[p50 > -1].mean()) if (p50 > -1).any() else None,
                  "AP50-95": float(p[p > -1].mean()) if (p > -1).any() else None}
    return {"mAP50-95": st[0], "mAP50": st[1], "mAP75": st[2], "AP_small": st[3], "AP_medium": st[4],
            "AP_large": st[5], "AR100": st[8], "per_class": per}


def iou(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    return inter / max(1e-9, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def operating_point(gt, preds):
    """Precision / recall at IoU 0.5 using the app's confidence thresholds (what the app would draw)."""
    gts = defaultdict(list)
    for a in gt["annotations"]:
        x, y, w, h = a["bbox"]
        gts[a["image_id"]].append(([x, y, x + w, y + h], a["category_id"] - 1))
    tp, fp, fn = np.zeros(3, int), np.zeros(3, int), np.zeros(3, int)
    per_image = {}
    for iid, dets in preds.items():
        dets = sorted([d for d in dets if d[1] >= APP_CONF[d[2]]], key=lambda d: -d[1])
        used = set()
        e_fp = e_fn = 0
        for b, s, c in dets:
            best, bi = 0.5, None
            for j, (g, gc) in enumerate(gts[iid]):
                if gc == c and j not in used and iou(b, g) >= best:
                    best, bi = iou(b, g), j
            if bi is None:
                fp[c] += 1
                e_fp += 1
            else:
                used.add(bi)
                tp[c] += 1
        for j, (g, gc) in enumerate(gts[iid]):
            if j not in used:
                fn[gc] += 1
                e_fn += 1
        per_image[iid] = (e_fp, e_fn)
    out = {}
    for c, n in enumerate(NAMES):
        out[n] = {"precision": tp[c] / max(1, tp[c] + fp[c]), "recall": tp[c] / max(1, tp[c] + fn[c]),
                  "tp": int(tp[c]), "fp": int(fp[c]), "fn": int(fn[c])}
    T, F, N = tp.sum(), fp.sum(), fn.sum()
    out["all"] = {"precision": T / max(1, T + F), "recall": T / max(1, T + N)}
    return out, per_image


# --------------------------------------------------------------------------- pictures

def draw(img, gt_boxes, dets, label):
    im = img.copy()
    for b, c in gt_boxes:
        cv2.rectangle(im, tuple(map(int, b[:2])), tuple(map(int, b[2:])), (60, 200, 60), 2)
    col = {0: (0, 90, 255), 1: (255, 120, 0), 2: (200, 0, 200)}
    for b, s, c in dets:
        if s < APP_CONF[c]:
            continue
        cv2.rectangle(im, tuple(map(int, b[:2])), tuple(map(int, b[2:])), col[c], 2)
        cv2.putText(im, f"{NAMES[c]} {s:.2f}", (int(b[0]) + 2, max(12, int(b[1]) - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, col[c], 1, cv2.LINE_AA)
    h = 300
    im = cv2.resize(im, (int(im.shape[1] * h / im.shape[0]), h))
    im = cv2.copyMakeBorder(im, 26, 0, 0, 0, cv2.BORDER_CONSTANT, value=(255, 255, 255))
    cv2.putText(im, label, (4, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
    return im


def grid(tiles, path, title, cols=4, w=420):
    tiles = [cv2.resize(t, (w, int(t.shape[0] * w / t.shape[1]))) for t in tiles]
    h = max(t.shape[0] for t in tiles)
    tiles = [cv2.copyMakeBorder(t, 0, h - t.shape[0], 0, 0, cv2.BORDER_CONSTANT, value=(255, 255, 255)) for t in tiles]
    while len(tiles) % cols:
        tiles.append(np.full_like(tiles[0], 255))
    g = np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)])
    head = np.full((44, g.shape[1], 3), 255, np.uint8)
    cv2.putText(head, title, (8, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (0, 0, 0), 2, cv2.LINE_AA)
    cv2.imwrite(str(path), np.vstack([head, g]), [cv2.IMWRITE_JPEG_QUALITY, 85])


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "reports" / "det_coco"))
    ap.add_argument("--animals", type=int, default=500)
    ap.add_argument("--people", type=int, default=600)
    ap.add_argument("--empty", type=int, default=150)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--folds", type=int, default=5)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    from pycocotools.coco import COCO
    meta = load_val()
    chosen, cat, anns = select(meta, a.animals, a.people, a.empty, a.seed)
    by_id = {im["id"]: im for im in meta["images"]}
    ids = [i for v in chosen.values() for i in v]
    images = download([by_id[i] for i in ids])
    ids = [im["id"] for im in images]
    empty_ids = set(chosen["empty"]) & set(ids)
    gt = build_gt(images, cat, anns)
    with contextlib.redirect_stdout(io.StringIO()):
        gt_coco = COCO()
        gt_coco.dataset = gt
        gt_coco.createIndex()
    counts = defaultdict(int)
    for x in gt["annotations"]:
        counts[NAMES[x["category_id"] - 1]] += 1
    res = {"dataset": {"source": "COCO val2017 (not used in training)", "images": len(ids),
                       "selection": {k: len(set(v) & set(ids)) for k, v in chosen.items()}, "boxes": dict(counts)},
           "app_conf": {NAMES[k]: v for k, v in APP_CONF.items()}, "models": {}}
    print(json.dumps(res["dataset"]))

    det_b = ROOT / "runs/detect/det_B/weights/best.pt"
    variants = [
        ("det_B (ours) .pt 640", lambda: ultra_runner(det_b, 640), "GPU"),
        ("det_B (ours) .pt 480", lambda: ultra_runner(det_b, 480), "GPU"),
        ("det_B (ours) .pt 320", lambda: ultra_runner(det_b, 320), "GPU"),
        ("yolo26n stock COCO-80 -> 3", lambda: ultra_runner(ROOT / "models/yolo26n.pt", 640, STOCK_MAP), "GPU"),
        ("yolo26s stock COCO-80 -> 3", lambda: ultra_runner(ROOT / "models/yolo26s.pt", 640, STOCK_MAP), "GPU"),
    ]
    for b in ("openvino", "onnxruntime"):
        if b in available_backends():
            variants.append((f"det_B (ours) deployed ONNX 640x384, {b}", lambda b=b: onnx_runner(b), "CPU 4 threads"))

    rng = np.random.default_rng(a.seed)
    folds = np.array_split(rng.permutation(ids), a.folds)
    all_preds = {}
    for name, make, device in variants:
        run = make()
        img0 = cv2.imread(str(RAW / "val2017" / images[0]["file_name"]))
        for _ in range(3):
            run(img0)  # warm-up
        preds, dets, t = {}, [], 0.0
        for im in images:
            img = cv2.imread(str(RAW / "val2017" / im["file_name"]))
            t0 = time.perf_counter()
            p = run(img)
            t += time.perf_counter() - t0
            preds[im["id"]] = p
            for b, s, c in p:
                dets.append({"image_id": im["id"], "category_id": c + 1, "score": s,
                             "bbox": [float(b[0]), float(b[1]), float(b[2] - b[0]), float(b[3] - b[1])]})
        m = coco_eval(gt_coco, dets)
        m["fold_mAP50"] = [coco_eval(gt_coco, dets, [int(i) for i in f])["mAP50"] for f in folds]
        m["fold_mAP50_mean"], m["fold_mAP50_std"] = float(np.mean(m["fold_mAP50"])), float(np.std(m["fold_mAP50"]))
        op, per_image = operating_point(gt, preds)
        m["at_app_thresholds"] = op
        fa = sum(1 for i in empty_ids if any(s >= APP_CONF[c] for _, s, c in preds[i]))
        m["empty_images_with_false_alarm"] = {"images": len(empty_ids), "with_any_box": fa}
        m["ms_per_image"], m["device"] = 1000 * t / len(images), device
        res["models"][name] = m
        all_preds[name] = (preds, per_image)
        print(f"{name:45s} mAP50 {m['mAP50']:.3f} (folds {m['fold_mAP50_mean']:.3f}±{m['fold_mAP50_std']:.3f})  "
              f"mAP50-95 {m['mAP50-95']:.3f}  person {m['per_class']['person']['AP50']:.3f}  "
              f"animal {m['per_class']['animal']['AP50']:.3f}  plant {m['per_class']['plant']['AP50']:.3f}  "
              f"{m['ms_per_image']:.1f} ms")

    # agreement between the backends running the same exported file, and with the .pt
    names = list(res["models"])
    dep = [n for n in names if "deployed" in n]
    if len(dep) == 2:
        pa, pb = all_preds[dep[0]][0], all_preds[dep[1]][0]
        same = []
        for i in ids:
            A = sorted([d for d in pa[i] if d[1] >= APP_CONF[d[2]]], key=lambda d: -d[1])
            B = sorted([d for d in pb[i] if d[1] >= APP_CONF[d[2]]], key=lambda d: -d[1])
            same.append(len(A) == len(B) and all(x[2] == y[2] and iou(x[0], y[0]) > 0.95 for x, y in zip(A, B)))
        res["backend_agreement"] = {"pair": dep, "images_identical_pct": 100 * float(np.mean(same))}

    # pictures: where the deployed model does worst and best, and ours vs stock on plants
    ref = dep[0] if dep else names[0]
    preds, per_image = all_preds[ref]
    gtb = defaultdict(list)
    for x in gt["annotations"]:
        bx, by, bw, bh = x["bbox"]
        gtb[x["image_id"]].append(([bx, by, bx + bw, by + bh], x["category_id"] - 1))
    worst = sorted(per_image, key=lambda i: -(per_image[i][0] + per_image[i][1]))[:12]
    best = [i for i in ids if per_image[i] == (0, 0) and gtb[i]][:8]
    tile = lambda i, p, lab: draw(cv2.imread(str(RAW / "val2017" / by_id[i]["file_name"])), gtb[i], p[i], lab)  # noqa: E731
    grid([tile(i, preds, f"{i}: {per_image[i][0]} false, {per_image[i][1]} missed") for i in worst],
         out / "det_worst.jpg", "Hardest images for the deployed detector (green = truth, colour = detected)")
    grid([tile(i, preds, f"{i}: all correct") for i in best], out / "det_best.jpg", "Images the deployed detector got fully right")
    plant_ids = [i for i in chosen["plant"] if i in preds][:6]
    stock = next((n for n in names if n.startswith("yolo26s")), None)
    if stock:
        tiles = []
        for i in plant_ids:
            tiles += [tile(i, preds, f"{i}: det_B (ours, deployed)"), tile(i, all_preds[stock][0], f"{i}: yolo26s stock")]
        grid(tiles, out / "det_ours_vs_stock_plants.jpg", "Plants: our detector (left) vs the stock COCO model (right)", cols=4)

    # chart
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(13, 4.8))
    x = np.arange(4)
    w = 0.8 / len(names)
    for k, n in enumerate(names):
        m = res["models"][n]
        v = [m["mAP50"]] + [m["per_class"][c]["AP50"] or 0 for c in NAMES]
        ax.bar(x + k * w - 0.4 + w / 2, v, w, label=n)
    ax.set_xticks(x, ["all (mAP50)", "person AP50", "animal AP50", "plant AP50"])
    ax.set_ylim(0, 1)
    ax.set_title("Detector variants on COCO val2017 (unseen)")
    ax.legend(fontsize=8, ncol=2)
    fig.tight_layout()
    fig.savefig(out / "det_variants.png", dpi=110)
    plt.close(fig)

    (out / "det_coco.json").write_text(json.dumps(res, indent=2, default=float))
    print("saved", out / "det_coco.json")


if __name__ == "__main__":
    main()
