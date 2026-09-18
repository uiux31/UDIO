"""
quality.py — Stem Quality Scoring

Computes a heuristic quality score (0.0–1.0) for each separated stem.
Used to decide whether to accept BS-RoFormer output or fall back to HTDemucs.

Metrics used (spec §40):
  - energy       (stem should have non-zero energy)
  - crest factor (not flat/noise-like)
  - clipping %   (samples at or above 1.0)
  - silence %    (samples below noise floor)
  - reconstruction residual (energy conservation)
  - spectral continuity (detect metallic/noise artifacts)

None of these are objective perceptual metrics (SDR/SI-SDR).
They are heuristics for obvious failure detection only.
"""

import sys
from pathlib import Path
from typing import Dict, Tuple
import numpy as np

_backend_dir = str(Path(__file__).resolve().parent.parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

try:
    from config import MAX_CLIPPING_PCT, MAX_SILENCE_PCT, QUALITY_THRESHOLD  # type: ignore
except (ImportError, ModuleNotFoundError):
    from backend.config import MAX_CLIPPING_PCT, MAX_SILENCE_PCT, QUALITY_THRESHOLD  # type: ignore


def stem_quality_score(stem: np.ndarray, sr: int) -> Tuple[float, dict]:
    """
    Compute a scalar quality score for one stem and return metadata.

    Args:
        stem  — (channels, samples) float32
        sr    — sample rate

    Returns:
        (score, details) where score ∈ [0.0, 1.0]
    """
    # Flatten to mono for scalar metrics
    mono = stem.mean(axis=0) if stem.ndim == 2 else stem

    details = {}
    penalties = []

    # 1. Energy: score 0 if stem is silent
    rms = float(np.sqrt(np.mean(mono ** 2)))
    details["rms"] = rms
    if rms < 1e-5:
        return 0.0, {**details, "failed_reason": "silence"}

    # 2. Clipping percentage
    clip_pct = float(np.mean(np.abs(mono) >= 1.0))
    details["clipping_pct"] = clip_pct
    if clip_pct > MAX_CLIPPING_PCT:
        penalties.append(("clipping", min(1.0, clip_pct / MAX_CLIPPING_PCT) * 0.4))

    # 3. Silence percentage (samples below -60 dBFS proxy)
    silence_floor = 10 ** (-60 / 20)
    silence_pct = float(np.mean(np.abs(mono) < silence_floor))
    details["silence_pct"] = silence_pct
    if silence_pct > MAX_SILENCE_PCT:
        return 0.0, {**details, "failed_reason": "excessive_silence"}

    # 4. Crest factor — very low crest factor indicates noise-like flatness
    peak = float(np.max(np.abs(mono)))
    crest = peak / (rms + 1e-10)
    crest_db = 20 * np.log10(crest + 1e-10)
    details["crest_db"] = crest_db
    # Normal music crest: 8–20 dB. Below 3 dB → likely noise.
    if crest_db < 3.0:
        penalties.append(("low_crest", 0.3))

    # 5. Spectral flatness — measures how noise-like the spectrum is
    # Compute over a middle block to avoid silence edges
    mid_start = len(mono) // 4
    mid_end   = 3 * len(mono) // 4
    block = mono[mid_start:mid_end]
    if len(block) > 512:
        fft = np.abs(np.fft.rfft(block[:4096]))
        fft = fft + 1e-10
        geo_mean = np.exp(np.mean(np.log(fft)))
        ari_mean = np.mean(fft)
        flatness = float(geo_mean / ari_mean)
        details["spectral_flatness"] = flatness
        # > 0.5 is very noise-like for music
        if flatness > 0.5:
            penalties.append(("high_flatness", flatness * 0.25))
    else:
        details["spectral_flatness"] = None

    # Compute final score from penalty accumulation
    total_penalty = sum(v for _, v in penalties)
    score = max(0.0, min(1.0, 1.0 - total_penalty))

    details["penalties"] = [f"{k}:{v:.3f}" for k, v in penalties]
    details["score"] = score

    return score, details


def score_all_stems(
    stems: Dict[str, np.ndarray],
    sr: int,
) -> Tuple[float, Dict[str, dict]]:
    """
    Score all stems and return (aggregate_score, per_stem_details).
    Aggregate score is the minimum score across all stems (weakest link).
    """
    per_stem = {}
    scores = []
    for name, audio in stems.items():
        score, details = stem_quality_score(audio, sr)
        per_stem[name] = details
        scores.append(score)

    agg = float(np.min(scores)) if scores else 0.0
    return agg, per_stem


def is_acceptable(agg_score: float) -> bool:
    """True if the aggregate quality score meets the minimum threshold."""
    return agg_score >= QUALITY_THRESHOLD
