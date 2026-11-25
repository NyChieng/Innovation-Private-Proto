"""FloraGuard live detection UI (Gradio).

    .venv\\Scripts\\python app\\floraguard_app.py      -> http://127.0.0.1:7860

1. Plant zone tab (required): grab a frame, click 6-10 points around the plant, save.
   Live does not start without one (require_zone in app/config.json; false = protect detected plants).
   "Clear saved zone" removes it in one click, also from a running Live view.
2. Live tab: pick the webcam (or a video file), Start. People go SAFE -> WARNING (close to the plant)
   -> ALERT (touching it); animals are labelled only. Alerts appear on the right with snapshots.
3. Record touch / no_touch hand crops while you demo in front of your own camera, then rebuild and
   retrain the touch model: python scripts/make_touch_crops.py ; python scripts/train.py touch
"""
import sys
import threading
import time
from pathlib import Path

import cv2
import gradio as gr
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import available_backends, cuda_status  # noqa: E402
from notifier import summary as alerts_summary  # noqa: E402
from pipeline import FloraGuard, load_config, model_info, save_config  # noqa: E402
import theme  # noqa: E402

_guard = None
_stop = False
_record = "Off"
USER_DATA = Path(__file__).resolve().parents[1] / "data" / "touch_user"


def guard(backend="auto", threads=4):
    """The pipeline, rebuilt only when the backend or thread count changes (loading takes seconds)."""
    global _guard
    if _guard is None or (backend, threads) != (_guard.cfg["backend"], _guard.cfg["threads"]):
        cfg = load_config()
        cfg.update(backend=backend, threads=threads)
        _guard = FloraGuard(cfg, find_server=True)  # alerts reach the local server with no set-up
    return _guard


def open_source(kind, cam_index, video):
    if kind == "Video file":
        if not video:
            raise gr.Error("Upload a video file first.")
        return cv2.VideoCapture(video)
    cap = cv2.VideoCapture(int(cam_index), cv2.CAP_DSHOW)
    # most laptop webcams only reach 30 fps at 720p in MJPG; uncompressed YUY2 is often 5-10 fps
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    return cap


class Camera:
    """Reads a webcam on its own thread and keeps only the newest frame, so capture and inference overlap
    and a slow frame never builds up a backlog of stale ones."""

    def __init__(self, cap):
        self.cap, self.frame, self.n, self.taken, self.alive = cap, None, 0, 0, True
        self.cond = threading.Condition()
        self.t0 = time.perf_counter()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self):
        while self.alive:
            ok, f = self.cap.read()
            with self.cond:
                if not ok:
                    self.alive = False
                else:
                    self.frame, self.n = f, self.n + 1
                self.cond.notify_all()

    def read(self):
        with self.cond:
            self.cond.wait_for(lambda: self.n > self.taken or not self.alive, timeout=2)
            if self.n == self.taken:
                return False, None
            self.taken = self.n
            return True, self.frame

    def fps(self):
        return self.n / max(1e-3, time.perf_counter() - self.t0)

    def isOpened(self):
        return self.cap.isOpened()

    def release(self):
        self.alive = False
        self.thread.join(timeout=2)
        self.cap.release()


def rgb(img):
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


# ---- plant zone ---------------------------------------------------------------------------------
def grab_frame(kind, cam_index, video):
    cap = open_source(kind, cam_index, video)
    frame = None
    for _ in range(10):  # let auto-exposure settle
        ok, f = cap.read()
        if ok:
            frame = f
    cap.release()
    if frame is None:
        raise gr.Error("Could not read a frame from that source.")
    pts = [[x * frame.shape[1], y * frame.shape[0]] for x, y in load_config().get("zone", [])]
    return frame, pts, draw_zone(frame, pts)


def draw_zone(frame, pts):
    if frame is None:
        return None
    img = frame.copy()
    if len(pts) >= 3:
        over = img.copy()
        cv2.fillPoly(over, [np.array(pts, np.int32)], (0, 160, 0))
        img = cv2.addWeighted(over, 0.25, img, 0.75, 0)
    for i, p in enumerate(pts):
        cv2.circle(img, tuple(map(int, p)), 6, (0, 255, 255), -1)
        if i:
            cv2.line(img, tuple(map(int, pts[i - 1])), tuple(map(int, p)), (0, 255, 0), 2)
    if len(pts) >= 3:
        cv2.line(img, tuple(map(int, pts[-1])), tuple(map(int, pts[0])), (0, 255, 0), 2)
    return rgb(img)


def add_point(frame, pts, evt: gr.SelectData):
    pts = pts + [list(evt.index)]
    return pts, draw_zone(frame, pts)


def undo_point(frame, pts):
    pts = pts[:-1]
    return pts, draw_zone(frame, pts)


def clear_points(frame):
    """Clears the points being drawn; the saved zone stays until Save zone or Clear saved zone."""
    return [], draw_zone(frame, [])


def zone_status(cfg):
    n = len(cfg.get("zone") or [])
    if n >= 3:
        return f"**Saved zone:** {n} points. Live protects the plant inside it."
    if cfg["require_zone"]:
        return "**Saved zone:** none. Draw one and **Save zone** before Live."
    return "**Saved zone:** none. Live protects every plant the detector finds."


def write_zone(zone):
    cfg = load_config()
    cfg["zone"] = zone
    save_config(cfg)
    if _guard is not None:  # a running Live view reads the zone every frame
        _guard.cfg["zone"] = zone
    return cfg


def save_zone(frame, pts):
    if len(pts) < 3 or frame is None:
        raise gr.Error("Grab a frame and click at least 3 points around the plant. "
                       "To remove the saved zone, use Clear saved zone.")
    h, w = frame.shape[:2]
    cfg = write_zone([[round(x / w, 4), round(y / h, 4)] for x, y in pts])
    return f"Saved plant zone with {len(pts)} points.", zone_status(cfg)


def clear_saved_zone(frame):
    cfg = write_zone([])
    msg = "Saved zone removed. "
    msg += ("A running Live view now protects every detected plant; Start needs a new zone."
            if cfg["require_zone"] else "Live now protects every plant the detector finds.")
    return [], draw_zone(frame, []), msg, zone_status(cfg)


def backend_note():
    ready, text = cuda_status()
    have = ", ".join(available_backends()) or "none"
    if ready:
        return f"Backends here: auto, {have}. **cuda** runs on the {text}; **auto** picks it."
    return f"Backends here: auto, {have}. **cuda is not in the list:** {text}."


# ---- live ---------------------------------------------------------------------------------------
def event_rows(events):
    return [[time.strftime("%H:%M:%S", time.localtime(e.t)), e.tier, e.track_id, e.detail]
            for e in reversed(events[-200:])]


def run_name(entry):
    return Path(entry["weights"]).parent.parent.name if entry else None


def status_md(info, fps, g, saved, cam_fps=None, cpu=None):
    cam = f" · camera {cam_fps:.0f} fps" if cam_fps else ""
    spec = g.models.spec
    return (f"{theme.stage_html(info['stage'])}\n\n"
            f"| | |\n|---|---|\n"
            f"| Processed FPS / frame time | {fps:.1f} / {info.get('total_ms', 0):.0f} ms ({info['profile']}){cam} |\n"
            f"| Last model frame: detect / pose / touch | {info.get('det_ms', 0):.0f} / {info.get('pose_ms', 0):.0f} / "
            f"{info.get('touch_ms', 0):.0f} ms |\n"
            f"| Backend | {g.models.backend}, {g.models.threads} threads"
            f"{f' · process CPU {cpu:.0f}% of one core' if cpu is not None else ''} |\n"
            f"| People / animals / plants | {info['people']} / {info['animals']} / {info['plants']} |\n"
            f"| Protected plant zones | {info.get('zones', 0)} ({info.get('remembered', 0)} remembered) |\n"
            f"| Hands in buffer zone | {info['hands']} |\n"
            f"| Touch probability | {info['touch_p']:.2f} |\n"
            f"| Leaf motion | {info['leaf'] * 100:.2f}% (baseline {info.get('leaf_base', 0) * 100:.2f}%) |\n"
            f"| Detector | {run_name(spec['det'])} {spec['det']['imgsz'][0]}x{spec['det']['imgsz'][1]} |\n"
            f"| Touch model | {run_name(spec.get('touch')) or 'none yet (wrist + leaf motion rule)'} |\n"
            f"| Alerts to rangers | {g.sender.describe()} |\n"
            f"| Recorded crops this run | {saved} |")


def save_crops(crops, session, frame_i):
    if _record == "Off" or not crops:
        return 0
    d = USER_DATA / _record
    d.mkdir(parents=True, exist_ok=True)
    for k, c in enumerate(crops):
        cv2.imwrite(str(d / f"{session}_{frame_i:06d}_{k}.jpg"), c)
    return len(crops)


def run_live(kind, cam_index, video, conf_person, conf_animal, warn_s, touch_conf, touch_frames, after_hours,
             backend, threads, max_fps):
    global _stop
    _stop = False
    g = guard(backend, int(threads))
    g.cfg.update(load_config())
    if g.cfg["require_zone"] and len(g.cfg.get("zone") or []) < 3:
        raise gr.Error("Draw the plant zone first: Plant zone tab, click 3 or more points around the plant, Save zone.")
    g.cfg.update(conf_person=conf_person, conf_animal=conf_animal, warn_seconds=warn_s, touch_conf=touch_conf,
                 touch_frames=int(touch_frames), after_hours=after_hours, backend=backend, threads=int(threads),
                 max_fps=max_fps)
    g.reset()
    cap = open_source(kind, cam_index, video)
    if not cap.isOpened():
        raise gr.Error("Could not open the video source.")
    if kind == "Webcam":
        cap = Camera(cap)  # video files stay sequential so no frame is skipped
    snaps, t_last, fps = [], time.perf_counter(), 0.0
    banner, saved, session, frame_i = "", 0, time.strftime("%Y%m%d%H%M%S"), 0
    banner_tier = "WARNING"  # a WARNING banner never replaces an ALERT one
    # only the frame goes out every time: re-encoding the gallery and table each frame cost up to 270 ms
    t_status, sent_banner, events_dirty = 0.0, None, True
    cpu_t, cpu_wall, cpu = time.process_time(), time.perf_counter(), None
    t_slot = time.perf_counter()
    try:
        while not _stop:
            if kind == "Webcam" and max_fps:  # idle until the next slot; the camera thread keeps the newest frame
                time.sleep(max(0.0, t_slot - time.perf_counter()))
                t_slot = max(t_slot + 1 / max_fps, time.perf_counter())
            ok, frame = cap.read()
            if not ok:
                break
            out, info, new = g.step(frame)
            frame_i += 1
            if frame_i % 3 == 0:  # every 3rd frame: neighbouring frames are near-duplicates
                saved += save_crops(info["hand_crops"], session, frame_i)
            now = time.perf_counter()
            dt = max(1e-3, now - t_last)  # smooth the frame time, not 1/dt (that average overstates fps)
            fps = 1 / (0.9 / fps + 0.1 * dt) if fps else 1 / dt
            t_last = now
            events_dirty |= bool(new)
            for e in new:
                if e.snapshot:
                    snaps.insert(0, (e.snapshot, f"{e.tier} {time.strftime('%H:%M:%S', time.localtime(e.t))}"))
                stamp = time.strftime("%H:%M:%S", time.localtime(e.t))
                if e.tier in ("ALERT", "AFTER-HOURS") or (e.tier == "WARNING" and banner_tier == "WARNING"):
                    banner_tier = e.tier
                    banner = theme.banner_html(e.tier, f"{stamp} · person #{e.track_id} {e.detail}")
            status = gr.skip()
            if now - t_status > 0.25 or new:
                if now - cpu_wall > 2:  # this process's CPU use (models, drawing, encoding), in % of one core
                    cpu = (time.process_time() - cpu_t) / (now - cpu_wall) * 100
                    cpu_t, cpu_wall = time.process_time(), now
                cam_fps = cap.fps() if isinstance(cap, Camera) else None
                status, t_status = status_md(info, fps, g, saved, cam_fps, cpu), now
            log, gallery = (event_rows(g.events), snaps[:12]) if events_dirty else (gr.skip(), gr.skip())
            events_dirty = False
            ban = gr.skip() if banner == sent_banner else banner
            sent_banner = banner
            yield rgb(out), status, log, gallery, ban
    finally:
        cap.release()


def set_record(v):
    global _record
    _record = v
    n = {k: len(list((USER_DATA / k).glob("*.jpg"))) for k in ("touch", "no_touch")}
    return f"Recording: **{v}** · saved so far: touch {n['touch']}, no_touch {n['no_touch']}"


def stop_live():
    global _stop
    _stop = True


def clear_alerts():
    if _guard is not None:
        _guard.events.clear()
    return [], [], ""


# ---- layout -------------------------------------------------------------------------------------
def build():
    cfg = load_config()
    m = model_info()
    if not m:
        raise SystemExit("No exported models: run  python scripts/export_models.py")
    with gr.Blocks(title="FloraGuard") as demo:
        alerts = alerts_summary(cfg).replace("`", "")
        gr.HTML(theme.header_html(
            alerts, alerts.startswith("on"), cfg["require_zone"] and len(cfg.get("zone") or []) < 3,
            f"Detector {m['det']['weights']} · Pose {m['pose']['weights']} · "
            f"Touch {m['touch']['weights'] if m.get('touch') else 'none yet (wrist + leaf motion rule)'}"))
        with gr.Row():
            kind = gr.Radio(["Webcam", "Video file"], value="Webcam", label="Source")
            cam = gr.Number(value=0, precision=0, label="Webcam index")
            video = gr.Video(label="Video file", sources=["upload"], height=120)
        with gr.Tabs():
            with gr.Tab("Live"):
                banner = gr.Markdown()
                with gr.Row():
                    with gr.Column(scale=3):
                        # jpeg: the default webp took 180 ms to encode a 720p frame (~5 fps ceiling)
                        live = gr.Image(label="Live", type="numpy", interactive=False, format="jpeg")
                        with gr.Row():
                            start = gr.Button("Start", variant="primary")
                            stop = gr.Button("Stop", variant="stop")
                            clear = gr.Button("Clear alerts")
                    with gr.Column(scale=2):
                        status = gr.Markdown("Press **Start**.")
                        log = gr.Dataframe(headers=["Time", "Stage", "ID", "Detail"], label="Warnings and alerts",
                                           interactive=False, wrap=True, max_height=260)
                        gallery = gr.Gallery(label="Snapshots", columns=3, height=220)
                with gr.Accordion("Thresholds", open=False):
                    with gr.Row():
                        conf_p = gr.Slider(0.1, 0.9, cfg["conf_person"], step=0.05, label="Person confidence")
                        conf_a = gr.Slider(0.1, 0.9, cfg["conf_animal"], step=0.05, label="Animal confidence")
                        ws = gr.Slider(0, 5, cfg["warn_seconds"], step=0.5, label="Seconds near plant before WARNING")
                        tc = gr.Slider(0.3, 0.95, cfg["touch_conf"], step=0.05, label="Touch probability")
                        tf = gr.Slider(1, 15, cfg["touch_frames"], step=1, label="Touch frames before ALERT")
                        ah = gr.Checkbox(cfg["after_hours"], label=f"After-hours alert ({cfg['open_hours']})")
                with gr.Accordion("Performance (applies on Start)", open=False):
                    gr.Markdown("**openvino** runs on the CPU alone, as on a device without a GPU; **cuda** uses "
                                "the NVIDIA GPU. Fewer threads and a lower FPS cap leave more of a small device free.\n\n"
                                + backend_note())
                    with gr.Row():
                        be = gr.Dropdown(["auto"] + available_backends(), value=cfg["backend"], label="Backend")
                        th = gr.Slider(1, 8, cfg["threads"], step=1, label="CPU threads for the models")
                        mf = gr.Slider(2, 30, cfg["max_fps"], step=1, label="Max processed FPS")
                with gr.Accordion("Record touch-model training data", open=False):
                    gr.Markdown("While Live is running, pick **touch** and touch the plant in different ways, then "
                                "**no_touch** and reach near it without touching. Hands inside the buffer zone are "
                                "saved to `data/touch_user/`. Then run `scripts/make_touch_crops.py` and "
                                "`scripts/train.py touch`.")
                    rec = gr.Radio(["Off", "touch", "no_touch"], value="Off", label="Record hand crops as")
                    rec_msg = gr.Markdown()
            with gr.Tab("Plant zone"):
                gr.Markdown("Grab a frame, then click 6-10 points around the plant's outline and **Save zone**. "
                            "The orange buffer zone is drawn automatically around it. Live needs a saved zone. "
                            "**Clear points** starts the drawing again; **Clear saved zone** removes the saved one.")
                zone_saved = gr.Markdown(zone_status(cfg))
                frame_state = gr.State(None)
                pts_state = gr.State([])
                with gr.Row():
                    grab = gr.Button("Grab frame", variant="primary")
                    undo = gr.Button("Undo point")
                    clr = gr.Button("Clear points")
                    save = gr.Button("Save zone", variant="primary")
                    clr_saved = gr.Button("Clear saved zone", variant="stop")
                zone_img = gr.Image(label="Click to add points", type="numpy", interactive=False)
                zone_msg = gr.Markdown()

        rec.change(set_record, rec, rec_msg)
        live_ev = start.click(run_live, [kind, cam, video, conf_p, conf_a, ws, tc, tf, ah, be, th, mf],
                              [live, status, log, gallery, banner])
        stop.click(stop_live, None, None, cancels=[live_ev])
        clear.click(clear_alerts, None, [log, gallery, banner])
        grab.click(grab_frame, [kind, cam, video], [frame_state, pts_state, zone_img])
        zone_img.select(add_point, [frame_state, pts_state], [pts_state, zone_img])
        undo.click(undo_point, [frame_state, pts_state], [pts_state, zone_img])
        clr.click(clear_points, [frame_state], [pts_state, zone_img])
        save.click(save_zone, [frame_state, pts_state], [zone_msg, zone_saved])
        clr_saved.click(clear_saved_zone, [frame_state], [pts_state, zone_img, zone_msg, zone_saved])
    return demo


if __name__ == "__main__":
    print(f"[alerts] {alerts_summary(load_config())}")
    print(f"[backend] {backend_note().replace('**', '')}")
    build().queue().launch(server_name="127.0.0.1", inbrowser=True, **theme.LAUNCH)
