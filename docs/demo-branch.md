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
python scripts/test_pipeline.py                                # pipeline rules, no camera needed
python scripts/eval_touch_full.py --out reports/touch_full     # touch model accuracy, robustness
python scripts/eval_det_coco.py --out reports/det_coco         # detector vs stock models on COCO val2017
python scripts/eval_videos.py out/videos data/test_videos      # whole pipeline on the test clips
python scripts/eval_pose_variants.py out/pose data/test_videos # nano vs small pose model
```

`eval_det_coco.py` needs `pip install pycocotools` and downloads about 250 MB of COCO images
the first time (into `data/raw/`, not committed).

## Run the demo

Stop `npm run dev:test` and start the normal server, so the real rate limits apply:

```bash
npm run dev
```

Before presenting, sign in once with each demo account and press **Later** (or get a recovery
code), so the recovery banner is not the first thing the panel sees.
