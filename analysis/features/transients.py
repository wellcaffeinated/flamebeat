"""Transients: onset detection on the HPSS percussive part, per-band envelopes,
adaptive-threshold peak picking and kick / snare / hat classification."""
from __future__ import annotations

import librosa
import numpy as np
from scipy.ndimage import maximum_filter1d, median_filter
from scipy.signal import find_peaks

from .common import RATE, Audio

# ---- tuning (see PLAN.md progress log for how these were chosen) ----------
DRUM_BANDS = {           # Hz on the percussive spectrogram
    "kick": (30, 150),
    "snare": (150, 5000),
    "hat": (6000, 11025),
}
LOG_GAIN = 100.0         # log1p(LOG_GAIN * |P|) compression before flux
MED_WIN = 0.5            # s, moving-median window of the adaptive threshold
MAD_K = {"kick": 2.0, "snare": 2.0, "hat": 2.0}     # threshold = median + k * MAD
ABS_FLOOR = {"kick": 0.15, "snare": 0.15, "hat": 0.12}   # fraction of the env's p99.5
MIN_GAP = {"kick": 0.10, "snare": 0.10, "hat": 0.05}    # s, minimum spacing
SNARE_OVER_KICK = 0.8    # snare needs snare_env >= k * kick_env (normalised) at the peak
SNARE_NEEDS_HAT = 0.10   # ... and some broadband top end (normalised hat env)
HAT_NEAR_SNARE = 0.03    # s, hats this close to a snare are treated as snare noise
# ---------------------------------------------------------------------------


def _band_flux(a: Audio, spec_log: np.ndarray, lo: float, hi: float) -> np.ndarray:
    sel = (a.freqs >= lo) & (a.freqs < hi)
    d = np.diff(spec_log[sel], axis=1, prepend=spec_log[sel][:, :1])
    return np.maximum(d, 0.0).mean(axis=0)


def _adaptive_peaks(env: np.ndarray, kind: str) -> tuple[np.ndarray, np.ndarray]:
    """env on the RATE grid, normalised. Returns (frame idx, threshold array)."""
    w = max(3, int(MED_WIN * RATE) | 1)
    med = median_filter(env, size=w, mode="nearest")
    mad = median_filter(np.abs(env - med), size=w, mode="nearest")
    thr = np.maximum(med + MAD_K[kind] * mad, ABS_FLOOR[kind])
    # local max over +-2 frames so find_peaks doesn't fire on plateaus twice
    peaks, _ = find_peaks(env, height=thr, distance=max(1, int(MIN_GAP[kind] * RATE)))
    return peaks, thr


def transients(a: Audio) -> dict:
    _, perc = a.hpss
    spec_log = np.log1p(LOG_GAIN * perc)

    env, thr = {}, {}
    for name, (lo, hi) in DRUM_BANDS.items():
        e = a.to_grid(_band_flux(a, spec_log, lo, hi), a.frame_t)
        env[name] = np.clip(e / max(np.percentile(e, 99.5), 1e-9), 0.0, 1.0)

    picks = {k: _adaptive_peaks(env[k], k) for k in env}
    for k in picks:
        thr[k] = picks[k][1]

    def strength(kind, i):
        # peak height relative to the 99th percentile of this band's peaks
        p = env[kind][picks[kind][0]]
        ref = np.percentile(p, 99) if len(p) else 1.0
        return float(np.clip(env[kind][i] / max(ref, 1e-9), 0.0, 1.0))

    drums = []
    for i in picks["kick"][0]:
        drums.append({"t": i / RATE, "type": "kick", "strength": strength("kick", i)})

    # local max of the kick env around the snare peak (kick + snare can coincide)
    kick_local = maximum_filter1d(env["kick"], size=3)
    snare_t = []
    for i in picks["snare"][0]:
        if env["snare"][i] < SNARE_OVER_KICK * kick_local[i]:
            continue
        if env["hat"][max(0, i - 2): i + 3].max() < SNARE_NEEDS_HAT:
            continue
        snare_t.append(i / RATE)
        drums.append({"t": i / RATE, "type": "snare", "strength": strength("snare", i)})
    snare_t = np.array(snare_t)

    for i in picks["hat"][0]:
        t = i / RATE
        if len(snare_t) and np.min(np.abs(snare_t - t)) <= HAT_NEAR_SNARE:
            continue
        drums.append({"t": t, "type": "hat", "strength": strength("hat", i)})
    drums.sort(key=lambda d: d["t"])

    # generic onsets on the full-mix spectral flux
    oenv = librosa.onset.onset_strength(y=a.y, sr=a.sr, hop_length=220)
    of = librosa.onset.onset_detect(onset_envelope=oenv, sr=a.sr, hop_length=220, units="frames")
    on_ref = np.percentile(oenv[of], 99) if len(of) else 1.0
    ot = librosa.frames_to_time(of, sr=a.sr, hop_length=220)
    onsets = [{"t": float(t), "strength": float(np.clip(oenv[f] / on_ref, 0, 1))} for t, f in zip(ot, of)]

    return {"drums": drums, "onsets": onsets, "env": env, "thr": thr}
