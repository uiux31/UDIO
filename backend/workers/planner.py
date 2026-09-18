"""
planner.py — Spatial Scene Planner

Takes separated stems + extracted features and produces a SpatialScene JSON.

Design:
  - Start with per-stem defaults from config.STEM_SPATIAL_DEFAULTS (§4.1)
  - Apply feature-based adjustments within BOUNDED ranges
  - Never jump positions drastically based on noisy single-frame estimates
  - Output must be a valid SpatialScene JSON (schema below)

SpatialScene schema:
{
  "schemaVersion": "1.0",
  "jobId":         str,
  "model":         str,
  "duration":      float,
  "sampleRate":    int,
  "listener": {
    "position": [0, 0, 0],
    "forward":  [0, 0, -1],
    "up":       [0, 1, 0]
  },
  "sources": [
    {
      "id":          str,   // stem name
      "stemUrl":     str,   // /api/stems/{jobId}/{stemName}
      "azimuth":     float, // degrees: 0 = front, +right, -left
      "elevation":   float, // degrees: 0 = ear level, + = above
      "distance":    float, // meters
      "directGain":  float, // [0, 1]
      "reverbSend":  float, // [0, 1]
      "width":       float, // [0, 1]
    }
  ]
}
"""

import sys
from pathlib import Path
from typing import Dict, Any
import numpy as np

_backend_dir = str(Path(__file__).resolve().parent.parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from config import STEM_SPATIAL_DEFAULTS


def _clamp(val, lo, hi):
    return max(lo, min(hi, val))


def _feature_adjust(stem_id: str, default: dict, features: dict) -> dict:
    """
    Apply conservative feature-based adjustments to the default position.
    All adjustments are bounded to prevent wild position jumps.

    Rules:
      - High stereo correlation → narrower width
      - Non-zero ILD → slight azimuth shift (max ±10°)
      - High M/S ratio → center bias
      - High spectral centroid → slight elevation up
      - Low ms_ratio (side-heavy) → slightly wider
    """
    adj = dict(default)  # copy defaults

    rho = features.get("stereo_correlation", 1.0)
    ild = features.get("ild_db", 0.0)
    ms  = features.get("ms_ratio", 1.0)
    sc  = features.get("spectral_centroid_hz", 1500.0)

    # Width: high correlation → narrower
    base_width = adj["width"]
    width_adj = base_width * (1.0 - 0.3 * rho)
    adj["width"] = _clamp(width_adj, 0.0, 1.0)

    # Azimuth: non-zero ILD implies some lateral bias (max ±10° adjustment)
    az_adj = _clamp(ild * 0.5, -10.0, 10.0)
    adj["azimuth"] = _clamp(adj["azimuth"] + az_adj, -90.0, 90.0)

    # High M/S ratio → reduce any side component (slightly closer to center)
    if ms > 0.8:
        adj["azimuth"] *= 0.8

    # High spectral centroid → slight upward elevation (airy content)
    if sc > 6000 and stem_id not in ("bass", "drums"):
        elev_boost = min(5.0, (sc - 6000) / 2000)
        adj["elevation"] = _clamp(adj["elevation"] + elev_boost, -15.0, 30.0)

    return adj


def build_spatial_scene(
    job_id: str,
    model_used: str,
    stems: Dict[str, Any],   # stem_name → numpy array (for duration)
    features: Dict[str, Dict[str, Any]],
    sr: int,
) -> dict:
    """
    Build a SpatialScene dict from stems and features.

    Args:
        job_id     — UUID string
        model_used — 'bs_roformer' or 'htdemucs'
        stems      — {stem_name: (channels, samples) array}
        features   — {stem_name: features dict}
        sr         — sample rate

    Returns:
        SpatialScene dict (JSON-serializable)
    """
    # Compute duration from the longest stem
    if stems:
        duration = max(a.shape[1] / sr for a in stems.values())
    else:
        duration = 0.0

    sources = []
    for stem_id, audio in stems.items():
        # Start from defaults (spec §4.1)
        default = dict(STEM_SPATIAL_DEFAULTS.get(stem_id, STEM_SPATIAL_DEFAULTS["other"]))

        # Feature-based adjustments (bounded)
        stem_feats = features.get(stem_id, {})
        adjusted = _feature_adjust(stem_id, default, stem_feats)

        source = {
            "id":         stem_id,
            "stemUrl":    f"/api/stems/{job_id}/{stem_id}",
            "azimuth":    round(adjusted["azimuth"],    2),
            "elevation":  round(adjusted["elevation"],  2),
            "distance":   round(adjusted["distance"],   2),
            "directGain": round(_clamp(adjusted["directGain"], 0.2, 1.0), 3),
            "reverbSend": round(_clamp(adjusted["reverbSend"], 0.0, 0.4), 3),
            "width":      round(_clamp(adjusted["width"],      0.0, 1.0), 3),
        }
        sources.append(source)

    return {
        "schemaVersion": "1.0",
        "jobId":    job_id,
        "model":    model_used,
        "duration": round(duration, 3),
        "sampleRate": sr,
        "listener": {
            "position": [0, 0, 0],
            "forward":  [0, 0, -1],
            "up":       [0, 1, 0],
        },
        "sources": sources,
    }
