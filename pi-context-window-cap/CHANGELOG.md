# Changelog

All notable changes to pi-context-window-cap.

## 0.1.0

- Initial release: hard global cap on every model's context window.
- Commands: `/context-window-cap [toggle|on|off|set <cap>|status]`.
- Default state: enabled, cap 300K (floor 40K).
- Persistent state in `~/.pi/agent/context-window-cap.json` (atomic writes,
  malformed file falls back to defaults).
- Registry objects stay pristine; restore and cap-raises re-read originals
  from the registry instead of a stored map.
- Footer status: `ctx-cap 300K` / `ctx-cap off`.
