# flamebeat

Music-synced fractal flame visualizer.

- `analysis/` — Python (uv) offline analysis: full mix → JSON timeline of
  volume, energy, drum transients, pitch.
- `web/` — static WebGPU fractal flame renderer (ES modules, no build step)
  that plays the track and samples the timeline at `audio.currentTime`.

See `PLAN.md` for the plan, timeline schema and progress log.

## Quickstart

Requires [mise](https://mise.jdx.dev) tools `uv` and `just`.

```sh
just fetch                                  # download the test track
just analyze assets/audio/<track>.mp3       # -> web/timelines/<track>.json
just serve                                  # http://localhost:8000/web/
```
