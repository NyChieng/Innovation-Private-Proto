"""FloraGuard detection cascade with a three-stage warning system.

    motion gate -> detector (person / animal / plant) + person tracker -> pose on the region around
    people near the plant -> touch classifier on hand crops inside the buffer zone -> stage per person

Stages (people only; animals live in the forest, so they are labelled but never alerted):
    SAFE     person in view, away from the plant
    WARNING  person's body or wrist inside the buffer zone around the plant for warn_seconds
    ALERT    touch classifier says a hand is on the plant in touch_frames of the last touch_window
             model frames, AND the plant backs it up: its leaves move, or the hand crop is among
             green plant pixels (plant_green_min). The classifier alone can never alert, so a hand
             holding a camera in front of a coat stays a WARNING. Colour alone is not required,
             because a bare winter tree has no green but its branches still move when pruned.
             (without a trained touch model: wrist inside the plant outline + leaf motion)

The plant zone is the polygon drawn in the app; the app's Live tab needs one (require_zone).
Without one (scripts and tests), detected plants are the zones.

Built to run on a small CPU-only machine (app/engine.py: OpenVINO; an NVIDIA GPU is used if present):
  - the models run only when something moves, plus a heartbeat every heartbeat_seconds, so drawn
    boxes and remembered plants are never older than that;
  - pose runs only when someone is near a plant, on a crop around them; the touch model only on
    hands inside the buffer zone;
  - the app caps processing at max_fps.

Used by the Gradio app (app/floraguard_app.py) and scripts/evaluate.py.
"""
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from engine import EXPORT, Models
from notifier import AlertSender
from touchcrop import cut, hand_box
from tracker import Tracker, iou

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "app" / "config.json"

WRIST, ELBOW, SHOULDERS = (9, 10), (7, 8), [5, 6]  # COCO keypoints: left/right wrist, elbow, shoulders
PERSON, ANIMAL, PLANT = 0, 1, 2
STAGES = ("SAFE", "WARNING", "ALERT")
COLOURS = {"SAFE": (80, 200, 80), "WARNING": (0, 170, 255), "ALERT": (0, 0, 255)}  # BGR
SNAPSHOT_TIERS = ("ALERT", "AFTER-HOURS")  # warnings are logged without a picture
LOW_CONF = 0.15  # person detections this weak only keep an existing track alive
PERSON_STATE_SECONDS = 30.0  # forget a person's stage/cooldowns this long after their track ends

DEFAULTS = {
    "zone": [],                 # plant polygon, normalised [x, y] points; empty = use detected plants
    "buffer_scale": 0.25,       # buffer = plant zone grown by this share of the plant's width
    "conf_person": 0.4,
    "conf_animal": 0.35,
    "conf_plant": 0.35,
    "warn_seconds": 1.0,        # how long someone must be in the buffer before WARNING
    "touch_conf": 0.6,          # touch classifier probability that counts as a touch frame
    "touch_assist": 0.2,        # ... or this much, when the wrist is on the plant and its leaves move
    "touch_frames": 3,          # debounce: touch frames needed before ALERT (4 alerted ~5 s late on a
                                # flat hand brushing dark leaves in the team's 25 Nov clips; 3 caught it in 0.5 s) ...
    "touch_window": 6,          # ... among the last this many model frames (0 = in a row, the old rule)
    "plant_green_min": 0.15,    # plant evidence: share of green pixels (2G - R - B) in the hand crop
    "require_zone": True,       # Live does not start until a plant zone is drawn
    "cooldown_seconds": 10.0,   # per person and stage
    "motion_multiplier": 2.5,   # fallback touch rule: leaf motion must exceed baseline x this
    "leaf_motion_floor": 0.004, # ... and at least this share of plant pixels changing
    "idle_stride": 3,           # Watch profile: run the detector every Nth frame while something moves
    "heartbeat_seconds": 1.0,   # ... and at least this often when nothing moves
    "plant_memory_seconds": 1.5,        # an undetected plant stays protected this long
    "plant_cover_memory_seconds": 4.0,  # ... or this long while a person stands in front of it
    "track_lost_seconds": 2.0,  # a person who drops out of detection keeps their ID this long
    "backend": "auto",          # auto | openvino | onnxruntime | cuda
    "threads": 4,               # CPU threads for the models
    "max_fps": 15,              # processing cap (the camera may deliver more)
    "after_hours": False,
    "open_hours": "08:00-17:00",
    # Send ALERT / AFTER-HOURS snapshots to the FloraScan web app (rangers). Empty = in the live app,
    # the FloraScan server on this computer, found by itself (scripts and tests: off); "off" = never.
    # See app/notifier.py; FLORAGUARD_* environment variables take precedence.
    "server_url": "",
    "camera_code": "CAM-001",
    "camera_key": "",
    "server_ca": "",
}


def load_config():
    cfg = dict(DEFAULTS)
    if CONFIG.exists():
        saved = json.loads(CONFIG.read_text())
        cfg.update({k: v for k, v in saved.items() if k in DEFAULTS})
    return cfg


def save_config(cfg):
    CONFIG.write_text(json.dumps({k: cfg[k] for k in DEFAULTS if k in cfg}, indent=2))


def green_share(crop):
    """Share of a BGR crop that is green vegetation: excess-green index 2g - r - b > 0.1 on
    chromaticity (r, g, b = channel / sum), which ignores brightness, so shade and sun score alike."""
    if crop is None or crop.size == 0:
        return 0.0
    f = crop.astype(np.float32)
    s = f.sum(axis=2) + 1e-6
    exg = (2 * f[..., 1] - f[..., 2] - f[..., 0]) / s
    return float((exg > 0.1).mean())


def model_info():
    """models.json from scripts/export_models.py: what each network is and where it came from."""
    p = EXPORT / "models.json"
    return json.loads(p.read_text()) if p.exists() else {}


@dataclass
class Event:
    t: float
    tier: str
    track_id: int
    detail: str
    snapshot: str = ""


@dataclass
class PersonState:
    first_near: float = 0.0
    streak: int = 0
    recent: list = field(default_factory=list)  # touch (True/False) at each of the last model frames
    stage: str = "SAFE"
    seen: float = 0.0
    last_alert: dict = field(default_factory=dict)


class FloraGuard:
    def __init__(self, cfg=None, snapshot_dir=ROOT / "events", find_server=False):
        """find_server: with no server_url set, send alerts to the FloraScan server on this computer.
        Only the live app asks for it, so evaluation scripts and tests never alert real rangers."""
        self.cfg = cfg or load_config()
        self.models = Models(self.cfg["backend"], self.cfg["threads"])
        self.snap_dir = Path(snapshot_dir)
        self.snap_dir.mkdir(parents=True, exist_ok=True)
        self.sender = AlertSender(self.cfg, auto=find_server)
        self.reset()

    def reset(self):
        self.bg = cv2.createBackgroundSubtractorMOG2(history=300, varThreshold=32, detectShadows=False)
        self.prev_small = None
        self.leaf_base = None
        self.people = {}
        self.plants = []  # {"box", "seen", "conf"}: detected now, or remembered for a few seconds
        self.events = []
        self.frame_i = 0
        self.profile = "Watch"
        self.quiet_frames = 0
        self.last = ([], [], [])  # persons, animals, plants from the last model frame
        self.last_model_t = -1e9
        self.timing = {}
        self.tracker = Tracker(high=self.cfg["conf_person"], lost_seconds=self.cfg["track_lost_seconds"])

    # ---- geometry ---------------------------------------------------------------------------
    def zones(self, w, h, now):
        """[(plant polygon, buffer polygon, detected now?)]: the drawn zone, else one per plant."""
        z = self.cfg.get("zone") or []
        if len(z) >= 3:
            polys = [(np.array([[x * w, y * h] for x, y in z], np.float32), True)]
        else:
            polys = [(np.array([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], np.float32),
                      pl["seen"] == self.last_model_t) for pl in self.plants for b in [pl["box"]]]
        out = []
        for poly, fresh in polys:
            c = poly.mean(0)
            width = poly[:, 0].max() - poly[:, 0].min()
            grow = (width * self.cfg["buffer_scale"]) / max(1.0, np.linalg.norm(poly - c, axis=1).mean())
            out.append((poly, c + (poly - c) * (1 + grow), fresh))
        return out

    @staticmethod
    def inside(poly, pt):
        return cv2.pointPolygonTest(poly.astype(np.float32), (float(pt[0]), float(pt[1])), False) >= 0

    @staticmethod
    def box_hits(poly, box):
        """Does an xyxy box overlap a polygon? (corner/centre inside, or polygon vertex inside box)"""
        x0, y0, x1, y1 = box
        pts = [(x0, y0), (x1, y0), (x0, y1), (x1, y1), ((x0 + x1) / 2, (y0 + y1) / 2)]
        if any(FloraGuard.inside(poly, p) for p in pts):
            return True
        return any(x0 <= px <= x1 and y0 <= py <= y1 for px, py in poly)

    # ---- stages -----------------------------------------------------------------------------
    def motion(self, frame):
        small = cv2.resize(frame, (320, int(320 * frame.shape[0] / frame.shape[1])))
        fg = self.bg.apply(small)
        return float((fg > 0).mean()), small

    def leaf_motion(self, small, zones, hand_boxes, w, h):
        gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        prev, self.prev_small = self.prev_small, gray
        if prev is None or not zones:
            return 0.0
        sx, sy = small.shape[1] / w, small.shape[0] / h
        mask = np.zeros_like(gray)
        for poly, _, _ in zones:
            cv2.fillPoly(mask, [(poly * [sx, sy]).astype(np.int32)], 255)
        for x0, y0, x1, y1 in hand_boxes:  # the moving hand itself is not leaf motion
            cv2.rectangle(mask, (int(x0 * sx), int(y0 * sy)), (int(x1 * sx), int(y1 * sy)), 0, -1)
        n = int((mask > 0).sum())
        if n == 0:
            return 0.0
        diff = cv2.absdiff(gray, prev)
        return float(((diff > 18) & (mask > 0)).sum()) / n

    def detect(self, frame, now):
        cfg = self.cfg
        dets = self.models.detect(frame, min(LOW_CONF, cfg["conf_animal"], cfg["conf_plant"]))
        self.tracker.high = cfg["conf_person"]
        people = self._dedupe([(b, c) for b, c, k in dets if k == PERSON])
        persons = [dict(t) for t in self.tracker.update(people, now)]
        animals = [{"box": b, "conf": c} for b, c, k in dets if k == ANIMAL and c >= cfg["conf_animal"]]
        plants = [{"box": b, "conf": c} for b, c, k in dets if k == PLANT and c >= cfg["conf_plant"]]
        return persons, animals, plants

    @classmethod
    def _dedupe(cls, people):
        """Drop a second box on the same person: heavy overlap, or a box of similar size almost
        entirely inside a stronger one (seen in the live app as two labels on one person)."""
        area = lambda b: (b[2] - b[0]) * (b[3] - b[1])  # noqa: E731
        kept = []
        for b, c in sorted(people, key=lambda d: -d[1]):
            if not any(iou(b, k) > 0.5 or (cls._cover(b, k) > 0.85 and area(b) > 0.5 * area(k)) for k, _ in kept):
                kept.append((b, c))
        return kept

    def update_plants(self, plants, persons, now):
        """Remembered plant boxes, aged in seconds at each model run. A hand on a plant hides it
        from the detector or shrinks its box, so a plant a person covers keeps its old box for
        plant_cover_memory_seconds; one nobody covers is forgotten after plant_memory_seconds.
        A detection that overlaps several remembered boxes (a plant that moved) absorbs them all,
        so a moving plant leaves no trail of zones behind."""
        cfg = self.cfg
        covered = lambda b: any(self._cover(b, p["box"]) > 0.5 for p in persons)  # noqa: E731
        kept, used = [], set()  # identity: the dicts hold numpy boxes, == would compare arrays
        for pl in plants:
            same = [o for o in self.plants if id(o) not in used and self._same(o["box"], pl["box"])]
            used.update(id(o) for o in same)
            old = max(same, key=lambda o: iou(o["box"], pl["box"]), default=None)
            if old is None:
                kept.append({"box": pl["box"], "seen": now, "conf": pl["conf"]})
                continue
            old["seen"], old["conf"] = now, pl["conf"]
            # keep the old box only when the new one is a covered, shrunken part of it; a move is followed
            if not (covered(pl["box"]) and self._cover(pl["box"], old["box"]) > 0.7):
                old["box"] = pl["box"]
            kept.append(old)
        for old in self.plants:
            if id(old) not in used:
                memory = cfg["plant_cover_memory_seconds"] if covered(old["box"]) else cfg["plant_memory_seconds"]
                if now - old["seen"] < memory:
                    kept.append(old)
        self.plants = kept

    def add_pose(self, frame, persons):
        """Attach wrist/elbow keypoints to people near the plant. Pose runs once on the region
        around them (10% margin), not the whole frame."""
        h, w = frame.shape[:2]
        b = np.array([p["box"] for p in persons])
        x0, y0 = b[:, :2].min(0)
        x1, y1 = b[:, 2:].max(0)
        mx, my = 0.1 * (x1 - x0), 0.1 * (y1 - y0)
        roi = (max(0, x0 - mx), max(0, y0 - my), min(w, x1 + mx), min(h, y1 + my))
        found = self.models.keypoints(frame, roi)
        for p in persons:
            j = max(found, key=lambda f: iou(p["box"], f[0]), default=None)
            if j is not None and iou(p["box"], j[0]) > 0.3:
                p["kpts"], p["kconf"] = j[1], j[2]

    # ---- main step --------------------------------------------------------------------------
    def step(self, frame, now=None):
        """Process one BGR frame. Returns (annotated frame, info dict, new events)."""
        now = time.time() if now is None else now
        t0 = time.perf_counter()
        h, w = frame.shape[:2]
        cfg = self.cfg
        self.frame_i += 1
        new_events = []
        info = {"profile": self.profile, "people": 0, "animals": 0, "plants": 0, "motion": 0.0, "leaf": 0.0,
                "hands": 0, "touch_p": 0.0, "stage": "SAFE", "backend": self.models.backend}

        motion, small = self.motion(frame)
        info["motion"] = motion
        active = motion > 0.002 or self.profile != "Watch"
        stride = cfg["idle_stride"] if self.profile == "Watch" else 1
        run_models = ((active and self.frame_i % stride == 0) or self.frame_i == 1
                      or now - self.last_model_t >= cfg["heartbeat_seconds"])
        if run_models:
            persons, animals, plants = self.detect(frame, now)
            self.last = (persons, animals, plants)
            self.update_plants(plants, persons, now)
            self.last_model_t = now
        else:
            persons, animals, plants = self.last
        info["people"], info["animals"], info["plants"] = len(persons), len(animals), len(plants)
        zones = self.zones(w, h, now)
        info["zones"] = len(zones)
        info["remembered"] = sum(not fresh for _, _, fresh in zones)
        t1 = time.perf_counter()

        # stage 2 candidates: people whose body touches a buffer zone
        for p in persons:
            p["near"] = any(self.box_hits(buf, p["box"]) for _, buf, _ in zones)
            p["kpts"], p["hands"] = None, []
        near = [p for p in persons if p["near"]]
        if run_models and near:
            self.add_pose(frame, near)
        t2 = time.perf_counter()
        crops, metas = [], []
        for p in persons:
            if p["kpts"] is None:
                continue
            # close-up: only a hand and forearm reach into view (no shoulder). The elbow is then off-screen
            # and scored ~0.05, but the pose model still places it along the arm towards the frame edge;
            # without it the crop shrank to a sleeve cuff at the wrist (touch p 0.15 on a hand in the ivy)
            close_up = p["kconf"][SHOULDERS].max() < 0.3
            for wi, ei in zip(WRIST, ELBOW):
                if p["kconf"][wi] < 0.4:
                    continue
                wpt = p["kpts"][wi]
                in_buf = any(self.inside(buf, wpt) for _, buf, _ in zones)
                in_plant = any(self.inside(poly, wpt) for poly, _, _ in zones)
                if not in_buf:
                    continue
                elbow = p["kpts"][ei] if p["kconf"][ei] >= 0.4 or close_up else None
                hb = hand_box(wpt, elbow, p["box"][3] - p["box"][1])
                hand = {"wrist": wpt, "box": hb, "in_plant": in_plant, "p": None, "crop": None}
                p["hands"].append(hand)
                hand["crop"] = cut(frame, hb)  # also saved by the app's training-data recorder
                hand["green"] = green_share(hand["crop"])
                if self.models.touch is not None and hand["crop"] is not None:
                    crops.append(hand["crop"])
                    metas.append(hand)
        if crops:
            for hand, prob in zip(metas, self.models.touch_probs(crops)):
                hand["p"] = prob
        hand_boxes = [hd["box"] for p in persons for hd in p["hands"]]
        info["hands"] = len(hand_boxes)
        info["hand_crops"] = [hd["crop"] for p in persons for hd in p["hands"] if hd["crop"] is not None]
        t3 = time.perf_counter()

        leaf = self.leaf_motion(small, zones, hand_boxes, w, h)
        near_any = bool(near)
        if not near_any:  # learn the wind/light baseline only while nobody is near the plant
            self.leaf_base = leaf if self.leaf_base is None else 0.95 * self.leaf_base + 0.05 * leaf
        base = self.leaf_base or 0.0
        leaves_moving = leaf > max(base * cfg["motion_multiplier"], cfg["leaf_motion_floor"])
        info["leaf"], info["leaf_base"] = leaf, base

        # stages
        for p in persons:
            st = self.people.setdefault(p["id"], PersonState())
            st.seen = now
            if p["near"] or p["hands"]:
                st.first_near = st.first_near or now
            else:
                st.first_near, st.streak, st.recent = 0.0, 0, []
            probs = [hd["p"] for hd in p["hands"] if hd["p"] is not None]
            p["touch_p"] = max(probs, default=0.0)
            info["touch_p"] = max(info["touch_p"], p["touch_p"])
            if run_models:
                # a hand on the plant that makes its leaves move needs only weak model support:
                # public data has few plant touches, so the model under-scores them (see reports/touch.json)
                geometric = any(hd["in_plant"] for hd in p["hands"]) and leaves_moving
                green = any(hd.get("green", 0.0) >= cfg["plant_green_min"] for hd in p["hands"])
                p["plant_evidence"] = leaves_moving or green
                if self.models.touch is not None:
                    touching = p["touch_p"] >= cfg["touch_conf"] or (geometric and p["touch_p"] >= cfg["touch_assist"])
                    # the plant has to back the classifier up: leaves move, or the hand is among plant pixels
                    touching = touching and p["plant_evidence"]
                else:  # fallback rule until the touch model is trained
                    touching = geometric
                st.streak = st.streak + 1 if touching else 0
                st.recent = (st.recent + [touching])[-max(1, cfg["touch_window"]):]
            # touch_frames of the last touch_window frames: one weak frame no longer resets the count
            hits = sum(st.recent) if cfg["touch_window"] else st.streak
            if hits >= cfg["touch_frames"]:
                st.stage = "ALERT"
                if self.models.touch is None:
                    how = "wrist in plant zone + leaf motion (no touch model yet)"
                elif p["touch_p"] >= cfg["touch_conf"]:
                    how = f"touch model p={p['touch_p']:.2f}"
                else:
                    how = f"hand on plant + leaf motion, touch model p={p['touch_p']:.2f}"
                self._alert(st, "ALERT", p, frame, zones, now, new_events, f"touching the plant ({how})")
            elif st.first_near and (now - st.first_near >= cfg["warn_seconds"] or p["hands"]):
                st.stage = "WARNING"
                self._alert(st, "WARNING", p, frame, zones, now, new_events,
                            "hand inside the plant buffer" if p["hands"] else "standing close to the plant")
            else:
                st.stage = "SAFE"
            p["stage"] = st.stage
            if cfg.get("after_hours") and not self._open(now):
                self._alert(st, "AFTER-HOURS", p, frame, zones, now, new_events, "person outside opening hours",
                            cooldown=60)
        if persons:
            info["stage"] = max((p["stage"] for p in persons), key=STAGES.index)
        self.people = {k: s for k, s in self.people.items() if now - s.seen < PERSON_STATE_SECONDS}

        # next frame's profile
        if any(p["hands"] for p in persons):
            self.profile, self.quiet_frames = "Confirm", 0
        elif near_any:
            self.profile, self.quiet_frames = "Track", 0
        elif run_models or not active:
            self.quiet_frames += 1
            if self.quiet_frames > 15:
                self.profile = "Watch"
        t4 = time.perf_counter()
        if run_models:  # stage times of the last frame that ran the models (others only draw)
            self.timing = {"det_ms": (t1 - t0) * 1000, "pose_ms": (t2 - t1) * 1000, "touch_ms": (t3 - t2) * 1000}
        info.update(self.timing, total_ms=(t4 - t0) * 1000, ran_models=run_models)
        self.events += new_events
        return self.draw(frame, zones, persons, animals, plants, info), info, new_events

    def _alert(self, st, tier, p, frame, zones, now, out, detail, cooldown=None):
        cd = self.cfg["cooldown_seconds"] if cooldown is None else cooldown
        if now - st.last_alert.get(tier, -1e9) < cd:
            return
        st.last_alert[tier] = now
        tid = int(p["id"])
        if tier not in SNAPSHOT_TIERS:
            out.append(Event(now, tier, tid, detail))
            return
        snap = str(self.snap_dir / f"{time.strftime('%Y%m%d_%H%M%S', time.localtime(now))}_{tier}_{tid}.jpg")
        img = frame.copy()
        for poly, buf, _ in zones:  # the zones the person was near, so the snapshot shows why it fired
            cv2.polylines(img, [poly.astype(np.int32)], True, (0, 220, 0), 2)
            cv2.polylines(img, [buf.astype(np.int32)], True, (0, 200, 255), 1, cv2.LINE_AA)
        x0, y0, x1, y1 = map(int, p["box"])
        cv2.rectangle(img, (x0, y0), (x1, y1), COLOURS.get(tier, (0, 0, 255)), 3)
        cv2.imwrite(snap, img)
        ev = Event(now, tier, tid, detail, snap)
        out.append(ev)
        self.sender.send(ev)  # to the rangers, if a server is configured

    def _open(self, now):
        a, b = self.cfg["open_hours"].split("-")
        hm = time.strftime("%H:%M", time.localtime(now))
        return a <= hm <= b

    @staticmethod
    def _cover(a, b):
        """Share of box a's area that lies inside box b."""
        ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
        iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
        return ix * iy / ((a[2] - a[0]) * (a[3] - a[1]) + 1e-9)

    @classmethod
    def _same(cls, a, b):
        """Same plant: overlapping boxes, or one mostly inside the other (partly hidden, or nested)."""
        return iou(a, b) > 0.3 or cls._cover(a, b) > 0.5 or cls._cover(b, a) > 0.5

    # ---- drawing ----------------------------------------------------------------------------
    @staticmethod
    def _label(img, text, x, y, col):
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 1)
        y = max(th + 6, y)
        cv2.rectangle(img, (x, y - th - 6), (x + tw + 6, y), col, -1)
        cv2.putText(img, text, (x + 3, y - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)

    @staticmethod
    def _dashed(img, poly, col, dash=12):
        pts = poly.astype(np.int32)
        for a, b in zip(pts, np.roll(pts, -1, 0)):
            n = max(1, int(np.hypot(*(b - a)) // dash))
            for i in range(0, n, 2):
                p0 = a + (b - a) * i / n
                p1 = a + (b - a) * min(i + 1, n) / n
                cv2.line(img, tuple(p0.astype(int)), tuple(p1.astype(int)), col, 2, cv2.LINE_AA)

    def draw(self, frame, zones, persons, animals, plants, info):
        img = frame.copy()
        fresh = [poly for poly, _, f in zones if f]
        if fresh:  # one shared tint, so overlapping zones never stack up
            over = img.copy()
            cv2.fillPoly(over, [p.astype(np.int32) for p in fresh], (0, 160, 0))
            img = cv2.addWeighted(over, 0.15, img, 0.85, 0)
        for poly, buf, f in zones:
            if f:
                cv2.polylines(img, [poly.astype(np.int32)], True, (0, 220, 0), 2)
            else:  # remembered (hidden by a person, or just left): dashed, no tint
                self._dashed(img, poly, (0, 220, 0))
                x0, y0 = poly.min(0).astype(int)
                self._label(img, "plant (remembered)", x0, y0, (0, 120, 0))
            cv2.polylines(img, [buf.astype(np.int32)], True, (0, 200, 255), 1, cv2.LINE_AA)
        if self.cfg.get("zone"):  # plant boxes are the zones otherwise, already drawn
            for pl in plants:
                x0, y0, x1, y1 = map(int, pl["box"])
                cv2.rectangle(img, (x0, y0), (x1, y1), (0, 200, 0), 1)
                self._label(img, f"plant {pl['conf']:.2f}", x0, y0, (0, 140, 0))
        for a in animals:
            x0, y0, x1, y1 = map(int, a["box"])
            cv2.rectangle(img, (x0, y0), (x1, y1), (200, 120, 40), 2)
            self._label(img, f"animal {a['conf']:.2f}", x0, y0, (200, 120, 40))
        for p in persons:
            col = COLOURS[p.get("stage", "SAFE")]
            x0, y0, x1, y1 = map(int, p["box"])
            cv2.rectangle(img, (x0, y0), (x1, y1), col, 3 if p.get("stage") == "ALERT" else 2)
            extra = f" touch {p['touch_p']:.2f}" if p.get("hands") and self.models.touch is not None else ""
            self._label(img, f"person #{p['id']} {p.get('stage', 'SAFE')}{extra}", x0, y0, col)
            for hd in p.get("hands", []):
                hx0, hy0, hx1, hy1 = map(int, hd["box"])
                cv2.rectangle(img, (hx0, hy0), (hx1, hy1), (255, 255, 0), 1)
                cv2.circle(img, tuple(map(int, hd["wrist"])), 5, (255, 0, 255), -1)
        stage = info["stage"]
        mem = f" (+{info['remembered']} remembered)" if info.get("remembered") else ""
        cv2.rectangle(img, (0, 0), (img.shape[1], 36), COLOURS[stage], -1)
        cv2.putText(img, f"{stage}   people {info['people']}  animals {info['animals']}  plants {info['plants']}{mem}"
                         f"   {info['profile']} {info.get('total_ms', 0):.0f} ms",
                    (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
        return img
