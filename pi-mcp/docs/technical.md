# pi-mcp technical reference

Implementation details, storage formats, compatibility notes, and environment
variables for the pi-mcp extension.

## npx resolution

When a stdio server's command is `npx` (or `npm exec`), pi-mcp automatically
resolves it to the cached binary path, skipping the npm parent process for
lower latency and cleaner stderr:

```json
{
  "mcpServers": {
    "mcp-test": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-foo", "--", "--option=value"]
    }
  }
}
```

The resolved binary path is cached in `<agentDir>/mcp-npx-cache.json` for 24
hours. If resolution fails (package not yet installed), pi-mcp falls back to
running the original `npx` command.

## Connection lifecycle

### Health check

Keep-alive connections run a `pingTools` check every 30 seconds. If the check
fails, the connection is marked as disconnected and torn down. The next
`mcp_load` or `mcp_call` automatically reconnects, carrying over the stale
session ID so servers that recognize it (e.g. a game engine preserving
its active context) re-adopt the prior session.

### Retry strategy

When `mcp_call` encounters a transient error on a still-live transport (session
ID intact), it retries up to 2 additional times with linear backoff
(200ms → 400ms). If the transport dies mid-retry, it falls through to a full
reconnect carrying the cached session ID.

### Stdio lifecycle

Stdio servers support the same `lifecycle` modes as HTTP:
- `"keep-alive"` — holds the connection open with a 30s health-check
- `"lazy"` (default) — connects on first `mcp_load`

Note: `eager` mode is not yet implemented for stdio.

## OAuth token storage

Tokens are stored in `<agentDir>/mcp-oauth/sha256-<server-hash>/tokens.json`
with restrictive permissions (0600).

### Format

```json
{
  "tokens": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1234567890,
    "scope": "..."
  },
  "clientInfo": {
    "clientId": "...",
    "clientSecret": "..."
  },
  "serverUrl": "https://mcp.example.com/mcp"
}
```

The `serverUrl` field detects URL changes (which invalidate stored credentials).

### Environment variables

| Variable | Purpose |
|---|---|
| `MCP_OAUTH_DIR` | Override token storage directory |
| `MCP_OAUTH_CALLBACK_PORT` | Use a fixed port for the local OAuth callback server |

### Auth auto-detection

Without explicit `oauth` config, pi-mcp auto-detects OAuth by checking if the
server responds with `401 Unauthorized`. Set `"oauth": false` in the server
config to disable auto-detection.

### Manual auth completion

If the callback server doesn't work (e.g., remote/SSH environment):

1. `/mcp-auth login <server>` — prints an authorization URL (or use
   `mcp_auth { action: "start", server: "..." }`).
2. Open the URL in your browser, authorize, and copy the redirect URL (or raw
   authorization code).
3. `/mcp-auth complete <server> <code>` — completes the flow, or use
   `mcp_auth { action: "complete", server: "...", code: "..." }`.

## Config compatibility notes

- `lifecycle` accepts flat (`"keep-alive"`) **or** legacy nested
  (`{ "mode": "keep-alive" }`).
- HTTP servers are detected by the presence of `url` **or** `type: "http"`.
- `allowedTools` / `excludeTools` / `directTools` are tolerated and ignored
  in v1 (full schema is always fetched).
- `headers` carries bearer tokens / API keys inline — no OAuth flow in v1.
  Servers that require MCP OAuth report `needs-auth` on `mcp_load`.
- `requestTimeoutMs` sets a per-server default timeout for connect/list_tools/call_tool.

## Stdio env interpolation

Server-specific `env` values support `${VAR}` interpolation from the parent
process environment:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["server.js"],
      "env": {
        "API_KEY": "${MY_API_KEY}",
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

Variables are merged over `process.env` — any key in the `env` block overrides
the inherited value; undefined/missing environment variables interpolate to an
empty string.

## Output truncation

Tool text output is truncated at 2000 lines or 50 KB (whichever comes first).
Truncated content is saved to a temporary file, and the path is included in the
result so the agent can read the full output.

## Disabling OAuth per server

Set `"oauth": false` at the server config level to skip OAuth auto-detection
for servers that return 401 for other reasons:

```json
{
  "mcpServers": {
    "my-server": {
      "url": "https://example.com/mcp",
      "oauth": false
    }
  }
}
```

## Error classification

pi-mcp classifies `mcp_call` failures into categories for diagnostics:

| Category | Meaning |
|---|---|
| `needs-auth` | Server returned 401; OAuth flow required |
| `timeout` | Call exceeded the timeout |
| `connection` | Transient network error (ECONNRESET, socket hang-up, etc.) |
| `unknown-tool` | Tool name not recognized by the server |
| `validation` | Parameter validation error (wrong type, missing field) |
| `other` | Everything else |
