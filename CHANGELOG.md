# Changelog

All notable changes to FableCut are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-07-07

### Added
- **Motion FX** (all animatable): camera `shake` / `shakeSpeed`, `rgbSplit`
  chromatic aberration, and boiling film `grain`.
- **Speed ramps** — `speed` is now keyframable. The engine time-remaps media time
  as `in + ∫ speed dt` in both preview and the offline export audio mix (the
  fast-into-slow-motion reel move).
- **Adjustment layers** — a new `kind:"adjust"` clip that re-renders everything
  drawn below it through its own grade/filter/shake/grain/vignette stack,
  Premiere-style. Added the *+ Adjust* button, inspector, and timeline styling.
- **Neon caption glow** (`glow` / `glowColor`).
- Four new kinetic text animations: `letter-pop`, `wave`, `bounce`, `shake`.
- Two new transitions: `glitch` (RGB split + jitter) and `pop` (overshoot scale).
- Project-level `background` color, persisted and drawn behind all clips.
- 16 new animated library SVGs (subscribe pill/bell, rating stars, arrows,
  badges, progress/loading bars, speech bubble, hearts, equalizer, pulses…).

### Changed
- `CLAUDE.md` and `README.md` expanded to document all of the above.
- MCP server validation now exempts `adjust` clips from the `mediaId` check.

## [1.0.0] - 2026-07-06

### Added
- Initial public release: a zero-dependency, Premiere-style browser video editor
  whose entire timeline is a single `project.json` document.
- **Editing** — 4 video + 3 audio tracks, drag/trim/split/snap, undo/redo, beat &
  cue markers, real decoded audio waveforms, aspect presets + safe-area guides.
- **Look** — 12 filter presets, full grade controls (temperature/tint/vignette),
  blend modes, fit/crop/corner-radius/flip, chroma key, in-browser AI background
  removal (MediaPipe).
- **Motion** — keyframe animation with easing, per-clip speed, 15 transitions.
- **Text** — kinetic captions, gradient/outline/pill styling, any Google Font by
  name, drop-in custom fonts.
- **Animated SVG clips** — a first-class `svg` kind rendered frame-accurately from
  CSS `@keyframes`.
- **Export** — fast browser-rendered frames + offline audio mix encoded by ffmpeg
  (CRF-18 MP4), with a realtime MediaRecorder fallback.
- Three control surfaces for AI agents: **MCP server**, direct `project.json`
  editing, and a **REST API** with live-reload over server-sent events.

[1.1.0]: https://github.com/ronak-create/FableCut/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ronak-create/FableCut/releases/tag/v1.0.0
