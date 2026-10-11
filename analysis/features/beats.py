"""Beats: librosa beat tracker + a cheap downbeat guess.

The tracked beat is the meter's pulse (the denominator note: a quarter in
4/4, an eighth in 9/8). Bars are `pulses` tracked beats long, counted by beat
index, so a beat the tracker drops or inserts shifts the bar phase after it.
Downbeats are APPROXIMATE: the phase (which pulse is "1") is picked as the one
with the most low-band percussive energy (kick drums tend to land on 1).
The meter is given, not detected (default 4/4).

Each beat gets `bar_pos` (0 .. pulses-1) and `group_start` (first pulse of a
group: every beat in simple meters, every dotted quarter in 9/8 = 3+3+3).
"""
from __future__ import annotations

import librosa
import numpy as np

from .common import HOP, RATE, Audio

DEFAULT_METER = "4/4"


def parse_meter(meter: str = DEFAULT_METER, groups: str | None = None) -> dict:
    """'9/8' (+ optional groups '2+2+2+3') -> {pulses, unit, groups}.
    Without groups: compound meters (6/8, 9/8, 12/8) group in 3s, others in 1s."""
    try:
        num, den = (int(x) for x in meter.split("/"))
    except ValueError:
        raise ValueError(f"meter must look like 9/8, got {meter!r}") from None
    if num < 1 or den < 1:
        raise ValueError(f"bad meter {meter!r}")
    if groups:
        g = [int(x) for x in groups.split("+")]
        if sum(g) != num or min(g) < 1:
            raise ValueError(f"groups {groups!r} must add up to {num}")
    elif den == 8 and num % 3 == 0 and num > 3:
        g = [3] * (num // 3)
    else:
        g = [1] * num
    return {"pulses": num, "unit": den, "groups": g}


ALIGN_WIN = 0.08   # s, search window for the onset nearest each beat
ALIGN_MIN = 0.01   # s, only correct a median offset larger than this


def beats(a: Audio, kick_env: np.ndarray | None = None,
          onset_times: np.ndarray | None = None, meter: dict | None = None) -> dict:
    meter = meter or parse_meter()
    per_bar = meter["pulses"]
    group_starts = set(np.cumsum([0] + meter["groups"][:-1]).tolist())
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
    if kick_env is not None and len(bt) >= 2 * per_bar:
        idx = np.clip(np.round(bt * RATE).astype(int), 0, len(kick_env) - 1)
        # max of kick env within +-30 ms of each beat
        k = np.array([kick_env[max(0, i - 3): i + 4].max() for i in idx])
        score = [k[p::per_bar].mean() for p in range(per_bar)]
        phase = int(np.argmax(score))

    out = []
    for i, t in enumerate(bt):
        pos = (i - phase) % per_bar
        out.append({"t": float(t), "downbeat": pos == 0, "bar_pos": int(pos), "group_start": pos in group_starts})
    return {"beats": out, "tempo": float(np.atleast_1d(tempo)[0]), "phase": phase, "offset": offset, "meter": meter}
