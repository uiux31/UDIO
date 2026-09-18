"""
health.py — GET /api/health

Returns backend status and model availability.
"""

import sys
from pathlib import Path

_backend_dir = str(Path(__file__).resolve().parent.parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

try:
    from fastapi import APIRouter  # type: ignore
except (ImportError, ModuleNotFoundError):
    class APIRouter:  # fallback dummy
        def get(self, *args, **kwargs): return lambda f: f
        def post(self, *args, **kwargs): return lambda f: f

try:
    import torch  # type: ignore
    _HAS_TORCH = True
except (ImportError, ModuleNotFoundError):
    _HAS_TORCH = False

try:
    from config import BSROFORMER_AVAILABLE, BSROFORMER_CKPT, HTDEMUCS_MODEL  # type: ignore
except (ImportError, ModuleNotFoundError):
    from backend.config import BSROFORMER_AVAILABLE, BSROFORMER_CKPT, HTDEMUCS_MODEL  # type: ignore

router = APIRouter()


@router.get("/api/health")
async def health():
    """
    Returns backend status and model availability.
    The frontend polls this to show the "AI Backend: Online/Offline" badge.
    """
    gpu_available = torch.cuda.is_available() if _HAS_TORCH else False
    gpu_name = torch.cuda.get_device_name(0) if (_HAS_TORCH and gpu_available) else None

    # Check if demucs is importable (model weights download on first inference)
    try:
        import demucs  # noqa
        demucs_available = True
    except ImportError:
        demucs_available = False

    return {
        "status":   "ok",
        "backend":  "udio-local",
        "gpu":      gpu_available,
        "gpu_name": gpu_name,
        "models": {
            "bs_roformer": {
                "available": BSROFORMER_AVAILABLE,
                "checkpoint": str(BSROFORMER_CKPT) if BSROFORMER_AVAILABLE else None,
            },
            "htdemucs": {
                "available": demucs_available,
                "model":     HTDEMUCS_MODEL,
            },
        },
        "inference_device": "cuda" if gpu_available else "cpu",
    }
