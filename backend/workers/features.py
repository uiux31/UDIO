"""
features.py — Per-Stem Audio Feature Extraction

Computes features used by the spatial planner to adjust default stem positions
within bounded ranges. Features are descriptive, not prescriptive.

Computed per stem (spec §4.2):
  - RMS energy
  - peak level
  - spectral centroid
  - spectral rolloff (85%)
  - stereo correlation (ρ)
  - ILD (inter-channel level difference, dB)
  - stereo Mid/Side ratio
  - onset density (proxy: energy flux above threshold)
  - zero crossing rate
  - spectral flatness
"""

import numpy as np
from typing import Dict, Any


def compute_features(stem: np.ndarray, sr: int) -> Dict[str, Any]:
    """
    Compute all features for one stem.

    Args:
        stem — (channels, samples) float32, stereo
        sr   — sample rate

    Returns:
        dict of feature values
    """
    channels, samples = stem.shape

    # Use a stable middle window for spectral features (avoids silence edges)
    win_len = min(samples, int(sr * 10.0))   # up to 10 seconds
    center  = samples // 2
    start   = max(0, center - win_len // 2)
    end     = start + win_len
    window  = stem[:, start:end]

    mono = window.mean(axis=0)
    feat: Dict[str, Any] = {}

    # 1. RMS
    feat["rms"] = float(np.sqrt(np.mean(stem ** 2)))

    # 2. Peak
    feat["peak_db"] = float(20 * np.log10(np.max(np.abs(stem)) + 1e-10))

    # 3. Spectral centroid
    fft_mag = np.abs(np.fft.rfft(mono))
    freqs   = np.fft.rfftfreq(len(mono), 1.0 / sr)
    total   = fft_mag.sum() + 1e-10
    feat["spectral_centroid_hz"] = float(np.sum(freqs * fft_mag) / total)

    # 4. Spectral rolloff (85%)
    cumsum = np.cumsum(fft_mag)
    rolloff_idx = np.searchsorted(cumsum, 0.85 * cumsum[-1])
    feat["spectral_rolloff_hz"] = float(freqs[min(rolloff_idx, len(freqs) - 1)])

    # 5. Stereo correlation
    if channels >= 2:
        L = window[0]
        R = window[1]
        mu_L, mu_R   = L.mean(), R.mean()
        sigma_L = np.std(L) + 1e-10
        sigma_R = np.std(R) + 1e-10
        cov = np.mean((L - mu_L) * (R - mu_R))
        feat["stereo_correlation"] = float(np.clip(cov / (sigma_L * sigma_R), -1.0, 1.0))
    else:
        feat["stereo_correlation"] = 1.0

    # 6. ILD — inter-channel level difference (dB)
    if channels >= 2:
        rms_L = float(np.sqrt(np.mean(window[0] ** 2)) + 1e-10)
        rms_R = float(np.sqrt(np.mean(window[1] ** 2)) + 1e-10)
        feat["ild_db"] = float(20 * np.log10(rms_L / rms_R))
    else:
        feat["ild_db"] = 0.0

    # 7. M/S ratio
    if channels >= 2:
        M = (window[0] + window[1]) * 0.5
        S = (window[0] - window[1]) * 0.5
        mid_rms  = float(np.sqrt(np.mean(M ** 2)) + 1e-10)
        side_rms = float(np.sqrt(np.mean(S ** 2)) + 1e-10)
        feat["ms_ratio"] = float(mid_rms / (mid_rms + side_rms))
    else:
        feat["ms_ratio"] = 1.0

    # 8. Onset density (energy flux proxy)
    hop = 512
    frames = [mono[i:i+hop] for i in range(0, len(mono) - hop, hop)]
    if len(frames) > 1:
        energies = np.array([np.mean(f ** 2) for f in frames])
        flux = np.maximum(0, np.diff(energies))
        threshold = np.percentile(flux, 75)
        onset_density = float(np.mean(flux > threshold))
    else:
        onset_density = 0.5
    feat["onset_density"] = onset_density

    # 9. Zero crossing rate
    zcr = float(np.mean(np.abs(np.diff(np.sign(mono))) > 0))
    feat["zero_crossing_rate"] = zcr

    # 10. Spectral flatness
    fft_win = np.abs(np.fft.rfft(mono)) + 1e-10
    geo_mean = float(np.exp(np.mean(np.log(fft_win))))
    ari_mean = float(np.mean(fft_win))
    feat["spectral_flatness"] = geo_mean / ari_mean

    return feat


def extract_all_features(stems: Dict[str, np.ndarray], sr: int) -> Dict[str, Dict[str, Any]]:
    """
    Extract features for all stems.
    Returns dict: stem_name → features dict.
    """
    return {name: compute_features(audio, sr) for name, audio in stems.items()}
