# perception sidecar

> **Optional face & body recognition — a per-install hookup, not a default.**
> Motion-vision works fully without this sidecar (motion + captions only;
> `perceptionEnabled` defaults false, and the organ never spawns or requires
> this process). Installs that want presence and identity events run it — **no
> special hardware required**: body detection (YOLOv8n, ONNX) and face detection
> (BlazeFace) are CPU-native, and the full stack including face _recognition_
> runs on any reasonably modern computer via `--device cpu` with the
> integer-quantized embedding model. A Coral USB TPU, when present, only
> accelerates the face embedder. The Deno-side seam
> (`entity-flux/src/organs/motion-vision/perception-client.ts`) is the only
> contract; any service speaking `/perceive` can stand behind it.

Classical perception for the Psycheros sensory stack: person detection (the
stable presence layer) and face identity, running as one small FastAPI service.
The motion-vision Sensory Organ calls it once per captured frame; Flux itself
never knows it exists beyond that HTTP seam.

Boot-time infrastructure, like the llama-server fleet — started by systemd,
owned by the box, not by the daemon and not by any Sensory Organ. When it's
down, the organ degrades gracefully: no presence/identity events, captioning
continues.

## Setup

```bash
cd packages/psycheros/perception

# Python 3.9 is REQUIRED — Google's pycoral/tflite-runtime wheels stop at cp39.
# On Ubuntu 24.04: sudo add-apt-repository ppa:deadsnakes/ppa && sudo apt install python3.9 python3.9-venv
python3.9 -m venv .venv
.venv/bin/pip install --index-url https://google-coral.github.io/py-repo/ \
                      --extra-index-url https://pypi.org/simple pycoral tflite-runtime
.venv/bin/pip install 'numpy<2' fastapi uvicorn Pillow   # numpy must stay <2 (pycoral bindings)
# With a Coral (optional): sudo dpkg -i libedgetpu1-std.deb
#   from https://packages.cloud.google.com/apt pool/coral-edgetpu-stable/
```

### Models

Download into `<dataRoot>/.psycheros/perception/models/` (the loader's default;
override with `--models-dir`):

| File                   | What                                                                   | CPU-capable variant                                                 |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `yolov8n.onnx`         | **YOLOv8n person detector (ONNX, CPU) — the preferred body detector**  | same file (CPU-native, ~32ms; needs `onnxruntime` in the venv)      |
| `person_detect.tflite` | Legacy SSD-MobileNetV2 (fallback when the ONNX is absent — locks onto  | `person_detect_cpu.tflite` (required for `--device cpu`)            |
| `blazeface.tflite`     | MediaPipe BlazeFace front 128×128, float32 (runs on CPU always, 2ms)   | — (same file)                                                       |
| `arcface.tflite`       | face embedder — #194 face_recognizer_fast EdgeTPU build (128-d, uint8) | `arcface_cpu.tflite` (#175 ArcFace integer-quant, 512-d) if present |

Sources: person detector from google-coral/test_data (both variants);
BlazeFace + ArcFace from the PINTO model zoo (030_BlazeFace,
194_face_recognizer_fast, 175_face-recognition-resnet100-arcface-onnx).
`anchors_face.npy` (shipped here) is the canonical MediaPipe anchor grid the
BlazeFace decoder needs.

**Measured quirks (2026-09-09, this box):**

- The PINTO EdgeTPU BlazeFace build's quantized head emits garbage (its declared
  quantization collapses the score range) — that's why BlazeFace runs the
  float32 CPU build everywhere. 2ms; not worth fighting.
- The #194 embedder's DECLARED output quantization is also wrong (all faces
  match at cosine 1.0). The sidecar uses the raw uint8 output, mean-centered —
  verified discriminative (same person ~0.9, non-face ~0.6).
- The Coral enumerates as `1a6e:089a` (Global Unichip) until libedgetpu first
  opens it and never re-enumerates on this runtime — that's normal; the proof is
  inference working (`--selftest`). After a hard USB error 5, the chip needs a
  physical replug; a service restart alone won't recover it.
- **This room has a mirror**, and the face matcher correctly identifies the
  reflection as the enrolled person (it IS them). Faces never inflate the person
  count — occupancy uses the SSD count only, which measured functionally
  correct: empty room → 0, occupied → 1. The SSD's box localization is poor in
  this lighting (locks onto a lit-wall region rather than the person), but
  nothing consumes box position. If a future room mirrors the _body_ detector
  into double-counting, revisit.

### Enrollment — the filesystem is the registry

Reference photos live under `<dataRoot>/.psycheros/perception/faces/` — the
daemon's data root, the same convention as every other Psycheros runtime file,
gitignored with it.

```
<dataRoot>/.psycheros/perception/faces/
└── alex/
    ├── 01-frontal.jpg
    ├── 02-side.jpg      # a few angles, including dim lighting
    └── 03-desk-lamp.jpg
```

The directory name IS the identity the sidecar reports — use whatever the entity
should call that person, not necessarily a legal name.

Photos on disk ARE the registry — nothing else persists. After adding or
removing photos:

```bash
curl -X POST http://localhost:18085/face/registry/reload
```

One good frontal photo minimum; several angles (including the lighting where
mis-ID has happened) work better. The largest detected face in each photo is
enrolled, so group photos enroll their subject.

## Run

```bash
# CPU (default — no special hardware needed)
.venv/bin/python sidecar.py --selftest    # load + one synthetic frame, exit
.venv/bin/python sidecar.py               # serve on 127.0.0.1:18085

# With a Coral USB TPU (~10x inference speed)
.venv/bin/python sidecar.py --device edgetpu
```

Latency, measured: CPU ≈ 45ms/frame with no face, ~340ms when a face is visible
(the embedder dominates); EdgeTPU ≈ 55-70ms regardless. Both fit the organ's
capture cadence (~3fps, 333ms/frame).

### systemd unit (the intended home)

`~/.config/systemd/user/perception.service`:

```ini
[Unit]
Description=Psycheros perception sidecar
After=network.target

[Service]
WorkingDirectory=%h/Projects/Psycheros-staging/packages/psycheros/perception
# CPU default; add --device edgetpu with a Coral
ExecStart=%h/Projects/Psycheros-staging/packages/psycheros/perception/.venv/bin/python sidecar.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

`systemctl --user enable --now perception`, then `loginctl enable-linger $USER`
so it survives logout.

## API

| Route                        | What                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `GET /health`                | liveness + device + registry listing (empty registry = healthy-but-useless, still 200) |
| `POST /perceive`             | `{image_b64}` → `{people: {count, boxes}, faces: [{id, confidence, box}], latency_ms}` |
| `GET /face/registry`         | enrolled ids + photo counts                                                            |
| `POST /face/registry/reload` | rescan `faces/` after adding photos                                                    |

`people.count` counts ALL detections; `faces` lists MATCHED identities only —
`count > faces.length` means "person present, identity unknown" (never a fake
`unknown` id). The organ's presence machines and caption prompt consume exactly
this distinction.

### Threshold calibration

The match threshold (default cosine 0.75, `--threshold`) is the honesty dial:

- too low → strangers match (false identity)
- too high → the enrolled person misses (false "unknown")

Measured bands on this install (raw-uint8 mean-centered embeddings): same person
~0.90, non-face crops ~0.62 — the default sits between. After enrolling,
calibrate against a real second person if one's available: `curl` a few live
frames through `/perceive`, watch confidences, set the threshold between the
clusters. Then re-check the salience bands downstream (briefing item #7 — any
perception change re-calibrates noticing).

## Enabling the organ side

In `.psycheros/flux-settings.json` (per this install):

```json
{
  "perceptionEnabled": true,
  "perceptionUrl": "http://localhost:18085"
}
```

**TODO (settings UI):** the perception settings (`perceptionEnabled`,
`perceptionUrl`, the debounce knobs) and the enrollment/registry management
(reload after adding photos, a registry view, threshold calibration) belong in
the Flux settings UI eventually. Deferred deliberately — UI comes last; until
then these are file-edited. **Trap while file-edited:** the Flux settings UI
POSTs a partial body and the server saves it wholesale — a UI save resets
file-edited `vision*`/`perception*`/`modelHookups` fields to defaults. Edit the
file and restart flux (or the daemon); don't save the Flux settings UI.

## TPU failure behavior (the wedged-Coral protocol)

The Coral can wedge (signature: white LED pulsing/flash, USB transfer error 5 in
kernel logs, a fresh process can't load the EdgeTPU delegate). **Recovery is a
physical replug** — no software path resets the device. The sidecar handles the
wedge without operator babysitting:

- **Startup**: delegate load failure → degraded mode (bodies + face detection,
  no identity) + background retry with backoff (10s→5min). The moment the TPU is
  replugged, identity returns on its own.
- **Runtime wedge**: 50 consecutive embed failures exit the process → systemd
  restarts → degraded path (visible as restarts in
  `systemctl --user status psycheros-perception`, not silent 500s).
- **`/health`** carries `"identity": "ok" | "degraded"` — poll this when the LED
  pulses.
- Degraded `/perceive` returns people boxes with `faces: []` ("person present,
  identity unknown") — body-gated presence never depended on identity.

**Do not run a second EdgeTPU process alongside the service** (e.g. for testing)
— concurrent device access wedges BOTH with error 5. Test degraded mode with
`--device cpu` and the embedder model file absent.

## Design notes

- I hold no state across frames — the organ's presence machines own
  occupancy/identity state; perceiving is stateless.
- First-person convention applies to the source comments like the rest of the
  workspace.
- Ports in use on this box: 3000 daemon, 18080/18082 llama-servers, 18085 this
  sidecar.
