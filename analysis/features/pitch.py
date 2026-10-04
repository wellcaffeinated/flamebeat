"""Pitch: chroma (CQT, harmonic part), bass f0 (pYIN on a low-passed signal)
and note events (basic-pitch, optional)."""
from __future__ import annotations

import sys

import librosa
import numpy as np
from scipy.signal import butter, sosfiltfilt

from .common import Audio

CHROMA_HOP = 512           # CQT needs a hop divisible by 2**(octaves-1)
BASS_SR = 11025            # pYIN runs on a downsampled, low-passed signal
BASS_LP = 250.0            # Hz
BASS_FMIN, BASS_FMAX = 40.0, 250.0
BASS_HOP = 110             # 10 ms at 11025 Hz
BASS_FRAME = 1024          # 93 ms, >= 2 periods of 40 Hz (50 ms)


def chroma(a: Audio) -> np.ndarray:
    """(n_grid, 12) chroma, each frame max-normalised, gated by harmonic energy."""
    yh = a.y_harmonic
    c = librosa.feature.chroma_cqt(y=yh, sr=a.sr, hop_length=CHROMA_HOP)   # (12, n)
    t = librosa.frames_to_time(np.arange(c.shape[1]), sr=a.sr, hop_length=CHROMA_HOP)
    # gate: near-silent harmonic frames get their chroma scaled down
    rms = librosa.feature.rms(y=yh, frame_length=2048, hop_length=CHROMA_HOP)[0]
    rms_db = 20 * np.log10(np.maximum(rms, 1e-6))
    gate = np.clip((rms_db - (np.percentile(rms_db, 99) - 40)) / 20, 0, 1)
    c = c * gate[None, : c.shape[1]]
    return np.stack([a.to_grid(c[i], t) for i in range(12)], axis=1)


def bass_f0(a: Audio) -> dict:
    sos = butter(6, BASS_LP, btype="low", fs=a.sr, output="sos")
    yl = sosfiltfilt(sos, a.y.astype(np.float64))
    yl = librosa.resample(yl, orig_sr=a.sr, target_sr=BASS_SR)
    f0, voiced, vprob = librosa.pyin(yl, fmin=BASS_FMIN, fmax=BASS_FMAX, sr=BASS_SR,
                                     frame_length=BASS_FRAME, hop_length=BASS_HOP)
    t = librosa.frames_to_time(np.arange(len(f0)), sr=BASS_SR, hop_length=BASS_HOP)
    f0 = np.where(voiced & np.isfinite(f0), f0, 0.0)          # 0 Hz = unvoiced
    return {
        "f0": a.to_grid(f0, t, kind="nearest"),               # don't interpolate across gaps
        "conf": a.to_grid(np.nan_to_num(vprob), t),
    }


def notes(a: Audio) -> tuple[list, str | None]:
    """basic-pitch note events. Returns (notes, error message or None)."""
    try:
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import predict
    except Exception as e:  # pragma: no cover - optional dependency
        return [], f"basic-pitch unavailable: {e!r}"
    _, _, events = predict(
        a.path, ICASSP_2022_MODEL_PATH,
        onset_threshold=0.5, frame_threshold=0.3,
        minimum_note_length=100.0,           # ms
        minimum_frequency=30.0, maximum_frequency=2000.0,
        melodia_trick=True,
    )
    out = []
    for start, end, pitch, amp, _bends in events:
        out.append({"t": float(start), "dur": float(end - start), "midi": int(pitch),
                    "vel": float(np.clip(amp, 0, 1))})
    out.sort(key=lambda n: (n["t"], n["midi"]))
    print(f"  basic-pitch: {len(out)} notes", file=sys.stderr)
    return out, None
