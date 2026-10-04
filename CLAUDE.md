# flamebeat

Music-synced fractal flame visualizer: Python offline audio analysis → JSON
timeline → WebGPU renderer synced to an `<audio>` element.

- **Read `PLAN.md` first.** It is the task list and progress log. Keep it current:
  tick boxes as work lands and add a dated log entry each session.
- Commit often, one logical step per commit. Don't push.
- Tools only via mise/uv, never apt. Python: `uv` inside `analysis/`.
- Audio files are gitignored. Attribution in `assets/ATTRIBUTION.md` is committed.
- Shared 16 GiB memory ceiling: one heavy process at a time.
