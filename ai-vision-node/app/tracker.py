"""Small ByteTrack-style person tracker (numpy only), built for keeping one ID per person.

Ultralytics' tracker gave a person a new ID every few seconds in the live app (#8 -> #114 -> #121):
it counts lost time in frames, but the pipeline skips frames when nothing moves, and a person close
to the camera changes box shape faster than IoU matching tolerates. Every new ID reset the alert
cooldown, so the same person raised warning after warning. Here:
  - lost time is measured in seconds, so skipped frames do not age tracks;
  - a lost track is still matched by centre distance when IoU fails (fast or close-up movement);
  - low-score detections only extend existing tracks (ByteTrack's second pass), never start one.
"""
import itertools

import numpy as np


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9)


class Tracker:
    def __init__(self, high=0.4, lost_seconds=2.0, min_iou=0.3, max_centre_dist=0.5):
        self.high, self.lost_seconds = high, lost_seconds
        self.min_iou, self.max_centre_dist = min_iou, max_centre_dist
        self.tracks = []  # {"id", "box", "vel", "seen", "conf"}
        self.ids = itertools.count(1)

    def _predict(self, t, now):
        return t["box"] + t["vel"] * min(now - t["seen"], 1.0)

    def _match(self, tracks, dets, now, use_centre):
        """Greedy best-first matching (a handful of people per frame: no need for Hungarian)."""
        pairs = []
        for i, t in enumerate(tracks):
            p = self._predict(t, now)
            for j, (b, _) in enumerate(dets):
                o = iou(p, b)
                if o >= self.min_iou:
                    pairs.append((o, i, j))
                elif use_centre:
                    size = max(p[2] - p[0], p[3] - p[1], b[2] - b[0], b[3] - b[1])
                    d = np.hypot(*((p[:2] + p[2:]) / 2 - (b[:2] + b[2:]) / 2)) / size
                    if d <= self.max_centre_dist:
                        pairs.append((self.min_iou * (1 - d), i, j))  # ranks below every IoU match
        out, ti, dj = [], set(), set()
        for _, i, j in sorted(pairs, reverse=True):
            if i not in ti and j not in dj:
                ti.add(i)
                dj.add(j)
                out.append((i, j))
        return out

    def _update(self, t, box, conf, now):
        dt = max(now - t["seen"], 1e-3)
        t["vel"] = 0.5 * t["vel"] + 0.5 * (box - t["box"]) / dt if dt < 1.0 else np.zeros(4)
        t["box"], t["conf"], t["seen"] = box, conf, now

    def update(self, dets, now):
        """dets: [(xyxy box, score)]. Returns [{"id", "box", "conf"}] for tracks seen in this frame."""
        dets = [(np.asarray(b, float), c) for b, c in dets]
        high = [d for d in dets if d[1] >= self.high]
        low = [d for d in dets if d[1] < self.high]
        seen = []
        m = self._match(self.tracks, high, now, use_centre=True)
        for i, j in m:
            self._update(self.tracks[i], *high[j], now)
            seen.append(self.tracks[i])
        used_t, used_d = {i for i, _ in m}, {j for _, j in m}
        rest = [t for k, t in enumerate(self.tracks) if k not in used_t]
        for i, j in self._match(rest, low, now, use_centre=False):
            self._update(rest[i], *low[j], now)
            seen.append(rest[i])
        for j, (b, c) in enumerate(high):
            if j not in used_d:
                t = {"id": next(self.ids), "box": b, "vel": np.zeros(4), "seen": now, "conf": c}
                self.tracks.append(t)
                seen.append(t)
        self.tracks = [t for t in self.tracks if now - t["seen"] <= self.lost_seconds]
        return [{"id": t["id"], "box": t["box"], "conf": t["conf"]} for t in seen]
