"""Large qualitative study of the touch classifier: more crops, more kinds of example, more damage.

Crops: the held-out test split AND the validation split (data/touch, 6,200+ crops; neither was
trained on), scored on the deployed ONNX model (OpenVINO), with ONNX Runtime and a mirror
test-time-augmentation variant for comparison.

  kinds       every crop is tagged by what is in it (100DOH contact state, plant scenes from
              HICO / Visual Genome / COCO, hands near a plant without touching) and by picture
              properties (lighting, sharpness, how much green, hand at the frame edge); accuracy,
              F1 and a bootstrap 95% CI per kind, plus a random sample gallery per kind
  damage      17 kinds of camera damage, 15 of them at 3 strengths (ImageNet-C style): noise, blur,
              motion blur, dusk, overexposure, low contrast, fog, rain, JPEG, pixelation,
              canopy-green tint, leaf occlusion, rotation, zoomed-out crop, off-centre crop,
              plus mirrored and greyscale IR. Shown on example crops as picture strips.

    python scripts/eval_touch_big.py --out reports/touch_big
"""
import argparse
import csv
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import eval_touch_full as T  # noqa: E402  (Net, run_net, score, bootstrap, at_threshold)

THR = T.APP_THRESHOLD
STATE = {"state0": "100DOH: hand touching nothing", "state1": "100DOH: hand on own body",
         "state2": "100DOH: hand on another person", "state3": "100DOH: hand holding an object",
         "state4": "100DOH: hand on a fixed object (wall, tree, table)"}


def load(splits):
    with open(T.TOUCH / "manifest.csv", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if r["split"] in splits]
    for r in rows:
        r["path"] = T.TOUCH / r["split"] / r["label"] / f"{r['stem']}.jpg"
    return rows


def kind_of(r):
    if r["source"] == "100doh":
        return STATE.get(r["note"], "100DOH: other")
    if r["label"] == "touch":
        return "plant scene: hand on the plant"
    if "near" in r["note"] or r["note"] in ("close", "close to"):
        return "plant scene: hand near the plant, not touching"
    return "plant scene: no touch"


def attrs(im):
    g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    m = float(g.mean())
    sharp = float(cv2.Laplacian(g, cv2.CV_64F).var())
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    green = float(((hsv[..., 0] >= 35) & (hsv[..., 0] <= 85) & (hsv[..., 1] >= 50) & (hsv[..., 2] >= 40)).mean())
    pad = float((np.abs(im.astype(np.int16) - 114).max(axis=2) <= 1).mean())
    return {"lighting": "dark" if m < 80 else "bright" if m > 170 else "normal",
            "sharpness": "blurry" if sharp < 60 else "sharp",
            "green": "lots of green (>25%)" if green > 0.25 else "some green (5-25%)" if green > 0.05 else "little green (<5%)",
            "frame edge": "hand at the frame edge" if pad > 0.04 else "hand inside the frame"}


# --------------------------------------------------------------------------- damage

def damages(seed=0):
    rng = np.random.default_rng(seed)
    lut = lambda g: np.clip(((np.arange(256) / 255.0) ** g) * 255, 0, 255).astype(np.uint8)  # noqa: E731

    def noise(s):
        return lambda im: np.clip(im + rng.normal(0, s, im.shape), 0, 255).astype(np.uint8)

    def motion(k):
        ker = np.zeros((k, k), np.float32)
        ker[k // 2, :] = 1 / k
        return lambda im: cv2.filter2D(im, -1, ker)

    def dusk(g, s):
        L = lut(g)
        return lambda im: np.clip(cv2.LUT(im, L) + rng.normal(0, s, im.shape), 0, 255).astype(np.uint8)

    def contrast(c):
        return lambda im: np.clip((im.astype(np.float32) - im.mean()) * c + im.mean(), 0, 255).astype(np.uint8)

    def fog(a):
        return lambda im: cv2.addWeighted(im, 1 - a, np.full_like(im, 225), a, 0)

    def rain(n):
        def f(im):
            o = im.copy()
            for _ in range(n):
                x, y = int(rng.integers(0, 224)), int(rng.integers(-20, 224))
                cv2.line(o, (x, y), (x - 4, y + 18), (210, 210, 210), 1, cv2.LINE_AA)
            return cv2.blur(o, (2, 2))
        return f

    def jpeg(q):
        return lambda im: cv2.imdecode(cv2.imencode(".jpg", im, [cv2.IMWRITE_JPEG_QUALITY, q])[1], cv2.IMREAD_COLOR)

    def pixelate(p):
        return lambda im: cv2.resize(cv2.resize(im, (p, p), interpolation=cv2.INTER_AREA), (224, 224), interpolation=cv2.INTER_NEAREST)

    def tint(a):
        return lambda im: np.clip(im * np.array([1 - a, 1, 1 - a * 0.8]), 0, 255).astype(np.uint8)

    def leaves(cover):
        def f(im):
            o = im.copy()
            area = 0
            while area < cover * 224 * 224:
                cx, cy = int(rng.integers(0, 224)), int(rng.integers(0, 224))
                ax, ay = int(rng.integers(12, 34)), int(rng.integers(6, 16))
                cv2.ellipse(o, (cx, cy), (ax, ay), float(rng.uniform(0, 180)), 0, 360,
                            (int(rng.integers(20, 60)), int(rng.integers(90, 160)), int(rng.integers(30, 70))), -1, cv2.LINE_AA)
                area += np.pi * ax * ay * 0.8
            return o
        return f

    def rotate(d):
        M = cv2.getRotationMatrix2D((112, 112), d, 1.0)
        return lambda im: cv2.warpAffine(im, M, (224, 224), borderValue=(114, 114, 114))

    def zoom_out(s):
        def f(im):
            k = int(224 * s)
            o = np.full_like(im, 114)
            o[(224 - k) // 2:(224 - k) // 2 + k, (224 - k) // 2:(224 - k) // 2 + k] = cv2.resize(im, (k, k), interpolation=cv2.INTER_AREA)
            return o
        return f

    def shift(p):
        M = np.float32([[1, 0, 224 * p], [0, 1, 224 * p * 0.6]])
        return lambda im: cv2.warpAffine(im, M, (224, 224), borderValue=(114, 114, 114))

    levels = {
        "sensor noise": [noise(8), noise(15), noise(30)],
        "focus blur": [lambda im: cv2.GaussianBlur(im, (3, 3), 0), lambda im: cv2.GaussianBlur(im, (7, 7), 0), lambda im: cv2.GaussianBlur(im, (13, 13), 0)],
        "motion blur": [motion(5), motion(9), motion(15)],
        "dusk (dark + noise)": [dusk(1.5, 4), dusk(2.0, 8), dusk(2.8, 12)],
        "overexposed (sun)": [lambda im, L=lut(0.7): cv2.LUT(im, L), lambda im, L=lut(0.5): cv2.LUT(im, L), lambda im, L=lut(0.35): cv2.LUT(im, L)],
        "low contrast (haze)": [contrast(0.7), contrast(0.5), contrast(0.3)],
        "fog": [fog(0.2), fog(0.35), fog(0.5)],
        "rain streaks": [rain(40), rain(90), rain(180)],
        "JPEG compression": [jpeg(40), jpeg(20), jpeg(10)],
        "pixelated (far away)": [pixelate(112), pixelate(72), pixelate(48)],
        "green canopy tint": [tint(0.15), tint(0.3), tint(0.45)],
        "leaf occlusion": [leaves(0.1), leaves(0.2), leaves(0.3)],
        "rotated": [rotate(10), rotate(20), rotate(35)],
        "zoomed-out crop (pose too big)": [zoom_out(0.85), zoom_out(0.7), zoom_out(0.55)],
        "off-centre crop (pose error)": [shift(0.1), shift(0.2), shift(0.3)],
    }
    single = {"mirrored": lambda im: cv2.flip(im, 1),
              "greyscale (night IR)": lambda im: cv2.cvtColor(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)}
    return levels, single


# --------------------------------------------------------------------------- pictures

def tile(im, top, bottom, ok=None, size=150):
    t = cv2.resize(im, (size, size), interpolation=cv2.INTER_AREA)
    if ok is not None:
        cv2.rectangle(t, (0, 0), (size - 1, size - 1), (60, 170, 60) if ok else (40, 40, 220), 4)
    bar = np.full((38, size, 3), 255, np.uint8)
    cv2.putText(bar, top[:24], (3, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1, cv2.LINE_AA)
    cv2.putText(bar, bottom[:26], (3, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.36, (90, 90, 90), 1, cv2.LINE_AA)
    return np.vstack([t, bar])


def grid(tiles, path, title, cols=8):
    if not tiles:
        return False
    while len(tiles) % cols:
        tiles.append(np.full_like(tiles[0], 255))
    g = np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)])
    head = np.full((36, g.shape[1], 3), 255, np.uint8)
    cv2.putText(head, title[:110], (6, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1, cv2.LINE_AA)
    cv2.imwrite(str(path), np.vstack([head, g]), [cv2.IMWRITE_JPEG_QUALITY, 80])
    return True


def slug(s):
    return "".join(c if c.isalnum() else "_" for c in s.lower()).strip("_")[:48]


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "reports" / "touch_big"))
    ap.add_argument("--backend", default="openvino")
    ap.add_argument("--bootstrap", type=int, default=500)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(a.seed)

    spec = json.loads((T.EXPORT / "models.json").read_text())["touch"]
    idx = spec["names"].index("touch")
    rows = load({"test", "val"})
    images = [cv2.imread(str(r["path"])) for r in rows]
    y = np.array([r["label"] == "touch" for r in rows])
    for r, im in zip(rows, images):
        r["kind"] = kind_of(r)
        r.update(attrs(im))
    print(f"{len(rows)} crops ({int(y.sum())} touch), kinds: {Counter(r['kind'] for r in rows)}", flush=True)

    net = T.Net(spec, a.backend, 4)
    T.run_net(net, idx, images[:8])
    t0 = time.perf_counter()
    s = T.run_net(net, idx, images)
    ms = 1000 * (time.perf_counter() - t0) / len(images)
    res = {"crops": len(rows), "touch": int(y.sum()), "threshold": THR, "backend": a.backend, "ms_per_crop": ms,
           "splits": {}, "variants": {}, "kinds": {}, "properties": {}, "damage": {}, "galleries": []}
    for sp in ("test", "val"):
        m = np.array([r["split"] == sp for r in rows])
        res["splits"][sp] = {"metrics": T.score(y[m], s[m]), "bootstrap": T.bootstrap(y[m], s[m], THR, a.bootstrap)}
    res["splits"]["test + val"] = {"metrics": T.score(y, s), "bootstrap": T.bootstrap(y, s, THR, a.bootstrap)}

    # ---- model variants on the same crops
    s_flip = T.run_net(net, idx, [cv2.flip(im, 1) for im in images])
    var = {f"deployed ONNX ({a.backend})": s, "mirror test-time augmentation (average of image and mirror)": (s + s_flip) / 2}
    if a.backend != "onnxruntime" and "onnxruntime" in T.available_backends():
        var["ONNX Runtime"] = T.run_net(T.Net(spec, "onnxruntime", 4), idx, images)
    for n, sv in var.items():
        res["variants"][n] = {"metrics": T.score(y, sv), "same_decision_as_deployed_pct": float(((sv >= THR) == (s >= THR)).mean() * 100)}
        for thr in (0.45, 0.5):
            res["variants"][n][f"at_{thr}"] = T.score(y, sv, thr)

    # ---- kinds of example and picture properties
    def table(key, target):
        groups = defaultdict(list)
        for i, r in enumerate(rows):
            groups[r[key]].append(i)
        for k, ids in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            ids = np.array(ids)
            m = T.score(y[ids], s[ids])
            m["share_correct"] = float(((s[ids] >= THR) == y[ids]).mean())
            if len(ids) >= 30:
                ok = ((s[ids] >= THR) == y[ids]).astype(float)
                bs = [ok[rng.integers(0, len(ok), len(ok))].mean() for _ in range(1000)]
                m["accuracy_ci95"] = [float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))]
            target[k] = m
    table("kind", res["kinds"])
    for p in ("lighting", "sharpness", "green", "frame edge"):
        res["properties"][p] = {}
        table(p, res["properties"][p])
    for k, m in res["kinds"].items():
        print(f"  {k:52s} n={m['crops']:5d}  correct {m['share_correct']:.3f}", flush=True)

    # ---- damage at 3 strengths
    levels, single = damages(a.seed)
    base_dec = s >= THR
    for name, fs in levels.items():
        res["damage"][name] = []
        for lvl, f in enumerate(fs, 1):
            sp = T.run_net(net, idx, [f(im) for im in images])
            m = T.score(y, sp)
            m["decisions_changed_pct"] = float(((sp >= THR) != base_dec).mean() * 100)
            m["level"] = lvl
            res["damage"][name].append(m)
        print(f"  {name:34s} acc " + " / ".join(f"{m['accuracy']:.3f}" for m in res["damage"][name]), flush=True)
    for name, f in single.items():
        sp = T.run_net(net, idx, [f(im) for im in images])
        m = T.score(y, sp)
        m["decisions_changed_pct"] = float(((sp >= THR) != base_dec).mean() * 100)
        m["level"] = 1
        res["damage"][name] = [m]
        print(f"  {name:34s} acc {m['accuracy']:.3f}", flush=True)
    base_acc = res["splits"]["test + val"]["metrics"]["accuracy"]
    res["damage_summary"] = {
        "clean_accuracy": base_acc,
        "mean_accuracy_by_level": {lvl: float(np.mean([v[lvl - 1]["accuracy"] for v in res["damage"].values() if len(v) == 3])) for lvl in (1, 2, 3)},
        "worst_at_level_3": sorted(((k, v[-1]["accuracy"]) for k, v in res["damage"].items()), key=lambda kv: kv[1])[:5],
        "safe_at_level_3": [k for k, v in res["damage"].items() if base_acc - v[-1]["accuracy"] < 0.02],
    }

    # ---- galleries: random sample per kind (green border = right, red = wrong)
    for k in res["kinds"]:
        ids = [i for i, r in enumerate(rows) if r["kind"] == k]
        pick = rng.choice(ids, min(24, len(ids)), replace=False)
        tiles = [tile(images[i], f"p={s[i]:.2f} {'touch' if y[i] else 'no touch'}", rows[i]["stem"][-22:], (s[i] >= THR) == y[i]) for i in pick]
        n_ok = sum((s[i] >= THR) == y[i] for i in pick)
        if grid(tiles, out / f"kind_{slug(k)}.jpg", f"{k}: random {len(pick)}, {n_ok} right (green) / {len(pick) - n_ok} wrong (red)"):
            res["galleries"].append({"file": f"kind_{slug(k)}.jpg", "title": k})
    for p, val in (("lighting", "dark"), ("sharpness", "blurry"), ("green", "lots of green (>25%)"), ("frame edge", "hand at the frame edge")):
        ids = [i for i, r in enumerate(rows) if r[p] == val]
        if not ids:
            continue
        pick = rng.choice(ids, min(16, len(ids)), replace=False)
        tiles = [tile(images[i], f"p={s[i]:.2f} {'touch' if y[i] else 'no touch'}", rows[i]["kind"][-26:], (s[i] >= THR) == y[i]) for i in pick]
        f = f"prop_{slug(val)}.jpg"
        if grid(tiles, out / f, f"{p}: {val}, random sample"):
            res["galleries"].append({"file": f, "title": f"{p}: {val}"})
    # damage strips: 3 example crops (a touch, a fixed-object touch, a near-miss) under every damage
    ex = []
    for want in ("100DOH: hand holding an object", "100DOH: hand on a fixed object (wall, tree, table)", "plant scene: hand near the plant, not touching", "100DOH: hand touching nothing"):
        ids = [i for i, r in enumerate(rows) if r["kind"] == want and (s[i] >= THR) == y[i]]
        if ids:
            ex.append(int(rng.choice(ids)))
    for i in ex:
        tiles = [tile(images[i], f"original p={s[i]:.2f}", "touch" if y[i] else "no touch")]
        for name, fs in levels.items():
            for lvl in (1, 3):
                im = fs[lvl - 1](images[i])
                p = T.run_net(net, idx, [im])[0]
                tiles.append(tile(im, f"p={p:.2f}", f"{name[:18]} L{lvl}", (p >= THR) == y[i]))
        for name, f in single.items():
            im = f(images[i])
            p = T.run_net(net, idx, [im])[0]
            tiles.append(tile(im, f"p={p:.2f}", name[:24], (p >= THR) == y[i]))
        fn = f"damage_strip_{len([g for g in res['galleries'] if g['file'].startswith('damage_strip')]) + 1}.jpg"
        if grid(tiles, out / fn, f"One {rows[i]['kind']} crop under every kind of damage (strength 1 and 3)", cols=11):
            res["galleries"].append({"file": fn, "title": f"damage on a '{rows[i]['kind']}' crop"})

    # ---- charts
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    names = list(res["damage"])
    mat = np.array([[v[l]["accuracy"] if l < len(v) else np.nan for l in range(3)] for v in res["damage"].values()])
    fig, ax = plt.subplots(figsize=(6.5, 0.36 * len(names) + 1.2))
    im = ax.imshow(mat, cmap="RdYlGn", vmin=0.5, vmax=max(0.85, base_acc), aspect="auto")
    for (i, j), v in np.ndenumerate(mat):
        if not np.isnan(v):
            ax.text(j, i, f"{v:.3f}", ha="center", va="center", fontsize=8)
    ax.set_xticks(range(3), ["strength 1", "strength 2", "strength 3"])
    ax.set_yticks(range(len(names)), names, fontsize=8)
    ax.set_title(f"Touch accuracy under camera damage (clean {base_acc:.3f})", fontsize=10)
    fig.colorbar(im, ax=ax, fraction=0.04)
    fig.tight_layout()
    fig.savefig(out / "touch_damage_heatmap.png", dpi=105)
    plt.close(fig)

    ks = list(res["kinds"])
    fig, ax = plt.subplots(figsize=(8, 0.42 * len(ks) + 1))
    v = [res["kinds"][k]["share_correct"] for k in ks]
    lo = [res["kinds"][k].get("accuracy_ci95", [vv, vv])[0] for k, vv in zip(ks, v)]
    hi = [res["kinds"][k].get("accuracy_ci95", [vv, vv])[1] for k, vv in zip(ks, v)]
    ax.barh(range(len(ks)), v, xerr=[np.subtract(v, lo), np.subtract(hi, v)], color="#2a7d4f", capsize=3)
    ax.set_yticks(range(len(ks)), [f"{k} (n={res['kinds'][k]['crops']})" for k in ks], fontsize=8)
    ax.set(xlim=(0, 1), xlabel="share of crops decided right (error bar = bootstrap 95% CI)", title="Touch classifier by kind of example")
    fig.tight_layout()
    fig.savefig(out / "touch_kinds.png", dpi=105)
    plt.close(fig)

    with open(out / "per_crop.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["stem", "split", "source", "label", "kind", "lighting", "sharpness", "green", "frame_edge", "p_touch", "p_touch_mirror_tta"])
        for i, r in enumerate(rows):
            w.writerow([r["stem"], r["split"], r["source"], r["label"], r["kind"], r["lighting"], r["sharpness"], r["green"], r["frame edge"], f"{s[i]:.5f}", f"{(s[i] + s_flip[i]) / 2:.5f}"])
    (out / "touch_big.json").write_text(json.dumps(res, indent=2, default=float))
    print(json.dumps({"splits": {k: v["metrics"]["accuracy"] for k, v in res["splits"].items()}, "damage_summary": res["damage_summary"]}, indent=1))


if __name__ == "__main__":
    main()
