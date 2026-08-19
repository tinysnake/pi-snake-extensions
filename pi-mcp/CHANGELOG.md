# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-19

### Added

- `/mcp-list` command — a user-only overlay panel (globally centered,
  Esc to close) listing the cached MCP server state: availability, loaded
  tool count, auth status, and errors. Content is display-only and never
  enters LLM context.
- MCP server list is injected into LLM context as `<mcp-info-update>` blocks
  (`display: false`) — the agent's picture of available servers now stays in
  sync with the registry, and only the most recent block is authoritative.

### Changed

- CI: npm publishing is now gated on GitHub releases (`on: release`) instead
  of push-triggered auto-publish. Pre-releases are skipped, and the release
  tag must match `package.json` version before anything runs.
- Release notes are sourced from this CHANGELOG: bump the version, move the
  `[Unreleased]` section into a versioned heading, then paste that section
  into the GitHub release body.
- The `CHANGELOG.md` is now included in the published npm tarball, and the
  README links to it.

### Fixed

- Retry backoff timers no longer call `unref()`, so in-flight retries keep the
  Node event loop alive until they complete.
- Tests await the fire-and-forget background discovery before asserting state.

## [0.1.0] - 2026-07-26

Initial release.

### Added

- `mcp_load` / `mcp_call` / `mcp_refresh` tools — load-once, whole-server
  schema workflow: `mcp_load <server>` fetches every tool's name, description,
  and full parameter schema in one call; `mcp_call <server.tool>` uses the
  cached schemas with zero additional discovery round-trips.
- Load-before-call gating — `mcp_call` refuses to execute without a prior
  `mcp_load`, and errors steer the agent back to the missing step.
- Background server discovery at session start (non-blocking, parallel probes).
- System prompt guidelines reminding the agent of the load-before-call
  workflow (a few lines only — not a full schema dump).
- Actionable validation-error hints with parameter-schema snippets for
  self-correction.
- Self-healing keep-alive connections — 30s health check tears down stale
  transports; session identity is preserved across reconnects.
- HTTP (StreamableHTTP with SSE fallback) and stdio transports; automatic `npx`
  binary resolution (cached 24h) for stdio servers.
- Lifecycle modes: `"lazy"` (connect on first load) and `"keep-alive"`.
- MCP OAuth 2.1 with PKCE: browser auto-open, callback server, token storage
  in the agent dir, and `/mcp-auth login|complete|status|logout` commands.
- Config resolution from `~/.config/mcp/mcp.json`, `~/.pi/agent/mcp.json`,
  and `<project>/.mcp.json` (later overrides earlier, per server).