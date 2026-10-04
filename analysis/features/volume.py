"""Volume: momentary loudness (ITU-R BS.1770 K-weighting, 400 ms window) + RMS dB."""
from __future__ import annotations

import numpy as np
import pyloudnorm as pyln
from scipy.ndimage import uniform_filter1d

from .common import RATE, Audio, db, robust_norm

LUFS_FLOOR = -60.0   # anything quieter maps to 0


def volume(a: Audio) -> dict:
    meter = pyln.Meter(a.sr)               # K-weighting filters for this sample rate
    k = a.y.astype(np.float64)
    for f in meter._filters.values():      # high-shelf + high-pass (BS.1770)
        k = f.apply_filter(k)

    win = int(round(0.4 * a.sr))           # momentary: 400 ms
    ms = uniform_filter1d(k * k, win, mode="constant")
    # value at sample n describes the window centred on n; sample at grid times
    idx = np.minimum((a.grid_t * a.sr).astype(int), len(ms) - 1)
    lufs = -0.691 + db(ms[idx])
    lufs = np.maximum(lufs, LUFS_FLOOR - 10)

    rms_win = int(round(0.05 * a.sr))      # short RMS (50 ms) for snappier response
    rms = np.sqrt(uniform_filter1d(a.y.astype(np.float64) ** 2, rms_win, mode="constant")[idx])
    rms_db = 20 * np.log10(np.maximum(rms, 1e-6))

    return {
        "volume": robust_norm(lufs, 1, 99.5, floor=LUFS_FLOOR),
        "volume_db": lufs,                 # momentary LUFS
        "rms_db": rms_db,
    }
