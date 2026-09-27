# pi-context-window-cap

> Hard global cap on every model's context window — sessions stop growing (and auto-compact) at your number, not the model's.

| | |
| --- | --- |
| Commands | `/context-window-cap`, `/context-window-cap toggle`, `/context-window-cap on`, `/context-window-cap off`, `/context-window-cap set <cap>`, `/context-window-cap status` |
| Config | `~/.pi/agent/context-window-cap.json` — `{ "enabled": true, "cap": 300000 }` |
| Default | enabled, `300000` (minimum `40000`) |
| Status bar | `ctx-cap 300K` while enabled, `ctx-cap off` while disabled |

## What it does

While enabled, every model pi uses gets an effective context window of
`min(original, cap)`. Because compaction, the footer context meter, and
overflow recovery all read the model's window at use time, the cap is
enforced everywhere at once:

- **Auto-compaction** triggers at `cap − reserveTokens` (283,616 tokens by
  default for a 300K cap), not at the model's native window.
- **The context meter** in the footer shows usage against the cap.
- **Models smaller than the cap are untouched** — a 128K model stays 128K.

While disabled, every model's original window is restored.

## Usage

```text
/context-window-cap                 # status: state + active model's effective window
/context-window-cap toggle          # global on/off switch
/context-window-cap on              # enable
/context-window-cap off             # disable (originals restored)
/context-window-cap set 300k        # change the cap: 300k / 1.5m / 300000
/context-window-cap status          # same as running it with no argument
```

`set` accepts `300k`, `300K`, `1.5m`, or a raw token count like `300000`.
Raising the cap immediately frees models whose original window fits under the
new number; lowering it re-clamps everything. The cap is retained while the
extension is off, so `off` → `on` round-trips exactly.

## How restore works without a per-model map

pi's model registry is treated as pristine, read-only truth. Every effective-
window change swaps in a clone carrying the new window via `pi.setModel()`;
model objects are never mutated in place — the active object may itself be a
shared catalog entry (identity checks can't reliably prove a copy is private),
and rebuilding `find()` results make such checks unstable anyway. The registry
keeps the original, so the original window is always recoverable — restore and
cap-raises just re-read it.

Re-clamping is idempotent and hooks `session_start`, `model_select`,
`before_agent_start`, and `turn_start`, so models handed back by a registry
refresh get re-capped before they're used. `turn_start` / `before_agent_start`
handlers skip work when the window already matches, so steady-state cost is a
single comparison per turn.

## State

State lives at `~/.pi/agent/context-window-cap.json`, outside every session,
and is re-read on `session_start` (another pi window can toggle it). A
missing or malformed file falls back to the defaults — a corrupt state file
can never break the extension. Writes are atomic (tmp + rename).

## Limits

- Cap floor is 40,000 tokens: compaction needs `reserveTokens` (16,384) plus
  `keepRecentTokens` (20,000) of headroom or it would thrash.
- A single oversized tool result can overshoot the cap briefly (up to the
  size of that result) — the same is true of a real context window; the next
  check compacts it away.
- If a provider has no configured auth, its model is left uncapped (it can't
  run anyway); it gets clamped as soon as it becomes usable.
- `pi --list-models` runs in a separate process and shows native windows.

## Install

```sh
pi install file:///Users/snake/workspace/pi-extensions/pi-context-window-cap
```

The `file://` three-slash URL form is required — `file:/path` is resolved as
a relative path instead.

## Development

```sh
npm test          # unit tests (cap math, state parsing) — node --test
npm run typecheck # tsc --noEmit
npm run smoke     # end-to-end over pi's RPC mode, zero LLM calls
```

The smoke test drives a real `pi --mode rpc` instance: verifies the initial
clamp, `set`/`toggle`/`on`/`off` round-trips, small models staying untouched,
`model_select` re-clamping, the footer status, and that the registry stays
pristine throughout. `--installed` runs the same suite against the installed
package instead of `-e ../index.ts`.
