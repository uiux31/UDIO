"""
config.py — UDIO Backend Configuration

All tunable constants live here. Do not hardcode these values in route handlers
or worker functions. Import from this module instead.
"""

import os
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent
JOBS_DIR   = BASE_DIR / "jobs"
MODELS_DIR = BASE_DIR / "models"

# Create jobs directory if it does not exist
JOBS_DIR.mkdir(parents=True, exist_ok=True)

# ── Audio processing ─────────────────────────────────────────────────────────
# Target sample rate for AI model inference
MODEL_SAMPLE_RATE = 44100

# Max duration (seconds) for a single inference chunk (before chunking kicks in)
CHUNK_DURATION_S  = 30.0

# Overlap between adjacent chunks (seconds) for smooth crossfade reconstruction
CHUNK_OVERLAP_S   = 5.0

# Minimum track duration to apply chunking (shorter tracks processed whole)
CHUNKING_THRESHOLD_S = 35.0

# Input pre-processing: safety high-pass filter frequency (Hz)
INPUT_HPF_HZ = 25.0

# ── Model configuration ───────────────────────────────────────────────────────
# HTDemucs model variant (demucs package model name)
HTDEMUCS_MODEL = "htdemucs"

# Supported stems for HTDemucs 4-stem model
HTDEMUCS_STEMS = ["vocals", "drums", "bass", "other"]

# BS-RoFormer: path to checkpoint file (None = unavailable, use HTDemucs only)
# Set via environment variable UDIO_BSROFORMER_CKPT or auto-detected below.
BSROFORMER_CKPT = os.environ.get(
    "UDIO_BSROFORMER_CKPT",
    str(MODELS_DIR / "bs_roformer.ckpt")  # default expected location
)
BSROFORMER_AVAILABLE = Path(BSROFORMER_CKPT).exists()

# ── Quality scoring thresholds ────────────────────────────────────────────────
# Minimum stem quality score (0-1) to accept a separation result
QUALITY_THRESHOLD = 0.45

# Maximum allowed clipping percentage in a stem (0-1)
MAX_CLIPPING_PCT = 0.02

# Maximum silence percentage in a stem before marking it as failed
MAX_SILENCE_PCT = 0.85

# ── Job management ───────────────────────────────────────────────────────────
# Maximum number of concurrent separation jobs
MAX_CONCURRENT_JOBS = 2

# Job TTL: auto-clean jobs older than this (seconds). 2 hours.
JOB_TTL_S = 7200

# Caching: SHA-256 hash of (audio bytes + model id + stems) is the cache key.
CACHE_ENABLED = True

# ── Server ───────────────────────────────────────────────────────────────────
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8000

# CORS allowed origins (Vite dev server + prod)
CORS_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:5173",
]

# ── Speed of sound (m/s) — used by spatial planner ───────────────────────────
SPEED_OF_SOUND = 343.0

# ── Default stem spatial positions (from spec §4.1) ──────────────────────────
# These are starting priors; feature analysis can adjust within bounded ranges.
STEM_SPATIAL_DEFAULTS = {
    "vocals": {
        "azimuth":    0.0,   # degrees: center
        "elevation":  2.0,   # degrees: slightly above ear level
        "distance":   1.2,   # meters: close
        "directGain": 0.90,
        "reverbSend": 0.10,
        "width":      0.10,  # narrow
    },
    "drums": {
        "azimuth":    0.0,
        "elevation":  0.0,
        "distance":   1.8,
        "directGain": 0.75,
        "reverbSend": 0.20,
        "width":      0.60,  # wide
    },
    "bass": {
        "azimuth":    0.0,
        "elevation": -5.0,   # slightly below (sub-bass is non-directional)
        "distance":   2.0,
        "directGain": 0.80,
        "reverbSend": 0.08,
        "width":      0.10,  # narrow
    },
    "other": {
        "azimuth":   15.0,   # slight offset to avoid direct center overlap
        "elevation":  0.0,
        "distance":   2.5,
        "directGain": 0.60,
        "reverbSend": 0.18,
        "width":      0.50,  # medium-wide
    },
    "guitar": {
        "azimuth":   30.0,
        "elevation":  0.0,
        "distance":   1.8,
        "directGain": 0.70,
        "reverbSend": 0.15,
        "width":      0.30,
    },
    "piano": {
        "azimuth":  -25.0,
        "elevation":  0.0,
        "distance":   2.0,
        "directGain": 0.70,
        "reverbSend": 0.15,
        "width":      0.35,
    },
}
