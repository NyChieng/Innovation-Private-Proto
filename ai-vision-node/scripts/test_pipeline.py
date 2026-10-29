"""Scripted scenes for the live pipeline's bookkeeping: remembered plants, tracking, duplicate
boxes, warning cooldowns. The detector is replaced by a script and time is simulated.

    python scripts/test_pipeline.py      -> PASS / FAIL per scene
"""
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
from pipeline import FloraGuard, load_config, PERSON, PLANT

cfg = load_config(); cfg.update(backend="openvino", zone=[])
g = FloraGuard(cfg, snapshot_dir=tempfile.mkdtemp())
g.models.keypoints = lambda frame, roi: []
script = {}
g.models.detect = lambda frame, min_conf: script["dets"]
rng = np.random.default_rng(0)
frames = [rng.integers(0, 255, (720, 1280, 3), dtype=np.uint8) for _ in range(2)]  # alternating = motion
still = np.full((720, 1280, 3), 90, np.uint8)
def run(t0, t1, fps=10, dets=None, moving=True):
    out = []
    for i, t in enumerate(np.arange(t0, t1, 1 / fps)):
        if dets is not None: script["dets"] = dets(t) if callable(dets) else dets
        img = still.copy()
        if moving:  # a textured blob that moves every frame, so the motion gate sees activity
            x = int(100 + (i * 37) % 1000)
            img[300:420, x:x + 120] = frames[0][300:420, x:x + 120]
        _, info, _ = g.step(img, now=t)
        out.append((t, info, [p["id"] for p in g.last[0]]))
    return out
B = lambda *v: np.array(v, float)
fails = []


def ok(c, msg):
    print(("PASS " if c else "FAIL ") + msg)
    if not c:
        fails.append(msg)

# 1. phone with a plant photo moves right in jumps (screenshot 'image.jpeg'), person filling the frame
g.reset()
big_person = (B(0, 0, 1280, 720), 0.9, PERSON)
run(0, 1, dets=lambda t: [big_person, (B(700, 300, 900, 600), 0.8, PLANT)])
run(1, 2, dets=lambda t: [big_person, (B(1000, 300, 1200, 600), 0.8, PLANT)])   # jumped, no overlap
z = run(2, 6.5, dets=lambda t: [big_person, (B(1000, 300, 1200, 600), 0.8, PLANT)])
first_one = next((t for t, info, _ in z if info["zones"] == 1), None)
ok(first_one is not None and first_one <= 1 + 4.0 + 0.2, f"old plant zone gone {first_one - 1:.1f}s after the move (cover memory 4 s)" if first_one else "old zone never cleared")

# 2. same, then the scene goes still: zones must still age out (heartbeat), not freeze
g.reset()
run(0, 1, dets=lambda t: [(B(700, 300, 900, 600), 0.8, PLANT)])
z = run(1, 4, dets=[], moving=False)
gone = next((t for t, info, _ in z if info["zones"] == 0), None)
ok(gone is not None and gone - 1 <= 2.6, f"plant that left a still scene forgotten after {gone - 1:.1f}s" if gone else "zone frozen in still scene")

# 3. person close to the camera moving fast, detector misses 0.8 s, weak scores: one ID
g.reset()
def walker(t):
    if 2.0 <= t < 2.8: return []                                    # missed detections
    x = 100 + 350 * t                                               # 350 px/s
    conf = 0.25 if 4 <= t < 5 else 0.8                              # weak scores for a second
    h = 700 if int(t) % 2 else 500                                  # box shape jumps (close-up)
    return [(B(x, 720 - h, x + 400, 720), conf, PERSON)]
z = run(0, 6, dets=walker)
ids = {i for _, _, l in z for i in l}
ok(len(ids) == 1, f"fast close-up person keeps one ID across a 0.8 s miss and weak frames: ids {sorted(ids)}")

# 4. two boxes on one person (screenshot): one survives
g.reset()
z = run(0, 1, dets=[(B(0, 200, 720, 720), 0.7, PERSON), (B(0, 200, 1082, 720), 0.6, PERSON)])
ok(z[-1][1]["people"] == 1, f"duplicate person boxes merged -> {z[-1][1]['people']} person")
z = run(1, 2, dets=[(B(0, 200, 400, 720), 0.7, PERSON), (B(500, 200, 900, 720), 0.6, PERSON)])
ok(z[-1][1]["people"] == 2, f"two separate people kept -> {z[-1][1]['people']} people")

# 5. person leaves: their box disappears at the next model run, even in a still scene
g.reset()
run(0, 1, dets=[(B(100, 100, 500, 700), 0.8, PERSON)])
z = run(1, 3, dets=[], moving=False)
gone = next((t for t, info, _ in z if info["people"] == 0), None)
ok(gone is not None and gone - 1 <= 1.05, f"box of a person who left removed after {gone - 1:.1f}s")

# 6. warnings: a person lingering near a plant for 30 s gets 3 warnings (10 s cooldown), no pictures
g.reset(); g.events.clear()
run(0, 30, fps=5, dets=[(B(600, 300, 800, 600), 0.8, PLANT), (B(550, 100, 750, 700), 0.8, PERSON)])
w = [e for e in g.events if e.tier == "WARNING"]
ok(len(w) == 3 and not any(e.snapshot for e in w), f"{len(w)} warnings in 30 s for one person, snapshots: {sum(bool(e.snapshot) for e in w)}")

ran = sum(info["ran_models"] for _, info, _ in run(10, 12, dets=[]))
ok(ran >= 5, f"motion gate active in the test: models ran {ran}/20 frames")

sys.exit(1 if fails else 0)
