"""Perceived intensity, built from what makes the loud, busy parts of a track
feel intense: brightness, rhythmic density, bass weight and harmonic
complexity. Each ingredient is averaged over a few seconds (centred: the
whole track is known), scaled 0..1 for the track, and the four are averaged.

The ingredients are stored too, so routes can re-weight them.
"""
from __future__ import annotations

import librosa
import numpy as np

from .common import RATE, Audio, robust_norm, smooth

WINDOW = 3.0            # s, averaging of each ingredient
FINAL_SMOOTH = 1.0      # s, on the combined value
WEIGHTS = {"brightness": 0.25, "rhythm": 0.25, "low": 0.25, "harmony": 0.25}


def _events_per_second(events: list, n: int) -> np.ndarray:
    d = np.zeros(n)
    for e in events:
        i = int(round(e["t"] * RATE))
        if 0 <= i < n:
            d[i] += e.get("strength", 1.0)
    return smooth(d, WINDOW) * RATE


def _polyphony(notes: list, n: int) -> np.ndarray:
    """Number of transcribed notes sounding at each frame (velocity-weighted)."""
    d = np.zeros(n + 1)
    for nt in notes:
        i0 = int(round(nt["t"] * RATE))
        i1 = int(round((nt["t"] + nt["dur"]) * RATE))
        if i0 < n and i1 > i0:
            d[max(0, i0)] += nt.get("vel", 1.0)
            d[min(n, i1)] -= nt.get("vel", 1.0)
    return np.cumsum(d)[:n]


def intensity(a: Audio, drums: list, band_db: dict, chroma: np.ndarray, notes: list) -> dict:
    n = a.n_grid

    # brightness: log spectral centroid; the quietest frames (silence, fades)
    # carry no timbre, so they get the track's lowest value instead of noise
    cen = librosa.feature.spectral_centroid(S=a.mag, sr=a.sr)[0]
    power = (a.mag ** 2).sum(axis=0)
    logc = np.log(cen + 1.0)
    quiet = power < np.percentile(power, 5)
    logc[quiet] = np.percentile(logc[~quiet], 1) if (~quiet).any() else 0.0
    brightness = a.to_grid(logc, a.frame_t[: len(logc)])

    # rhythmic density: drum hits per second, weighted by strength
    rhythm = _events_per_second(drums, n)

    # bass weight: total sub+bass power in dB (one scale for both bands, so a
    # full low end counts more than a quiet one at its own peak)
    low = 10 * np.log10(10 ** (band_db["sub"] / 10) + 10 ** (band_db["bass"] / 10) + 1e-12)

    # harmonic complexity: spread of the 12 pitch classes (normalised entropy;
    # 0 = one note, 1 = all equal), weighted by how much harmony is sounding,
    # plus how many transcribed notes sound at once
    c = np.maximum(np.asarray(chroma, float), 0.0)
    tot = c.sum(axis=1, keepdims=True)
    p = c / np.maximum(tot, 1e-9)
    ent = -(p * np.log(np.maximum(p, 1e-12))).sum(axis=1) / np.log(12)
    ent *= np.clip(tot[:, 0] / max(np.percentile(tot, 95), 1e-9), 0, 1)   # chroma is gated: quiet harmony -> low
    ent = ent[:n] if len(ent) >= n else np.pad(ent, (0, n - len(ent)), mode="edge")
    harmony = robust_norm(smooth(ent, WINDOW), 2, 98)
    if notes:
        harmony = 0.5 * harmony + 0.5 * robust_norm(smooth(_polyphony(notes, n), WINDOW), 2, 98)

    parts = {
        "brightness": robust_norm(smooth(brightness, WINDOW), 2, 98),
        "rhythm": robust_norm(rhythm, 2, 98),
        "low": robust_norm(smooth(low, WINDOW), 2, 98),
        "harmony": robust_norm(harmony, 2, 98),
    }
    combo = sum(WEIGHTS[k] * v for k, v in parts.items())
    return {"intensity": robust_norm(smooth(combo, FINAL_SMOOTH), 1, 99.5), **parts}
