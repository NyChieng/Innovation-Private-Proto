"""Send ALERT / AFTER-HOURS events, with their snapshot, to the FloraScan web app.

The server notifies everyone who can resolve alerts (the Ranger role) in the app
and by email with the picture attached; the picture is shown only to staff with
sensor.view. See POST /api/camera/alerts in Server/api.js and section 15 of
Server/schema-extensions.sql.

In the live app (floraguard_app.py) it is on by default: with nothing set, it
sends to the FloraScan server running from this same checkout, so a demo needs
no set-up. Scripts and tests send only to a server_url set explicitly, so they
never alert real rangers. Configured in app/config.json (the app's settings) or,
taking precedence, by environment variables:

    server_url   FLORAGUARD_SERVER_URL   empty = in the app, the local server, found
                                         from the port in ../proto.config.json (or
                                         PORT in ../.env); "off" = do not send
    camera_code  FLORAGUARD_CAMERA_CODE  default CAM-001
    camera_key   FLORAGUARD_CAMERA_KEY   the key set up for that camera; for the local
                                         server, also read from ../.env, else the demo
                                         key Server/seed.js gives CAM-001
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
REPO = ROOT.parent   # the FloraScan checkout this node lives in
MAX_SIDE = 1280      # long side of the picture sent; the server refuses more than 900 KB
JPEG_QUALITY = 80
RETRIES = 3
# The key Server/seed.js gives CAM-001 when FLORAGUARD_CAMERA_KEY is not set. Fine on
# a laptop demo; a real installation sets its own key in .env (see .env.example).
DEMO_CAMERA_KEY = "demo-camera-key-change-me"
OFF = {"off", "none", "false", "0", "no"}


def read_env_file(path):
    """KEY=value lines of the FloraScan server's .env, as the server itself reads them."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return {}
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k.strip()] = v
    return out


def local_server(repo=REPO):
    """https://localhost:<port> of the FloraScan server run from this checkout, or "".

    The port is PORT in .env when set (the server honours it), otherwise the one
    `npm run dev` picked and saved in proto.config.json.
    """
    port = read_env_file(Path(repo) / ".env").get("PORT")
    if not port:
        try:
            port = json.loads((Path(repo) / "proto.config.json").read_text(encoding="utf-8")).get("port")
        except (OSError, ValueError, AttributeError):
            port = None
    try:
        port = int(port)
    except (TypeError, ValueError):
        return ""
    return f"https://localhost:{port}" if 0 < port < 65536 else ""


def settings(cfg, repo=REPO, auto=False):
    """Where alerts go. source: "set" (configured), "auto" (the local server) or "off".

    auto: with no server_url, use the FloraScan server on this computer. The live app
    asks for it; scripts and tests do not, so they never alert real rangers by accident.
    """
    env = os.environ.get
    url = (env("FLORAGUARD_SERVER_URL") or cfg.get("server_url") or "").strip()
    if url.lower() in OFF:
        url, source = "", "off"
    elif url:
        source = "set"
    elif auto:
        url, source = local_server(repo), "auto"
    else:
        source = "off"
    key = env("FLORAGUARD_CAMERA_KEY") or cfg.get("camera_key") or ""
    if not key and source == "auto":
        # The local server was seeded from the same .env, so its key is the one there.
        key = read_env_file(Path(repo) / ".env").get("FLORAGUARD_CAMERA_KEY") or DEMO_CAMERA_KEY
    default_ca = Path(repo) / ".certs" / "ca.pem"  # made by the FloraScan server on first start
    return {
        "server_url": url.rstrip("/"),
        "camera_code": env("FLORAGUARD_CAMERA_CODE") or cfg.get("camera_code") or "CAM-001",
        "camera_key": key,
        "server_ca": env("FLORAGUARD_SERVER_CA") or cfg.get("server_ca") or (str(default_ca) if default_ca.exists() else ""),
        "source": source,
    }


def summary(cfg, repo=REPO, auto=True):
    """One line for the app's header: are alerts reaching the rangers, and where."""
    s = settings(cfg, repo, auto)
    if s["source"] == "off":
        return 'off (server_url is "off")'
    if not s["server_url"]:
        return "off: no FloraScan server found. Start it once with `npm run dev`, or set server_url"
    if not s["camera_key"]:
        return f"off: set camera_key for {s['server_url']}"
    how = "the FloraScan server on this computer" if s["source"] == "auto" else "the configured server"
    return f"on: {s['server_url']} as {s['camera_code']} ({how})"


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

    def __init__(self, cfg, log=print, repo=REPO, auto=False):
        s = settings(cfg, repo, auto)
        self.url = s["server_url"]
        self.code = s["camera_code"]
        self.key = s["camera_key"]
        self.source = s["source"]
        self.log = log
        self.enabled = bool(self.url and self.code and self.key)
        self.sent = 0
        self.failed = 0
        self.last_error = ""
        if not self.enabled:
            return
        ca = s["server_ca"]
        self.ctx = ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()
        self.q = queue.Queue(maxsize=50)
        threading.Thread(target=self._run, name="alert-sender", daemon=True).start()
        found = " (the FloraScan server on this computer)" if self.source == "auto" else ""
        self.log(f"[alerts] ALERT and AFTER-HOURS snapshots go to {self.url}{found} as {self.code}")

    def describe(self):
        """Status for the app's panel: where alerts go, and how sending has gone so far."""
        if not self.enabled:
            if self.source == "off":
                return "off"
            return "off: no FloraScan server found" if not self.url else "off: no camera key"
        text = f"on: {self.url} as {self.code} · sent {self.sent}"
        if self.failed:
            text += f", failed {self.failed}"
        if self.last_error:
            text += f" · last error: {self.last_error[:90]}"
        return text

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
