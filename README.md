# pi-snake-extensions

A monorepo of [pi](https://github.com/earendil-works/pi) coding agent extensions.

## Extensions

### pi-mcp

MCP extension — load once, whole-server schema, then call; with OAuth 2.1 and no daemon.

## Install

```bash
pi install ./pi-mcp
```

Or from npm (once published):

```bash
pi install npm:@tinysnake/pi-mcp
```

## Requirements

- Node.js ≥ 22.6 (for native TS stripping)
- [pi coding agent ≥ 0.80](https://github.com/earendil-works/pi)
