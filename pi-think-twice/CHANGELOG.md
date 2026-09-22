# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-23

### Added

- Send countdown: `Enter` opens a countdown (default 3 s) with the message
  staying in the editor; the send fires only after it expires.
- Interrupt semantics: any key cancels and keeps the text editable; plain
  `Enter` during the countdown is ignored; `ESC` cancels; `Ctrl+Enter` sends
  immediately (skips the countdown, or finishes it early).
- Exemption decision table: built-in and extension commands submit as before;
  skills, prompt templates, unknown `/commands`, and `!bash` count down;
  `alwaysCountdown` (seeded with `/compact`) overrides everything.
- Built-in command list obtained by live reflection from pi's autocomplete
  provider, with a pi 0.86 snapshot fallback and fail-open behavior, so a
  broken reflection never affects pi.
- Grace-period border indicator with pi's working spinner, three width
  variants, and stock-border degradation on any rendering fault.
- Autocomplete split: `Enter` with an open suggestion applies the completion
  first, then runs the countdown decision on the completed text.
- Global config at `~/.pi/agent/pi-think-twice.json` (`delaySeconds`,
  `alwaysCountdown`), read once per process; `delaySeconds: 0` disables the
  extension.
- Cancelled messages never enter the session; cancelled `up`/`down` history.
- Headless test suite (33 tests): config parsing, decision table, reflection
  fallbacks, and editor key-behavior including failure-path fail-open checks.
