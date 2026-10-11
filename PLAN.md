# flamebeat — plan & progress

Music-synced fractal flame visualizer.

1. **Offline analysis (Python):** turn a song's full mix into a JSON timeline of
   signal streams: volume, energy, transients (drums) and pitch.
2. **Realtime rendering (WebGPU, browser):** a GPU fractal flame renderer that
   plays the song and drives flame parameters from the timeline, kept in sync
   with `audio.currentTime`.

This file is the source of truth for progress. Tick boxes as work lands, and
add a dated line to the **Progress log** at the end of every work session and
whenever a decision changes the plan.

---

## Ground rules

- **Commit often.** One logical step per commit, with a clear message. Never
  leave a working state uncommitted. Don't push. There is no remote yet.
- **Toolchain via mise only.** No `apt install`. Python comes from `uv`
  (already installed by mise), Node from mise. Use `mise use` if you need a new tool.
- **Memory:** the container has a 16 GiB ceiling shared with other sessions.
  Run one analysis process at a time, and don't run ML models in parallel.
  Use `rg`/`fd` and search only inside this repo.
- **Audio files are not committed.** Put them in `assets/audio/` (gitignored)
  and fetch them with a script. License and attribution text *is* committed.
- **Be honest in the log.** If something can't be verified (e.g. WebGPU in
  headless Chromium), say so rather than claiming it works.

## Layout (target)

```
analysis/            uv project (Python): analyze.py + feature modules + plot.py
  pyproject.toml
web/                 static site, no build step, ES modules
  index.html
  src/renderer/      WebGPU flame: compute (chaos game) + tone-map passes, WGSL
  src/timeline.js    loads timeline JSON, samples it at time t
  src/mapping.js     signals → flame parameters (envelopes, clamps)
  src/presets.js     flame presets
assets/audio/        test tracks (gitignored) + ATTRIBUTION.md (committed)
scripts/             fetch-test-track.sh etc.
justfile             common tasks: fetch, analyze, serve
```

## Timeline JSON schema (v1)

```json
{
  "version": 1,
  "track": {"file": "...", "duration": 183.2, "sr": 22050, "tempo": 100.2},
  "rate": 100,
  "continuous": {
    "volume":   [...],                                  // momentary LUFS mapped to 0..1, plus raw dB in "volume_db"
    "volume_db": [...], "rms_db": [...],                // raw momentary LUFS, 50 ms RMS dBFS
    "drums":    {"kick": [...], "snare": [...], "hat": [...]},   // percussive band-flux envelopes 0..1
    "energy":   {"sub": [...], "bass": [...], "mid": [...], "high": [...], "flux": [...], "intensity": [...]},
    "chroma":   [[12 floats], ...],
    "pitch":    {"bass": {"f0": [...], "conf": [...]}}
  },
  "events": {
    "drums": [{"t": 12.341, "type": "kick|snare|hat", "strength": 0.92}],
    "onsets": [{"t": 12.34, "strength": 0.8}],
    "notes": [{"t": 12.30, "dur": 0.4, "midi": 45, "vel": 0.7}],
    "beats": [{"t": 12.34, "downbeat": true}]
  }
}
```

All continuous arrays share `rate` (frames per second). Normalise each stream to
0..1 per track (keep raw values alongside where useful). Unvoiced bass f0 frames are `0`.
Round floats to about
4 significant digits to keep the file small. Bump `version` if the shape changes.

---

## Phase 0: Scaffold
- [x] `.gitignore` (audio, `.venv`, `__pycache__`, generated timelines if large)
- [x] `analysis/` uv project. Pin a Python version that basic-pitch supports
      (likely 3.10 or 3.11; check).
- [x] `web/` skeleton and `justfile` (`fetch`, `analyze <file>`, `serve`)
- [x] `README.md` with the quickstart
- [x] commit

## Phase 1: Test track
- [x] Find a **free-to-use** track with a clear beat (drums, bass, some melody),
      2–4 min long. Acceptable licenses: CC0, CC-BY (with attribution), or an
      equivalent explicit free-use license. Candidate sources: Incompetech
      (Kevin MacLeod, CC-BY 4.0), Free Music Archive (CC-filtered),
      Wikimedia Commons, ccMixter. Verify the license on the track's own page.
- [x] `scripts/fetch-test-track.sh` downloads it to `assets/audio/` (curl;
      `yt-dlp` is available but prefer direct downloads)
- [x] `assets/ATTRIBUTION.md`: title, artist, source URL, license, license URL
- [x] commit

## Phase 2: Analysis pipeline (Python, full mix only, no stem separation)
Libraries: librosa, numpy, scipy, pyloudnorm, basic-pitch, matplotlib.
- [x] Load audio (mono, 22050 Hz). Hop ≈ 10 ms → `rate` 100.
- [x] **Volume:** momentary loudness (K-weighted, 400 ms window) via
      pyloudnorm's filters or an equivalent, plus RMS dB. Normalise to 0..1.
- [x] **Energy:** band energies (sub <60, bass 60–250, mid 250–2k, high >2k Hz),
      spectral flux, and a combined `intensity` (flux + onset density + band
      energy, smoothed). Normalise per track.
- [x] **Transients:** HPSS → onset detection on the percussive part; per-band
      onset envelopes → classify kick (low), snare (mid + broadband), hat
      (high). Adaptive thresholds. Also a generic `onsets` list.
- [x] **Pitch:** `chroma_cqt` on the harmonic part; bass f0 via `pyin` on a
      40–250 Hz low-passed signal, with confidence (voiced probability);
      note events via basic-pitch. If basic-pitch can't be installed after a
      reasonable attempt, log why, leave `notes` empty and move on.
- [x] **Beats:** `librosa.beat.beat_track`; mark every 4th beat as a downbeat
      as a first approximation (log that it's approximate).
- [x] `analyze.py <audio> -o <timeline.json>` CLI
- [x] `plot.py <timeline.json>` → PNG with every stream and event over time,
      for checking by eye. Look at it on the test track and tune thresholds
      until kicks/snares/hats line up plausibly. Record the chosen values in the log.
- [x] commit after each feature, not just at the end

## Phase 3: WebGPU flame renderer (no audio yet)
- [x] Feature-detect WebGPU; show a clear message if it's unavailable.
- [x] Flame params: transforms (weight, color, affine[6], variations map),
      optional final transform, camera, palette (gradient → 256-entry texture),
      brightness, gamma, vibrancy.
- [x] Variations: linear, sinusoidal, spherical, swirl, horseshoe, polar,
      heart, disc, spiral, julia (Draves & Reckase formulas).
- [x] **Compute pass:** many parallel chains (e.g. 64k), each with a persistent
      point (storage buffer) and a PCG random state. N iterations per frame.
      Transform chosen by a cumulative weight table. Histogram as `atomic<u32>`
      fixed point: density + R, G, B (WebGPU has no float atomics).
- [x] **Temporal decay:** a pass that scales the histogram by `decay` (≈0.85–0.95)
      each frame instead of clearing it. Watch for fixed-point underflow/overflow.
- [x] **Tone-map pass:** log-density, gamma, vibrancy, background, drawn as a
      full-screen triangle.
- [x] Uniforms update every frame (params will change every frame later).
- [x] FPS + iterations/s overlay. (60 fps target UNVERIFIED: no GPU here) Target 60 fps at 1080p on a decent GPU, with
      adjustable iterations per frame.
- [x] 2–3 good-looking presets.
- [x] commit at each working step

## Phase 4: Track sync + mapping
- [x] `<audio>` element + file picker; the matching timeline JSON is loaded by
      name, or picked alongside it.
- [x] `timeline.js`: sample continuous streams at `audio.currentTime` with
      linear interpolation; query events in a window (with **lookahead**, so
      visuals can anticipate hits by a configurable few ms).
- [x] Handles pause, seek and playback-rate changes correctly.
- [x] `mapping.js`: a declarative table of signal → parameter, with gain,
      curve, attack/release envelope, and clamp. Drum events trigger decaying
      impulses. Starting set:
  - volume → brightness
  - intensity → affine rotation speed / iteration budget
  - kick → zoom pulse + transform weight bump
  - snare → palette offset kick
  - hat → small variation blend jitter (e.g. toward julia)
  - chroma (dominant pitch class, smoothed) → palette position
  - bass f0 (confidence-gated, hold last value) → rotation of one transform
- [x] Keep affines contractive: clamp so the shape doesn't blow up.
- [x] Debug overlay: live bars for each signal + event flashes (toggle with `D`).
- [x] commit

## Phase 5: Polish & verification
- [x] Keyboard: space play/pause, ←/→ seek, P next preset, D debug.
- [x] Try headless verification: Chromium headless shell exists under
      `~/.cache/ms-playwright/` (playwright-core available via npx). Try
      flags such as `--enable-unsafe-webgpu --enable-features=Vulkan
      --use-angle=swiftshader` / `--use-webgpu-adapter=swiftshader` to grab
      screenshots at a few timestamps. If WebGPU can't run headless here,
      say so in the log and README. Don't fake it.
- [x] README: quickstart, how mapping works, how to add a track, known limits.
- [x] Final log entry summarising what works, what's unverified and what's next.
- [x] commit

---

## Progress log
<!-- newest last: `- YYYY-MM-DD — what changed / decisions / problems` -->
- 2026-10-04: Repo created, plan written. Decisions: Python for offline
  analysis (full mix only, no stem separation); WebGPU for rendering; sync via
  a pre-computed JSON timeline sampled at `audio.currentTime`.
- 2026-10-04: Phase 0 scaffold. Python pinned to **3.10**: basic-pitch 0.4.0
  pulls full TensorFlow on >=3.11 but the light `tflite-runtime` (2.3 MB) on
  Linux <3.11. tflite-runtime 2.14 is built against NumPy 1.x, so `numpy<2`;
  resampy (basic-pitch dep) imports `pkg_resources`, so `setuptools<81`.
  basic-pitch imports and loads its tflite model OK. Generated timelines go to
  `web/timelines/` (gitignored), diagnostic PNGs to `analysis/out/`.
- 2026-10-04: Phase 1. Test track: "Funkorama" by Kevin MacLeod, 3:21,
  ~101 BPM, electronic drum kit + bass + organ/synth, **CC BY 3.0**. The
  Incompetech per-track page is JS-rendered and did not show the license
  version when fetched, so the license was verified on the Wikimedia Commons
  file page instead (CC BY 3.0, attribution required). The fetch script
  downloads from Commons (falls back to the identical Incompetech file) and
  checks the SHA-1.
- 2026-10-04: Phase 2 done; analysis of the 3:21 test track takes ~35 s
  (pYIN ~11 s, basic-pitch ~4 s, HPSS ~13 s), JSON is 3.8 MB (chroma is
  ~40 % of it). Additive schema keys (still v1): `continuous.volume_db`,
  `continuous.rms_db`, `continuous.drums.{kick,snare,hat}` (percussive
  envelopes, useful for continuous visuals), `track.tempo`.
  - Grid: STFT hop 220 @ 22050 Hz (100.23 fps) resampled by interpolation to
    an exact 100 fps grid; bass f0 uses nearest-neighbour so it never
    interpolates across voiced/unvoiced gaps.
  - Volume: pyloudnorm K-weighting filters + 400 ms mean-square window;
    normalised with floor -60 LUFS, p1..p99.5. The track is compressed, so
    volume sits ~0.85-1 in the groove and ~0.5 in the breakdown.
  - Energy bands: dB, normalised to the top 30 dB (p2..p99.5). Intensity =
    0.4 * flux(0.5 s smooth) + 0.25 * onset density(2 s) + 0.35 * mean(bass,
    mid, high), smoothed 0.75 s. It clearly shows intro / groove / breakdown.
  - Drums, first pass (independent per-band peak picking, kick 30-150 Hz,
    snare 150-5000 Hz) was bad: 951 kicks / 912 snares for 328 beats, because
    kick leakage dominates 150-5000 Hz and hats were suppressed as "snare
    noise". A scatter of per-onset band features showed clusters, so it is now
    candidate + classify on the HPSS percussive part (log1p(100*P) flux):
    candidates = peaks of kick+snare+hat env above median(1 s) + 1.5*MAD,
    floor 0.25, gap 60 ms; kick if 30-120 Hz env >= 0.45; snare if 1-4 kHz
    env >= 0.65 AND 7-11 kHz env >= 0.45 (broadband); hats picked on their own
    envelope (median + 2*MAD, floor 0.15, gap 50 ms), rejected if 1-4 kHz
    >= 0.5 or within 30 ms of a snare. Result: 523 kick / 344 snare / 613 hat.
    Bar-position histogram: snares peak on 16ths 4 and 12 (beats 2 and 4),
    hats on off-beat 16ths, kicks syncopated on 0/10/13. Looks plausible by eye
    on the zoom plot; not checked against a hand-labelled ground truth.
  - Beats: librosa 100.2 BPM (catalogue says 101). Beats sat ~41 ms after the
    percussive onsets, so the grid is shifted by the median beat->onset offset.
    Downbeats are **approximate**: every 4th beat, phase = the one with most
    kick energy (phase 2 here); assumes 4/4 and no tempo/metre changes.
  - Pitch: chroma_cqt on the HPSS-harmonic signal (gated by harmonic RMS);
    pYIN 40-250 Hz on a 250 Hz low-passed, 11025 Hz copy. basic-pitch works
    (tflite): 1642 notes. Bass f0 ~110 Hz, chroma A and basic-pitch MIDI 45
    agree at 66.6-67.5 s. pYIN also tracks 808-kick pitch sweeps (low conf).
- 2026-10-04: Phase 3. WebGPU **does** run in headless Chromium here:
  `chromium-1234` (and the headless shell) with `--enable-unsafe-webgpu
  --enable-features=Vulkan --use-angle=swiftshader
  --use-webgpu-adapter=swiftshader` gives a `google/swiftshader` adapter, but
  only on a secure-context URL (http://localhost), not about:blank. Page
  screenshots and `canvas.toDataURL()` of the WebGPU canvas come back
  blank/transparent, so verification uses `window.__grab()`: tone-map into an
  offscreen rgba8 texture, copy to a buffer, map it (`tools/grab.mjs`).
  Renderer: 64k chains x 16 iters/frame default, 4 x atomic<u32> per pixel,
  DENS_ONE = 256 / COLOR_ONE = 255 fixed point, decay pass clamps to 2^31
  before scaling so it can't wrap. Tone map is flam3-style with
  k2 = pixels / (hits held in histogram) * 4 and an extra 0.1 on k1 (first
  try without it saturated everything to white). Cameras are auto-framed by
  a CPU chaos game (2-98 percentile box). Three presets render as expected
  in SwiftShader (docs/presets-headless.png). SwiftShader speed: ~12 fps /
  1.5 M iter/s at 960x540 with 16k chains x 8; real-GPU fps not measured.
- 2026-10-04: Phase 4. `timeline.js` is stateless in t (interpolated
  streams, binary-searched events, impulses computed directly from events
  with a 30 ms default lookahead), so pause/seek/rate need no special
  handling; `AudioClock` extrapolates between coarse `currentTime` updates
  (capped at 250 ms). `mapping.js`: declarative MAPPINGS table, one-pole
  attack/release envelopes on *media* time (pause freezes, seek resets,
  1.5x speeds them up). Starting values: volume->brightness x0.45..1.25
  (curve 1.6); intensity->spin 0.03..0.55 rad/s on xform 0 and iterations
  x0.55..1; kick->zoom +0..9 % (release 120 ms) and xform-1 weight
  x1..2.6; snare->palette +0..0.12; hat->julia blend 0..0.3 on the last
  xform (release 70 ms); chroma circular mean -> palette 0..0.35 (0.6 s);
  bass f0 (pYIN conf >= 0.5, held, 40-160 Hz log) -> xform-1 rotation
  +-0.5 rad. All affines clamped to max singular value 0.98.
  - Bug found by `tools/test-sync.mjs`: held bass pitch leaked across seeks;
    now rebuilt by scanning back to the last confident frame.
  - Bug found by `tools/verify.mjs`: seeking snapped to 0 because
    `python -m http.server` ignores HTTP Range. Added `scripts/serve.py`
    (Range support); `just serve` uses it.
  - Verified headless (SwiftShader): mp3 loads (201.46 s), playback runs,
    the render clock equals `audio.currentTime` in the same frame, Space
    pauses, seek to 64 s and ArrowRight (+5 s) land correctly, 1.5x advances
    3.03 s of media in 2.02 s wall. Snapshots at 3/64.45/66.55/110/150 s show
    different palette/shape (docs/timeline-snapshots-headless.png).
    Not verified: how it *feels* with sound on a real GPU (no audio output
    or GPU here), and whether 30 ms lookahead is right for real output latency.
- 2026-10-04: Phase 5 / session summary.
  - Added: keyboard (space, arrows +-5 s / shift 30 s, P, D, [ ] iterations,
    H hide UI); camera follow (re-frames the *modulated* flame every 0.5 s
    on the CPU and eases toward it, tau 1.5 s; without it preset 2 drifted
    out of frame); `just test` (node checks, 12 pass) and `just verify`
    (headless end-to-end + `tools/keys.mjs`); README.
  - **Works and verified here:** analysis pipeline end to end via
    `just analyze` (~33 s); diagnostic plots inspected and detectors tuned;
    WebGPU flame renders in headless Chromium via SwiftShader (snapshots in
    docs/); timeline loads, mapping changes the flame across the track;
    playback, pause, seek, arrow keys, 1.5x rate, P/D/H/] keys; no page
    errors.
  - **Unverified:** real-GPU performance (60 fps @ 1080p target), visual
    quality at full chain count on real hardware, perceived audio-visual
    sync with actual sound output (no GPU or speakers in the container),
    other browsers (only Chromium 1234 tested), drum accuracy vs ground truth.
  - Next: try on a real GPU and tune chains/iters + lookahead by ear; more
    presets and per-preset `mod` routing; smaller timeline (quantised chroma
    or a binary format); downbeat detection beyond the 4-beat heuristic;
    preset morphing on section changes (intensity jumps).
- 2026-10-04: Route editor. `mapping.js` routes are now `{ src, target, amount }`
  over `SOURCES` / `TARGETS` catalogues (defaults reproduce the old modulation
  ranges exactly, checked with `just test`). Routes add their deviation from
  the target's neutral value, so several can share a target; `applyMods`
  clamps every slot since amounts can be −2…2. UI: `web/src/routes-ui.js`
  (M / routes button), saved to localStorage. Fixed `#msg` overriding
  `hidden` with `display:flex`, which put an invisible full-screen layer over
  every click. `tools/routes.mjs` (part of `just verify`) drives the selects
  and slider headless and checks the mods respond. Not verified: how amount
  changes feel with sound on a real GPU.
- 2026-10-04: Camera follow is now **off by default** (`?follow=1` turns it on).
  With every route at amount 0 it still made the whole image drift: each
  re-frame estimates the bounds from 6000 random CPU samples, so the target
  jitters about 1%. Measured headless: brightness-centre drift 0.28% of width
  with follow on vs 0.03% (render noise) with it off. Trade-off: heavy spin
  can now carry presets partly out of frame (the original reason for follow).
- 2026-10-11: Preset 3 "julia bloom teal", imported from flame-fractal's
  `examples/julia-bloom-dense-teal-hires.json` via `fromFlameFractal()` in
  `presets.js` (camera zoom = units across the short side there → `2 / zoom`
  here; palette stops spread over 0..1 inclusive, no wrap; background /255).
  flamebeat's julia used `atan2(y, x)` while flame-fractal/flam3 use the paper's
  `atan2(x, y)`; added a per-flame `juliaAtan: 'xy'` flag (shader `misc.y` + CPU
  sampler) rather than change it globally, so presets 0–2 look the same.
  Original brightness/gamma/vibrancy work as-is despite the different tone map:
  a headless render without timeline (decay 0.98) matches the reference by eye.
  With the music on, chroma/snare palette offsets push it toward the peach
  end of the gradient. `just test` and `verify.mjs` pass.
- 2026-10-11: Second track "MASTER-Thirteen TeV-suncloud-2025-07-19" (user's
  own, 5:10, ~154 BPM electronic; analysed: 1296 kick / 395 snare / 674 hat,
  980 notes, 5.8 MB timeline). Volume is heavily compressed (~0.85-1 for most
  of the track). Measured peak RSS: analyze.py 2.3 GB, plot.py 0.3 GB. An
  earlier run of the same commands coincided with the shared container
  running out of memory; it could not be reproduced alone, so heavy steps now
  run one at a time under an RSS watchdog.
  Default routes changed at the user's request: beats show as brightness and
  palette, not motion. Removed kick->zoom pulse, kick->transform weight and
  intensity->iterations (targets still in the editor). Added kick->brightness
  (quadratic, x1..3.2; the teal preset's gamma 3.2 flattens smaller ranges)
  and beat->palette shift (+0..0.06). Routes now take a named response curve
  (`CURVES`: square root, linear, quadratic, cubic, exponential
  `expm1(5x)/expm1(5)`) or a power; the route editor has a curve column.
  localStorage key bumped to `flamebeat.routes.v2` so the new defaults apply.
  Note: the curve acts before the envelope, so with a frozen clock it only
  shows after time moves (`tools/routes.mjs` jumps time to check it).
