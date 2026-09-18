"""
jobs.py — Job state store and GET /api/jobs/{id} endpoint

In-memory job registry. For production with concurrent users, migrate to
Redis + persistent storage. For local single-user use, in-memory is sufficient.

Job states:
  queued → processing → separating → analyzing → render-ready → failed
"""

import uuid
import time
from typing import Optional
import sys
from pathlib import Path

_backend_dir = str(Path(__file__).resolve().parent.parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

try:
    from fastapi import APIRouter, HTTPException  # type: ignore
    from fastapi.responses import FileResponse  # type: ignore
except (ImportError, ModuleNotFoundError):
    class APIRouter:  # type: ignore
        def get(self, *args, **kwargs): return lambda f: f
        def post(self, *args, **kwargs): return lambda f: f
    class HTTPException(Exception):  # type: ignore
        def __init__(self, status_code: int = 500, detail: str = ""):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail
    class FileResponse:  # type: ignore
        def __init__(self, path: str, media_type: str = ""): self.path = path

try:
    from config import JOB_TTL_S, JOBS_DIR  # type: ignore
except (ImportError, ModuleNotFoundError):
    from backend.config import JOB_TTL_S, JOBS_DIR  # type: ignore

router = APIRouter()

# In-memory job registry: job_id → job_state dict
_jobs: dict[str, dict] = {}


# ── Job management ────────────────────────────────────────────────────────────

def create_job(filename: str) -> str:
    """Create a new job and return its ID."""
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {
        "job_id":    job_id,
        "status":    "queued",
        "filename":  filename,
        "created_at": time.time(),
        "updated_at": time.time(),
        "model_used": None,
        "quality_score": None,
        "error":     None,
        "stems":     [],
        "scene":     None,
    }
    return job_id


def update_job(job_id: str, **kwargs):
    """Update job fields."""
    if job_id in _jobs:
        _jobs[job_id].update(kwargs)
        _jobs[job_id]["updated_at"] = time.time()


def get_job(job_id: str) -> Optional[dict]:
    return _jobs.get(job_id)


def job_dir(job_id: str) -> Path:
    d = JOBS_DIR / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def cleanup_expired_jobs():
    """Remove jobs older than JOB_TTL_S seconds."""
    now = time.time()
    expired = [
        jid for jid, j in _jobs.items()
        if now - j["created_at"] > JOB_TTL_S
    ]
    for jid in expired:
        d = JOBS_DIR / jid
        if d.exists():
            import shutil
            shutil.rmtree(d, ignore_errors=True)
        del _jobs[jid]


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/api/jobs/{job_id}")
async def get_job_status(job_id: str):
    """
    Poll job status. Frontend polls this until status = 'render-ready' or 'failed'.
    """
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/api/stems/{job_id}/{stem_name}")
async def serve_stem(job_id: str, stem_name: str):
    """
    Serve a separated stem WAV file.
    """
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "render-ready":
        raise HTTPException(status_code=425, detail="Stems not ready yet")

    stem_path = job_dir(job_id) / f"{stem_name}.wav"
    if not stem_path.exists():
        raise HTTPException(status_code=404, detail=f"Stem '{stem_name}' not found")

    return FileResponse(
        str(stem_path),
        media_type="audio/wav",
        filename=f"{stem_name}.wav",
    )


@router.get("/api/scene/{job_id}")
async def get_scene(job_id: str):
    """
    Return the SpatialScene JSON for a completed job.
    """
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "render-ready":
        raise HTTPException(status_code=425, detail="Scene not ready yet")
    if not job["scene"]:
        raise HTTPException(status_code=500, detail="Scene data missing")
    return job["scene"]
