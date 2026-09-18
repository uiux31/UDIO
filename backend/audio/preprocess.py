"""
preprocess.py — Audio Input Validation, Normalization, and Decoding

Pipeline:
  decode → stereo validation → NaN/Inf/DC check → resample → floating-point PCM

Robust against:
  - Missing external libraries (provides Python standard library `wave` fallback)
  - 1D mono or transposed (samples, channels) audio input shapes
  - Mastered / compressed audio with peaks near or at 1.0 (no false clipping errors)
  - Path / working directory differences (auto-locates config.py)
"""

from __future__ import annotations

import sys
import io
from pathlib import Path
from typing import Tuple, Union

# Ensure backend root is on sys.path so config can always be imported
_backend_dir = str(Path(__file__).resolve().parent.parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

try:
    from config import INPUT_HPF_HZ, MODEL_SAMPLE_RATE  # type: ignore
except (ImportError, ModuleNotFoundError):
    try:
        from backend.config import INPUT_HPF_HZ, MODEL_SAMPLE_RATE  # type: ignore
    except (ImportError, ModuleNotFoundError):
        INPUT_HPF_HZ = 20.0
        MODEL_SAMPLE_RATE = 44100

import numpy as np

# Optional soundfile with standard wave module fallback
try:
    import soundfile as sf  # type: ignore
    _HAS_SOUNDFILE = True
except ImportError:
    _HAS_SOUNDFILE = False
    import wave


def _read_wav_stream(stream_or_path) -> Tuple[np.ndarray, int]:
    """Fallback reader using Python's built-in wave module for PCM WAV."""
    import wave
    with wave.open(stream_or_path, 'rb') as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sr = wf.getframerate()
        n_frames = wf.getnframes()
        raw_bytes = wf.readframes(n_frames)

    if sampwidth == 2:  # 16-bit PCM
        samples = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 4:  # 32-bit PCM
        samples = np.frombuffer(raw_bytes, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif sampwidth == 1:  # 8-bit unsigned PCM
        samples = (np.frombuffer(raw_bytes, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sampwidth == 3:  # 24-bit PCM
        b = np.frombuffer(raw_bytes, dtype=np.uint8).reshape(-1, 3)
        b4 = np.pad(b, ((0, 0), (1, 0)), mode='constant')
        samples = b4.view(np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"Unsupported WAV sample width: {sampwidth} bytes")

    # Reshape from interleaved samples to (channels, samples)
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).T
    else:
        samples = samples.reshape(1, -1)

    return samples, sr


def load_audio(path: Union[str, Path]) -> Tuple[np.ndarray, int]:
    """
    Load an audio file to float32 numpy array.
    Returns (audio, sample_rate).
    audio shape: (channels, samples) — always 2D, always float32.
    """
    path_str = str(path)
    if _HAS_SOUNDFILE:
        try:
            audio, sr = sf.read(path_str, dtype="float32", always_2d=True)
            return audio.T, sr
        except Exception:
            pass  # Fall through to wave reader if soundfile fails

    # Fallback to wave reader
    return _read_wav_stream(path_str)


def load_audio_bytes(data: bytes) -> Tuple[np.ndarray, int]:
    """
    Load audio from raw bytes (e.g. uploaded file).
    """
    buf = io.BytesIO(data)
    if _HAS_SOUNDFILE:
        try:
            audio, sr = sf.read(buf, dtype="float32", always_2d=True)
            return audio.T, sr
        except Exception:
            buf.seek(0)

    # Fallback to wave reader
    return _read_wav_stream(buf)


def validate_audio(audio: np.ndarray, sr: int) -> np.ndarray:
    """
    Run sanity checks on decoded audio.
    Automatically handles 1D arrays, transposes (samples, channels),
    cleans NaNs/Infs, and soft-normalizes excessive peaks without throwing.
    Raises ValueError only on genuinely corrupt or unplayable audio.
    """
    if not isinstance(audio, np.ndarray):
        audio = np.asarray(audio, dtype=np.float32)

    # Promote 1D to 2D (1, samples)
    if audio.ndim == 1:
        audio = audio[np.newaxis, :]

    # If passed as (samples, channels) where samples >> channels, transpose to (channels, samples)
    if audio.ndim == 2 and audio.shape[0] > audio.shape[1] and audio.shape[1] <= 8:
        audio = audio.T

    if audio.ndim != 2:
        raise ValueError(f"Expected 2D audio array, got shape {audio.shape}")

    channels, samples = audio.shape

    if channels < 1 or channels > 8:
        raise ValueError(f"Audio must have between 1 and 8 channels, got {channels}")

    if samples < sr * 0.1:
        raise ValueError("Audio is shorter than 0.1s - too short to process")

    if samples > sr * 3600:
        raise ValueError("Audio exceeds 1 hour - please upload a shorter file")

    # NaN / Inf cleanup
    if np.any(~np.isfinite(audio)):
        audio = np.nan_to_num(audio, nan=0.0, posinf=1.0, neginf=-1.0)

    # Peak check: if peak exceeds 1.0 (e.g. 32-bit float headroom), normalize smoothly
    peak = float(np.max(np.abs(audio))) if audio.size > 0 else 0.0
    if peak > 1.0:
        audio = audio / peak

    return audio


def to_stereo(audio: np.ndarray) -> np.ndarray:
    """
    Ensure audio is stereo (2, samples).
    Mono → duplicated to stereo. Multi-channel → first two channels.
    """
    if audio.ndim == 1:
        audio = audio[np.newaxis, :]

    channels = audio.shape[0]
    if channels == 1:
        return np.concatenate([audio, audio], axis=0)
    elif channels >= 2:
        return audio[:2]
    return audio


def remove_dc_offset(audio: np.ndarray) -> np.ndarray:
    """
    Remove DC offset per channel.
    """
    return audio - audio.mean(axis=1, keepdims=True)


def apply_safety_hpf(audio: np.ndarray, sr: int, cutoff_hz: float = INPUT_HPF_HZ) -> np.ndarray:
    """
    Apply a gentle safety high-pass filter to remove subsonic content.
    Uses scipy butterworth if available, with a stable 1-pole IIR fallback.
    """
    try:
        from scipy.signal import butter, sosfilt  # type: ignore
        sos = butter(2, cutoff_hz / (sr / 2), btype='highpass', output='sos')
        return sosfilt(sos, audio, axis=1).astype(np.float32)
    except (ImportError, ModuleNotFoundError):
        # 1-pole RC high-pass filter fallback in pure NumPy
        alpha = 1.0 / (1.0 + 2.0 * np.pi * (cutoff_hz / sr))
        out = np.zeros_like(audio, dtype=np.float32)
        for c in range(audio.shape[0]):
            x = audio[c]
            y = np.empty_like(x)
            y[0] = x[0]
            for n in range(1, len(x)):
                y[n] = alpha * (y[n-1] + x[n] - x[n-1])
            out[c] = y
        return out


def resample(audio: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    """
    Resample audio to target sample rate.
    Uses scipy resample_poly if available, with linear interpolation fallback.
    """
    if src_sr == dst_sr:
        return audio

    try:
        from scipy.signal import resample_poly  # type: ignore
        from math import gcd

        g = gcd(dst_sr, src_sr)
        up = dst_sr // g
        down = src_sr // g
        resampled = resample_poly(audio, up, down, axis=1)
        return resampled.astype(np.float32)
    except (ImportError, ModuleNotFoundError):
        # Pure NumPy linear interpolation fallback
        orig_len = audio.shape[1]
        new_len = int(round(orig_len * dst_sr / src_sr))
        t_orig = np.linspace(0.0, 1.0, orig_len, endpoint=False)
        t_new = np.linspace(0.0, 1.0, new_len, endpoint=False)
        resampled = np.zeros((audio.shape[0], new_len), dtype=np.float32)
        for c in range(audio.shape[0]):
            resampled[c] = np.interp(t_new, t_orig, audio[c]).astype(np.float32)
        return resampled


def preprocess(
    audio: np.ndarray,
    sr: int,
    target_sr: int = MODEL_SAMPLE_RATE,
) -> Tuple[np.ndarray, int]:
    """
    Full preprocessing pipeline:
      validate → to_stereo → remove_dc → hpf → resample

    Returns (processed_audio, sample_rate).
    audio shape: (2, samples) float32.
    """
    audio = validate_audio(audio, sr)
    audio = to_stereo(audio)
    audio = remove_dc_offset(audio)
    audio = apply_safety_hpf(audio, sr)
    audio = resample(audio, sr, target_sr)
    return audio, target_sr


def save_audio(audio: np.ndarray, path: Union[str, Path], sr: int) -> None:
    """
    Save a (channels, samples) float32 array to WAV.
    """
    path_str = str(path)
    if _HAS_SOUNDFILE:
        try:
            sf.write(path_str, audio.T, sr, subtype="FLOAT")
            return
        except Exception:
            pass

    # Fallback to standard wave module (16-bit PCM WAV)
    import wave
    with wave.open(path_str, 'wb') as wf:
        channels = audio.shape[0]
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        clamped = np.clip(audio, -1.0, 1.0)
        pcm16 = (clamped * 32767.0).astype(np.int16)
        interleaved = pcm16.T.flatten()
        wf.writeframes(interleaved.tobytes())
