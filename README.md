# pi-snake-extensions

A monorepo of [pi](https://github.com/earendil-works/pi) coding agent extensions.

## Extensions

### pi-mcp

MCP extension — load once, whole-server schema, then call; with OAuth 2.1 and no daemon.

### pi-think-twice

Send countdown — `Enter` opens a grace period (default 3 s) instead of sending:
your message stays in the editor, any key interrupts and keeps it editable,
`ESC` cancels, `Ctrl+Enter` sends now.

## Install

```bash
pi install ./pi-mcp
```

Or from npm (once published):

```bash
pi install npm:@tinysnake/pi-mcp
pi install npm:pi-think-twice
```

## Requirements

- Node.js ≥ 22.6 (for native TS stripping)
- [pi coding agent ≥ 0.80](https://github.com/earendil-works/pi)
