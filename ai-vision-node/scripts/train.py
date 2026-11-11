"""Two-stage transfer learning (frozen backbone -> full fine-tune) for the FloraGuard models.

    python scripts/train.py det       # YOLO26s detector: person / animal / plant (data/floraguard_det)
    python scripts/train.py touch     # YOLO26s-cls touch / no_touch on hand crops (data/touch)
    python scripts/train.py hand      # YOLO26n-pose on Ultralytics Hand Keypoints (optional)
    python scripts/train.py det --full   # comparison run: all layers from the start

Stage A trains only the new head on top of the frozen COCO/ImageNet backbone; stage B unfreezes
everything at a low learning rate. Stage B must set optimizer=SGD: under optimizer=auto
Ultralytics ignores lr0. It also keeps the warm-up gentle: the default warm-up starts the bias
learning rate at 0.1, and with lr0=0.005 the first det_B run lost 0.16 mAP50 in 5 epochs
(training loss rose, i.e. the unfrozen backbone forgot its COCO features).
Runs land in runs/<task>/<name>; an interrupted run resumes with --resume.

    python scripts/train.py det --stage b   # stage B only, from runs/detect/det_A/weights/best.pt
"""
import argparse
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs"

# freeze: layers 0..10 are the backbone of YOLO26 detect/pose; the -cls model's head is layer 10
JOBS = {
    "det": dict(model=str(ROOT / "models/yolo26s.pt"), data=str(ROOT / "data/floraguard_det/data.yaml"), task="detect",
                a_epochs=10, b_epochs=50, full_epochs=60, lr0=0.001, imgsz=640, freeze=11, cache="disk"),
    "touch": dict(model=str(ROOT / "models/yolo26s-cls.pt"), data=str(ROOT / "data/touch"), task="classify",
                  a_epochs=10, b_epochs=40, full_epochs=50, lr0=0.0005, imgsz=224, freeze=10, cache=False),
    "hand": dict(model=str(ROOT / "models/yolo26n-pose.pt"), data="hand-keypoints.yaml", task="pose",
                 a_epochs=15, b_epochs=60, full_epochs=75, lr0=0.002, imgsz=640, freeze=11, cache=False),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("job", choices=JOBS)
    ap.add_argument("--full", action="store_true", help="single run, all layers trainable from the start")
    ap.add_argument("--batch", type=float, default=0.7, help="0.7 = auto-size to ~70%% of VRAM; use 8 on OOM")
    # each Windows worker is a full python + torch (~1.3 GB commit) and validation starts 2x workers more,
    # so 6 workers = 18 processes ran the 31 GB laptop out of commit memory
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--imgsz", type=int)
    ap.add_argument("--freeze", type=int)
    ap.add_argument("--resume", metavar="NAME", help="resume runs/<task>/NAME/weights/last.pt")
    ap.add_argument("--stage", choices=["all", "a", "b"], default="all")
    ap.add_argument("--a-epochs", type=int)
    ap.add_argument("--b-epochs", type=int)
    a = ap.parse_args()
    j = JOBS[a.job]
    project = str(RUNS / j["task"])
    batch = a.batch if a.batch < 1 else int(a.batch)
    if j["task"] == "classify" and batch < 1:
        batch = 64  # tiny 224 px crops; AutoBatch would pick far more than the dataset needs
    common = dict(data=j["data"], imgsz=a.imgsz or j["imgsz"], batch=batch, workers=a.workers, project=project,
                  device=0, plots=True, exist_ok=True, cache=j["cache"])

    if a.resume:
        YOLO(f"{project}/{a.resume}/weights/last.pt").train(resume=True)
        if a.resume != f"{a.job}_A":
            return  # a resumed stage A carries on into stage B below
    elif a.full:
        YOLO(j["model"]).train(epochs=j["full_epochs"], name=f"{a.job}_full", **common)
        return
    elif a.stage != "b":
        YOLO(j["model"]).train(epochs=a.a_epochs or j["a_epochs"], freeze=a.freeze or j["freeze"],
                               name=f"{a.job}_A", **common)
    if a.stage == "a":
        return
    best_a = f"{project}/{a.job}_A/weights/best.pt"
    YOLO(best_a).train(epochs=a.b_epochs or j["b_epochs"], optimizer="SGD", lr0=j["lr0"], cos_lr=True,
                       warmup_epochs=1, warmup_bias_lr=j["lr0"], patience=15, name=f"{a.job}_B", **common)


if __name__ == "__main__":
    main()
