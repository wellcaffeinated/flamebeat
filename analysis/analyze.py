"""flamebeat offline analysis: audio file -> timeline JSON (schema v1, see PLAN.md).

usage: uv run python analyze.py <audio> -o <timeline.json>
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

from features.common import RATE, SR, load
from features.energy import energy
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
    args = ap.parse_args(argv)

    t0 = time.time()

    def step(name):
        print(f"[{time.time() - t0:6.1f}s] {name}", file=sys.stderr, flush=True)

    step("load")
    a = load(args.audio)

    step("volume")
    vol = volume(a)

    step("energy")
    en = energy(a, onset_times=None)
    en.pop("_raw_db")

    continuous = {
        "volume": vol["volume"],
        "volume_db": vol["volume_db"],
        "rms_db": vol["rms_db"],
        "energy": en,
    }
    events: dict = {"drums": [], "onsets": [], "notes": [], "beats": []}

    timeline = {
        "version": 1,
        "track": {"file": os.path.basename(args.audio), "duration": round(a.duration, 3), "sr": SR},
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
