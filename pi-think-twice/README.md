# pi-think-twice

**Think twice before you send:** `Enter` opens a send countdown (default 3 s)
instead of sending — your text stays in the editor, giving you a grace period
to notice the typo, the wrong wording, or the Enter you didn't mean to press.
Type anything to interrupt, `ESC` to cancel, `Ctrl+Enter` to send now.

A send-countdown extension for the [pi](https://github.com/earendil-works/pi)
coding agent.

## Behavior

| State | Key | Result |
| --- | --- | --- |
| idle | `Enter` | Start the countdown — text stays in the box |
| idle | `Ctrl+Enter` | Send immediately (skip the countdown) |
| counting down | any key | Interrupt — text stays, you keep editing |
| counting down | `Enter` | Ignored (no send, no restart, no cancel) |
| counting down | `Ctrl+Enter` | Send now, countdown finished early |
| counting down | timeout | Message enters the session |

The countdown renders in the editor's top border, next to the same spinner pi
uses for its working indicator:

```
── ⠹ sending in 2s · ESC to cancel · Ctrl+Enter send now ──
```

## What counts down

A submit either *executes an action* (exempt) or *becomes a message the model
sees* (countdown) — see [CONTEXT.md](https://github.com/tinysnake/pi-snake-extensions/blob/master/CONTEXT.md).

- **Exempt (no countdown):** built-in slash commands (`/settings`, `/model`,
  …) and commands registered via `pi.registerCommand()`.
- **Counts down:** plain text, `!bash` submissions, skills (`/skill:…`),
  prompt templates, mistyped/unknown slash input, and `alwaysCountdown`
  entries — seeded with `/compact`.
- Streaming steer/follow-up messages count down too; messages injected via RPC
  or `sendUserMessage` are untouched (they never pass through the editor).

Cancelled messages never enter `↑` input history — cancel means *never sent*.

## Config

`~/.pi/agent/pi-think-twice.json`, read once at startup (restart pi to apply):

```json
{
  "delaySeconds": 3,
  "alwaysCountdown": ["/compact"]
}
```

- `delaySeconds` — countdown length; `0` disables pi-think-twice entirely.
  Missing/invalid file or value falls back to `3`.
- `alwaysCountdown` — extra commands forced through the countdown; unioned with
  the built-in seed (`compact`), entries may be written with or without the
  leading slash.

## Install

```bash
pi install npm:pi-think-twice
```

From a local checkout (development): `pi install ./pi-think-twice`.

Requires Node ≥ 22.6 and pi ≥ 0.80.

## Notes & limitations

- **Ctrl+Enter** relies on enhanced key reporting (kitty protocol /
  modifyOtherKeys). In terminals without it the shortcut simply doesn't
  exist; tmux needs `extended-keys on`. Everything else works without it.
- **Autocomplete:** stock pi treats `Enter` with an open suggestion as
  "complete *and* run". pi-think-twice splits that gesture — the suggestion is
  applied (same as `Tab`), then the countdown decision runs on the completed
  text. Deliberate picks of exempt commands still run instantly.
- **Editor extensions:** this replaces the editor component, so running
  another editor-replacing extension (e.g. vim mode) together with pi-think-twice
  means the last one loaded wins.
- **Built-in commands are dynamic:** they are reflected from the live
  autocomplete provider pi hands to the editor (its `commands` own property,
  minus `pi.getCommands()`), so commands added by future pi versions need no
  change here. Skills are excluded by their `skill:` prefix.
- **Failure policy (pi is never affected):** if reflection breaks — field
  renamed, made truly private, provider missing, throwing getter, empty
  result — a last-known pi 0.86 snapshot (`RESERVED_BUILTIN_COMMANDS`) is
  used instead; if the decision itself throws it *fails open* to an
  immediate stock submit; a fault mid-countdown stops the timer with your
  text intact; a rendering fault falls back to the stock border. No failure
  path wedges or crashes pi.
- Terminal scroll doesn't interrupt the countdown (only key input does).

## Development

```bash
npm test              # node --test: config, decision table, reflection, editor behavior
tsc -p tsconfig.json  # strict type check
```
