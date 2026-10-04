"""Shared helpers: audio loading, the common 100 Hz output grid, normalisation."""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import cached_property

import librosa
import numpy as np
from scipy.ndimage import uniform_filter1d

SR = 22050
HOP = 220          # ~9.98 ms analysis hop at 22050 Hz
N_FFT = 2048
RATE = 100         # output grid, frames per second (exact)


@dataclass
class Audio:
    path: str
    y: np.ndarray
    sr: int = SR
    _cache: dict = field(default_factory=dict, repr=False)

    @property
    def duration(self) -> float:
        return len(self.y) / self.sr

    @cached_property
    def n_grid(self) -> int:
        return int(np.floor(self.duration * RATE)) + 1

    @cached_property
    def grid_t(self) -> np.ndarray:
        return np.arange(self.n_grid) / RATE

    @cached_property
    def stft(self) -> np.ndarray:
        return librosa.stft(self.y, n_fft=N_FFT, hop_length=HOP).astype(np.complex64)

    @cached_property
    def mag(self) -> np.ndarray:
        return np.abs(self.stft)

    @cached_property
    def freqs(self) -> np.ndarray:
        return librosa.fft_frequencies(sr=self.sr, n_fft=N_FFT)

    @cached_property
    def frame_t(self) -> np.ndarray:
        return librosa.frames_to_time(np.arange(self.mag.shape[1]), sr=self.sr, hop_length=HOP)

    @cached_property
    def hpss(self) -> tuple[np.ndarray, np.ndarray]:
        """(harmonic, percussive) magnitude spectrograms."""
        h, p = librosa.decompose.hpss(self.mag, margin=(1.0, 2.0))
        return h.astype(np.float32), p.astype(np.float32)

    @cached_property
    def y_harmonic(self) -> np.ndarray:
        h, _ = self.hpss
        mask = h / np.maximum(self.mag, 1e-10)
        return librosa.istft(self.stft * mask, hop_length=HOP, length=len(self.y))

    def to_grid(self, values: np.ndarray, times: np.ndarray, kind: str = "linear") -> np.ndarray:
        """Resample a stream sampled at `times` (s) onto the exact RATE grid."""
        values = np.asarray(values, dtype=np.float64)
        if kind == "nearest":
            idx = np.searchsorted(times, self.grid_t).clip(1, len(times) - 1)
            left = times[idx - 1]
            right = times[idx]
            idx = np.where(self.grid_t - left < right - self.grid_t, idx - 1, idx)
            return values[idx]
        return np.interp(self.grid_t, times, values)


def load(path: str) -> Audio:
    y, sr = librosa.load(path, sr=SR, mono=True)
    return Audio(path=path, y=y.astype(np.float32), sr=sr)


def robust_norm(x: np.ndarray, lo_pct: float = 1.0, hi_pct: float = 99.5,
                floor: float | None = None) -> np.ndarray:
    """Map to 0..1 using per-track percentiles (robust to outliers)."""
    lo = np.percentile(x, lo_pct)
    if floor is not None:
        lo = max(lo, floor)
    hi = np.percentile(x, hi_pct)
    if hi - lo < 1e-9:
        return np.zeros_like(x)
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


def smooth(x: np.ndarray, seconds: float, rate: float = RATE) -> np.ndarray:
    n = max(1, int(round(seconds * rate)))
    return uniform_filter1d(x, n, mode="nearest")


def db(x: np.ndarray, eps: float = 1e-10) -> np.ndarray:
    return 10.0 * np.log10(np.maximum(x, eps))
