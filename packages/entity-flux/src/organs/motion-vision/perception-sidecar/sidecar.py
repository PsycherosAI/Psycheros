#!/usr/bin/env python3
"""
perception sidecar — my share of the Psycheros perception stack.

A custom per-install hookup, not a bundled default: installs with a Coral
USB TPU (or a CPU willing to run the models) can run me to give
motion-vision its presence/identity layer. Stock installs don't — the
organ's `perceptionEnabled` defaults false and nothing misses me.

I am a small FastAPI service running classical perception models on the
Coral USB TPU (with a CPU fallback). The motion-vision Sensory Organ POSTs
frames to me; I answer with what I can see — how many people (bodies, the
stable presence layer) and which registered faces I recognize (identity). I
know nothing about envelopes, moods, or Flux; perception is my whole job.

Pipeline per frame:
  decode → person detector (bodies) → face detector → per-face crop →
  face embedder (512-d) → cosine against the registry

The registry is the filesystem: reference photos under
<dataRoot>/.psycheros/perception/faces/<person-id>/* — the daemon's data
root (same convention as organ-state and settings files; gitignored). With
no --data-root passed, I look next to this package
(packages/psycheros/.psycheros/perception/), matching how `deno task start`
resolves dataRoot. Enrollment is "drop photos in a directory, POST
/face/registry/reload". Per-image embeddings are kept (match = max over
images, not a centroid — more robust to pose). Nothing persists; a restart
rescans.

Usage:
  python3 sidecar.py [--port 18085]
      [--data-root <dir>]   (default: this package's directory)
      [--device edgetpu|cpu] [--selftest]
      [--faces-dir DIR] [--models-dir DIR]   (override the data-root join)

Requires Python 3.9 (Google's pycoral/tflite-runtime wheels stop at cp39).

First-person convention per the workspace's design value.
"""

import argparse
import base64
import io
import logging
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from PIL import Image
from pydantic import BaseModel
import uvicorn

log = logging.getLogger("perception")

# The embedder's resilience knobs. A wedged Coral (USB transfer error 5 —
# the process keeps running, every TPU call fails, the white LED pulses)
# must degrade loudly and self-heal, not 500 quietly for days:
#   - startup: if the EdgeTPU delegate won't load, serve degraded (bodies
#     only, no faces) and retry in the background with backoff;
#   - runtime: EMBED_FAIL_EXIT consecutive embed failures exit the process
#     so systemd restarts it (which re-enters the degraded path if the TPU
#     is still dead — and recovers the moment the device is replugged).
EMBED_RETRY_MIN_S = 10
EMBED_RETRY_MAX_S = 300
EMBED_FAIL_EXIT = 50
logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                    format="[perception] %(levelname)s %(message)s")

# =============================================================================
# Model loading — TPU with CPU fallback
# =============================================================================


def load_interpreter(path: Path, device: str):
    """Load a tflite interpreter on the EdgeTPU when told to, else CPU."""
    if device == "edgetpu":
        from pycoral.utils.edgetpu import make_interpreter
        return make_interpreter(str(path))
    import tflite_runtime.interpreter as tflite
    return tflite.Interpreter(model_path=str(path))


class EmbedderUnavailable(Exception):
    """The face embedder is down (TPU wedged / not yet loaded). Identity
    is degraded; bodies and face detection continue."""


class Models:
    """The three models I run, plus their I/O contracts.

    Placement (measured on this box, 2026-09-09): person detector and face
    embedder run on the EdgeTPU (28ms / 22ms); BlazeFace runs float32 on CPU
    (2ms) because the EdgeTPU build's quantized head produces garbage — see
    detect_faces. `--device cpu` puts everything on CPU for bring-up."""

    def __init__(self, models_dir: Path, device: str):
        self.device = device
        # Per-device model files: EdgeTPU-compiled builds carry the
        # edgetpu custom op and cannot run on CPU, so CPU mode needs its
        # own plain-quantized person detector. (The embedder's integer-quant
        # build runs on either; the file just has to not be the edgetpu one
        # when device=cpu.)
        # Person detection: YOLOv8n (ONNX, CPU) when present — measured
        # 2026-09-11 on this frame: finds the seated person 5/5 at 0.79-0.93
        # where the SSD locked onto a dresser (0/5 for the person), and 0
        # detections on the empty room even at a 0.30 threshold. 32ms on
        # CPU — body detection no longer needs the TPU at all.
        self.yolo = None
        yolo_path = models_dir / "yolov8n.onnx"
        if yolo_path.exists():
            import onnxruntime as _ort
            # Constrained threads: ORT's default pool spins one thread per
            # core continuously (>1 core of burn at 3fps — the fan issue,
            # 2026-09-11). Two intra-op threads run the model in ~40ms with
            # idle-blocking between calls.
            _opts = _ort.SessionOptions()
            _opts.intra_op_num_threads = 2
            _opts.inter_op_num_threads = 1
            _opts.execution_mode = _ort.ExecutionMode.ORT_SEQUENTIAL
            self._yolo_sess = _ort.InferenceSession(
                str(yolo_path), _opts, providers=["CPUExecutionProvider"])
            self._yolo_input = self._yolo_sess.get_inputs()[0]
            self._yolo_size = self._yolo_input.shape[2]
            self.yolo = True
            # YOLO runs every Nth /perceive call (body position is slow;
            # the tracker's grace bridges gaps). Cached boxes serve the rest.
            self._yolo_period = 3
            self._yolo_calls = 0
            self._yolo_cache: list = []
            log.info("person detector: YOLOv8n ONNX (CPU, every %dth frame)",
                     self._yolo_period)
        detector_name = ("person_detect_cpu.tflite" if device == "cpu"
                         else "person_detect.tflite")
        embedder_name = ("arcface_cpu.tflite" if device == "cpu"
                         and (models_dir / "arcface_cpu.tflite").exists()
                         else "arcface.tflite")
        self.detector = load_interpreter(models_dir / detector_name, device)
        self.detector.allocate_tensors()
        # BlazeFace is float32 — always the CPU interpreter, whichever device
        # the rest of the stack targets.
        import tflite_runtime.interpreter as tflite
        self.face = tflite.Interpreter(
            model_path=str(models_dir / "blazeface.tflite"))
        self.face.allocate_tensors()
        # The face embedder is the only TPU-dependent model, and the TPU
        # can wedge (USB error 5: device dead until replug, delegate load
        # fails). Bodies (YOLO/CPU) and faces (BlazeFace/CPU) don't need
        # it — so a dead TPU degrades IDENTITY ONLY, never presence.
        self._embedder_path = models_dir / embedder_name
        self._embedder_device = device
        self.embedder = None  # loaded below / by the retry thread
        self._embedder_failures = 0
        self._load_embedder()  # synchronous first attempt
        if self.embedder is None and device == "edgetpu":
            log.warning(
                "face embedder UNAVAILABLE (EdgeTPU delegate failed — device "
                "wedged?) — serving DEGRADED: bodies + face detection, no "
                "identity. Retrying in the background; replug the TPU to "
                "recover.")
            threading.Thread(target=self._embedder_retry_loop,
                             daemon=True, name="edgetpu-retry").start()
        self._detector_detail = self._common_detail(self.detector)
        self._face_detail = self._common_detail(self.face)
        self._embedder_detail = (
            self._common_detail(self.embedder) if self.embedder else None
        )

    def _load_embedder(self) -> None:
        """Try to (re)load the embedder. Never raises — failure leaves
        self.embedder None and the service degraded."""
        try:
            interp = load_interpreter(self._embedder_path,
                                      self._embedder_device)
            interp.allocate_tensors()
            detail = interp.get_input_details()[0]
            # Swap under a lock-free single assignment; embed() reads
            # self.embedder once per call, so a swap mid-flight is safe
            # (the old interpreter may be dead — that call fails once and
            # the next uses the new one).
            self.embedder = interp
            self._embedder_detail = detail
            self._embedder_failures = 0
        except Exception as exc:  # noqa: BLE001 — degradation, not crash
            log.warning("embedder load failed: %s", exc)

    def _embedder_retry_loop(self) -> None:
        """Background: retry the wedged TPU with backoff until it loads
        (i.e. until the device is replugged)."""
        wait = EMBED_RETRY_MIN_S
        while self.embedder is None:
            time.sleep(wait)
            self._load_embedder()
            if self.embedder is not None:
                log.warning(
                    "face embedder RECOVERED — identity back online "
                    "after TPU retry")
                return
            wait = min(wait * 2, EMBED_RETRY_MAX_S)

    def _note_embed_failure(self) -> None:
        """Watchdog: a LOADED embedder failing repeatedly is a wedged
        device — exit so systemd restarts (and the restart enters the
        degraded path, loud in `systemctl status`, instead of a silent
        500-fountain)."""
        self._embedder_failures += 1
        if self._embedder_failures >= EMBED_FAIL_EXIT:
            log.critical(
                "embedder failed %d consecutive times — TPU presumed "
                "wedged; exiting for systemd restart. REPLUG the device.",
                self._embedder_failures)
            os._exit(1)

    @staticmethod
    def _common_detail(interp):
        # pycoral's common.input_details requires a key; the plain
        # interpreter's get_input_details() gives the same first-tensor info.
        return interp.get_input_details()[0]

    # -- person detection ----------------------------------------------------

    def detect_people(self, img: Image.Image) -> list:
        """Person boxes [x1, y1, x2, y2] in source pixels. YOLOv8n when
        available (accurate, CPU, ghost-free); the legacy SSD otherwise."""
        if self.yolo:
            return self._detect_people_yolo(img)
        return self._detect_people_ssd(img)

    def _detect_people_yolo(self, img: Image.Image, conf=0.4) -> list:
        import numpy as np

        self._yolo_calls += 1
        if (self._yolo_calls - 1) % self._yolo_period != 0:
            return self._yolo_cache  # cached boxes between runs

        size = self._yolo_size
        W, H = img.size
        scale = min(size / W, size / H)
        nw, nh = int(W * scale), int(H * scale)
        canvas = Image.new("RGB", (size, size), (114, 114, 114))
        canvas.paste(
            img.resize((nw, nh), Image.BILINEAR),
            ((size - nw) // 2, (size - nh) // 2),
        )
        arr = (np.asarray(canvas, dtype=np.float32) / 255.0)
        arr = arr.transpose(2, 0, 1)[None]
        out = self._yolo_sess.run(None, {self._yolo_input.name: arr})[0]
        pred = out[0].T  # (8400, 84): box + 80 class scores

        ox, oy = (size - nw) / 2, (size - nh) / 2
        candidates = []
        for row in pred:
            score = float(row[4])  # COCO class 0 = person
            if score < conf:
                continue
            cx, cy, w, h = row[:4]
            x1 = (cx - w / 2 - ox) / scale
            y1 = (cy - h / 2 - oy) / scale
            candidates.append((score, x1, y1, x1 + w / scale, y1 + h / scale))

        # Greedy NMS.
        candidates.sort(reverse=True, key=lambda c: c[0])
        kept = []
        for c in candidates:
            ok = True
            for k in kept:
                ix1 = max(c[1], k[1]); iy1 = max(c[2], k[2])
                ix2 = min(c[3], k[3]); iy2 = min(c[4], k[4])
                inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
                ua = (c[3] - c[1]) * (c[4] - c[2]) + \
                    (k[3] - k[1]) * (k[4] - k[2]) - inter
                if ua > 0 and inter / ua > 0.45:
                    ok = False
                    break
            if ok:
                kept.append(c)
        self._yolo_cache = [(c[1], c[2], c[3], c[4]) for c in kept]
        return self._yolo_cache

    def _detect_people_ssd(self, img: Image.Image) -> list:
        """The legacy SSD path — pycoral's detect adapter convention. Kept
        as the fallback when the YOLO model file is absent (it locks onto
        the dresser in this room; see NOTES for the A/B)."""
        from pycoral.adapters import common, detect

        size = common.input_size(self.detector)
        _, scale = common.set_resized_input(
            self.detector, size, lambda s: img.resize(s, Image.NEAREST))
        self.detector.invoke()
        return [
            (b.bbox.xmin, b.bbox.ymin, b.bbox.xmax, b.bbox.ymax)
            for b in detect.get_objects(self.detector, 0.5, scale)
            if b.id == 0
        ]

    # -- face detection --------------------------------------------------------

    def detect_faces(self, img: Image.Image, score_threshold: float = 0.5) -> list:
        """Run BlazeFace; return pixel boxes.

        Uses the float32 CPU build (2ms — trivially cheap): the EdgeTPU
        build's quantized head produces garbage (verified empirically). The
        float32 model exports the canonical MediaPipe head: `regressors`
        (896×16) and `classificators` (896×1 logits). Decode per the
        reference MediaPipe port: regressor values are scaled by 128
        (x/y/w/h_scale), anchors are normalized coords from the canonical
        anchor file shipped with this sidecar, box center = anchor +
        (regressor_xy / 128), size = regressor_wh / 128 in image fraction.
        """
        d = self._face_detail
        size = (d["shape"][2], d["shape"][1])
        arr = np.asarray(img.resize(size, Image.BILINEAR), dtype=np.float32)
        arr = (arr / 255.0 - 0.5) / 0.5  # [-1, 1] — MediaPipe convention
        self.face.set_tensor(d["index"], arr[None])
        self.face.invoke()

        details = self.face.get_output_details()
        by_name = {det["name"]: self.face.get_tensor(det["index"])
                   for det in details}
        regressors = by_name.get("regressors", list(by_name.values())[0])[0]
        logits = by_name.get("classificators", list(by_name.values())[1])[0]
        logits = np.clip(logits.flatten(), -100.0, 100.0)  # MediaPipe clips
        scores = 1.0 / (1.0 + np.exp(-logits))

        anchors = _face_anchors()  # (896, 4) normalized [cx, cy, w, h]

        boxes = []
        for idx in np.where(scores > score_threshold)[0]:
            if idx >= len(anchors):
                break
            cx = (anchors[idx, 0] + regressors[idx, 0] / 128.0) * img.width
            cy = (anchors[idx, 1] + regressors[idx, 1] / 128.0) * img.height
            w = regressors[idx, 2] / 128.0 * img.width
            h = regressors[idx, 3] / 128.0 * img.height
            x1 = max(0.0, cx - w / 2)
            y1 = max(0.0, cy - h / 2)
            boxes.append((x1, y1, min(img.width, cx + w / 2), min(img.height, cy + h / 2)))

        # Greedy NMS — overlapping anchors fire together on one face.
        boxes.sort(key=lambda b: -(b[2] - b[0]) * (b[3] - b[1]))
        kept = []
        for b in boxes:
            if all(_iou(b, k) < 0.3 for k in kept):
                kept.append(b)
        return kept

    # -- face embedding --------------------------------------------------------

    EMBED_SIZE = 112

    def embed(self, img: Image.Image, box) -> np.ndarray:
        """Crop a face box, resize to 112×112, embed to a unit vector.

        The uint8 embedder's DECLARED output quantization is wrong (PINTO's
        conversion left params that collapse the discriminative range —
        everything dequantizes into a ~0.3% band and all faces match at
        cosine 1.0). The raw uint8 output IS discriminative, so I use raw
        values, mean-centered to kill the constant offset, then normalized."""
        if self.embedder is None:
            raise EmbedderUnavailable()
        x1, y1, x2, y2 = [max(0, v) for v in box]
        crop = img.crop((int(x1), int(y1), int(x2), int(y2))).resize(
            (self.EMBED_SIZE, self.EMBED_SIZE), Image.BILINEAR)
        arr = np.asarray(crop)
        try:
            if self._embedder_detail["dtype"] == np.uint8:
                self.embedder.set_tensor(
                    self._embedder_detail["index"], arr[None])
                self.embedder.invoke()
                out = np.array(self.embedder.get_tensor(
                    self.embedder.get_output_details()[0]["index"]),
                    copy=True)[0]
                out = out.flatten().astype(np.float32)
                out = out - out.mean()
            else:
                f = np.asarray(crop, dtype=np.float32) / 255.0
                f = (f - 0.5) / 0.5  # [-1, 1] — ArcFace convention
                self.embedder.set_tensor(self._embedder_detail["index"], f[None])
                self.embedder.invoke()
                out = np.array(self.embedder.get_tensor(
                    self.embedder.get_output_details()[0]["index"]),
                    copy=True)[0].flatten()
        except RuntimeError as exc:
            # A loaded-but-failing embedder is the wedged-TPU signature
            # (the misleading 'internal data reference' error). Account it;
            # sustained failure exits for a systemd restart.
            self._note_embed_failure()
            raise EmbedderUnavailable() from exc
        self._embedder_failures = 0
        return out / (np.linalg.norm(out) + 1e-9)


# The canonical MediaPipe 896-anchor grid for the 128×128 front model
# (normalized coords). Shipped as a data file to avoid hand-deriving the
# layout — sourced from the reference MediaPipe PyTorch port.
_ANCHORS = None


def _face_anchors() -> np.ndarray:
    global _ANCHORS
    if _ANCHORS is None:
        _ANCHORS = np.load(
            Path(__file__).parent / "anchors_face.npy").astype(np.float32)
    return _ANCHORS


def _iou(a, b) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


# =============================================================================
# Registry — the filesystem is the enrollment
# =============================================================================


class Registry:
    """Reference embeddings per person, rebuilt from photos on demand."""

    def __init__(self, faces_dir: Path, models: Models,
                 threshold: float = 0.45):
        self.faces_dir = faces_dir
        self.models = models
        self.threshold = threshold
        self.embeddings: dict[str, list[np.ndarray]] = {}
        self.reload()

    def reload(self):
        """Rescan faces/<id>/*.jpg — photos on disk ARE the registry."""
        self.embeddings = {}
        if not self.faces_dir.exists():
            log.warning("faces dir %s missing — registry empty", self.faces_dir)
            return
        for person_dir in sorted(self.faces_dir.iterdir()):
            if not person_dir.is_dir():
                continue
            refs = []
            for photo in sorted(person_dir.glob("*.jp*g")):
                try:
                    img = Image.open(photo).convert("RGB")
                    boxes = self.models.detect_faces(img)
                    if not boxes:
                        log.warning("%s: no face found, skipped", photo.name)
                        continue
                    # Largest box wins — group photos enroll the subject.
                    box = max(boxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
                    refs.append(self.models.embed(img, box))
                except Exception as exc:  # noqa: BLE001 — one bad photo must not kill the scan
                    log.warning("%s: %s", photo.name, exc)
            if refs:
                self.embeddings[person_dir.name] = refs
                log.info("enrolled %s (%d photos)", person_dir.name, len(refs))
            else:
                log.warning("no usable photos for %s", person_dir.name)

    def match(self, embedding: np.ndarray):
        """Best (id, confidence) over all reference photos, or None."""
        best_id, best_sim = None, self.threshold
        for person, refs in self.embeddings.items():
            for ref in refs:
                sim = float(np.dot(ref, embedding))
                if sim > best_sim:
                    best_id, best_sim = person, sim
        if best_id is None:
            return None
        # Map cosine → [0.5, 1.0] confidence: threshold reads as 0.5, a
        # perfect match as 1.0. Calibrate after enrollment — see README.
        conf = 0.5 + (best_sim - self.threshold) / max(1e-9, 1.0 - self.threshold) * 0.5
        return {"id": best_id, "confidence": round(min(conf, 1.0), 3)}


# =============================================================================
# App
# =============================================================================

app = FastAPI(title="perception sidecar")
# Quoted annotations — module-level `X | None` syntax is 3.10+; the sidecar
# runs on 3.9 (Google's pycoral wheels stop at cp39).
models: "Models | None" = None
registry: "Registry | None" = None


class PerceiveRequest(BaseModel):
    image_b64: str


@app.get("/health")
def health():
    """Liveness + what I can do. An empty registry is healthy-but-useless —
    a distinct, reportable state, not an error. `identity` distinguishes
    "ok" from "degraded" (TPU wedged: bodies + face boxes, no names —
    watch this field when the white LED pulses)."""
    return JSONResponse({
        "status": "ok",
        "device": models.device if models else "unloaded",
        "identity": "ok" if (models and models.embedder is not None) else "degraded",
        "registry": [
            {"id": p, "images": len(v)} for p, v in registry.embeddings.items()
        ] if registry else [],
    })


@app.post("/face/registry/reload")
def reload_registry():
    """Rescan faces/ — the enrollment endpoint (photos first, then this)."""
    registry.reload()
    return {"ok": True, "people": list(registry.embeddings.keys())}


@app.get("/face/registry")
def list_registry():
    return {"people": [
        {"id": p, "images": len(v)} for p, v in registry.embeddings.items()
    ]}


@app.post("/perceive")
def perceive(req: PerceiveRequest):
    """One frame in, bodies + matched faces out. The organ's whole call."""
    t0 = time.monotonic()
    try:
        img = Image.open(io.BytesIO(base64.b64decode(req.image_b64)))
        img = img.convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"bad image: {exc}") from exc

    people_boxes = models.detect_people(img)
    faces = []
    for box in models.detect_faces(img):
        try:
            match = registry.match(models.embed(img, box))
        except EmbedderUnavailable:
            # Degraded: face detected, identity down. `faces` stays empty
            # (the organ reads that as "person present, identity unknown"
            # — honest, and body-gated presence never depended on it).
            break
        if match:
            faces.append({
                "id": match["id"],
                "confidence": match["confidence"],
                "box": [round(v, 1) for v in box],
            })

    return {
        "people": {"count": len(people_boxes), "boxes": [
            [round(v, 1) for v in b] for b in people_boxes
        ]},
        "faces": faces,
        "latency_ms": round((time.monotonic() - t0) * 1000, 1),
    }


# =============================================================================
# Entry
# =============================================================================


def selftest(models_dir: Path, device: str, faces_dir: Path) -> int:
    """Load both pipelines and push a synthetic frame through — my whole
    automated test story. Exits 0 when everything answers."""
    global models, registry
    try:
        models = Models(models_dir, device)
        registry = Registry(faces_dir, models)
    except Exception as exc:  # noqa: BLE001
        log.error("selftest load failed: %s", exc)
        return 1
    synthetic = Image.fromarray(
        (np.random.rand(480, 640, 3) * 255).astype(np.uint8))
    boxes = models.detect_people(synthetic)
    _ = models.detect_faces(synthetic)
    identity = "ok" if models.embedder is not None else "DEGRADED (no embedder)"
    log.info(
        "selftest ok — device=%s, identity=%s, registry=%d people, "
        "synthetic frame: %d bodies",
        device, identity, len(registry.embeddings), len(boxes))
    return 0


def main():
    # Default data root: the psycheros package directory (this file's
    # parent's parent), matching how the daemon resolves dataRoot when run
    # via `deno task start` (projectRoot).
    default_data_root = Path(__file__).resolve().parent.parent
    default_perception = default_data_root / ".psycheros" / "perception"

    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--port", type=int, default=18085)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--data-root", type=Path, default=default_data_root,
                        help="the daemon's data root; perception data lives "
                             "at <data-root>/.psycheros/perception/")
    # Faces/models default to None and are derived from --data-root AFTER
    # parsing — argparse evaluates defaults at module load, so a
    # file-relative default here ignores an explicit --data-root (the
    # stale-path crash after the perception-sidecar relocation, 2026-10-15).
    parser.add_argument("--faces-dir", type=Path, default=None)
    parser.add_argument("--models-dir", type=Path, default=None)
    # CPU is a first-class mode, not a fallback — most installs have no
    # Coral, and the stack stays real-time there too (person detect ~40ms,
    # blazeface 2ms, embedder ~300ms only when a face is visible).
    parser.add_argument("--device", choices=["edgetpu", "cpu"], default="cpu")
    parser.add_argument("--threshold", type=float, default=0.75,
                        help="cosine similarity threshold for a face match")
    parser.add_argument("--selftest", action="store_true",
                        help="load models, run one synthetic frame, exit")
    args = parser.parse_args()
    perception_dir = args.data_root / ".psycheros" / "perception"
    if args.faces_dir is None:
        args.faces_dir = perception_dir / "faces"
    if args.models_dir is None:
        args.models_dir = perception_dir / "models"

    if args.selftest:
        sys.exit(selftest(args.models_dir, args.device, args.faces_dir))

    global models, registry
    models = Models(args.models_dir, args.device)
    registry = Registry(args.faces_dir, models, threshold=args.threshold)
    log.info(
        "listening on %s:%d (device=%s, %d people enrolled)",
        args.host, args.port, args.device, len(registry.embeddings))
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
