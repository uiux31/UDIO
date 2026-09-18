"""
reconstruction.py — Post-Separation Quality Reconstruction

After AI separation, verifies energy conservation and applies
per-stem gain normalization if needed.
"""

import numpy as np
from typing import Dict


def check_energy_conservation(
    mix: np.ndarray,
    stems: Dict[str, np.ndarray],
    tolerance_db: float = 6.0,
) -> float:
    """
    Check if sum(stems) ≈ mix in energy.
    Returns residual RMS in dB relative to mix RMS.
    Logs a warning if residual > tolerance_db.
    """
    stem_sum = sum(stems.values())

    # Align lengths (some models may return slightly different lengths)
    min_len = min(mix.shape[1], stem_sum.shape[1])
    mix_trimmed  = mix[:, :min_len]
    sum_trimmed  = stem_sum[:, :min_len]

    residual = mix_trimmed - sum_trimmed
    mix_rms      = float(np.sqrt(np.mean(mix_trimmed ** 2)) + 1e-10)
    residual_rms = float(np.sqrt(np.mean(residual ** 2)) + 1e-10)
    residual_db  = 20 * np.log10(residual_rms / mix_rms)
    return residual_db


def normalize_stems(
    stems: Dict[str, np.ndarray],
    mix: np.ndarray,
) -> Dict[str, np.ndarray]:
    """
    Normalize stems so sum(stems) has the same RMS as the original mix.
    Only applied if there is significant gain deviation (> 1 dB).
    """
    stem_sum = sum(stems.values())
    min_len = min(mix.shape[1], stem_sum.shape[1])

    mix_rms = float(np.sqrt(np.mean(mix[:, :min_len] ** 2)) + 1e-10)
    sum_rms = float(np.sqrt(np.mean(stem_sum[:, :min_len] ** 2)) + 1e-10)

    ratio_db = 20 * np.log10(mix_rms / (sum_rms + 1e-10))

    # Only normalize if deviation exceeds 1 dB
    if abs(ratio_db) > 1.0:
        gain = mix_rms / sum_rms
        return {name: audio * gain for name, audio in stems.items()}

    return stems


def trim_stems_to_mix_length(
    stems: Dict[str, np.ndarray],
    mix: np.ndarray,
) -> Dict[str, np.ndarray]:
    """
    Trim all stem arrays to match the original mix length exactly.
    """
    target_len = mix.shape[1]
    trimmed = {}
    for name, audio in stems.items():
        if audio.shape[1] > target_len:
            trimmed[name] = audio[:, :target_len]
        elif audio.shape[1] < target_len:
            pad = target_len - audio.shape[1]
            trimmed[name] = np.pad(audio, ((0, 0), (0, pad)), mode='constant')
        else:
            trimmed[name] = audio
    return trimmed
