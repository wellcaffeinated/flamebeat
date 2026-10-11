"""flamebeat offline analysis: audio file -> timeline JSON (schema v1, see PLAN.md).

usage: uv run python analyze.py <audio> -o <timeline.json> [--meter 9/8] [--groups 2+2+2+3]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

from features.beats import DEFAULT_METER, beats, parse_meter
from features.common import RATE, SR, load
from features.energy import energy
from features.pitch import bass_f0, chroma, notes
from features.transients import transients
from features.volume import volume


def r4(x):
    """Round floats (recursively) to ~4 significant digits for a compact JSON."""
    if isinstance(x, np.ndarray):
        x = x.tolist()
    if isinstance(x, float):
        return float(f"{x:.4g}") if np.isfinite(x) else 0.0
    if isinstance(x, (np.floating,)):
        return r4(float(x))
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, dict):
        return {k: r4(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [r4(v) for v in x]
    return x


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio")
    ap.add_argument("-o", "--out", required=True, help="output timeline JSON path")
    ap.add_argument("--no-notes", action="store_true", help="skip basic-pitch note transcription")
    ap.add_argument("--meter", default=DEFAULT_METER,
                    help="time signature, e.g. 4/4, 7/8, 9/8; the tracked beat is its pulse (default %(default)s)")
    ap.add_argument("--groups", help="pulse grouping within a bar, e.g. 2+2+2+3 (default: 3s for 6/8 9/8 12/8, else 1s)")
    args = ap.parse_args(argv)
    try:
        meter = parse_meter(args.meter, args.groups)
    except ValueError as e:
        ap.error(str(e))

    t0 = time.time()

    def step(name):
        print(f"[{time.time() - t0:6.1f}s] {name}", file=sys.stderr, flush=True)

    step("load")
    a = load(args.audio)

    step("volume")
    vol = volume(a)

    step("transients")
    tr = transients(a)

    step("beats")
    bt = beats(a, kick_env=tr["env"]["kick"], onset_times=tr["candidates"] / RATE, meter=meter)
    step(f"  tempo {bt['tempo']:.1f} BPM, {len(bt['beats'])} beats, "
         f"grid offset {bt['offset'] * 1000:+.0f} ms, meter {args.meter} {'+'.join(map(str, meter['groups']))}, "
         f"downbeat phase {bt['phase']}")
    counts = {k: sum(d["type"] == k for d in tr["drums"]) for k in ("kick", "snare", "hat")}
    step(f"  drums {counts}, onsets {len(tr['onsets'])}")

    step("energy")
    en = energy(a, onset_times=np.array([o["t"] for o in tr["onsets"]]))
    en.pop("_raw_db")

    step("chroma")
    ch = chroma(a)

    step("bass f0 (pyin)")
    bf = bass_f0(a)

    note_events, note_err = [], "skipped (--no-notes)"
    if not args.no_notes:
        step("notes (basic-pitch)")
        note_events, note_err = notes(a)
        if note_err:
            step(f"  {note_err}")

    continuous = {
        "volume": vol["volume"],
        "volume_db": vol["volume_db"],
        "rms_db": vol["rms_db"],
        "energy": en,
        "drums": tr["env"],              # per-band percussive onset envelopes, 0..1
        "chroma": ch,
        "pitch": {"bass": bf},
    }
    events: dict = {"drums": tr["drums"], "onsets": tr["onsets"], "notes": note_events, "beats": bt["beats"]}

    timeline = {
        "version": 1,
        "track": {"file": os.path.basename(args.audio), "duration": round(a.duration, 3), "sr": SR,
                  "tempo": round(bt["tempo"], 2), "meter": meter},
        "rate": RATE,
        "continuous": continuous,
        "events": events,
    }
    step("write")
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(r4(timeline), f, separators=(",", ":"))
    step(f"done -> {args.out} ({os.path.getsize(args.out) / 1e6:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
