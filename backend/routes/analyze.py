"""
analyze.py — POST /api/analyze

Quick stereo analysis without AI separation.
Used by the frontend to get per-stem-less spatial hints from the raw stereo mix
(used in "Quick 3D" / no-AI mode as a lightweight alternative).
"""

import sys
from pathlib import Path
import numpy as np
import logging

_backend_dir = str(Path(__file__).resolve().parent.parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

try:
    from fastapi import APIRouter, File, UploadFile, HTTPException  # type: ignore
except (ImportError, ModuleNotFoundError):
    class APIRouter:  # type: ignore
        def get(self, *args, **kwargs): return lambda f: f
        def post(self, *args, **kwargs): return lambda f: f
    def File(*args, **kwargs): return None  # type: ignore
    class UploadFile: pass  # type: ignore
    class HTTPException(Exception): pass  # type: ignore

try:
    from config import MODEL_SAMPLE_RATE  # type: ignore
    from audio.preprocess import load_audio_bytes, preprocess  # type: ignore
    from workers.features import compute_features  # type: ignore
except (ImportError, ModuleNotFoundError):
    from backend.config import MODEL_SAMPLE_RATE  # type: ignore
    from backend.audio.preprocess import load_audio_bytes, preprocess  # type: ignore
    from backend.workers.features import compute_features  # type: ignore

router = APIRouter()
logger = logging.getLogger("udio.analyze")


@router.post("/api/analyze")
async def analyze_audio(file: UploadFile = File(...)):
    """
    Quick stereo analysis. Returns perceptual features + rough spatial hints.
    Does NOT perform source separation. No AI inference is run.
    """
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty file")

    try:
        raw_audio, raw_sr = load_audio_bytes(audio_bytes)
        audio, sr = preprocess(raw_audio, raw_sr, MODEL_SAMPLE_RATE)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"Analysis preprocessing failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Audio processing error")

    features = compute_features(audio, sr)
    duration = audio.shape[1] / sr

    return {
        "duration": round(duration, 3),
        "sampleRate": sr,
        "features": features,
        "mode": "stereo_analysis",
    }
