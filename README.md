# 🎵 UDIO — Spatial Audio Engine

> A full-stack, browser-based **3D spatial audio processor** built for laptop speakers and headphones.  
> All AI inference runs **100% locally** — no cloud, no API keys, no subscriptions.

---

## ✨ Features

| Feature | Details |
|---|---|
| 🔊 **Dual Output Modes** | Optimised DSP chains for **Headphones** and **Laptop Speakers** |
| 🧠 **AI Stem Separation** | Splits audio into Vocals / Drums / Bass / Other via **HTDemucs** (or **BS-RoFormer** if available) |
| 🌐 **3D Spatial Rendering** | HRTF-based binaural panning with Image Source Method (ISM) early reflections |
| 📡 **Soundstage Radar** | Real-time 3D acoustic visualiser showing stem positions in a polar field |
| 📊 **Spectrum Analyser & VU Meters** | Live FFT spectrum + stereo level metering |
| 🎛️ **6 DSP Knobs** | Width · Depth · Focus · Height · Room · Bass — all real-time |
| 🎚️ **Parametric EQ** | Per-band equaliser with enable/disable toggle |
| 💾 **Audio File & System Capture** | Load local files **or** capture live system audio via `getDisplayMedia` |
| 🎨 **9 Built-in Presets** | Wide Binaural, Cinema Wide, Vocal Focus, Bass Assist, Large Room, and more |
| 🔒 **Privacy-first** | All processing stays on your machine |

---

## 🏗️ Architecture

```
UDIO/
├── index.html              # Single-page app shell
├── style.css               # Global design system & animations
├── vite.config.js          # Vite dev/build config (proxies /api → backend)
│
├── src/
│   ├── main.js             # App entry point — wires all modules together
│   ├── presets.js          # 9 named DSP presets
│   │
│   ├── engine/             # Web Audio API DSP chain
│   │   ├── AudioEngine.js      # Core 3D spatial engine + HRTF
│   │   ├── SpatialEngine.js    # Azimuth / elevation / distance renderer
│   │   ├── StemRenderer.js     # Per-stem spatial object rendering
│   │   ├── BassEnhancer.js     # Harmonic bass enhancement
│   │   ├── DynamicsProcessor.js # Compressor / limiter chain
│   │   ├── Equalizer.js        # Parametric EQ
│   │   └── RoomSimulator.js    # ISM early reflections + reverb tail
│   │
│   ├── spatial/            # Spatial scene utilities
│   │   ├── SpatialMath.js      # 3D vector / HRTF math helpers
│   │   ├── SceneAnalyzer.js    # Analyses stem features for spatial placement
│   │   └── SceneGenerator.js   # Generates a spatial scene from AI stems
│   │
│   ├── room/
│   │   └── EarlyReflections.js # Image Source Method reflection calculator
│   │
│   └── ai/
│       └── AIClient.js         # REST client → backend AI service
│
└── backend/                # Python FastAPI AI inference service
    ├── app.py              # FastAPI application entry point
    ├── config.py           # All tunable constants (paths, models, thresholds)
    ├── requirements.txt    # Python dependencies
    ├── routes/
    │   ├── health.py       # GET /api/health
    │   ├── separate.py     # POST /api/separate  (stem separation)
    │   ├── jobs.py         # GET /api/jobs/{id}  (async job polling)
    │   └── analyze.py      # POST /api/analyze   (feature analysis)
    ├── workers/            # Background separation workers
    ├── audio/              # Audio pre/post-processing utilities
    └── models/             # Drop BS-RoFormer checkpoint here (optional)
```

---

## 🚀 Quick Start

### Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 18 |
| Python | ≥ 3.10 |
| pip | latest |

> **Note:** A CUDA-capable GPU is *not* required — HTDemucs runs on CPU. GPU will significantly speed up processing.

---

### 1 — Install frontend dependencies

```bash
npm install
```

### 2 — Install backend dependencies

```bash
cd backend
pip install -r requirements.txt
```

> On first run, `demucs` will automatically download the **htdemucs** model weights (~80 MB). An internet connection is required for this one-time download only.

### 3 — Start the backend

```bash
# from the backend/ directory
python -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

### 4 — Start the frontend

```bash
# from the project root
npm run dev
```

Open **http://localhost:3000** in your browser.

---

## 🤖 AI Stem Separation — Pipeline

UDIO supports two separation back-ends, selected automatically based on what's installed:

| Model | Quality | Speed | Setup |
|---|---|---|---|
| **HTDemucs** | ★★★★☆ | Medium | Auto-downloaded via `demucs` pip package |
| **BS-RoFormer** | ★★★★★ | Slower | Drop `.ckpt` file into `backend/models/` |

### Using BS-RoFormer (optional upgrade)

1. Download a BS-RoFormer checkpoint (e.g. `bs_roformer_ep_317_sdr_12.9755.ckpt`).
2. Place it at `backend/models/bs_roformer.ckpt`.
3. Alternatively, set the environment variable:
   ```bash
   set UDIO_BSROFORMER_CKPT=C:\path\to\your\checkpoint.ckpt
   ```
4. Restart the backend — it will log `BS-RoFormer: available`.

---

## 🎛️ DSP Controls Reference

| Knob | Range | Description |
|---|---|---|
| **Width** | 0 – 200 | Stereo width via M/S matrix scaling |
| **Depth** | 0 – 100 | Virtual distance from the listener |
| **Focus** | 0 – 100 | Center-channel extraction strength |
| **Height** | 0 – 45° | Elevation angle for binaural height cues |
| **Room** | 0 – 100 | ISM reverb / room size blend |
| **Bass** | 0 – 100 | Harmonic bass enhancement intensity |

---

## 🎨 Built-in Presets

| Preset | Mode | Best For |
|---|---|---|
| 🎧 Wide Binaural | Headphones | General music listening |
| 🎬 Cinema Wide | Headphones | Movies & cinematic content |
| 🔴 Live Stream 3D | Headphones | Podcasts, streams, minimal processing |
| 🎵 Music Wide | Headphones | High-quality music tracks |
| 💻 Laptop Stereo Expander | Speakers | Laptop built-in speakers |
| 🎙️ Vocal Focus | Headphones | Spoken word, vocals-forward mixes |
| 🏛️ Large Room | Headphones | Concert hall / ambient effect |
| 🔊 Bass Assist | Headphones | EDM, hip-hop, bass-heavy content |
| — Flat / Direct — | Headphones | Bypass / A-B comparison |

---

## 🔌 Backend API Reference

The FastAPI backend exposes an OpenAPI UI at **http://localhost:8000/docs**.

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Service info |
| `/api/health` | GET | Health check + model status |
| `/api/separate` | POST | Submit an audio file for stem separation |
| `/api/jobs/{job_id}` | GET | Poll async job status & download stems |
| `/api/analyze` | POST | Analyse stems for spatial scene generation |

---

## ⚙️ Configuration

All backend constants are centralised in `backend/config.py`:

```python
HTDEMUCS_MODEL      = "htdemucs"      # model variant
MAX_CONCURRENT_JOBS = 2               # parallel separation jobs
JOB_TTL_S           = 7200           # job cache expiry (2 hours)
CHUNK_DURATION_S    = 30.0           # chunking for long files
MODEL_SAMPLE_RATE   = 44100          # inference sample rate
```

---

## 🛠️ Development

### Frontend only (no AI features)

If you only want to test the spatial DSP engine without the Python backend:

```bash
npm run dev
```

Load an audio file — the app falls back to **Quick Pipeline** (no stem separation, full-mix spatial processing).

### Build for production

```bash
npm run build
# output → dist/
```

### Preview production build

```bash
npm run preview
```

---

## 📦 Tech Stack

**Frontend**
- [Vite](https://vite.dev) — build tool & dev server
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) — all DSP graph nodes
- [WaveSurfer.js](https://wavesurfer.xyz) — waveform visualisation
- Vanilla JS + HTML + CSS (no framework)

**Backend**
- [FastAPI](https://fastapi.tiangolo.com) — async REST API
- [Demucs](https://github.com/facebookresearch/demucs) (HTDemucs) — AI stem separation
- [PyTorch](https://pytorch.org) — model inference
- [torchaudio](https://pytorch.org/audio) — audio I/O
- [SciPy](https://scipy.org) / [NumPy](https://numpy.org) — DSP utilities

---

## 🗺️ Roadmap

- [ ] Stem-level volume and mute controls in the UI
- [ ] HRTF personalisation / custom SOFA file import
- [ ] Export processed audio (spatial mix bounce)
- [ ] Support for more separation models (MDX-Net, Demucs v4 fine-tuned)
- [ ] Playlist / queue support
- [ ] Mobile-responsive layout

---

## 📄 License

MIT © UDIO Contributors

---

> **Disclaimer:** UDIO makes no claim of compatibility with or certification by Dolby Atmos®, DTS:X®, or any other proprietary spatial audio format. All spatial processing is an independent DSP implementation using the Web Audio API and open-source AI models.
