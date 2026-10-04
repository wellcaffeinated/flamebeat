"""Energy: band energies, spectral flux and a combined, smoothed `intensity`."""
from __future__ import annotations

import librosa
import numpy as np

from .common import HOP, Audio, db, robust_norm, smooth

BANDS = {            # Hz, [lo, hi)
    "sub": (20, 60),
    "bass": (60, 250),
    "mid": (250, 2000),
    "high": (2000, 11025),
}


def band_power(a: Audio, lo: float, hi: float, spec: np.ndarray | None = None) -> np.ndarray:
    spec = a.mag if spec is None else spec
    sel = (a.freqs >= lo) & (a.freqs < hi)
    return (spec[sel] ** 2).sum(axis=0)


def energy(a: Audio, onset_times: np.ndarray | None = None) -> dict:
    out: dict = {}
    raw_db = {}
    for name, (lo, hi) in BANDS.items():
        p = a.to_grid(db(band_power(a, lo, hi)), a.frame_t)
        raw_db[name] = p
        # 30 dB of usable range below the loud end of each band
        hi_v = np.percentile(p, 99.5)
        out[name] = robust_norm(p, 2, 99.5, floor=hi_v - 30.0)

    # spectral flux: librosa onset strength (log-mel, positive diff, mean over bands)
    flux = librosa.onset.onset_strength(S=librosa.power_to_db(
        librosa.feature.melspectrogram(S=a.mag ** 2, sr=a.sr)), sr=a.sr)
    flux = a.to_grid(flux, a.frame_t[: len(flux)])
    out["flux"] = robust_norm(flux, 0, 99.5)

    # onset density: onsets per second, smoothed over ~2 s
    dens = np.zeros(a.n_grid)
    if onset_times is not None and len(onset_times):
        idx = np.clip(np.round(np.asarray(onset_times) * 100).astype(int), 0, a.n_grid - 1)
        np.add.at(dens, idx, 1.0)
    dens = smooth(dens, 2.0) * 100.0   # events / s

    band_mean = np.mean([out[k] for k in ("bass", "mid", "high")], axis=0)
    combo = (0.4 * smooth(out["flux"], 0.5)
             + 0.25 * robust_norm(dens, 0, 99.5)
             + 0.35 * band_mean)
    out["intensity"] = robust_norm(smooth(combo, 0.75), 1, 99.5)
    out["_raw_db"] = raw_db
    return out
