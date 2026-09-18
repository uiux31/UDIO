"""
chunking.py — Overlap-Add Chunking for Long Tracks

Splits a long audio array into overlapping chunks for batch AI inference,
then reconstructs using weighted overlap-add with a Hann window.

This avoids boundary artifacts that occur when independently concatenating
separately processed chunks.
"""

import sys
from pathlib import Path
from typing import List, Tuple
import numpy as np

_backend_dir = str(Path(__file__).resolve().parent.parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from config import CHUNK_DURATION_S, CHUNK_OVERLAP_S, CHUNKING_THRESHOLD_S


def should_chunk(audio: np.ndarray, sr: int) -> bool:
    """True if the track is long enough to require chunking."""
    duration = audio.shape[1] / sr
    return duration > CHUNKING_THRESHOLD_S


def split_into_chunks(
    audio: np.ndarray,
    sr: int,
    chunk_s: float = CHUNK_DURATION_S,
    overlap_s: float = CHUNK_OVERLAP_S,
) -> Tuple[List[np.ndarray], int, int]:
    """
    Split (channels, samples) audio into overlapping chunks.

    Returns:
        chunks       — list of (channels, chunk_samples) arrays
        hop_samples  — non-overlapping hop size in samples
        chunk_samples— total chunk length in samples
    """
    total_samples = audio.shape[1]
    chunk_samples = int(chunk_s * sr)
    overlap_samples = int(overlap_s * sr)
    hop_samples = chunk_samples - overlap_samples

    chunks = []
    start = 0
    while start < total_samples:
        end = min(start + chunk_samples, total_samples)
        chunk = audio[:, start:end]

        # Pad the last chunk if it is shorter than chunk_samples
        if chunk.shape[1] < chunk_samples:
            pad = chunk_samples - chunk.shape[1]
            chunk = np.pad(chunk, ((0, 0), (0, pad)), mode='constant')

        chunks.append(chunk)
        start += hop_samples
        if end == total_samples:
            break

    return chunks, hop_samples, chunk_samples


def reconstruct_from_chunks(
    stem_chunks: List[np.ndarray],
    hop_samples: int,
    chunk_samples: int,
    total_samples: int,
    channels: int = 2,
) -> np.ndarray:
    """
    Weighted overlap-add reconstruction using a Hann window.

    Args:
        stem_chunks   — list of (channels, chunk_samples) processed stems
        hop_samples   — non-overlapping step size
        chunk_samples — full chunk length
        total_samples — desired output length (from original audio)
        channels      — number of output channels

    Returns:
        (channels, total_samples) float32 array
    """
    # Hann window for smooth crossfade at chunk boundaries
    window = np.hanning(chunk_samples).astype(np.float32)

    output = np.zeros((channels, total_samples), dtype=np.float32)
    weight = np.zeros(total_samples, dtype=np.float32)

    for i, chunk in enumerate(stem_chunks):
        start = i * hop_samples
        end = min(start + chunk_samples, total_samples)
        chunk_end = end - start  # actual samples to copy (may be < chunk_samples at end)

        output[:, start:end] += chunk[:, :chunk_end] * window[:chunk_end]
        weight[start:end] += window[:chunk_end]

    # Normalize by accumulated window weight (avoid divide-by-zero at edges)
    weight = np.maximum(weight, 1e-8)
    output /= weight[np.newaxis, :]

    return output


class ChunkProcessor:
    """
    Convenience wrapper: split → process each chunk → reconstruct.

    Usage:
        processor = ChunkProcessor(audio, sr)
        for i, chunk in processor.iter_chunks():
            separated = model.infer(chunk)
            processor.add_result(i, stem_name, separated)
        stems = processor.reconstruct()
    """

    def __init__(self, audio: np.ndarray, sr: int):
        self.sr = sr
        self.total_samples = audio.shape[1]
        self.channels = audio.shape[0]

        self.chunks, self.hop_samples, self.chunk_samples = split_into_chunks(
            audio, sr
        )
        self._results: dict[str, List[np.ndarray | None]] = {}

    def iter_chunks(self):
        for i, chunk in enumerate(self.chunks):
            yield i, chunk

    def n_chunks(self) -> int:
        return len(self.chunks)

    def add_result(self, chunk_idx: int, stem_name: str, stem_audio: np.ndarray):
        if stem_name not in self._results:
            self._results[stem_name] = [None] * len(self.chunks)
        self._results[stem_name][chunk_idx] = stem_audio

    def reconstruct(self) -> dict[str, np.ndarray]:
        """
        Reconstruct all stems via overlap-add.
        Returns dict: stem_name → (channels, total_samples) array.
        """
        stems = {}
        for stem_name, chunk_list in self._results.items():
            # Replace any None (failed) chunks with silence
            clean = []
            for chunk in chunk_list:
                if chunk is None:
                    clean.append(np.zeros((self.channels, self.chunk_samples), dtype=np.float32))
                else:
                    clean.append(chunk)

            stems[stem_name] = reconstruct_from_chunks(
                clean,
                self.hop_samples,
                self.chunk_samples,
                self.total_samples,
                self.channels,
            )
        return stems
