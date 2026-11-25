"""Pose model variants on the test clips: does the nano pose model find wrists as well as the small one?

The app finds wrists with YOLO26s-pose (models.json). A nano model is ~3x smaller and the README
offers it for weak CPUs (export_models.py --pose n). This samples frames from every clip and runs
both stock models on the same frames (GPU, 640 px), reporting how often each finds a person and a
wrist, how confident the wrists are, how far apart the two models put the same wrist, and speed.

    python scripts/eval_pose_variants.py OUT_DIR VIDEO_OR_FOLDER [...]   (env STRIDE=5)
"""
import glob
import json
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]
WRISTS = (9, 10)  # COCO keypoints: left wrist, right wrist
KP_CONF = 0.5
VARIANTS = {"yolo26n-pose": ROOT / "models/yolo26n-pose.pt", "yolo26s-pose (deployed)": ROOT / "models/yolo26s-pose.pt"}


def frames(video, stride):
    cap = cv2.VideoCapture(str(video))
    i = 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        if i % stride == 0:
            yield i, f
        i += 1
    cap.release()


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    videos = []
    for p in map(Path, sys.argv[2:]):
        videos += sorted(glob.glob(str(p / "*.mp4"))) if p.is_dir() else [str(p)]
    stride = int(os.environ.get("STRIDE", 5))
    models = {k: YOLO(str(v)) for k, v in VARIANTS.items()}
    blank = np.zeros((640, 640, 3), np.uint8)
    for m in models.values():
        for _ in range(3):
            m.predict(blank, imgsz=640, device=0, verbose=False)

    res = {"stride": stride, "kp_conf": KP_CONF, "clips": {}, "overall": {}}
    tot = {k: {"frames": 0, "person": 0, "wrist": 0, "wrist_conf": [], "ms": []} for k in models}
    agree = []
    sheet = []
    for v in videos:
        name = Path(v).stem
        clip = {k: {"frames": 0, "person": 0, "wrist": 0} for k in models}
        for i, f in frames(v, stride):
            wr = {}
            for k, m in models.items():
                t0 = time.perf_counter()
                r = m.predict(f, imgsz=640, conf=0.25, device=0, verbose=False)[0]
                tot[k]["ms"].append(1000 * (time.perf_counter() - t0))
                kp = r.keypoints
                has_p = kp is not None and len(r.boxes) > 0
                pts = []
                if has_p:
                    xy, cf = kp.xy.cpu().numpy(), kp.conf.cpu().numpy() if kp.conf is not None else None
                    for p in range(len(xy)):
                        for w in WRISTS:
                            if cf is not None and cf[p, w] >= KP_CONF:
                                pts.append(xy[p, w])
                                tot[k]["wrist_conf"].append(float(cf[p, w]))
                wr[k] = pts
                for d in (clip[k], tot[k]):
                    d["frames"] += 1
                    d["person"] += int(has_p)
                    d["wrist"] += int(bool(pts))
            a, b = list(models)
            if wr[a] and wr[b]:
                diag = float(np.hypot(*f.shape[:2]))
                for p in wr[a]:
                    agree.append(min(float(np.hypot(*(p - q))) for q in wr[b]) / diag)
            if i % (stride * 12) == 0 and len(sheet) < 16:
                tiles = []
                for k, m in models.items():
                    im = m.predict(f, imgsz=640, conf=0.25, device=0, verbose=False)[0].plot()
                    im = cv2.resize(im, (480, int(480 * im.shape[0] / im.shape[1])))
                    cv2.putText(im, f"{name} #{i}: {k}", (6, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
                    tiles.append(im)
                sheet.append(np.hstack(tiles))
        res["clips"][name] = {k: {"frames": c["frames"], "person_rate": c["person"] / max(1, c["frames"]),
                                  "wrist_rate": c["wrist"] / max(1, c["frames"])} for k, c in clip.items()}
        print(name, {k: (round(x["person_rate"], 2), round(x["wrist_rate"], 2)) for k, x in res["clips"][name].items()})
    for k, t in tot.items():
        res["overall"][k] = {"frames": t["frames"], "person_rate": t["person"] / max(1, t["frames"]),
                             "wrist_rate": t["wrist"] / max(1, t["frames"]),
                             "mean_wrist_conf": float(np.mean(t["wrist_conf"])) if t["wrist_conf"] else None,
                             "median_ms_gpu": float(np.median(t["ms"])),
                             "params_mb": round(VARIANTS[k].stat().st_size / 1e6, 1)}
    if agree:
        ag = np.array(agree)
        res["wrist_agreement"] = {"pairs": len(ag), "median_dist_pct_of_diag": float(np.median(ag) * 100),
                                  "within_2pct": float((ag < 0.02).mean()), "within_5pct": float((ag < 0.05).mean())}
    if sheet:
        w = max(s.shape[1] for s in sheet)
        cv2.imwrite(str(out / "pose_n_vs_s.jpg"),
                    np.vstack([cv2.copyMakeBorder(s, 0, 0, 0, w - s.shape[1], cv2.BORDER_CONSTANT) for s in sheet]),
                    [cv2.IMWRITE_JPEG_QUALITY, 80])
    (out / "pose_variants.json").write_text(json.dumps(res, indent=2))
    print(json.dumps({"overall": res["overall"], "agreement": res.get("wrist_agreement")}, indent=2))


if __name__ == "__main__":
    main()
