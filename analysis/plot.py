"""Diagnostic plot of a flamebeat timeline: every stream and event over time.

usage: uv run python plot.py <timeline.json> [-o out.png] [--start S --dur D]
Writes the full-track overview to out.png and, if --dur is given (default 12 s
from --start 60), a zoomed window to out_zoom.png for checking drum hits by eye.
"""
from __future__ import annotations

import argparse
import json
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

DRUM_COLORS = {"kick": "#d62728", "snare": "#1f77b4", "hat": "#2ca02c"}
PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def render(tl: dict, out: str, t0: float = 0.0, t1: float | None = None) -> None:
    rate = tl["rate"]
    c, ev = tl["continuous"], tl["events"]
    n = len(c["volume"])
    t = np.arange(n) / rate
    t1 = t[-1] if t1 is None else t1
    sl = slice(int(t0 * rate), int(t1 * rate) + 1)
    zoom = (t1 - t0) < 60
    inwin = lambda e: t0 <= e["t"] <= t1  # noqa: E731

    panels = ["volume", "energy", "flux", "drums_env", "drums", "chroma", "bass", "notes"]
    fig, axes = plt.subplots(len(panels), 1, figsize=(18 if not zoom else 16, 20), sharex=True,
                             gridspec_kw={"height_ratios": [1, 1.2, 1, 1.4, 0.8, 1.2, 1, 1.2]})
    ax = dict(zip(panels, axes))

    def beats(a, alpha=0.25):
        for b in filter(inwin, ev.get("beats", [])):
            a.axvline(b["t"], color="k" if b.get("downbeat") else "0.5",
                      lw=1.2 if b.get("downbeat") else 0.5, alpha=alpha if zoom else alpha / 3)

    a = ax["volume"]
    a.plot(t[sl], c["volume"][sl], lw=0.8, label="volume (LUFS→0..1)")
    a2 = a.twinx()
    a2.plot(t[sl], c["volume_db"][sl], lw=0.5, color="0.6", label="momentary LUFS")
    a2.set_ylabel("LUFS")
    a.set_ylabel("volume"); a.legend(loc="upper left", fontsize=8)

    a = ax["energy"]
    for k in ("sub", "bass", "mid", "high"):
        a.plot(t[sl], c["energy"][k][sl], lw=0.7, label=k)
    a.plot(t[sl], c["energy"]["intensity"][sl], lw=2, color="k", label="intensity")
    a.set_ylabel("energy"); a.legend(loc="upper left", fontsize=8, ncol=5)

    a = ax["flux"]
    a.plot(t[sl], c["energy"]["flux"][sl], lw=0.6, color="purple", label="flux")
    for o in filter(inwin, ev.get("onsets", [])):
        a.plot([o["t"], o["t"]], [0, o["strength"]], color="orange", lw=0.8 if zoom else 0.3)
    a.set_ylabel("flux / onsets"); a.legend(loc="upper left", fontsize=8)

    a = ax["drums_env"]
    if "drums" in c:
        for i, k in enumerate(("kick", "snare", "hat")):
            a.plot(t[sl], np.asarray(c["drums"][k][sl]) + 1.1 * (2 - i), lw=0.6,
                   color=DRUM_COLORS[k], label=f"{k} env")
    for d in filter(inwin, ev.get("drums", [])):
        i = ("kick", "snare", "hat").index(d["type"])
        a.plot(d["t"], 1.1 * (2 - i) + d["strength"], "v", ms=4 if zoom else 1.5,
               color=DRUM_COLORS[d["type"]])
    beats(a)
    a.set_yticks([0.5, 1.6, 2.7], ["hat", "snare", "kick"]); a.set_ylabel("percussive envs")

    a = ax["drums"]
    for i, k in enumerate(("kick", "snare", "hat")):
        ts = [d["t"] for d in ev.get("drums", []) if d["type"] == k and inwin(d)]
        a.vlines(ts, 2 - i, 2 - i + 0.8, color=DRUM_COLORS[k], lw=1.0 if zoom else 0.3)
        a.text(1.001, (2 - i + 0.4) / 3, f"{k}: {len(ts)}", transform=a.transAxes, fontsize=8)
    beats(a, 0.5)
    a.set_yticks([0.4, 1.4, 2.4], ["hat", "snare", "kick"]); a.set_ylabel("drum events")

    a = ax["chroma"]
    if c.get("chroma"):
        ch = np.asarray(c["chroma"])[sl].T
        a.imshow(ch, aspect="auto", origin="lower", extent=[t[sl][0], t[sl][-1], -0.5, 11.5],
                 cmap="magma", interpolation="nearest")
        a.set_yticks(range(12), PITCH_NAMES, fontsize=7)
    a.set_ylabel("chroma")

    a = ax["bass"]
    pb = c.get("pitch", {}).get("bass")
    if pb:
        f0 = np.asarray(pb["f0"], dtype=float)[sl]
        conf = np.asarray(pb["conf"], dtype=float)[sl]
        f0m = np.where(f0 > 0, f0, np.nan)
        a.scatter(t[sl], f0m, c=conf, s=2, cmap="viridis", vmin=0, vmax=1)
        a.set_yscale("log"); a.set_ylim(35, 300)
        a2 = a.twinx(); a2.plot(t[sl], conf, lw=0.4, color="0.6"); a2.set_ylim(0, 3)
    a.set_ylabel("bass f0 (Hz)")

    a = ax["notes"]
    for nt in ev.get("notes", []):
        if nt["t"] + nt["dur"] < t0 or nt["t"] > t1:
            continue
        a.plot([nt["t"], nt["t"] + nt["dur"]], [nt["midi"]] * 2, lw=2,
               color=plt.cm.plasma(nt["vel"]), solid_capstyle="butt")
    a.set_ylabel("notes (MIDI)")
    a.set_xlabel("time (s)")
    a.set_xlim(t0, t1)

    fig.suptitle(f"{tl['track']['file']}  {t0:.1f}–{t1:.1f}s  "
                 f"(drums {len(ev.get('drums', []))}, onsets {len(ev.get('onsets', []))}, "
                 f"beats {len(ev.get('beats', []))}, notes {len(ev.get('notes', []))})")
    fig.tight_layout()
    fig.savefig(out, dpi=80)
    plt.close(fig)
    print(f"wrote {out}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("timeline")
    ap.add_argument("-o", "--out")
    ap.add_argument("--start", type=float, default=60.0)
    ap.add_argument("--dur", type=float, default=12.0)
    args = ap.parse_args(argv)
    with open(args.timeline) as f:
        tl = json.load(f)
    out = args.out or os.path.splitext(args.timeline)[0] + ".png"
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    render(tl, out)
    if args.dur > 0:
        root, ext = os.path.splitext(out)
        render(tl, f"{root}_zoom{ext}", args.start, args.start + args.dur)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
