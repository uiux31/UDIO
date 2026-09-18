"""
separator.py — Music Source Separation Worker

Tries BS-RoFormer first (if checkpoint available), falls back to HTDemucs.
Quality scoring is applied to decide which result to use.

BS-RoFormer:
  Uses the lucidrains/BS-RoFormer architecture (MIT licensed code).
  Requires a pretrained checkpoint. The checkpoint license must be verified
  separately (see backend/docs/THIRD_PARTY_AUDIO_MODELS.md).
  If no checkpoint is found, BS-RoFormer is skipped.

HTDemucs:
  Uses the demucs Python package (Meta AI / MIT licensed code).
  Downloaded weights on first run (~330 MB). Cached locally by demucs.
  Checkpoint license: see THIRD_PARTY_AUDIO_MODELS.md.
"""

import numpy as np
import logging
import hashlib
import json
import time
from pathlib import Path
import sys
from pathlib import Path
from typing import Dict, Optional, Tuple

_backend_dir = str(Path(__file__).resolve().parent.parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

try:
    from config import (  # type: ignore
        BSROFORMER_CKPT,
        BSROFORMER_AVAILABLE,
        HTDEMUCS_MODEL,
        HTDEMUCS_STEMS,
        JOBS_DIR,
        CACHE_ENABLED,
        MODEL_SAMPLE_RATE,
    )
except (ImportError, ModuleNotFoundError):
    from backend.config import (  # type: ignore
        BSROFORMER_CKPT,
        BSROFORMER_AVAILABLE,
        HTDEMUCS_MODEL,
        HTDEMUCS_STEMS,
        JOBS_DIR,
        CACHE_ENABLED,
        MODEL_SAMPLE_RATE,
    )

try:
    from audio.preprocess import save_audio  # type: ignore
    from audio.chunking import ChunkProcessor, should_chunk  # type: ignore
    from audio.reconstruction import check_energy_conservation, normalize_stems, trim_stems_to_mix_length  # type: ignore
    from workers.quality import score_all_stems, is_acceptable  # type: ignore
except (ImportError, ModuleNotFoundError):
    from backend.audio.preprocess import save_audio  # type: ignore
    from backend.audio.chunking import ChunkProcessor, should_chunk  # type: ignore
    from backend.audio.reconstruction import check_energy_conservation, normalize_stems, trim_stems_to_mix_length  # type: ignore
    from backend.workers.quality import score_all_stems, is_acceptable  # type: ignore

logger = logging.getLogger("udio.separator")


# ── Cache ────────────────────────────────────────────────────────────────────

def _cache_key(audio_bytes: bytes, model_id: str, stems: list[str]) -> str:
    h = hashlib.sha256()
    h.update(audio_bytes)
    h.update(model_id.encode())
    h.update(json.dumps(sorted(stems)).encode())
    return h.hexdigest()


def _cache_dir(key: str) -> Path:
    return JOBS_DIR / f"cache_{key[:16]}"


def _load_from_cache(key: str, stem_names: list[str]) -> Optional[Tuple[Dict, str]]:
    d = _cache_dir(key)
    meta_path = d / "meta.json"
    if not meta_path.exists():
        return None
    try:
        import soundfile as sf  # type: ignore
        meta = json.loads(meta_path.read_text())
        stems = {}
        for name in stem_names:
            p = d / f"{name}.wav"
            if not p.exists():
                return None
            audio, _ = sf.read(str(p), dtype="float32", always_2d=True)
            stems[name] = audio.T
        return stems, meta["model"]
    except Exception:
        return None


def _save_to_cache(key: str, stems: Dict, model_id: str, sr: int):
    d = _cache_dir(key)
    d.mkdir(parents=True, exist_ok=True)
    for name, audio in stems.items():
        save_audio(audio, d / f"{name}.wav", sr)
    (d / "meta.json").write_text(json.dumps({"model": model_id, "sr": sr}))


# ── HTDemucs separation ───────────────────────────────────────────────────────

def _separate_htdemucs(audio: np.ndarray, sr: int, job_id: str) -> Dict[str, np.ndarray]:
    """
    Run HTDemucs 4-stem separation.
    Uses the demucs Python API.
    """
    import torch  # type: ignore
    import torchaudio  # type: ignore
    from demucs.pretrained import get_model  # type: ignore
    from demucs.apply import apply_model  # type: ignore

    logger.info(f"[{job_id}] Running HTDemucs separation")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    logger.info(f"[{job_id}] Using device: {device}")

    model = get_model(HTDEMUCS_MODEL)
    model.eval()
    model.to(device)

    # Convert numpy → torch tensor (1, channels, samples)
    wav = torch.from_numpy(audio).unsqueeze(0).to(device)

    # Resample to model's expected rate if needed
    if sr != model.samplerate:
        wav = torchaudio.functional.resample(wav, sr, model.samplerate)

    with torch.no_grad():
        sources = apply_model(model, wav, device=device, split=True, overlap=0.25)

    # sources shape: (1, stems, channels, samples)
    sources = sources.squeeze(0).cpu().numpy()

    stem_names = model.sources  # e.g. ['drums', 'bass', 'other', 'vocals']
    stems = {}
    for i, name in enumerate(stem_names):
        stem = sources[i]  # (channels, samples)
        # Resample back to input SR if needed
        if sr != model.samplerate:
            wav_stem = torch.from_numpy(stem).unsqueeze(0)
            wav_stem = torchaudio.functional.resample(wav_stem, model.samplerate, sr)
            stem = wav_stem.squeeze(0).numpy()
        stems[name] = stem.astype(np.float32)

    logger.info(f"[{job_id}] HTDemucs complete: stems={list(stems.keys())}")
    return stems


# ── BS-RoFormer separation ────────────────────────────────────────────────────

def _separate_bsroformer(audio: np.ndarray, sr: int, job_id: str) -> Optional[Dict[str, np.ndarray]]:
    """
    Run BS-RoFormer separation if checkpoint is available.
    Returns None if checkpoint not found or inference fails.

    Integration note:
    BS-RoFormer from lucidrains/BS-RoFormer uses a different inference API.
    This wrapper handles the most common pretrained checkpoint format
    (vocals/other 2-stem). Falls back to returning None on any failure.
    """
    if not BSROFORMER_AVAILABLE:
        logger.warning(f"[{job_id}] BS-RoFormer checkpoint not found at {BSROFORMER_CKPT}")
        return None

    try:
        import torch  # type: ignore
        from bs_roformer import BSRoformer  # type: ignore

        logger.info(f"[{job_id}] Running BS-RoFormer separation")
        device = "cuda" if torch.cuda.is_available() else "cpu"

        # Load checkpoint
        ckpt = torch.load(BSROFORMER_CKPT, map_location=device)
        model_cfg = ckpt.get("config", {})

        model = BSRoformer(**model_cfg)
        model.load_state_dict(ckpt["state_dict"])
        model.eval()
        model.to(device)

        wav = torch.from_numpy(audio).unsqueeze(0).to(device)

        with torch.no_grad():
            # BSRoformer typically returns vocals (primary target)
            vocals = model(wav).squeeze(0).cpu().numpy()

        other = (audio - vocals).astype(np.float32)

        stems = {
            "vocals": vocals.astype(np.float32),
            "other":  other,
        }

        logger.info(f"[{job_id}] BS-RoFormer complete: stems={list(stems.keys())}")
        return stems

    except Exception as e:
        logger.error(f"[{job_id}] BS-RoFormer failed: {e}")
        return None


# ── Main entry point ──────────────────────────────────────────────────────────

def separate(
    audio: np.ndarray,
    sr: int,
    job_id: str,
    audio_bytes: bytes = b"",
) -> Tuple[Dict[str, np.ndarray], str, dict]:
    """
    Main separation entry point.
    Tries BS-RoFormer → quality check → falls back to HTDemucs if needed.
    Returns (stems, model_used, quality_info).

    Args:
        audio      — (channels, samples) float32, already preprocessed
        sr         — sample rate
        job_id     — job UUID for logging
        audio_bytes— raw bytes for cache key (optional)

    Returns:
        (stems, model_used, quality_info)
    """
    stems_names = HTDEMUCS_STEMS  # canonical 4-stem set

    # Check cache first
    if CACHE_ENABLED and audio_bytes:
        for model_id in ("bs_roformer", "htdemucs"):
            key = _cache_key(audio_bytes, model_id, stems_names)
            cached = _load_from_cache(key, stems_names)
            if cached is not None:
                stems, model_used = cached
                score, details = score_all_stems(stems, sr)
                logger.info(f"[{job_id}] Cache hit: model={model_used} score={score:.3f}")
                return stems, model_used, {"score": score, "cache_hit": True, **details}

    # Handle long tracks with overlap-add chunking
    use_chunking = should_chunk(audio, sr)

    def run_model(model_name: str) -> Optional[Dict]:
        if model_name == "bs_roformer":
            if not use_chunking:
                return _separate_bsroformer(audio, sr, job_id)
            else:
                processor = ChunkProcessor(audio, sr)
                logger.info(f"[{job_id}] Chunking: {processor.n_chunks()} chunks")
                for i, chunk in processor.iter_chunks():
                    result = _separate_bsroformer(chunk, sr, job_id)
                    if result is None:
                        return None
                    for stem, stem_audio in result.items():
                        processor.add_result(i, stem, stem_audio)
                return processor.reconstruct()
        else:
            if not use_chunking:
                return _separate_htdemucs(audio, sr, job_id)
            else:
                processor = ChunkProcessor(audio, sr)
                logger.info(f"[{job_id}] Chunking: {processor.n_chunks()} chunks")
                for i, chunk in processor.iter_chunks():
                    result = _separate_htdemucs(chunk, sr, job_id)
                    for stem, stem_audio in result.items():
                        processor.add_result(i, stem, stem_audio)
                return processor.reconstruct()

    # Attempt BS-RoFormer first
    stems = None
    model_used = "htdemucs"

    if BSROFORMER_AVAILABLE:
        bsr_stems = run_model("bs_roformer")
        if bsr_stems is not None:
            # BS-RoFormer may return only 2 stems (vocals/other)
            # Run HTDemucs for drums/bass if needed
            if "drums" not in bsr_stems or "bass" not in bsr_stems:
                logger.info(f"[{job_id}] BS-RoFormer 2-stem: augmenting drums/bass with HTDemucs")
                try:
                    ht_stems = run_model("htdemucs")
                    # Use BS-RoFormer vocals, HTDemucs for drums/bass/other
                    merged = {
                        "vocals": bsr_stems.get("vocals", ht_stems.get("vocals")),
                        "drums":  ht_stems.get("drums"),
                        "bass":   ht_stems.get("bass"),
                        "other":  bsr_stems.get("other", ht_stems.get("other")),
                    }
                    merged = {k: v for k, v in merged.items() if v is not None}
                    score, details = score_all_stems(merged, sr)
                    if is_acceptable(score):
                        stems = merged
                        model_used = "bs_roformer+htdemucs"
                except Exception as e:
                    logger.error(f"[{job_id}] Hybrid augmentation failed: {e}")
            else:
                score, details = score_all_stems(bsr_stems, sr)
                if is_acceptable(score):
                    stems = bsr_stems
                    model_used = "bs_roformer"
                else:
                    logger.warning(f"[{job_id}] BS-RoFormer quality insufficient (score={score:.3f}), falling back")

    # HTDemucs fallback
    if stems is None:
        logger.info(f"[{job_id}] Running HTDemucs fallback")
        try:
            stems = run_model("htdemucs")
            model_used = "htdemucs"
        except Exception as e:
            logger.error(f"[{job_id}] HTDemucs also failed: {e}")
            raise RuntimeError(f"All separation models failed: {e}")

    # Post-processing: trim, normalize, quality score
    stems = trim_stems_to_mix_length(stems, audio)
    stems = normalize_stems(stems, audio)

    residual_db = check_energy_conservation(audio, stems)
    score, details = score_all_stems(stems, sr)

    logger.info(
        f"[{job_id}] Separation complete: model={model_used} "
        f"score={score:.3f} residual={residual_db:.1f}dB"
    )

    quality_info = {
        "score": score,
        "residual_db": residual_db,
        "model_used": model_used,
        "cache_hit": False,
        "per_stem": details,
    }

    # Save to cache
    if CACHE_ENABLED and audio_bytes:
        try:
            key = _cache_key(audio_bytes, model_used, stems_names)
            _save_to_cache(key, stems, model_used, sr)
        except Exception as e:
            logger.warning(f"[{job_id}] Cache save failed: {e}")

    return stems, model_used, quality_info
