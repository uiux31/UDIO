"""
separate.py — POST /api/separate

Accepts an audio file upload, queues a separation job,
runs it in a background thread, and returns a job ID immediately.

The browser polls GET /api/jobs/{id} until status = 'render-ready'.
"""

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import sys
from pathlib import Path

_backend_dir = str(Path(__file__).resolve().parent.parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

try:
    from fastapi import APIRouter, File, UploadFile, HTTPException, BackgroundTasks  # type: ignore
except (ImportError, ModuleNotFoundError):
    class APIRouter:  # type: ignore
        def get(self, *args, **kwargs): return lambda f: f
        def post(self, *args, **kwargs): return lambda f: f
    def File(*args, **kwargs): return None  # type: ignore
    class UploadFile: pass  # type: ignore
    class HTTPException(Exception): pass  # type: ignore
    class BackgroundTasks: pass  # type: ignore

try:
    from config import MAX_CONCURRENT_JOBS, MODEL_SAMPLE_RATE  # type: ignore
    from audio.preprocess import load_audio_bytes, preprocess, save_audio  # type: ignore
    from workers.separator import separate  # type: ignore
    from workers.features import extract_all_features  # type: ignore
    from workers.planner import build_spatial_scene  # type: ignore
    from routes.jobs import create_job, update_job, job_dir  # type: ignore
except (ImportError, ModuleNotFoundError):
    from backend.config import MAX_CONCURRENT_JOBS, MODEL_SAMPLE_RATE  # type: ignore
    from backend.audio.preprocess import load_audio_bytes, preprocess, save_audio  # type: ignore
    from backend.workers.separator import separate  # type: ignore
    from backend.workers.features import extract_all_features  # type: ignore
    from backend.workers.planner import build_spatial_scene  # type: ignore
    from backend.routes.jobs import create_job, update_job, job_dir  # type: ignore

router = APIRouter()
logger = logging.getLogger("udio.separate")

# Semaphore to limit concurrent jobs
_semaphore = asyncio.Semaphore(MAX_CONCURRENT_JOBS)
_executor  = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_JOBS)

# Accepted audio MIME types
ACCEPTED_TYPES = {
    "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
    "audio/flac", "audio/ogg", "audio/aac", "audio/mp4",
    "video/mp4",  # some browsers label mp4 audio as video/mp4
}


def _run_separation_job(job_id: str, audio_bytes: bytes, filename: str):
    """
    Background thread: full separation pipeline.
    Updates job state as each phase completes.
    """
    t0 = time.time()
    try:
        # --- Phase 1: Preprocess ---
        update_job(job_id, status="processing")
        logger.info(f"[{job_id}] Preprocessing {filename}")

        raw_audio, raw_sr = load_audio_bytes(audio_bytes)
        audio, sr = preprocess(raw_audio, raw_sr, MODEL_SAMPLE_RATE)

        # Save original (preprocessed) to job dir for reference
        jdir = job_dir(job_id)
        save_audio(audio, jdir / "source.wav", sr)

        # --- Phase 2: AI Separation ---
        update_job(job_id, status="separating")
        logger.info(f"[{job_id}] Starting separation")

        stems, model_used, quality_info = separate(
            audio, sr, job_id, audio_bytes=audio_bytes
        )

        # Save separated stems to job dir
        for stem_name, stem_audio in stems.items():
            save_audio(stem_audio, jdir / f"{stem_name}.wav", sr)

        # --- Phase 3: Feature Extraction & Scene Planning ---
        update_job(job_id, status="analyzing")
        logger.info(f"[{job_id}] Extracting features")

        features = extract_all_features(stems, sr)
        scene    = build_spatial_scene(job_id, model_used, stems, features, sr)

        # --- Done ---
        elapsed = round(time.time() - t0, 2)
        logger.info(f"[{job_id}] Complete in {elapsed}s: model={model_used} score={quality_info['score']:.3f}")

        update_job(
            job_id,
            status="render-ready",
            model_used=model_used,
            quality_score=quality_info.get("score"),
            quality_details=quality_info,
            stems=list(stems.keys()),
            scene=scene,
            processing_time_s=elapsed,
        )

    except Exception as e:
        logger.error(f"[{job_id}] Job failed: {e}", exc_info=True)
        update_job(job_id, status="failed", error=str(e))


@router.post("/api/separate")
async def separate_audio(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
):
    """
    Upload an audio file to start AI source separation.
    Returns { jobId, status: 'queued' } immediately.
    Poll GET /api/jobs/{jobId} for progress.
    """
    # Validate content type (lenient — also accept unknown, rely on soundfile)
    content_type = (file.content_type or "").split(";")[0].strip()
    if content_type and content_type not in ACCEPTED_TYPES and not content_type.startswith("audio/"):
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported media type: {content_type}. Please upload an audio file."
        )

    # Read file bytes
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty file uploaded")

    # Max file size: 500 MB
    if len(audio_bytes) > 500 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 500 MB)")

    job_id = create_job(file.filename or "upload.wav")
    logger.info(f"[{job_id}] Job created for file={file.filename} size={len(audio_bytes)} bytes")

    # Schedule background processing (non-blocking)
    background_tasks.add_task(
        _run_separation_job, job_id, audio_bytes, file.filename or "upload.wav"
    )

    return {"jobId": job_id, "status": "queued"}
