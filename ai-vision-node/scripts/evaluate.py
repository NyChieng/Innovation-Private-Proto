"""Evaluate trained models and benchmark the full cascade on this GPU.

    python scripts/evaluate.py det [--weights runs/detect/det_B/weights/best.pt]
        test-split mAP per class (person / animal / plant), overall and per source
        (SWG jungle camera traps vs COCO / Open Images photos), plus false detections on the
        empty jungle frames.
    python scripts/evaluate.py touch [--weights runs/classify/touch_B/weights/best.pt]
        test-split accuracy, touch precision / recall at the app's threshold, per source.
    python scripts/evaluate.py speed
        per-model latency and full-pipeline FPS in the Confirm profile (worst case).
"""
import argparse
import csv
import json
import sys
import time
from pathlib import Path

import numpy as np
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]
DET = ROOT / "data" / "floraguard_det"
TOUCH = ROOT / "data" / "touch"
OUT = ROOT / "reports"
NAMES = ["person", "animal", "plant"]


def box_metrics(r):
    out = {"all": {"mAP50": r.box.map50, "mAP50-95": r.box.map, "precision": r.box.mp, "recall": r.box.mr}}
    for i, c in enumerate(r.box.ap_class_index):
        out[NAMES[c]] = {"mAP50": r.box.ap50[i], "mAP50-95": r.box.ap[i], "precision": r.box.p[i], "recall": r.box.r[i]}
    return out


def det(weights):
    m = YOLO(weights)
    res = {}
    r = m.val(data=str(DET / "data.yaml"), split="test", imgsz=640, batch=16, device=0, plots=True,
              project=str(ROOT / "runs/detect"), name="det_test", exist_ok=True, verbose=False)
    res["test"] = box_metrics(r)

    with open(DET / "manifest.csv", encoding="utf-8") as f:
        rows = [x for x in csv.DictReader(f) if x["split"] == "test"]
    lists = OUT / "lists"
    lists.mkdir(parents=True, exist_ok=True)
    names = "".join(f"  {i}: {n}\n" for i, n in enumerate(NAMES))
    for src in sorted({x["source"] for x in rows}):
        files = [str(DET / "images/test" / f"{x['stem']}.jpg") for x in rows if x["source"] == src and x["n_boxes"] != "0"]
        (lists / f"test_{src}.txt").write_text("\n".join(files))
        y = lists / f"test_{src}.yaml"
        y.write_text(f"path: {DET.as_posix()}\ntrain: {(lists / f'test_{src}.txt').as_posix()}\n"
                     f"val: {(lists / f'test_{src}.txt').as_posix()}\nnames:\n{names}")
        r = m.val(data=str(y), imgsz=640, batch=16, device=0, plots=False, verbose=False,
                  project=str(ROOT / "runs/detect"), name=f"det_test_{src}", exist_ok=True)
        res[src] = dict(images=len(files), **box_metrics(r))

    # empty jungle frames: anything detected there is a false alarm
    empty = [str(DET / "images/test" / f"{x['stem']}.jpg") for x in rows if x["n_boxes"] == "0"]
    hits = np.zeros(3, int)
    for i in range(0, len(empty), 32):
        for p in m.predict(empty[i:i + 32], conf=0.35, imgsz=640, device=0, verbose=False):
            for c in set(p.boxes.cls.int().tolist()):
                hits[c] += 1
    res["empty_frames"] = {"images": len(empty), **{f"with_false_{n}": int(hits[i]) for i, n in enumerate(NAMES)}}
    return res


def touch(weights, thr=0.6):
    m = YOLO(weights)
    ti = next(i for i, n in m.names.items() if n == "touch")
    with open(TOUCH / "manifest.csv", encoding="utf-8") as f:
        rows = [x for x in csv.DictReader(f) if x["split"] == "test"]
    preds = []
    for i in range(0, len(rows), 64):
        chunk = rows[i:i + 64]
        files = [str(TOUCH / "test" / x["label"] / f"{x['stem']}.jpg") for x in chunk]
        for x, r in zip(chunk, m.predict(files, imgsz=224, device=0, verbose=False)):
            preds.append((x["source"], x["label"] == "touch", float(r.probs.data[ti]), x["note"]))

    def score(ps):
        y = np.array([p[1] for p in ps])
        s = np.array([p[2] for p in ps])
        yhat = s >= thr
        tp, fp, fn = int((y & yhat).sum()), int((~y & yhat).sum()), int((y & ~yhat).sum())
        return {"crops": len(ps), "touch": int(y.sum()), "accuracy": float((y == yhat).mean()),
                "touch_precision": tp / max(1, tp + fp), "touch_recall": tp / max(1, tp + fn),
                "false_touch_rate": fp / max(1, int((~y).sum()))}

    res = {"threshold": thr, "all": score(preds)}
    for src in sorted({p[0] for p in preds}):
        res[src] = score([p for p in preds if p[0] == src])
    near = [p for p in preds if not p[1] and "near" in p[3]]
    if near:
        res["hard_negatives_near_plant"] = score(near)
    return res


def speed():
    """Worst case per backend: a person inside the plant zone on every frame, so detector, pose and
    touch model all run each frame. CPU backends at 4 and 2 threads, standing in for a small device."""
    sys.path.insert(0, str(ROOT / "app"))
    import cv2
    from engine import available_backends
    from pipeline import FloraGuard, load_config, model_info
    res = {"models": model_info()}
    rows = json.loads((ROOT / "data/raw/hico/pairs.json").read_text())
    stem = next(r["stem"] for r in rows if any(p["verb"] == "hold" for p in r["pairs"]))  # a hand on a plant
    img = cv2.resize(cv2.imread(str(ROOT / "data/raw/hico/images" / f"{stem}.jpg")), (1280, 720))
    for backend in available_backends():
        for threads in ((4,) if backend == "cuda" else (4, 2)):
            cfg = load_config()
            cfg.update(backend=backend, threads=threads, zone=[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]])
            g = FloraGuard(cfg, snapshot_dir=ROOT / "logs" / "speed_events")
            for i in range(10):
                g.step(img if i % 2 else cv2.flip(img, 1))
            rows, cpu0, t0 = [], time.process_time(), time.perf_counter()
            for i in range(60):
                g.profile = "Confirm"
                _, info, _ = g.step(img if i % 2 else cv2.flip(img, 1))
                rows.append([info["det_ms"], info["pose_ms"], info["touch_ms"], info["total_ms"]])
            wall = time.perf_counter() - t0
            det, pose, touch, total = np.median(rows, 0)
            res[f"{backend}_{threads}t"] = {"det_ms": det, "pose_ms": pose, "touch_ms": touch, "frame_ms": total,
                                            "max_fps": 60 / wall, "cpu_cores_busy": (time.process_time() - cpu0) / wall,
                                            "hands_per_frame": info["hands"]}
            print(f"{backend:12s} {threads}t  detect {det:5.1f}  pose {pose:5.1f}  touch {touch:5.1f}  "
                  f"frame {total:5.1f} ms  -> {60 / wall:5.1f} FPS, {(time.process_time() - cpu0) / wall:.1f} cores busy")
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["det", "touch", "speed"])
    ap.add_argument("--weights")
    a = ap.parse_args()
    if a.what == "det":
        res = det(a.weights or str(ROOT / "runs/detect/det_B/weights/best.pt"))
    elif a.what == "touch":
        res = touch(a.weights or str(ROOT / "runs/classify/touch_B/weights/best.pt"))
    else:
        res = speed()
    OUT.mkdir(exist_ok=True)
    name = a.what if not a.weights else f"{a.what}_{Path(a.weights).parents[1].name}"
    (OUT / f"{name}.json").write_text(json.dumps(res, indent=2, default=float))
    print(json.dumps(res, indent=2, default=float))


if __name__ == "__main__":
    main()
