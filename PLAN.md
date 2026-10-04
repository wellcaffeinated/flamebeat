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
  "track": {"file": "...", "duration": 183.2, "sr": 22050},
  "rate": 100,
  "continuous": {
    "volume":   [...],                                  // momentary LUFS mapped to 0..1, plus raw dB in "volume_db"
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
0..1 per track (keep raw values alongside where useful). Round floats to about
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
- [ ] Find a **free-to-use** track with a clear beat (drums, bass, some melody),
      2–4 min long. Acceptable licenses: CC0, CC-BY (with attribution), or an
      equivalent explicit free-use license. Candidate sources: Incompetech
      (Kevin MacLeod, CC-BY 4.0), Free Music Archive (CC-filtered),
      Wikimedia Commons, ccMixter. Verify the license on the track's own page.
- [ ] `scripts/fetch-test-track.sh` downloads it to `assets/audio/` (curl;
      `yt-dlp` is available but prefer direct downloads)
- [ ] `assets/ATTRIBUTION.md`: title, artist, source URL, license, license URL
- [ ] commit

## Phase 2: Analysis pipeline (Python, full mix only, no stem separation)
Libraries: librosa, numpy, scipy, pyloudnorm, basic-pitch, matplotlib.
- [ ] Load audio (mono, 22050 Hz). Hop ≈ 10 ms → `rate` 100.
- [ ] **Volume:** momentary loudness (K-weighted, 400 ms window) via
      pyloudnorm's filters or an equivalent, plus RMS dB. Normalise to 0..1.
- [ ] **Energy:** band energies (sub <60, bass 60–250, mid 250–2k, high >2k Hz),
      spectral flux, and a combined `intensity` (flux + onset density + band
      energy, smoothed). Normalise per track.
- [ ] **Transients:** HPSS → onset detection on the percussive part; per-band
      onset envelopes → classify kick (low), snare (mid + broadband), hat
      (high). Adaptive thresholds. Also a generic `onsets` list.
- [ ] **Pitch:** `chroma_cqt` on the harmonic part; bass f0 via `pyin` on a
      40–250 Hz low-passed signal, with confidence (voiced probability);
      note events via basic-pitch. If basic-pitch can't be installed after a
      reasonable attempt, log why, leave `notes` empty and move on.
- [ ] **Beats:** `librosa.beat.beat_track`; mark every 4th beat as a downbeat
      as a first approximation (log that it's approximate).
- [ ] `analyze.py <audio> -o <timeline.json>` CLI
- [ ] `plot.py <timeline.json>` → PNG with every stream and event over time,
      for checking by eye. Look at it on the test track and tune thresholds
      until kicks/snares/hats line up plausibly. Record the chosen values in the log.
- [ ] commit after each feature, not just at the end

## Phase 3: WebGPU flame renderer (no audio yet)
- [ ] Feature-detect WebGPU; show a clear message if it's unavailable.
- [ ] Flame params: transforms (weight, color, affine[6], variations map),
      optional final transform, camera, palette (gradient → 256-entry texture),
      brightness, gamma, vibrancy.
- [ ] Variations: linear, sinusoidal, spherical, swirl, horseshoe, polar,
      heart, disc, spiral, julia (Draves & Reckase formulas).
- [ ] **Compute pass:** many parallel chains (e.g. 64k), each with a persistent
      point (storage buffer) and a PCG random state. N iterations per frame.
      Transform chosen by a cumulative weight table. Histogram as `atomic<u32>`
      fixed point: density + R, G, B (WebGPU has no float atomics).
- [ ] **Temporal decay:** a pass that scales the histogram by `decay` (≈0.85–0.95)
      each frame instead of clearing it. Watch for fixed-point underflow/overflow.
- [ ] **Tone-map pass:** log-density, gamma, vibrancy, background, drawn as a
      full-screen triangle.
- [ ] Uniforms update every frame (params will change every frame later).
- [ ] FPS + iterations/s overlay. Target 60 fps at 1080p on a decent GPU, with
      adjustable iterations per frame.
- [ ] 2–3 good-looking presets.
- [ ] commit at each working step

## Phase 4: Track sync + mapping
- [ ] `<audio>` element + file picker; the matching timeline JSON is loaded by
      name, or picked alongside it.
- [ ] `timeline.js`: sample continuous streams at `audio.currentTime` with
      linear interpolation; query events in a window (with **lookahead**, so
      visuals can anticipate hits by a configurable few ms).
- [ ] Handles pause, seek and playback-rate changes correctly.
- [ ] `mapping.js`: a declarative table of signal → parameter, with gain,
      curve, attack/release envelope, and clamp. Drum events trigger decaying
      impulses. Starting set:
  - volume → brightness
  - intensity → affine rotation speed / iteration budget
  - kick → zoom pulse + transform weight bump
  - snare → palette offset kick
  - hat → small variation blend jitter (e.g. toward julia)
  - chroma (dominant pitch class, smoothed) → palette position
  - bass f0 (confidence-gated, hold last value) → rotation of one transform
- [ ] Keep affines contractive: clamp so the shape doesn't blow up.
- [ ] Debug overlay: live bars for each signal + event flashes (toggle with `D`).
- [ ] commit

## Phase 5: Polish & verification
- [ ] Keyboard: space play/pause, ←/→ seek, P next preset, D debug.
- [ ] Try headless verification: Chromium headless shell exists under
      `~/.cache/ms-playwright/` (playwright-core available via npx). Try
      flags such as `--enable-unsafe-webgpu --enable-features=Vulkan
      --use-angle=swiftshader` / `--use-webgpu-adapter=swiftshader` to grab
      screenshots at a few timestamps. If WebGPU can't run headless here,
      say so in the log and README. Don't fake it.
- [ ] README: quickstart, how mapping works, how to add a track, known limits.
- [ ] Final log entry summarising what works, what's unverified and what's next.
- [ ] commit

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
