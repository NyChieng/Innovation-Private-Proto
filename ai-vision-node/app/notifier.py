"""Send ALERT / AFTER-HOURS events, with their snapshot, to the FloraScan web app.

The server notifies everyone who can resolve alerts (the Ranger role) in the app
and by email with the picture attached; the picture is shown only to staff with
sensor.view. See POST /api/camera/alerts in Server/api.js and section 15 of
Server/schema-extensions.sql.

Configured in app/config.json (the app's settings) or, taking precedence, by
environment variables:

    server_url   FLORAGUARD_SERVER_URL   e.g. https://localhost:42791   (empty = off)
    camera_code  FLORAGUARD_CAMERA_CODE  e.g. CAM-001
    camera_key   FLORAGUARD_CAMERA_KEY   the key set up for that camera
    server_ca    FLORAGUARD_SERVER_CA    CA certificate to trust; defaults to the
                                         FloraScan server's own (../.certs/ca.pem)

Sending happens on a background thread, so a slow or unreachable server never
holds up the camera. A failed send is retried a few times, then logged.
"""
import base64
import json
import os
import queue
import ssl
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CA = ROOT.parent / ".certs" / "ca.pem"  # made by the FloraScan server on first start
MAX_SIDE = 1280      # long side of the picture sent; the server refuses more than 900 KB
JPEG_QUALITY = 80
RETRIES = 3


def settings(cfg):
    env = os.environ.get
    return {
        "server_url": (env("FLORAGUARD_SERVER_URL") or cfg.get("server_url") or "").rstrip("/"),
        "camera_code": env("FLORAGUARD_CAMERA_CODE") or cfg.get("camera_code") or "",
        "camera_key": env("FLORAGUARD_CAMERA_KEY") or cfg.get("camera_key") or "",
        "server_ca": env("FLORAGUARD_SERVER_CA") or cfg.get("server_ca") or "",
    }


def encode_snapshot(path):
    """The snapshot as base64 JPEG, scaled down so it stays well under the server's limit."""
    img = cv2.imread(str(path))
    if img is None:
        raise ValueError(f"cannot read snapshot {path}")
    h, w = img.shape[:2]
    scale = min(1.0, MAX_SIDE / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    for quality in (JPEG_QUALITY, 65, 50):
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if ok and len(buf) <= 850 * 1024:
            return base64.b64encode(buf.tobytes()).decode("ascii")
    raise ValueError("snapshot too large even at low quality")


class AlertSender:
    """Queue of events to post. send() returns at once; a worker thread does the HTTP."""

    def __init__(self, cfg, log=print):
        s = settings(cfg)
        self.url = s["server_url"]
        self.code = s["camera_code"]
        self.key = s["camera_key"]
        self.log = log
        self.enabled = bool(self.url and self.code and self.key)
        self.sent = 0
        self.failed = 0
        self.last_error = ""
        if not self.enabled:
            return
        ca = s["server_ca"] or (str(DEFAULT_CA) if DEFAULT_CA.exists() else "")
        self.ctx = ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()
        self.q = queue.Queue(maxsize=50)
        threading.Thread(target=self._run, name="alert-sender", daemon=True).start()

    def send(self, event):
        """Queue an event that has a snapshot. Events without one (warnings) stay on the camera."""
        if not self.enabled or not event.snapshot:
            return False
        try:
            self.q.put_nowait(event)
            return True
        except queue.Full:
            self.failed += 1
            self.last_error = "queue full - the server is not keeping up"
            self.log(f"[alerts] dropped {event.tier}: {self.last_error}")
            return False

    def _run(self):
        while True:
            event = self.q.get()
            try:
                self._post(event)
            finally:
                self.q.task_done()

    def _post(self, event):
        try:
            body = json.dumps({
                "tier": event.tier,
                "track_id": int(event.track_id),
                "detail": event.detail,
                "photo": encode_snapshot(event.snapshot),
            }).encode()
        except Exception as e:  # unreadable snapshot: nothing to retry
            self.failed += 1
            self.last_error = str(e)
            self.log(f"[alerts] {event.tier} not sent: {e}")
            return
        req = urllib.request.Request(
            self.url + "/api/camera/alerts", data=body, method="POST",
            headers={"Content-Type": "application/json", "X-Camera-Code": self.code, "X-Camera-Key": self.key},
        )
        for attempt in range(1, RETRIES + 1):
            try:
                with urllib.request.urlopen(req, timeout=10, context=self.ctx) as res:
                    alert_id = json.loads(res.read() or b"{}").get("id")
                self.sent += 1
                self.last_error = ""
                self.log(f"[alerts] {event.tier} sent to the rangers (alert {alert_id})")
                return
            except urllib.error.HTTPError as e:
                msg = e.read().decode(errors="replace")[:200]
                self.last_error = f"HTTP {e.code}: {msg}"
                if 400 <= e.code < 500 and e.code != 429:
                    break  # wrong key, bad picture: retrying will not help
            except Exception as e:  # network down, TLS, timeout
                self.last_error = str(e)
            time.sleep(2 * attempt)
        self.failed += 1
        self.log(f"[alerts] {event.tier} not sent: {self.last_error}")
