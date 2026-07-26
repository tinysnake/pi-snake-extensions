# pi-mcp

MCP for pi: **load once, whole-server schema, then call** — without a daemon,
without a CLI binary, without discovery churn.

The initial system prompt overhead is minimal: only a few concise guideline
lines are injected (not the full schema dump). Schemas are loaded on demand
via `mcp_load` and cached per session, not baked into the prompt.

## Rationale

MCP integration serves coding agents, not human users. The protocol design
assumes an interactive discovery loop (search → describe → call per tool),
but coding agents benefit from a different tradeoff: fetch *everything* up
front, then call freely.

### Reducing round-trips

The naive approach costs O(n) round-trips to discover n tools on a server.
pi-mcp replaces this with O(1) per server:

| Step | What happens | Round-trips |
|---|---|---|
| **`mcp_load <server>`** | Fetches **all** tool names, descriptions, and full parameter schemas (types, required/optional flags, enum values) for the entire server in one call. | 1 |
| **`mcp_call <server.tool>`** | Uses the cached schemas — zero additional discovery overhead. | 0 |
| **`mcp_refresh`** | Re-reads config, re-probes all servers, drops stale cache. | 1 per server |

**Result**: discovering and using 20 tools on one server costs 1 + 20 = 21
round-trips instead of (2 × 20) + 20 = 60.

Additionally, server availability is probed in the background at session start,
so by the time the agent begins working it already knows which servers are
reachable.

### Reducing agent errors

Coding agents hallucinate tool names, parameter names, and types when they lack
precise schema information. pi-mcp adds multiple safety layers:

1. **Load-before-call gating** — `mcp_call` refuses to execute without a prior
   `mcp_load` for that server. The error message explicitly tells the agent to
   load schemas first, preventing hallucinated calls.

2. **System prompt injection** — On every agent session, pi-mcp injects
   a small set of concise guidelines into the system prompt (not the full
   schema dump — only a few lines reminding the agent of the workflow):
   - *"You MUST call mcp_load \<server\> to load tool schemas before calling
     mcp_call."*
   - *"Never guess tool names, parameter names, or parameter types — load
     the server first."*
   - *"When a server is unavailable, report it to the user immediately."*

3. **Actionable error hints** — When a call fails with a validation error
   (wrong type, missing required argument, invalid enum value), the response
   includes a parameter-schema snippet so the agent can self-correct without
   a second load round-trip.

4. **Self-healing connections** — For keep-alive servers, a 30s health-check
   tears down stale connections automatically. Session identity is preserved
   across transport failures, so server-side state (e.g. a game engine's
   active scene) survives reconnection.

## Design

- **In-process**: Uses `@modelcontextprotocol/sdk` directly — no daemon, no
  CLI binary, no socket cleanup.
- **Two transports**: HTTP (StreamableHTTP with SSE fallback) and stdio (local
  command + args with automatic npx resolution).
- **Lifecycle**: `"lazy"` (connect on first load) or `"keep-alive"` (persistent
  connection with health check).
- **Auth**: MCP OAuth 2.1 with PKCE, browser auto-open, and callback server.

## Configuration

Reads `mcp.json` from (later overrides earlier, per server):

1. `~/.config/mcp/mcp.json`
2. `~/.pi/agent/mcp.json` (or `$PI_CODING_AGENT_DIR/mcp.json`)
3. `<project>/.mcp.json`

```json
{
  "mcpServers": {
    "some-service": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    },
    "game-engine": {
      "url": "http://127.0.0.1:8080/mcp",
      "lifecycle": "keep-alive"
    },
    "my-local": {
      "command": "node",
      "args": ["path/to/server.js"],
      "lifecycle": "keep-alive"
    }
  }
}
```

Stdio servers support `env` interpolation (`"${MY_API_KEY}"`) and `cwd`.
When the command is `npx`, pi-mcp automatically resolves the cached binary
path, skipping the npm parent process for lower latency.

## Auth (OAuth 2.1)

pi-mcp supports MCP OAuth 2.1 with PKCE for HTTP servers.

### Quick start

```
/mcp-auth login <server>
```

Opens your browser and completes the flow automatically. If browser auto-open
fails, the authorization URL is printed in chat.

### Commands

| Command | Description |
|---|---|
| `/mcp-auth login <server>` | Start OAuth login flow |
| `/mcp-auth complete <server> <code>` | Complete flow with code or redirect URL |
| `/mcp-auth status <server>` | Check stored token status |
| `/mcp-auth logout <server>` | Clear stored credentials |

### Configuration

```json
{
  "mcpServers": {
    "my-server": {
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "clientId": "my-client-id",
        "scope": "openid profile"
      }
    }
  }
}
```

See [docs/technical.md](docs/technical.md) for token storage format,
environment variables, and manual completion details.

## Out of scope (v1)

- `/mcp` panel, `/mcp setup`, search/describe verbs, sampling, elicitation,
  MCP-UI.
- Tool filtering by `allowedTools`/`excludeTools`.

## Tests

```bash
node --test tests/*.test.ts
```

Requires Node ≥ 22.6 with type-stripping (`--experimental-strip-types`).
The extension ships a `node_modules` junction to `~/.pi/agent/npm/node_modules`.
