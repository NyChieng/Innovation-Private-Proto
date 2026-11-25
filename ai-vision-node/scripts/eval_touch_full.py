"""Full evaluation of the touch classifier on its held-out test split (data/touch, split=test).

Goes further than `evaluate.py touch`, for the test report:

  accuracy    accuracy, precision, recall, F1, specificity, ROC-AUC, PR-AUC at the app's 0.6
              threshold, each with a bootstrap 95% confidence interval, plus per source
  threshold   every metric from 0.05 to 0.95, and the best-F1 threshold
  backends    the same 3,034 crops through every backend the app can use (cuda .pt,
              OpenVINO .onnx, ONNX Runtime .onnx): do they agree?
  robustness  accuracy when the crops are darker, brighter, blurred, noisy, low-resolution,
              JPEG-compressed or mirrored, i.e. what a forest camera does to a picture
  gallery     the most confident mistakes and successes, as labelled image grids
  plots       ROC, precision-recall, threshold sweep, calibration and score histograms

    python scripts/eval_touch_full.py --out reports/touch_full
"""
import argparse
import csv
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
from engine import EXPORT, Net, available_backends, to_tensor  # noqa: E402

TOUCH = ROOT / "data" / "touch"
APP_THRESHOLD = 0.6  # DEFAULTS["touch_conf"] in app/pipeline.py


def load_test():
    with open(TOUCH / "manifest.csv", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if r["split"] == "test"]
    for r in rows:
        r["path"] = TOUCH / "test" / r["label"] / f"{r['stem']}.jpg"
    return rows


def run_net(net, idx, images, batch=64):
    out = []
    if net.backend == "cuda":
        batch = 1  # the CUDA graph is captured for one input shape; keep it fixed
    for i in range(0, len(images), batch):
        x = np.concatenate([to_tensor(im) for im in images[i:i + batch]])
        out.extend(float(p[idx]) for p in net(x))
    return np.array(out)


# --------------------------------------------------------------------------- metrics

def roc_auc(y, s):
    order = np.argsort(-s)
    y = y[order]
    tps, fps = np.cumsum(y), np.cumsum(~y)
    tpr = np.r_[0, tps / max(1, y.sum())]
    fpr = np.r_[0, fps / max(1, (~y).sum())]
    return float(np.trapezoid(tpr, fpr)), fpr, tpr


def pr_auc(y, s):
    order = np.argsort(-s)
    y = y[order]
    tps = np.cumsum(y)
    prec = tps / np.arange(1, len(y) + 1)
    rec = tps / max(1, y.sum())
    # average precision: precision at each true positive, averaged
    return float((prec * y).sum() / max(1, y.sum())), rec, prec


def at_threshold(y, s, thr):
    yhat = s >= thr
    tp, fp = int((y & yhat).sum()), int((~y & yhat).sum())
    fn, tn = int((y & ~yhat).sum()), int((~y & ~yhat).sum())
    p = tp / max(1, tp + fp)
    r = tp / max(1, tp + fn)
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "accuracy": (tp + tn) / max(1, len(y)), "precision": p, "recall": r,
            "f1": 2 * p * r / max(1e-9, p + r), "specificity": tn / max(1, tn + fp),
            "balanced_accuracy": (r + tn / max(1, tn + fp)) / 2, "false_touch_rate": fp / max(1, fp + tn)}


def score(y, s, thr=APP_THRESHOLD):
    m = at_threshold(y, s, thr)
    m["roc_auc"] = roc_auc(y, s)[0] if 0 < y.sum() < len(y) else None
    m["pr_auc"] = pr_auc(y, s)[0] if y.sum() else None
    m["crops"], m["touch"] = int(len(y)), int(y.sum())
    return m


def bootstrap(y, s, thr, n=1000, seed=0):
    rng = np.random.default_rng(seed)
    keys = ["accuracy", "precision", "recall", "f1", "specificity", "roc_auc", "pr_auc"]
    vals = {k: [] for k in keys}
    for _ in range(n):
        i = rng.integers(0, len(y), len(y))
        m = score(y[i], s[i], thr)
        for k in keys:
            if m[k] is not None:
                vals[k].append(m[k])
    return {k: {"mean": float(np.mean(v)), "std": float(np.std(v)),
                "ci95": [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))]} for k, v in vals.items()}


# --------------------------------------------------------------------------- perturbations

def perturbations(seed=0):
    rng = np.random.default_rng(seed)
    lut = lambda g: np.clip(((np.arange(256) / 255.0) ** g) * 255, 0, 255).astype(np.uint8)  # noqa: E731
    dark, bright = lut(1.8), lut(0.55)

    def jpeg(im, q):
        return cv2.imdecode(cv2.imencode(".jpg", im, [cv2.IMWRITE_JPEG_QUALITY, q])[1], cv2.IMREAD_COLOR)

    return {
        "original": lambda im: im,
        "dark (dusk, gamma 1.8)": lambda im: cv2.LUT(im, dark),
        "bright (sun, gamma 0.55)": lambda im: cv2.LUT(im, bright),
        "motion/focus blur (7 px)": lambda im: cv2.GaussianBlur(im, (7, 7), 0),
        "sensor noise (sigma 15)": lambda im: np.clip(im + rng.normal(0, 15, im.shape), 0, 255).astype(np.uint8),
        "low resolution (56 px, upscaled)": lambda im: cv2.resize(cv2.resize(im, (56, 56), interpolation=cv2.INTER_AREA), im.shape[1::-1]),
        "JPEG quality 20": lambda im: jpeg(im, 20),
        "mirrored": lambda im: cv2.flip(im, 1),
        "greyscale (night IR)": lambda im: cv2.cvtColor(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR),
    }


# --------------------------------------------------------------------------- pictures

def gallery(rows, s, picks, title, path, cols=8):
    tiles = []
    for i in picks:
        im = cv2.resize(cv2.imread(str(rows[i]["path"])), (160, 160))
        bar = np.full((44, 160, 3), 255, np.uint8)
        cv2.putText(bar, f"p(touch)={s[i]:.2f}  {rows[i]['label']}", (4, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 1, cv2.LINE_AA)
        cv2.putText(bar, f"{rows[i]['source']} {rows[i]['note'][:18]}", (4, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (90, 90, 90), 1, cv2.LINE_AA)
        tiles.append(np.vstack([im, bar]))
    while len(tiles) % cols:
        tiles.append(np.full_like(tiles[0], 255))
    grid = np.vstack([np.hstack(tiles[r:r + cols]) for r in range(0, len(tiles), cols)])
    head = np.full((40, grid.shape[1], 3), 255, np.uint8)
    cv2.putText(head, title, (8, 27), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2, cv2.LINE_AA)
    cv2.imwrite(str(path), np.vstack([head, grid]), [cv2.IMWRITE_JPEG_QUALITY, 88])


def plots(y, s, sweep, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    auc, fpr, tpr = roc_auc(y, s)
    ap, rec, prec = pr_auc(y, s)
    fig, ax = plt.subplots(1, 4, figsize=(20, 4.6))
    ax[0].plot(fpr, tpr, color="#2a7d4f", lw=2)
    ax[0].plot([0, 1], [0, 1], ":", color="#999")
    m = at_threshold(y, s, APP_THRESHOLD)
    ax[0].scatter([1 - m["specificity"]], [m["recall"]], color="#c0392b", zorder=3, label=f"app threshold {APP_THRESHOLD}")
    ax[0].set(title=f"ROC (AUC {auc:.3f})", xlabel="false touch rate", ylabel="touches caught (recall)")
    ax[0].legend(loc="lower right")
    ax[1].plot(rec, prec, color="#2a7d4f", lw=2)
    ax[1].scatter([m["recall"]], [m["precision"]], color="#c0392b", zorder=3)
    ax[1].set(title=f"Precision-recall (AP {ap:.3f})", xlabel="recall", ylabel="precision", ylim=(0, 1.02))
    t = [r["threshold"] for r in sweep]
    for k, c in (("accuracy", "#333"), ("precision", "#2471a3"), ("recall", "#d68910"), ("f1", "#2a7d4f")):
        ax[2].plot(t, [r[k] for r in sweep], label=k, color=c, lw=2)
    ax[2].axvline(APP_THRESHOLD, ls="--", color="#c0392b")
    ax[2].set(title="Metric vs threshold", xlabel="touch threshold", ylim=(0, 1.02))
    ax[2].legend()
    ax[3].hist(s[~y], bins=40, range=(0, 1), alpha=0.65, label="no_touch", color="#2471a3")
    ax[3].hist(s[y], bins=40, range=(0, 1), alpha=0.65, label="touch", color="#d68910")
    ax[3].axvline(APP_THRESHOLD, ls="--", color="#c0392b")
    ax[3].set(title="Score distribution", xlabel="p(touch)", ylabel="crops")
    ax[3].legend()
    fig.tight_layout()
    fig.savefig(out / "touch_curves.png", dpi=110)
    plt.close(fig)

    # calibration: is "70% sure" right 70% of the time?
    bins = np.linspace(0, 1, 11)
    idx = np.clip(np.digitize(s, bins) - 1, 0, 9)
    conf = [float(s[idx == b].mean()) if (idx == b).any() else None for b in range(10)]
    acc = [float(y[idx == b].mean()) if (idx == b).any() else None for b in range(10)]
    fig, ax = plt.subplots(figsize=(5, 4.6))
    ax.plot([0, 1], [0, 1], ":", color="#999")
    ax.plot([c for c in conf if c is not None], [a for a, c in zip(acc, conf) if c is not None], "o-", color="#2a7d4f")
    ax.set(title="Calibration", xlabel="predicted p(touch)", ylabel="actual share that are touches")
    fig.tight_layout()
    fig.savefig(out / "touch_calibration.png", dpi=110)
    plt.close(fig)
    ece = sum(abs(a - c) * (idx == b).mean() for b, (a, c) in enumerate(zip(acc, conf)) if c is not None)
    return float(ece)


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "reports" / "touch_full"))
    ap.add_argument("--robust-backend", default=None, help="backend for the robustness runs (default: fastest available)")
    ap.add_argument("--bootstrap", type=int, default=1000)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    spec = json.loads((EXPORT / "models.json").read_text())["touch"]
    rows = load_test()
    y = np.array([r["label"] == "touch" for r in rows])
    images = [cv2.imread(str(r["path"])) for r in rows]
    print(f"{len(rows)} test crops, {int(y.sum())} touch / {int((~y).sum())} no_touch")
    res = {"test_crops": len(rows), "touch": int(y.sum()), "threshold": APP_THRESHOLD, "backends": {}}

    # ---- every backend on the same crops
    scores = {}
    for b in available_backends():
        net = Net(spec, b, 4)
        idx = spec["names"].index("touch")
        run_net(net, idx, images[:8])  # warm-up
        t0 = time.perf_counter()
        s = run_net(net, idx, images)
        dt = time.perf_counter() - t0
        scores[b] = s
        res["backends"][b] = {"metrics": score(y, s), "ms_per_crop": 1000 * dt / len(images)}
        print(f"{b:12s} acc {res['backends'][b]['metrics']['accuracy']:.4f}  {1000 * dt / len(images):.2f} ms/crop")
    ref = "openvino" if "openvino" in scores else next(iter(scores))
    res["reference_backend"] = ref
    s = scores[ref]
    for b, sb in scores.items():
        res["backends"][b]["vs_reference"] = {
            "max_abs_prob_diff": float(np.abs(sb - s).max()),
            "mean_abs_prob_diff": float(np.abs(sb - s).mean()),
            "same_decision_pct": float(((sb >= APP_THRESHOLD) == (s >= APP_THRESHOLD)).mean() * 100),
        }

    # ---- accuracy with confidence intervals, per source
    res["metrics"] = score(y, s)
    res["bootstrap"] = bootstrap(y, s, APP_THRESHOLD, a.bootstrap)
    res["metrics_at_0.5"] = score(y, s, 0.5)
    res["per_source"] = {}
    for src in sorted({r["source"] for r in rows}):
        m = np.array([r["source"] == src for r in rows])
        res["per_source"][src] = score(y[m], s[m])
    near = np.array([(not yy) and "near" in r["note"] for r, yy in zip(rows, y)])
    if near.any():
        res["per_source"]["hard negatives (hand near a plant, not touching)"] = score(y[near], s[near])

    sweep = []
    for thr in np.round(np.arange(0.05, 0.96, 0.05), 2):
        sweep.append({"threshold": float(thr), **{k: v for k, v in at_threshold(y, s, thr).items()}})
    res["threshold_sweep"] = sweep
    best = max(sweep, key=lambda r: r["f1"])
    res["best_f1_threshold"] = {"threshold": best["threshold"], "f1": best["f1"],
                                "precision": best["precision"], "recall": best["recall"]}
    res["calibration_ece"] = plots(y, s, sweep, out)

    # ---- robustness: same crops, degraded the way a field camera degrades them
    rb = a.robust_backend or ("cuda" if "cuda" in scores else ref)
    net = Net(spec, rb, 4)
    idx = spec["names"].index("touch")
    res["robustness_backend"] = rb
    res["robustness"] = {}
    for name, f in perturbations().items():
        sp = run_net(net, idx, [f(im) for im in images])
        m = score(y, sp)
        m["decisions_changed_pct"] = float(((sp >= APP_THRESHOLD) != (scores[rb] >= APP_THRESHOLD)).mean() * 100)
        res["robustness"][name] = m
        print(f"  {name:34s} acc {m['accuracy']:.4f}  f1 {m['f1']:.4f}  auc {m['roc_auc']:.4f}")
    accs = [m["accuracy"] for m in res["robustness"].values()]
    res["robustness_summary"] = {"accuracy_mean": float(np.mean(accs)), "accuracy_std": float(np.std(accs)),
                                 "worst": min(res["robustness"], key=lambda k: res["robustness"][k]["accuracy"])}

    # ---- qualitative galleries
    fp = [i for i in np.argsort(-s) if not y[i] and s[i] >= APP_THRESHOLD][:24]
    fn = [i for i in np.argsort(s) if y[i] and s[i] < APP_THRESHOLD][:24]
    tp = [i for i in np.argsort(-s) if y[i]][:16]
    tn = [i for i in np.argsort(s) if not y[i]][:16]
    hard = [i for i in np.argsort(-s) if near[i]][:16]
    gallery(rows, s, fp, "False touches: no_touch crops the model was most sure were touches", out / "gallery_false_touch.jpg")
    gallery(rows, s, fn, "Missed touches: touch crops the model scored lowest", out / "gallery_missed_touch.jpg")
    gallery(rows, s, tp + tn, "Most confident correct: 16 touches, then 16 no-touches", out / "gallery_correct.jpg")
    if hard:
        gallery(rows, s, hard, "Hard negatives: hand near a plant without touching (highest scores first)", out / "gallery_hard_negatives.jpg")
    res["gallery_counts"] = {"false_touch_total": int(((s >= APP_THRESHOLD) & ~y).sum()), "missed_total": int(((s < APP_THRESHOLD) & y).sum())}
    res["mistakes_by_source"] = {}
    for src in sorted({r["source"] for r in rows}):
        m = np.array([r["source"] == src for r in rows])
        res["mistakes_by_source"][src] = {"false_touch": int(((s >= APP_THRESHOLD) & ~y & m).sum()),
                                          "missed": int(((s < APP_THRESHOLD) & y & m).sum())}

    with open(out / "per_crop_scores.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["stem", "source", "label", "note", *[f"p_{b}" for b in scores]])
        for i, r in enumerate(rows):
            w.writerow([r["stem"], r["source"], r["label"], r["note"], *[f"{scores[b][i]:.5f}" for b in scores]])
    (out / "touch_full.json").write_text(json.dumps(res, indent=2))
    print(json.dumps({k: res[k] for k in ("metrics", "best_f1_threshold", "robustness_summary", "calibration_ece")}, indent=2))


if __name__ == "__main__":
    main()
