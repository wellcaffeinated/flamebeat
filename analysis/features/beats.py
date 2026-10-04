"""Beats: librosa beat tracker + a cheap downbeat guess.

Downbeats are APPROXIMATE: every 4th beat (4/4 assumed). The phase (which of
the 4 beats is "1") is picked as the one with the most low-band percussive
energy (kick drums tend to land on 1), which is better than always starting
at beat 0 but still a heuristic.
"""
from __future__ import annotations

import librosa
import numpy as np

from .common import HOP, RATE, Audio

BEATS_PER_BAR = 4


ALIGN_WIN = 0.08   # s, search window for the onset nearest each beat
ALIGN_MIN = 0.01   # s, only correct a median offset larger than this


def beats(a: Audio, kick_env: np.ndarray | None = None,
          onset_times: np.ndarray | None = None) -> dict:
    oenv = librosa.onset.onset_strength(y=a.y, sr=a.sr, hop_length=HOP)
    tempo, frames = librosa.beat.beat_track(onset_envelope=oenv, sr=a.sr, hop_length=HOP)
    bt = librosa.frames_to_time(frames, sr=a.sr, hop_length=HOP)

    # librosa's beats sit consistently a little after the percussive onsets on
    # our test track; shift the whole grid by the median beat->onset offset.
    offset = 0.0
    if onset_times is not None and len(onset_times) and len(bt):
        on = np.sort(np.asarray(onset_times))
        j = np.searchsorted(on, bt).clip(1, len(on) - 1)
        near = np.where(np.abs(on[j - 1] - bt) < np.abs(on[j] - bt), on[j - 1], on[j])
        d = near - bt
        d = d[np.abs(d) <= ALIGN_WIN]
        if len(d) > len(bt) // 4 and abs(np.median(d)) > ALIGN_MIN:
            offset = float(np.median(d))
            bt = np.clip(bt + offset, 0.0, a.duration)

    phase = 0
    if kick_env is not None and len(bt) >= 2 * BEATS_PER_BAR:
        idx = np.clip(np.round(bt * RATE).astype(int), 0, len(kick_env) - 1)
        # max of kick env within +-30 ms of each beat
        k = np.array([kick_env[max(0, i - 3): i + 4].max() for i in idx])
        score = [k[p::BEATS_PER_BAR].mean() for p in range(BEATS_PER_BAR)]
        phase = int(np.argmax(score))

    out = [{"t": float(t), "downbeat": bool((i - phase) % BEATS_PER_BAR == 0)} for i, t in enumerate(bt)]
    return {"beats": out, "tempo": float(np.atleast_1d(tempo)[0]), "phase": phase, "offset": offset}
