"""Export the FloraGuard models to ONNX for the CPU backends (OpenVINO / ONNX Runtime) in app/engine.py.

    python scripts/export_models.py                  # detector 640x384, pose s 320, touch 224
    python scripts/export_models.py --det-size 480   # weak CPU: detector 480x288 (test mAP50 0.788 -> 0.759)
    python scripts/export_models.py --pose n         # weak CPU: nano pose (wrist points less precise)

-> models/export/{det,pose,touch}.onnx + models.json (input sizes, class names, source weights)
Copy app/ and models/export/ to the target machine; it needs only openvino, numpy, opencv (+ gradio for the UI).

Detector input is 16:9 (640x384) like the camera, which saves 40% over a square 640x640. Pose runs
on a crop around the people near the plant, so 320x320 is enough.
"""
import argparse
import json
import shutil
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "models" / "export"
SOURCES = {
    "det": ["runs/detect/det_B/weights/best.pt", "runs/detect/det_A/weights/best.pt"],
    "touch": ["runs/classify/touch_B/weights/best.pt", "runs/classify/touch_A/weights/best.pt"],
}


def first(paths):
    return next((p for p in paths if (ROOT / p).exists()), None)


def export(weights, name, imgsz, dynamic=False):
    out = YOLO(str(ROOT / weights)).export(format="onnx", imgsz=imgsz, simplify=True, dynamic=dynamic, verbose=False)
    shutil.move(out, OUT / f"{name}.onnx")
    return {"onnx": f"{name}.onnx", "weights": weights, "names": list(YOLO(str(ROOT / weights)).names.values()),
            "imgsz": [imgsz[1], imgsz[0]] if isinstance(imgsz, list) else [imgsz, imgsz]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--det-size", type=int, choices=[640, 480, 320], default=640, help="detector input width (16:9)")
    ap.add_argument("--pose", choices=["s", "n"], default="s")
    ap.add_argument("--pose-size", type=int, default=320)
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    det = first(SOURCES["det"])
    if det is None:
        raise SystemExit("no trained detector: run scripts/train.py det first")
    h = -(-(a.det_size * 9 // 16) // 32) * 32  # 16:9 height rounded up to a multiple of 32
    spec = {"det": export(det, "det", [h, a.det_size]),
            "pose": export(f"models/yolo26{a.pose}-pose.pt", "pose", [a.pose_size, a.pose_size])}
    touch = first(SOURCES["touch"])
    if touch:
        spec["touch"] = export(touch, "touch", 224, dynamic=True)  # dynamic batch: one crop per hand
    (OUT / "models.json").write_text(json.dumps(spec, indent=2))
    for k, v in spec.items():
        print(f"{k:6s} {v['onnx']:11s} {v['imgsz'][0]}x{v['imgsz'][1]}  from {v['weights']}")


if __name__ == "__main__":
    main()
