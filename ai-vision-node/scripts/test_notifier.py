"""The camera -> FloraScan alert sender (app/notifier.py), against a stand-in server.

No models or camera needed:
    python scripts/test_notifier.py      -> PASS / FAIL per check
"""
import base64
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
from notifier import DEMO_CAMERA_KEY, AlertSender, settings  # noqa: E402
from pipeline import Event  # noqa: E402

# The checks below build their own settings; a FLORAGUARD_* variable in this shell must not leak in.
for _var in [v for v in os.environ if v.startswith("FLORAGUARD_")]:
    del os.environ[_var]

received = []
status_to_send = [201]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        received.append({"path": self.path, "headers": dict(self.headers), "body": json.loads(body)})
        code = status_to_send[0]
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"id": len(received)} if code == 201 else {"error": "no"}).encode())

    def log_message(self, *a):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_address[1]}"

fails = []


def ok(c, msg):
    print(("PASS " if c else "FAIL ") + msg)
    if not c:
        fails.append(msg)


def wait_for(n, timeout=10):
    end = time.time() + timeout
    while len(received) < n and time.time() < end:
        time.sleep(0.05)


tmp = Path(tempfile.mkdtemp())
snap = tmp / "alert.jpg"
rng = np.random.default_rng(0)
cv2.imwrite(str(snap), rng.integers(0, 255, (2160, 3840, 3), dtype=np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 95])  # a noisy 4K frame
ok(snap.stat().st_size > 900 * 1024, f"the test snapshot is bigger than the server accepts ({snap.stat().st_size // 1024} KB)")

# Where alerts go when nothing is configured: the FloraScan server of the checkout the node lives in.
# Each case uses a throwaway folder as that checkout, so the developer's own one never matters.
bare = Path(tempfile.mkdtemp())  # a checkout where the server has never run
local = Path(tempfile.mkdtemp())  # one where `npm run dev` saved its port
(local / "proto.config.json").write_text('{"port": 48123}')
blank = {"server_url": "", "camera_code": "CAM-001", "camera_key": ""}

off = AlertSender({"server_url": "", "camera_code": "CAM-001", "camera_key": "k"}, repo=bare, auto=True)
ok(not off.enabled, "no server_url and no FloraScan server here: sending is off")
ok(not off.send(Event(0, "ALERT", 1, "x", str(snap))), "...and send() does nothing")
ok(not AlertSender({**blank, "server_url": "off"}, repo=local, auto=True).enabled,
   'server_url "off": off, even beside a server')
ok(not AlertSender(blank, repo=local).enabled,
   "scripts and tests (no auto) never send to the local server unless told to")

auto = settings(blank, repo=local, auto=True)
ok(auto["server_url"] == "https://localhost:48123" and auto["source"] == "auto",
   f"the live app with no server_url: the local server, from proto.config.json ({auto['server_url']})")
ok(auto["camera_key"] == DEMO_CAMERA_KEY and auto["camera_code"] == "CAM-001",
   "...as CAM-001 with the key the seed gives it")
ok(AlertSender(blank, log=lambda *_: None, repo=local, auto=True).enabled, "...so sending is on with no set-up")
(local / ".env").write_text('PORT=48200\nFLORAGUARD_CAMERA_KEY="team-key"\n')
auto = settings(blank, repo=local, auto=True)
ok(auto["camera_key"] == "team-key", "FLORAGUARD_CAMERA_KEY in the server's .env is used, as the seed used it")
ok(auto["server_url"] == "https://localhost:48200", "PORT in .env wins over proto.config.json, as on the server")
ok(settings({**blank, "camera_key": "mine"}, repo=local, auto=True)["camera_key"] == "mine",
   "...but camera_key in the config wins")
ok(settings({**blank, "server_url": "https://floraguard.example"}, repo=local, auto=True)["camera_key"] == "",
   "a configured server never gets the local demo key")

cfg = {"server_url": url + "/", "camera_code": "CAM-001", "camera_key": "secret-key"}
logs = []
s = AlertSender(cfg, log=logs.append)
ok(s.enabled, "server, camera code and key set: sending is on")
ok(not s.send(Event(0, "WARNING", 1, "near the plant")), "a warning (no snapshot) is not sent")

ok(s.send(Event(1.0, "ALERT", 5, "touch 0.82 (pose+model)", str(snap))), "an ALERT with a snapshot is queued")
wait_for(1)
ok(len(received) == 1, "...and posted once")
r = received[0] if received else {"path": "", "headers": {}, "body": {}}
ok(r["path"] == "/api/camera/alerts", f"to /api/camera/alerts (got {r['path']})")
h = {k.lower(): v for k, v in r["headers"].items()}
ok(h.get("x-camera-code") == "CAM-001" and h.get("x-camera-key") == "secret-key", "signed with the camera code and key")
ok(r["body"].get("tier") == "ALERT" and r["body"].get("track_id") == 5, "with the tier and the person's track id")
ok(r["body"].get("detail") == "touch 0.82 (pose+model)", "with the detail")
raw = base64.b64decode(r["body"].get("photo", ""))
ok(raw[:3] == b"\xff\xd8\xff", "the photo is a JPEG")
ok(len(raw) <= 900 * 1024, f"...under the server's 900 KB limit ({len(raw) // 1024} KB)")
img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
ok(img is not None and max(img.shape[:2]) <= 1280, f"...scaled to at most 1280 px ({None if img is None else img.shape[1]}x{None if img is None else img.shape[0]})")

status_to_send[0] = 401
s.send(Event(2.0, "AFTER-HOURS", 6, "after hours", str(snap)))
wait_for(2)
time.sleep(0.3)
ok(len(received) == 2, "a refused key is not retried")
ok(s.failed == 1 and "401" in s.last_error, f"...and is recorded as a failure ({s.last_error})")

print(f"\n{'ALL PASS' if not fails else f'{len(fails)} FAILED'}")
server.shutdown()
sys.exit(1 if fails else 0)
