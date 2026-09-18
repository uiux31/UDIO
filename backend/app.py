"""
app.py — UDIO AI Backend Entry Point

FastAPI application. Run with:
    cd backend
    python -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload

Architecture: This service is the only point that talks to AI models.
The browser frontend communicates with this service via REST over localhost.
No API keys, no cloud dependencies, no external inference endpoints.
"""

import logging
from contextlib import asynccontextmanager

import sys
from pathlib import Path

_backend_dir = str(Path(__file__).resolve().parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

try:
    from fastapi import FastAPI  # type: ignore
    from fastapi.middleware.cors import CORSMiddleware  # type: ignore
except (ImportError, ModuleNotFoundError):
    class FastAPI:  # type: ignore
        def __init__(self, *args, **kwargs): pass
        def add_middleware(self, *args, **kwargs): pass
        def include_router(self, *args, **kwargs): pass
        def get(self, *args, **kwargs): return lambda f: f
        def post(self, *args, **kwargs): return lambda f: f
    class CORSMiddleware: pass  # type: ignore

try:
    from config import CORS_ORIGINS, BSROFORMER_AVAILABLE, HTDEMUCS_MODEL, JOBS_DIR  # type: ignore
    from routes.health import router as health_router  # type: ignore
    from routes.separate import router as separate_router  # type: ignore
    from routes.jobs import router as jobs_router, cleanup_expired_jobs  # type: ignore
    from routes.analyze import router as analyze_router  # type: ignore
except (ImportError, ModuleNotFoundError):
    from backend.config import CORS_ORIGINS, BSROFORMER_AVAILABLE, HTDEMUCS_MODEL, JOBS_DIR  # type: ignore
    from backend.routes.health import router as health_router  # type: ignore
    from backend.routes.separate import router as separate_router  # type: ignore
    from backend.routes.jobs import router as jobs_router, cleanup_expired_jobs  # type: ignore
    from backend.routes.analyze import router as analyze_router  # type: ignore

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("udio.app")


# ── Application lifespan ──────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown hooks."""
    logger.info("=" * 60)
    logger.info("UDIO AI Backend starting")
    logger.info(f"  Jobs directory:      {JOBS_DIR}")
    logger.info(f"  BS-RoFormer:         {'available' if BSROFORMER_AVAILABLE else 'NOT FOUND — will use HTDemucs only'}")
    logger.info(f"  HTDemucs model:      {HTDEMUCS_MODEL}")
    logger.info("=" * 60)

    # Attempt to warm up HTDemucs (triggers weight download on first run)
    try:
        import demucs.pretrained  # noqa — verifies demucs is installed
        logger.info("demucs package loaded OK")
    except ImportError:
        logger.error(
            "demucs not installed! Run: pip install demucs\n"
            "See backend/requirements.txt"
        )

    yield

    # Cleanup on shutdown
    cleanup_expired_jobs()
    logger.info("UDIO AI Backend shutdown complete")


# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="UDIO AI Backend",
    description=(
        "Local AI source separation and spatial scene planning for UDIO. "
        "All inference runs locally — no external API keys required."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# CORS: allow the Vite dev server and localhost production builds
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register route modules
app.include_router(health_router)
app.include_router(separate_router)
app.include_router(jobs_router)
app.include_router(analyze_router)


@app.get("/")
async def root():
    return {
        "service": "UDIO AI Backend",
        "docs": "/docs",
        "health": "/api/health",
    }
