# The `demo` branch

`demo` is where finished work is tried together before it reaches `main`:

1. Merge your branch into `demo` (not into `main`).
2. Run every test below on `demo`, and run the demo itself.
3. When everything passes, open a pull request from `demo` to `main`.

The latest full run is in [`test-report/index.html`](../test-report/index.html).

## One-time setup

```bash
npm ci
cp .env.example .env          # then edit DATABASE_URL to your local MySQL
npm run db:setup
```

Add your own MQTT topic prefix to `.env`, so test readings and alerts do not land in a
teammate's database (everyone's server listens to the same EMQX broker):

```
MQTT_TOPIC_PREFIX=florascan-test-yourname
```

## Run the tests

Start the server with the test limits (the real rate limits refuse the hundreds of sign-ins
the suites make), and leave it running:

```bash
npm run dev:test
```

In a second terminal:

```bash
npm test               # reseeds the local database, then security, i18n, API, UI, passkeys
npm run test:iot       # MQTT end to end: a simulated ESP32 -> broker -> server -> MySQL -> dashboard
```

Wait a minute before running `npm test` a second time against the same server: the
administrator recovery-email check is limited to one code per minute per account.

AI vision node (Python 3.12, from `ai-vision-node/`, with its `.venv` active):

```bash
python scripts/test_notifier.py                                # camera -> rangers alert sender, no models needed
python scripts/test_pipeline.py                                # pipeline rules, no camera needed
python scripts/eval_touch_full.py --out reports/touch_full     # touch model accuracy, robustness
python scripts/eval_det_coco.py --out reports/det_coco         # detector vs stock models on COCO val2017
python scripts/eval_videos.py out/videos data/test_videos      # whole pipeline on the test clips
python scripts/eval_pose_variants.py out/pose data/test_videos # nano vs small pose model
```

`eval_det_coco.py` needs `pip install pycocotools` and downloads about 250 MB of COCO images
the first time (into `data/raw/`, not committed).

## CI (GitHub Actions)

`.github/workflows/ci.yml` runs on every push to `main`, `demo`, `fix/**` and `feature/**`,
and on every pull request into `main` or `demo`. All four jobs must pass ("All checks passed"
is the one status to require in branch protection):

| Job | What it checks |
|---|---|
| Static | every server/script/test file parses, translations, security headers and rate limits, production build, `npm audit` (fails on critical) |
| Web app end to end | MariaDB **10.4 with a 1 MB `max_allowed_packet`** (same as XAMPP) + an MQTT broker + the server, then the API, browser UI (every role), passkey and MQTT suites |
| AI vision node | the camera alert sender and the pipeline rules on CPU (OpenVINO); the exported models come from Git LFS and are cached |
| ESP32 firmware | `iot-kit/FloraScan_Node` compiles for the DOIT DevKit V1 (esp32 core 3.3.12, PubSubClient 2.8) |

Merging `demo` into `main` goes through a pull request, so CI runs on exactly what will land.

## AI camera alerts to the rangers

When the camera sees someone touching the plant (ALERT) or near it after hours (AFTER-HOURS),
it sends the snapshot to the web app. Every Ranger (anyone with `alert.resolve`) gets a
notification with the picture, and an email with it attached when SMTP is set up; the picture
is shown only to roles with `sensor.view` and the alert is resolved on the IoT page. Warnings
carry no picture and stay on the camera.

It is ready with no set-up. The seed has one camera, `CAM-001`, and the FloraGuard app finds
the server on the same computer by itself (the port in `proto.config.json`, or `PORT` in
`.env`), signs as `CAM-001` with the same key the seed used (`FLORAGUARD_CAMERA_KEY` in `.env`,
or the demo key `demo-camera-key-change-me`), and trusts the server's own certificate
(`.certs/ca.pem`). The app's header says where alerts go, and the Live panel shows how many
were sent. Start both together with:

```bash
npm run demo      # the server and FloraGuard; or npm run ai for FloraGuard alone
```

To send to another server, set `server_url`, `camera_code` and `camera_key` in
`ai-vision-node/app/config.json` (or the `FLORAGUARD_*` environment variables, see
`app/notifier.py`); `"server_url": "off"` stops sending. The evaluation scripts and tests never
send unless a `server_url` is set, so they cannot alert real rangers.

## Run the demo

Stop `npm run dev:test` and start the normal server, so the real rate limits apply:

```bash
npm run dev
```

Before presenting, sign in once with each demo account and press **Later** (or get a recovery
code), so the recovery banner is not the first thing the panel sees.
