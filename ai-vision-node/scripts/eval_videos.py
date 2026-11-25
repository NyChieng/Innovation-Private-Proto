"""Run test videos through the real FloraGuard pipeline (app/pipeline.py) and record evidence.

    python scripts/eval_videos.py OUT_DIR VIDEO_OR_FOLDER [VIDEO_OR_FOLDER ...]
        env ZONES=zones.json   a plant zone per clip name (normalised polygon), as drawn in the app
        env BACKEND=openvino   openvino (default, the laptop-CPU deployment) | onnxruntime | cuda
        env THREADS=4
        env PERTURB=dusk       replay every frame as a worse camera would record it: dusk, night_ir,
                               fog, noise, low_res, jpeg15, shake (see PERTURB below)

Expected result per clip comes from its name (EXPECT below): a clip whose name starts with
"look" should never ALERT, every touch clip should.

Per video: annotated output video, keyframe screenshots, ALERT snapshots, per-frame timeline (CSV/JSON),
a timeline chart, and a contact sheet. Time = video timestamp (frame_index / fps), so time-based rules
(1 s WARNING, 10 s cooldown) behave as for a live camera regardless of how fast this laptop processes.
"""
import csv, glob, json, os, sys, time
from pathlib import Path

import cv2
import numpy as np

NODE = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[1])
INPUTS = [Path(p) for p in sys.argv[2:]]
sys.path.insert(0, str(NODE / "app"))
import pipeline  # noqa: E402

EXPECT = {"look plants 2": "ALERT", "look": "NO_ALERT", "pinch": "ALERT", "touch": "ALERT",
          "ivy_touch": "ALERT", "video2_4k": "ALERT"}  # video2_4k: hands picking strawberries among the leaves  # look plants 2: he strokes the leaves (verified visually)
STAGE_COL = {"SAFE": (80, 200, 80), "WARNING": (0, 170, 255), "ALERT": (0, 0, 255)}


def _noise(im, sigma):
    n = np.empty(im.shape, np.int16)
    cv2.randn(n, 0, sigma)
    return np.clip(im.astype(np.int16) + n, 0, 255).astype(np.uint8)


def _gamma(g):
    return np.clip(((np.arange(256) / 255.0) ** g) * 255, 0, 255).astype(np.uint8)


_MOTION = np.zeros((9, 9), np.float32)
_MOTION[4, :] = 1 / 9
# env PERTURB=<name>: replay the clip as a worse camera would have recorded it
PERTURB = {
    "": lambda f: f,
    "dusk": lambda f: _noise(cv2.LUT(f, _gamma(2.0)), 8),
    "night_ir": lambda f: _noise(cv2.cvtColor(cv2.cvtColor(cv2.LUT(f, _gamma(1.3)), cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR), 6),
    "fog": lambda f: cv2.addWeighted(f, 0.6, np.full_like(f, 225), 0.4, 0),
    "noise": lambda f: _noise(f, 15),
    "low_res": lambda f: cv2.resize(f, (640, int(f.shape[0] * 640 / f.shape[1])), interpolation=cv2.INTER_AREA),
    "jpeg15": lambda f: cv2.imdecode(cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 15])[1], cv2.IMREAD_COLOR),
    "shake": lambda f: cv2.filter2D(f, -1, _MOTION),
}
CONDITION = os.environ.get("PERTURB", "")
DAMAGE = PERTURB[CONDITION]


def small(img, w=960):
    h0, w0 = img.shape[:2]
    if w0 <= w and h0 <= w:
        return img
    s = w / max(w0, h0)
    return cv2.resize(img, (int(w0 * s), int(h0 * s)), interpolation=cv2.INTER_AREA)


def writer(path, fps, size):
    for cc in ("avc1", "H264", "mp4v"):
        vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*cc), fps, size)
        if vw.isOpened():
            return vw, cc
    raise RuntimeError("no video codec")


def chart(rows, dur, path, w=1200, h=260):
    img = np.full((h, w, 3), 255, np.uint8)
    L, R, T, B = 60, 20, 20, 60
    pw, ph = w - L - R, h - T - B
    xs = lambda t: int(L + pw * t / max(dur, 1e-6))
    for r in rows:  # stage band
        x = xs(r["t"])
        cv2.line(img, (x, h - B + 12), (x, h - B + 30), STAGE_COL[r["stage"]], 2)
    cv2.putText(img, "stage", (5, h - B + 26), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)
    cv2.rectangle(img, (L, T), (L + pw, T + ph), (180, 180, 180), 1)
    for v in (0.2, 0.6):  # thresholds
        y = int(T + ph * (1 - v))
        cv2.line(img, (L, y), (L + pw, y), (0, 140, 255) if v == 0.6 else (200, 200, 200), 1)
        cv2.putText(img, f"{v:.1f}", (L - 35, y + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)
    pts = [(xs(r["t"]), int(T + ph * (1 - r["touch_p"]))) for r in rows]
    for a, b in zip(pts, pts[1:]):
        cv2.line(img, a, b, (180, 60, 0), 2, cv2.LINE_AA)
    for s in range(0, int(dur) + 1):
        x = xs(s)
        cv2.putText(img, f"{s}s", (x - 8, h - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1)
    cv2.putText(img, "touch probability (blue); orange line = 0.6 touch threshold, grey = 0.2 assist",
                (L, T - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)
    cv2.imwrite(str(path), img)


def sheet(frames, path, cols=4, tw=400):
    tiles = []
    for img, label in frames:
        t = small(img, tw)
        t = cv2.copyMakeBorder(t, 0, 28, 0, 0, cv2.BORDER_CONSTANT, value=(30, 30, 30))
        cv2.putText(t, label, (6, t.shape[0] - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        tiles.append(t)
    th = max(t.shape[0] for t in tiles)
    tw2 = max(t.shape[1] for t in tiles)
    tiles = [cv2.copyMakeBorder(t, 0, th - t.shape[0], 0, tw2 - t.shape[1], cv2.BORDER_CONSTANT, value=(30, 30, 30))
             for t in tiles]
    while len(tiles) % cols:
        tiles.append(np.full_like(tiles[0], 30))
    rows = [np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]
    cv2.imwrite(str(path), np.vstack(rows))


def run(video):
    name = Path(video).stem
    slug = name.replace(" ", "_")
    d = OUT / slug
    (d / "keyframes").mkdir(parents=True, exist_ok=True)
    expect = next(v for k, v in EXPECT.items() if name.startswith(k))
    cfg = dict(pipeline.DEFAULTS)
    cfg.update(backend=os.environ.get("BACKEND", "openvino"), threads=int(os.environ.get("THREADS", 4)))
    if os.environ.get("ZONES"):
        cfg["zone"] = json.loads(Path(os.environ["ZONES"]).read_text()).get(name, [])
    g = pipeline.FloraGuard(cfg, snapshot_dir=d / "snapshots")
    g.reset()
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    t_base = 1_800_000_000.0  # fixed epoch so snapshot names are stable; only differences matter
    rows, events, vw, codec = [], [], None, None
    keyframes, firsts, peak = [], {}, (-1.0, None, None)
    prev_stage = "SAFE"
    wall0 = time.perf_counter()
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame = DAMAGE(frame)
        t = i / fps
        tic = time.perf_counter()
        out, info, new = g.step(frame, now=t_base + t)
        ms = (time.perf_counter() - tic) * 1000
        o = small(out)
        if vw is None:
            vw, codec = writer(d / f"{slug}_annotated.mp4", fps, (o.shape[1], o.shape[0]))
            src_res = f"{frame.shape[1]}x{frame.shape[0]}"
        vw.write(o)
        r = dict(i=i, t=round(t, 3), stage=info["stage"], profile=info["profile"], people=info["people"],
                 animals=info["animals"], plants=info["plants"], zones=info.get("zones", 0), hands=info["hands"],
                 touch_p=round(float(info["touch_p"]), 3), leaf=round(float(info["leaf"]), 4),
                 ran_models=bool(info["ran_models"]), ms=round(ms, 1))
        rows.append(r)
        for e in new:
            events.append(dict(t=round(e.t - t_base, 2), tier=e.tier, track_id=e.track_id, detail=e.detail,
                               snapshot=os.path.relpath(e.snapshot, d).replace("\\", "/") if e.snapshot else ""))
        st = info["stage"]
        if st != prev_stage or i == 0:
            fn = f"keyframes/{i:04d}_{st}.jpg"
            cv2.imwrite(str(d / fn), o)
            keyframes.append(dict(t=round(t, 2), stage=st, file=fn, why=f"{prev_stage} -> {st}" if i else "first frame"))
            firsts.setdefault(st, round(t, 2))
            prev_stage = st
        if info["touch_p"] > peak[0]:
            peak = (float(info["touch_p"]), o.copy(), t)
        i += 1
    wall = time.perf_counter() - wall0
    cap.release()
    vw.release()
    if peak[1] is not None and peak[0] > 0:
        fn = "keyframes/peak_touch.jpg"
        cv2.imwrite(str(d / fn), peak[1])
        keyframes.append(dict(t=round(peak[2], 2), stage="peak", file=fn, why=f"highest touch probability {peak[0]:.2f}"))
    # contact sheet: 8 evenly spaced frames from the annotated video
    cap = cv2.VideoCapture(str(d / f"{slug}_annotated.mp4"))
    tiles = []
    for k in range(8):
        idx = int(k * (len(rows) - 1) / 7)
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, f = cap.read()
        if ok:
            tiles.append((f, f"t={rows[idx]['t']:.1f}s {rows[idx]['stage']}"))
    cap.release()
    sheet(tiles, d / "contact_sheet.jpg")
    chart(rows, rows[-1]["t"], d / "timeline.png")
    with open(d / "frames.csv", "w", newline="") as fh:
        wr = csv.DictWriter(fh, rows[0].keys())
        wr.writeheader()
        wr.writerows(rows)
    counts = {s: sum(r["stage"] == s for r in rows) for s in pipeline.STAGES}
    got_alert = any(e["tier"] == "ALERT" for e in events)
    passed = got_alert if expect == "ALERT" else not got_alert
    ms_all = [r["ms"] for r in rows]
    ms_model = [r["ms"] for r in rows if r["ran_models"]]
    summary = dict(
        video=Path(video).name, slug=slug, resolution=src_res, fps=round(fps, 2), frames=len(rows),
        duration_s=round(len(rows) / fps, 2), expected=expect, alert_raised=got_alert, passed=passed,
        first_seen=firsts, stage_frames=counts,
        stage_seconds={s: round(c / fps, 2) for s, c in counts.items()},
        max_people=max(r["people"] for r in rows), max_animals=max(r["animals"] for r in rows),
        max_plants=max(r["plants"] for r in rows), frames_with_plant=sum(r["zones"] > 0 for r in rows),
        frames_with_hand=sum(r["hands"] > 0 for r in rows),
        peak_touch_p=round(peak[0], 3), peak_touch_t=round(peak[2] or 0, 2),
        frames_touch_ge_06=sum(r["touch_p"] >= 0.6 for r in rows),
        condition=CONDITION or "original", zone=cfg["zone"], events=events, keyframes=keyframes, backend=g.models.backend, codec=codec,
        processing=dict(wall_s=round(wall, 1), avg_ms=round(float(np.mean(ms_all)), 1),
                        p95_ms=round(float(np.percentile(ms_all, 95)), 1),
                        avg_model_ms=round(float(np.mean(ms_model)), 1) if ms_model else 0,
                        model_frames=len(ms_model), effective_fps=round(len(rows) / wall, 1)),
    )
    (d / "summary.json").write_text(json.dumps(summary, indent=2))
    print(f"{'PASS' if passed else 'FAIL'}  {name:20s} expect={expect:8s} alert={got_alert}  "
          f"first={firsts}  peak_p={peak[0]:.2f}  events={[(e['t'], e['tier']) for e in events]}  "
          f"{summary['processing']['effective_fps']} fps", flush=True)
    return summary


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    videos = []
    for p in INPUTS:
        videos += sorted(glob.glob(str(p / "*.mp4"))) if p.is_dir() else [str(p)]
    res = [run(v) for v in videos]
    ok = sum(r["passed"] for r in res)
    print(f"{ok}/{len(res)} clips gave the expected result")
    (OUT / "all_results.json").write_text(json.dumps(res, indent=2))
