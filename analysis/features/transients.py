"""Transients: onset detection on the HPSS percussive part, then per-onset
kick / snare / hat classification from band features.

1. Per-band positive log-spectral flux of the percussive spectrogram,
   each normalised by its own 99.5th percentile.
2. Candidates = peaks of the summed band envelopes above an adaptive
   threshold (moving median + k * moving MAD, plus an absolute floor).
3. Each candidate is classified from its band values (max over +-1 frame).
   A candidate can be kick AND snare/hat at once (layered hits).
"""
from __future__ import annotations

import librosa
import numpy as np
from scipy.ndimage import median_filter
from scipy.signal import find_peaks

from .common import HOP, RATE, Audio

# ---- tuning (values chosen on the test track, see PLAN.md log) ------------
BANDS = {                # Hz on the percussive spectrogram
    "kick": (30, 120),
    "snare": (1000, 4000),
    "hat": (7000, 11025),
}
LOG_GAIN = 100.0         # log1p(LOG_GAIN * |P|) compression before flux
MED_WIN = 1.0            # s, moving-median window of the adaptive threshold
MAD_K = 1.5              # threshold = median + MAD_K * MAD (on the summed env)
ABS_FLOOR = 0.25         # summed env (0..3) must also exceed this
MIN_GAP = 0.06           # s, minimum spacing between candidates
KICK_MIN = 0.45          # kick-band value for a kick
SNARE_MIN = 0.65         # snare-band value for a snare ...
SNARE_HAT_MIN = 0.45     # ... which must also be broadband (hat band)
# hats are picked on their own envelope (they are often too quiet to show up
# in the summed envelope), with their own adaptive threshold
HAT_MAD_K = 2.0          # hat threshold = median + HAT_MAD_K * MAD of the hat env
HAT_FLOOR = 0.15         # ... and at least this
HAT_MIN_GAP = 0.05       # s
HAT_SNARE_MAX = 0.5      # a hat needs little 1-4 kHz content (else it's snare noise)
HAT_NEAR_SNARE = 0.03    # s, hat peaks this close to a snare are part of the snare
# ---------------------------------------------------------------------------


def _band_flux(a: Audio, spec_log: np.ndarray, lo: float, hi: float) -> np.ndarray:
    sel = (a.freqs >= lo) & (a.freqs < hi)
    s = spec_log[sel]
    d = np.diff(s, axis=1, prepend=s[:, :1])
    return np.maximum(d, 0.0).mean(axis=0)


def _adaptive_peaks(env, k, floor, gap):
    w = max(3, int(MED_WIN * RATE) | 1)
    med = median_filter(env, size=w, mode="nearest")
    mad = median_filter(np.abs(env - med), size=w, mode="nearest")
    thr = np.maximum(med + k * mad, floor)
    peaks, _ = find_peaks(env, height=thr, distance=max(1, int(gap * RATE)))
    return peaks, thr


def transients(a: Audio) -> dict:
    _, perc = a.hpss
    spec_log = np.log1p(LOG_GAIN * perc)

    env = {}
    for name, (lo, hi) in BANDS.items():
        e = a.to_grid(_band_flux(a, spec_log, lo, hi), a.frame_t)
        env[name] = np.clip(e / max(np.percentile(e, 99.5), 1e-9), 0.0, 1.0)

    total = env["kick"] + env["snare"] + env["hat"]
    cand, thr = _adaptive_peaks(total, MAD_K, ABS_FLOOR, MIN_GAP)

    def feat(name, i):
        return float(env[name][max(0, i - 1): i + 2].max())

    drums = []
    for i in cand:
        k, s, h = feat("kick", i), feat("snare", i), feat("hat", i)
        t = i / RATE
        if k >= KICK_MIN:
            drums.append({"t": t, "type": "kick", "strength": k})
        if s >= SNARE_MIN and h >= SNARE_HAT_MIN:
            drums.append({"t": t, "type": "snare", "strength": s})

    snare_t = np.array([d["t"] for d in drums if d["type"] == "snare"])
    hat_pk, _ = _adaptive_peaks(env["hat"], HAT_MAD_K, HAT_FLOOR, HAT_MIN_GAP)
    hat_ref = np.percentile(env["hat"][hat_pk], 95) if len(hat_pk) else 1.0
    for i in hat_pk:
        t = i / RATE
        if feat("snare", i) >= HAT_SNARE_MAX:
            continue
        if len(snare_t) and np.min(np.abs(snare_t - t)) <= HAT_NEAR_SNARE:
            continue
        drums.append({"t": t, "type": "hat", "strength": float(min(1.0, env["hat"][i] / hat_ref))})
    drums.sort(key=lambda d: (d["t"], d["type"]))

    # generic onsets on the full-mix spectral flux
    oenv = librosa.onset.onset_strength(y=a.y, sr=a.sr, hop_length=HOP)
    of = librosa.onset.onset_detect(onset_envelope=oenv, sr=a.sr, hop_length=HOP, units="frames")
    on_ref = np.percentile(oenv[of], 99) if len(of) else 1.0
    ot = librosa.frames_to_time(of, sr=a.sr, hop_length=HOP)
    onsets = [{"t": float(t), "strength": float(np.clip(oenv[f] / on_ref, 0, 1))} for t, f in zip(ot, of)]

    return {"drums": drums, "onsets": onsets, "env": env, "threshold": thr, "candidates": cand}
