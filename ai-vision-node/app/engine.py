"""Inference backends for the FloraGuard models, so the pipeline runs on small CPU-only machines.

    openvino     any x86/ARM CPU (default without an NVIDIA GPU); needs only openvino + numpy + opencv
    onnxruntime  CPU fallback when OpenVINO is not installed
    cuda         NVIDIA GPU: PyTorch model replayed as a CUDA graph (needs torch + ultralytics)

The CPU backends run the ONNX files from scripts/export_models.py (models/export/, listed in
models.json). Outputs are the raw one-to-many head, as in validation (test mAP50 0.788): per anchor
cx, cy, w, h, class scores [, 17 x (x, y, conf) keypoints], then NMS here. YOLO26's NMS-free
end-to-end head was tried: OpenVINO cannot compile its pose variant, and its top-k cost more on CPU
than NMS does.

Measured on the dev laptop (Ryzen AI 7, 4 threads), detector at 640x384: PyTorch CPU 147 ms,
ONNX Runtime 104 ms, OpenVINO 37 ms. On the RTX 5060 the per-layer launch cost of eager PyTorch
(26 ms) dominates the GPU work, and a CUDA graph replays the whole network in 5 ms.
"""
import importlib.util
import json
import re
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
EXPORT = ROOT / "models" / "export"
GPU_SETUP = ("pip install torch torchvision --index-url https://download.pytorch.org/whl/cu130, "
             "then pip install -r requirements-train.txt")


def nvidia_gpu():
    """Name of the first NVIDIA GPU as the driver reports it, or None (no GPU or no driver).
    Asks nvidia-smi, so it works before PyTorch is installed."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "-L"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"GPU \d+: (.+?) \(UUID", out)
    return m.group(1).strip() if m else None


def cuda_status():
    """(ready, text). Ready: text is the GPU's name. Not ready: text says why, and how to fix it."""
    gpu = nvidia_gpu()
    try:
        import torch
    except ImportError:
        if not gpu:
            return False, "no NVIDIA GPU found, so the models run on the CPU"
        return False, f"{gpu} found, but PyTorch is not installed in this Python environment. To use it: {GPU_SETUP}"
    if not torch.cuda.is_available():
        if torch.version.cuda is None:
            return False, f"PyTorch {torch.__version__} is the CPU-only build. To use the GPU: {GPU_SETUP}"
        return False, (f"PyTorch {torch.__version__} (CUDA {torch.version.cuda}) cannot reach "
                       f"{gpu or 'an NVIDIA GPU'}: update the NVIDIA driver, or install a build for this GPU")
    if importlib.util.find_spec("ultralytics") is None:
        return False, "PyTorch sees the GPU, but ultralytics is not installed: pip install -r requirements-train.txt"
    return True, torch.cuda.get_device_name(0)


def available_backends():
    out = []
    try:
        import torch
        # the cuda backend loads the .pt weights through ultralytics (Net._init_cuda)
        if torch.cuda.is_available() and importlib.util.find_spec("ultralytics") is not None:
            out.append("cuda")
    except ImportError:
        pass
    for name, mod in (("openvino", "openvino"), ("onnxruntime", "onnxruntime")):
        try:
            __import__(mod)
            out.append(name)
        except ImportError:
            pass
    return out


def pick_backend(want="auto"):
    have = available_backends()
    if want != "auto":
        if want not in have:
            raise RuntimeError(f"backend {want!r} not available here (have {have})")
        return want
    for b in ("cuda", "openvino", "onnxruntime"):
        if b in have:
            return b
    raise RuntimeError("no inference backend: pip install openvino")


def letterbox(img, w, h):
    """Resize keeping the aspect ratio, pad to w x h with grey (as the models were trained).
    Returns the NCHW float32 RGB tensor and (scale, pad_x, pad_y) to map boxes back."""
    ih, iw = img.shape[:2]
    s = min(w / iw, h / ih)
    nw, nh = round(iw * s), round(ih * s)
    px, py = (w - nw) // 2, (h - nh) // 2
    out = np.full((h, w, 3), 114, np.uint8)
    out[py:py + nh, px:px + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    return to_tensor(out), (s, px, py)


def to_tensor(bgr):
    return np.ascontiguousarray(bgr[..., ::-1].transpose(2, 0, 1)[None], np.float32) / 255.0


class Net:
    """One network with a fixed input size. __call__(NCHW float32 array) -> first output as numpy."""

    def __init__(self, entry, backend, threads):
        self.backend, self.size, self.names = backend, entry["imgsz"], entry["names"]
        if backend == "openvino":
            import openvino as ov
            cfg = {"PERFORMANCE_HINT": "LATENCY", "INFERENCE_NUM_THREADS": int(threads)}
            self.req = ov.Core().compile_model(str(EXPORT / entry["onnx"]), "CPU", cfg).create_infer_request()
        elif backend == "onnxruntime":
            import onnxruntime as ort
            so = ort.SessionOptions()
            so.intra_op_num_threads, so.inter_op_num_threads = int(threads), 1
            self.sess = ort.InferenceSession(str(EXPORT / entry["onnx"]), so, providers=["CPUExecutionProvider"])
            self.inp = self.sess.get_inputs()[0].name
        else:
            self._init_cuda(entry)

    def _init_cuda(self, entry):
        import torch
        from ultralytics import YOLO
        m = YOLO(str(ROOT / entry["weights"])).model
        if hasattr(m.model[-1], "end2end"):
            m.model[-1].end2end = False  # same raw head as the ONNX export
        # torch's CPU thread pool spins after each use: with the default (all cores) the live app
        # kept 7 cores busy at 21 FPS. The GPU does the work, so one CPU thread is enough.
        torch.set_num_threads(1)
        self.torch = torch
        self.model = m.cuda().half().eval().fuse()
        self.graphs = {}  # input shape -> (graph, static input, static output)

    def _cuda(self, x):
        torch = self.torch
        with torch.inference_mode():
            if x.shape not in self.graphs:
                xs = torch.zeros(x.shape, device="cuda", dtype=torch.half)
                s = torch.cuda.Stream()
                s.wait_stream(torch.cuda.current_stream())
                with torch.cuda.stream(s):
                    for _ in range(3):  # warm-up outside the graph, as CUDA graph capture requires
                        self.model(xs)
                torch.cuda.current_stream().wait_stream(s)
                g = torch.cuda.CUDAGraph()
                with torch.cuda.graph(g):
                    y = self.model(xs)
                self.graphs[x.shape] = (g, xs, y[0] if isinstance(y, (list, tuple)) else y)
            g, xs, y = self.graphs[x.shape]
            xs.copy_(torch.from_numpy(x).cuda())  # float32 -> half on the GPU, not the CPU
            g.replay()
            return y.float().cpu().numpy()

    def __call__(self, x):
        if self.backend == "openvino":
            return self.req.infer({0: x})[0]
        if self.backend == "onnxruntime":
            return self.sess.run(None, {self.inp: x})[0]
        return self._cuda(x)


class Models:
    """The three FloraGuard networks on one backend."""

    def __init__(self, backend="auto", threads=4):
        spec = json.loads((EXPORT / "models.json").read_text())
        self.backend = pick_backend(backend)
        self.threads = threads
        self.spec = spec
        self.det = Net(spec["det"], self.backend, threads)
        self.pose = Net(spec["pose"], self.backend, threads)
        self.touch = Net(spec["touch"], self.backend, threads) if spec.get("touch") else None
        self.touch_idx = self.touch.names.index("touch") if self.touch else None

    def detect(self, frame, min_conf, iou=0.7):
        """[(xyxy box, score, class)] in frame pixels."""
        w, h = self.det.size
        x, (s, px, py) = letterbox(frame, w, h)
        p = self.det(x)[0].T  # anchors x (cx, cy, w, h, class scores...)
        cls = p[:, 4:].argmax(1)
        conf = p[np.arange(len(p)), 4 + cls]
        keep = conf >= min_conf
        p, cls, conf = p[keep], cls[keep], conf[keep]
        tl = p[:, :2] - p[:, 2:4] / 2
        i = cv2.dnn.NMSBoxesBatched(np.c_[tl, p[:, 2:4]].tolist(), conf.tolist(), cls.tolist(), min_conf, iou)
        i = np.asarray(i, int).reshape(-1)
        boxes = (np.c_[tl[i], tl[i] + p[i, 2:4]] - [px, py, px, py]) / s
        return [(b, float(c), int(k)) for b, c, k in zip(boxes, conf[i], cls[i])]

    def keypoints(self, frame, roi, min_conf=0.25, iou=0.7):
        """Pose on one region of the frame (people near the plant), so a small model sees them large.
        Returns [(xyxy box, (17, 2) keypoints, (17,) keypoint confidences)] in frame pixels."""
        x0, y0, x1, y1 = (int(round(v)) for v in roi)
        crop = frame[max(0, y0):y1, max(0, x0):x1]
        if crop.size == 0:
            return []
        ox, oy = max(0, x0), max(0, y0)
        w, h = self.pose.size
        x, (s, px, py) = letterbox(crop, w, h)
        p = self.pose(x)[0].T  # anchors x (cx, cy, w, h, person score, 17 x (x, y, conf))
        p = p[p[:, 4] >= min_conf]
        tl = p[:, :2] - p[:, 2:4] / 2
        i = np.asarray(cv2.dnn.NMSBoxes(np.c_[tl, p[:, 2:4]].tolist(), p[:, 4].tolist(), min_conf, iou), int).reshape(-1)
        res = []
        for row, t in zip(p[i], tl[i]):
            box = (np.r_[t, t + row[2:4]] - [px, py, px, py]) / s + [ox, oy, ox, oy]
            k = row[5:].reshape(17, 3)
            res.append((box, (k[:, :2] - [px, py]) / s + [ox, oy], k[:, 2]))
        return res

    def touch_probs(self, crops):
        """P(touch) for each 224 px BGR hand crop."""
        x = np.concatenate([to_tensor(c) for c in crops])
        return [float(p[self.touch_idx]) for p in self.touch(x)]
