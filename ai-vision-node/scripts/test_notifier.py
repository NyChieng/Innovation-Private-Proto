"""The camera -> FloraScan alert sender (app/notifier.py), against a stand-in server.

No models or camera needed:
    python scripts/test_notifier.py      -> PASS / FAIL per check
"""
import base64
import json
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
from notifier import AlertSender  # noqa: E402
from pipeline import Event  # noqa: E402

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

off = AlertSender({"server_url": "", "camera_code": "CAM-001", "camera_key": "k"})
ok(not off.enabled, "no server_url: sending is off")
ok(not off.send(Event(0, "ALERT", 1, "x", str(snap))), "...and send() does nothing")

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
