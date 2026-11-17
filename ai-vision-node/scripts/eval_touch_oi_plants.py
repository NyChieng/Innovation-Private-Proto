"""An external hand-on-plant test for the touch classifier, built from Open Images.

The touch training data has very few hands on plants (10 in test + val). Open Images V7
(validation + test, never used by the touch model) boxes human hands and plants, trees and flowers.
Every hand that overlaps a plant box, plus some hands in the same photos that do not, is cut the way
the live app cuts it (YOLO26s-pose wrist + elbow -> app/touchcrop.py), and a person labels each crop
by eye from numbered contact sheets: overlapping boxes do not mean touching.

    python scripts/eval_touch_oi_plants.py make  OUT     # download, crop, write numbered sheets
    (label OUT/labels.json: {"0": "touch" | "no_touch" | "skip", ...})
    python scripts/eval_touch_oi_plants.py score OUT     # score the deployed model, galleries
"""
import csv
import json
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "app"))
from fg_common import fetch_image  # noqa: E402
from touchcrop import box_dist, cut, hand_box  # noqa: E402

OI = ROOT / "data" / "raw" / "eval_big" / "openimages"
PLANTS = {"Plant", "Houseplant", "Flower", "Tree", "Rose", "Common sunflower", "Lily", "Tulip", "Palm tree",
          "Lavender (Plant)", "Maple", "Willow", "Cactus", "Flowerpot"}
WRISTS = ((9, 7), (10, 8))


def ioa(h, p):
    ix = max(0, min(h[2], p[2]) - max(h[0], p[0]))
    iy = max(0, min(h[3], p[3]) - max(h[1], p[1]))
    return ix * iy / max(1e-9, (h[2] - h[0]) * (h[3] - h[1]))


def make(out):
    names = {r[0]: r[1] for r in csv.reader(open(OI / "oidv7-class-descriptions-boxable.csv", encoding="utf-8"))}
    hands, plants, split_of = defaultdict(list), defaultdict(list), {}
    for split in ("validation", "test"):
        for r in csv.DictReader(open(OI / f"{split}-annotations-bbox.csv", encoding="utf-8")):
            n = names.get(r["LabelName"])
            b = (float(r["XMin"]), float(r["YMin"]), float(r["XMax"]), float(r["YMax"]))
            if r["IsGroupOf"] == "1":
                continue
            if n == "Human hand":
                hands[r["ImageID"]].append(b)
                split_of[r["ImageID"]] = split
            elif n in PLANTS and r["IsDepiction"] != "1":
                plants[r["ImageID"]].append((n, b))
    ids = sorted(i for i in hands if i in plants)
    img_dir = out / "images"
    with ThreadPoolExecutor(16) as ex:
        ok = list(ex.map(lambda i: fetch_image(f"https://open-images-dataset.s3.amazonaws.com/{split_of[i]}/{i}.jpg",
                                               img_dir / f"{i}.jpg", max_side=1600) is not None, ids))
    ids = [i for i, k in zip(ids, ok) if k]
    print(f"{len(ids)} photos with a hand and a plant")

    from ultralytics import YOLO
    pose = YOLO(str(ROOT / "models/yolo26s-pose.pt"))
    crops, meta = [], []
    (out / "crops").mkdir(exist_ok=True)
    for iid in ids:
        img = cv2.imread(str(img_dir / f"{iid}.jpg"))
        H, W = img.shape[:2]
        res = pose.predict(img, imgsz=640, conf=0.25, device=0, verbose=False)[0]
        if res.keypoints is None or not len(res.boxes):
            continue
        pb = res.boxes.xyxy.cpu().numpy()
        kxy, kcf = res.keypoints.xy.cpu().numpy(), res.keypoints.conf.cpu().numpy()
        used = set()
        for h in hands[iid]:
            best = max(((ioa(h, p[1]), p[0]) for p in plants[iid]), default=(0, ""))
            hb = (h[0] * W, h[1] * H, h[2] * W, h[3] * H)
            pad = 0.5 * max(hb[2] - hb[0], hb[3] - hb[1])
            big = (hb[0] - pad, hb[1] - pad, hb[2] + pad, hb[3] + pad)
            cand = [(m, s) for m in range(len(pb)) for s, (wi, _) in enumerate(WRISTS)
                    if kcf[m, wi] >= 0.5 and box_dist(kxy[m, wi], big) == 0 and (m, s) not in used]
            if not cand:
                continue
            cx, cy = (hb[0] + hb[2]) / 2, (hb[1] + hb[3]) / 2
            m, s = min(cand, key=lambda c: np.hypot(kxy[c[0], WRISTS[c[1]][0]][0] - cx, kxy[c[0], WRISTS[c[1]][0]][1] - cy))
            used.add((m, s))
            wi, ei = WRISTS[s]
            elbow = kxy[m, ei] if kcf[m, ei] >= 0.5 else None
            box = hand_box(kxy[m, wi], elbow, pb[m][3] - pb[m][1])
            crop = cut(img, box)
            if crop is None:
                continue
            k = len(crops)
            cv2.imwrite(str(out / "crops" / f"{k:04d}.jpg"), crop)
            crops.append(crop)
            meta.append({"id": k, "image": iid, "overlap": round(best[0], 3), "plant": best[1] if best[0] > 0 else ""})
    (out / "crops.json").write_text(json.dumps(meta, indent=1))
    # numbered sheets for labelling, 40 per sheet; the hand box context is shown next to each crop
    for start in range(0, len(crops), 40):
        tiles = []
        for c, mt in zip(crops[start:start + 40], meta[start:start + 40]):
            t = cv2.resize(c, (180, 180))
            cv2.rectangle(t, (0, 0), (52, 22), (255, 255, 255), -1)
            cv2.putText(t, str(mt["id"]), (3, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 200), 2)
            tiles.append(t)
        while len(tiles) % 8:
            tiles.append(np.full_like(tiles[0], 255))
        g = np.vstack([np.hstack(tiles[r:r + 8]) for r in range(0, len(tiles), 8)])
        cv2.imwrite(str(out / f"sheet_{start // 40:02d}.jpg"), g, [cv2.IMWRITE_JPEG_QUALITY, 85])
    print(f"{len(crops)} crops, overlap>=0.3: {sum(m['overlap'] >= 0.3 for m in meta)}; sheets in {out}")


def score(out):
    import eval_touch_full as T
    meta = json.loads((out / "crops.json").read_text())
    labels = json.loads((out / "labels.json").read_text())
    rows = [m for m in meta if labels.get(str(m["id"])) in ("touch", "no_touch")]
    images = [cv2.imread(str(out / "crops" / f"{m['id']:04d}.jpg")) for m in rows]
    y = np.array([labels[str(m["id"])] == "touch" for m in rows])
    spec = json.loads((T.EXPORT / "models.json").read_text())["touch"]
    idx = spec["names"].index("touch")
    s = T.run_net(T.Net(spec, "openvino", 4), idx, images)
    res = {"source": "Open Images V7 validation + test, hands labelled by eye", "crops": len(rows), "touch": int(y.sum()),
           "skipped": sum(1 for v in labels.values() if v == "skip"), "metrics": T.score(y, s),
           "metrics_at_0.5": T.score(y, s, 0.5), "metrics_at_0.3": T.score(y, s, 0.3), "by_plant": {}}
    if 0 < y.sum() < len(y):
        res["bootstrap"] = T.bootstrap(y, s, T.APP_THRESHOLD, 1000)
    for p in sorted({m["plant"] or "no plant overlap" for m in rows}):
        ids = np.array([(m["plant"] or "no plant overlap") == p for m in rows])
        res["by_plant"][p] = {"crops": int(ids.sum()), "touch": int(y[ids].sum()),
                              "share_correct": float(((s[ids] >= T.APP_THRESHOLD) == y[ids]).mean())}
    sweep = [{"threshold": float(t), **T.at_threshold(y, s, t)} for t in np.round(np.arange(0.05, 0.96, 0.05), 2)]
    res["threshold_sweep"] = sweep

    def grid(pick, title, path):
        tiles = []
        for i in pick:
            t = cv2.resize(images[i], (150, 150))
            ok = (s[i] >= T.APP_THRESHOLD) == y[i]
            cv2.rectangle(t, (0, 0), (149, 149), (60, 170, 60) if ok else (40, 40, 220), 4)
            bar = np.full((22, 150, 3), 255, np.uint8)
            cv2.putText(bar, f"p={s[i]:.2f} {'touch' if y[i] else 'no touch'}", (3, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 1, cv2.LINE_AA)
            tiles.append(np.vstack([t, bar]))
        if not tiles:
            return
        while len(tiles) % 8:
            tiles.append(np.full_like(tiles[0], 255))
        g = np.vstack([np.hstack(tiles[r:r + 8]) for r in range(0, len(tiles), 8)])
        head = np.full((36, g.shape[1], 3), 255, np.uint8)
        cv2.putText(head, title, (6, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1, cv2.LINE_AA)
        cv2.imwrite(str(path), np.vstack([head, g]), [cv2.IMWRITE_JPEG_QUALITY, 80])

    rng = np.random.default_rng(0)
    t_ids, n_ids = np.where(y)[0], np.where(~y)[0]
    grid(rng.choice(t_ids, min(24, len(t_ids)), replace=False), "Open Images: hands on a plant (labelled by eye), random sample", out / "oi_touch_sample.jpg")
    grid(rng.choice(n_ids, min(16, len(n_ids)), replace=False), "Open Images: hands near a plant, not touching, random sample", out / "oi_no_touch_sample.jpg")
    (out / "oi_plants.json").write_text(json.dumps(res, indent=2, default=float))
    m = res["metrics"]
    print(f"{len(rows)} crops ({int(y.sum())} touch): accuracy {m['accuracy']:.3f} precision {m['precision']:.3f} "
          f"recall {m['recall']:.3f}  auc {m['roc_auc']}  recall@0.3 {res['metrics_at_0.3']['recall']:.3f}")
    print(json.dumps(res["by_plant"], indent=1))


if __name__ == "__main__":
    mode, out = sys.argv[1], Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    make(out) if mode == "make" else score(out)
