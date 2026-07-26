/**
 * connection.ts — MCP connector for pi-mcp.
 *
 * Implements the `McpConnector` seam with a self-contained manager built on
 * `@modelcontextprotocol/sdk`. Supports HTTP (StreamableHTTP + SSE) and
 * stdio (command+args with npx resolution) transports.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";

import type { McpTool } from "./utils.ts";

import { hasStoredTokens, getAuthForUrl } from "./mcp-auth.ts";
import { McpOAuthProvider, type McpOAuthConfig } from "./mcp-oauth-provider.ts";

import { resolveNpxBinary } from "./npx-resolver.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Lifecycle mode for a server connection. */
export type LifecycleMode = "lazy" | "eager" | "keep-alive";

/** Normalized server definition read from config. */
export interface ServerEntry {
  name: string;
  /** HTTP endpoint URL (StreamableHTTP, SSE fallback). */
  url?: string;
  /** Legacy mcporter-style marker; treated as HTTP when "http". */
  type?: string;
  /** HTTP headers (env interpolation handled by caller if desired). */
  headers?: Record<string, string>;
  /** Flat lifecycle mode. */
  lifecycle?: LifecycleMode;
  /** Per-server request timeout in ms. */
  requestTimeoutMs?: number;
  /** OAuth authentication configuration. Set to false to disable OAuth auto-detection. */
  auth?: "oauth" | false;
  /** OAuth configuration object (grant type, client ID, scope, etc.). */
  oauth?: McpOAuthConfig | false;
  /** Stdio: executable command (e.g. "node", "npx", or a direct binary path). */
  command?: string;
  /** Stdio: arguments to the command. */
  args?: string[];
  /** Stdio: environment variables (merged over process.env, supports \${VAR} interpolation). */
  env?: Record<string, string>;
  /** Stdio: working directory. */
  cwd?: string;
  /** Stdio: show stderr (default false). */
  debug?: boolean;
  /** Fields tolerated but ignored in v1: allowedTools / excludeTools. */
  [key: string]: unknown;
}

export interface McpConfig {
  servers: Record<string, ServerEntry>;
  /** Raw JSON shape of settings block (parsed but not yet used in v1). */
  settings?: Record<string, unknown>;
}

export type ServerStatus = "connected" | "needs-auth" | "disconnected" | "error";

export interface LoadedServer {
  name: string;
  status: ServerStatus;
  error?: string;
  tools: McpTool[];
}

export interface ProbeResult {
  status: "connected" | "unreachable";
  error?: string;
}

export interface ContentBlock {
  type: string;
  text: string;
}

export type CallOutcome =
  | {
      success: true;
      /** MCP result content blocks (text-only; images dropped in v1). */
      content: ContentBlock[];
      /** MCP-level isError flag (tool ran but reported an error). */
      isError?: boolean;
    }
  | {
      success: false;
      /** Category for diagnostics. */
      kind: "needs-auth" | "connection" | "timeout" | "unknown-tool" | "validation" | "other";
      /** Plain-text error message for buildMcpErrorHint. */
      errorText: string;
    };

/**
 * The single seam through which index.ts talks to MCP. index.ts depends only
 * on this interface; `HttpMcpManager` is the production implementation and a
 * fake is used in tests.
 */
export interface McpConnector {
  discoverServerNames(): string[];
  probeServer(name: string, signal?: AbortSignal): Promise<ProbeResult>;
  loadServer(name: string, signal?: AbortSignal): Promise<LoadedServer>;
  callTool(
    name: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<CallOutcome>;
  close(name: string): Promise<void>;
  closeAll(): Promise<void>;
  /** Reload config (re-reads files); returns new server name list. */
  reloadConfig(): string[];
  /** Get the URL of a configured server. */
  getServerUrl(name: string): string | undefined;
  /** Get the OAuth config for a server. */
  getServerOAuthConfig(name: string): McpOAuthConfig | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pure helpers (exported for tests)
// ═══════════════════════════════════════════════════════════════════════════════

/** Clamp a per-call timeout in seconds to [1, 300], defaulting to 30. */
export function clampTimeout(sec: number | undefined): number {
  const s = typeof sec === "number" && Number.isFinite(sec) ? sec : 30;
  return Math.max(1, Math.min(s, 300)) * 1000;
}

/** Parse a "server.tool" selector into {server, tool}; both must be non-empty. */
export function parseSelector(selector: string): { server: string; tool: string } | null {
  const i = selector.indexOf(".");
  if (i <= 0) return null;
  const server = selector.slice(0, i);
  const tool = selector.slice(i + 1);
  if (!server || !tool) return null;
  return { server, tool };
}

/** Normalize flat or nested `lifecycle` into a flat mode, defaulting to lazy. */
export function normalizeLifecycle(entry: Record<string, unknown>): LifecycleMode {
  const lc = (entry as Record<string, unknown>).lifecycle;
  if (typeof lc === "string") {
    if (lc === "lazy" || lc === "eager" || lc === "keep-alive") return lc;
    return "lazy";
  }
  if (lc && typeof lc === "object" && !Array.isArray(lc)) {
    const mode = (lc as Record<string, unknown>).mode;
    if (mode === "lazy" || mode === "eager" || mode === "keep-alive") return mode;
  }
  return "lazy";
}

/** True when the entry should be treated as an HTTP server. */
export function isHttpServer(entry: Record<string, unknown>): boolean {
  return typeof entry.url === "string" || entry.type === "http";
}

/** True when the entry is a stdio server (has command but no url). */
export function isStdioServer(entry: Record<string, unknown>): boolean {
  return typeof entry.command === "string" && typeof entry.url !== "string";
}

/** Build a plain error string from a thrown value, mirroring mcporter extraction. */
export function extractErrorText(err: unknown): string {
  if (!err) return "Unknown error";
  const e = err as { message?: string; stdout?: string; stderr?: string; name?: string };
  const parts = [e?.message, e?.stdout, e?.stderr].filter((p) => typeof p === "string" && p.length > 0);
  if (parts.length > 0) return parts.join("\n");
  return e?.name ?? String(err);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Config loading
// ═══════════════════════════════════════════════════════════════════════════════

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Config file paths in precedence order (lowest → highest). */
export function configPaths(): string[] {
  return [
    join(homedir(), ".config", "mcp", "mcp.json"),
    join(agentDir(), "mcp.json"),
    join(process.cwd(), ".mcp.json"),
  ];
}

/** Merge a single parsed config file (overlay) into a base config (mutates base). */
export function mergeConfigInto(base: McpConfig, overlay: any): McpConfig {
  if (!overlay || typeof overlay !== "object") return base;
  if (overlay.settings && typeof overlay.settings === "object") {
    base.settings = { ...base.settings, ...overlay.settings };
  }
  const servers = overlay.mcpServers;
  if (servers && typeof servers === "object") {
    for (const [name, entry] of Object.entries(servers)) {
      if (entry && typeof entry === "object") {
        base.servers[name] = normalizeServerEntry(name, entry as Record<string, unknown>);
      }
    }
  }
  return base;
}

export function loadMcpConfig(): McpConfig {
  const merged: McpConfig = { servers: {}, settings: {} };
  for (const path of configPaths()) {
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    mergeConfigInto(merged, parsed);
  }
  return merged;
}

export function normalizeServerEntry(name: string, raw: Record<string, unknown>): ServerEntry {
  const entry: ServerEntry = {
    name,
    url: typeof raw.url === "string" ? raw.url : undefined,
    type: typeof raw.type === "string" ? raw.type : undefined,
    headers: raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)
      ? { ...(raw.headers as Record<string, string>) }
      : undefined,
    lifecycle: normalizeLifecycle(raw),
    requestTimeoutMs:
      typeof raw.requestTimeoutMs === "number" && Number.isFinite(raw.requestTimeoutMs)
        ? raw.requestTimeoutMs
        : undefined,
  };
  // Carry through tolerated-but-ignored fields so config round-trips visibly.
  for (const k of ["allowedTools", "excludeTools", "directTools", "idleTimeout", "auth", "oauth",
    "command", "args", "env", "cwd", "debug"]) {
    if (raw[k] !== undefined) entry[k] = raw[k];
  }
  return entry;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HttpMcpManager — production McpConnector
// ═══════════════════════════════════════════════════════════════════════════════

export interface ServerConnection {
  name: string;
  client: Client;
  transport: { close(): Promise<void> } | null;
  definition: ServerEntry;
  tools: McpTool[];
  lastUsedAt: number;
  status: ServerStatus;
  healthTimer?: ReturnType<typeof setInterval>;
  /** Last mcp-session-id observed on a healthy transport. Used to carry over
   * session identity into a reconnect after the transport dies (its live
   * `sessionId` getter is cleared on close, so we cache it while it's live). */
  knownSessionId?: string;
}

const HEALTH_CHECK_INTERVAL_MS = 30_000;

/** In-place retries on a still-live transport (A): transient server-side flap.
 * Total attempts = 1 (initial) + IN_PLACE_RETRIES. 2 → up to 3 total calls. */
const IN_PLACE_RETRIES = 2;
/** Base backoff for in-place retries; grows linearly (200ms, 400ms, 600ms). */
const IN_PLACE_BACKOFF_MS = 200;

/** Read the StreamableHTTP transport's current mcp-session-id (if any). */
export function transportSessionId(transport: unknown): string | undefined {
  if (!transport || typeof transport !== "object") return undefined;
  const sid = (transport as { sessionId?: unknown }).sessionId;
  return typeof sid === "string" ? sid : undefined;
}

/** True when the connection's transport still holds a live session id (A vs B+C). */
export function hasLiveSession(conn: { transport?: unknown }): boolean {
  return conn.transport != null && transportSessionId(conn.transport) !== undefined;
}

/** Abortable, non-blocking-when-unref'd delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as any)?.unref === "function") (t as any).unref();
  });
}

export class HttpMcpManager implements McpConnector {
  protected connections = new Map<string, ServerConnection>();
  protected connecting = new Map<string, Promise<ServerConnection>>();
  protected config: McpConfig;

  constructor(config?: McpConfig) {
    this.config = config ?? loadMcpConfig();
  }

  discoverServerNames(): string[] {
    return Object.keys(this.config.servers);
  }

  reloadConfig(): string[] {
    // Drop connections for servers that no longer exist; preserve the rest.
    const next = loadMcpConfig();
    this.config = next;
    for (const name of [...this.connections.keys()]) {
      if (!next.servers[name]) {
        this.close(name).catch(() => {});
      }
    }
    return Object.keys(next.servers);
  }

  private async fetchAllTools(client: Client, reqOpts?: RequestOptions): Promise<McpTool[]> {
    const all: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const res = await client.listTools(cursor ? { cursor } : undefined, reqOpts);
      for (const t of res.tools ?? []) {
        all.push({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as McpTool["inputSchema"],
        });
      }
      cursor = res.nextCursor;
    } while (cursor);
    return all;
  }

  private buildRequestOptions(def: ServerEntry | undefined, signal?: AbortSignal, timeoutMs?: number): RequestOptions | undefined {
    const timeout = timeoutMs ?? def?.requestTimeoutMs;
    if (!signal && timeout === undefined) return undefined;
    return {
      ...(signal ? { signal } : {}),
      ...(typeof timeout === "number" && timeout > 0 ? { timeout } : {}),
    };
  }

  /**
   * Build an HTTP transport, running a probe to detect StreamableHTTP vs SSE.
   *
   * `carrySessionId` (optional) is ONLY injected into the final real transport,
   * never into the probe — the probe is always a fresh initial handshake and must
   * not try to claim a pre-existing server session. When a stale connection's
   * session id is carried over here, a server that still recognizes it will
   * re-adopt the prior session (preserving server-side state such as
   * active_instance); a server that has dropped it will assign a new one.
   */
  private async createHttpTransport(
    def: ServerEntry,
    carrySessionId?: string,
  ): Promise<{ transport: any; authNeeded: boolean }> {
    const url = new URL(def.url!);
    const headers = def.headers ?? {};
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;

    // Check for stored OAuth tokens and create an auth provider if available.
    let authProvider: McpOAuthProvider | undefined;
    if (def.url && hasStoredTokens(def.name)) {
      const stored = getAuthForUrl(def.name, def.url);
      if (stored?.tokens) {
        const oauthConfig: McpOAuthConfig = {};
        // If the definition carries OAuth config, extract it.
        if (def.oauth && typeof def.oauth === "object") {
          const oc = def.oauth as Record<string, unknown>;
          if (typeof oc.clientId === "string") oauthConfig.clientId = oc.clientId;
          if (typeof oc.clientSecret === "string") oauthConfig.clientSecret = oc.clientSecret;
          if (typeof oc.scope === "string") oauthConfig.scope = oc.scope;
        }
        authProvider = new McpOAuthProvider(def.name, def.url, oauthConfig, {
          onRedirect: async () => {
            // Should not happen during transport creation; if it does,
            // the SDK is trying to start a fresh auth flow, which means
            // our stored tokens are no longer valid.
          },
        });
      }
    }

    const transportOpts: Record<string, unknown> = { requestInit };
    if (carrySessionId) transportOpts.sessionId = carrySessionId;
    if (authProvider) transportOpts.authProvider = authProvider;

    // Probe with authProvider (if present) so stored tokens are presented.
    const probe = new StreamableHTTPClientTransport(url, transportOpts);
    try {
      const probeClient = new Client({ name: `pi-mcp-probe`, version: "1.0.0" });
      await probeClient.connect(probe, this.buildRequestOptions(def));
      await probeClient.close().catch(() => {});
      await probe.close().catch(() => {});
      // Fresh transport for actual use (probe may have consumed session state on some servers).
      // Carry over the stale session id so a server that still recognizes it re-adopts it.
      const realOpts = { ...transportOpts };
      return { transport: new StreamableHTTPClientTransport(url, realOpts), authNeeded: false };
    } catch (err) {
      await probe.close().catch(() => {});
      if (err instanceof UnauthorizedError) {
        return { transport: null, authNeeded: true };
      }
      if (signalAborted(def, err)) throw err;
      // Fall back to SSE (legacy transport). SSE transport has no sessionId hook;
      // carry-over is a StreamableHTTP-only capability and is intentionally dropped here.
      return { transport: new SSEClientTransport(url, { requestInit }), authNeeded: false };
    }
  }

  /**
   * Create a transport and connection for a stdio server.
   * Resolves npx/npm exec to direct binary paths when possible.
   */
  private async createStdioConnection(
    name: string,
    def: ServerEntry,
    signal?: AbortSignal,
  ): Promise<ServerConnection> {
    let command = def.command!;
    let args = def.args ?? [];

    // Attempt npx/npm resolution
    if (command === "npx" || command === "npm") {
      try {
        const resolved = await resolveNpxBinary(command, args);
        if (resolved) {
          command = resolved.isJs ? "node" : resolved.binPath;
          args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
        }
      } catch { /* fall through to original command */ }
    }

    const env = resolveStdioEnv(def.env);
    const cwd = def.cwd ? resolve(def.cwd) : undefined;

    const transport = new StdioClientTransport({
      command,
      args,
      env,
      cwd,
      stderr: def.debug ? "inherit" : "ignore",
    });

    const client = new Client({ name: `pi-mcp-${name}`, version: "1.0.0" });
    const reqOpts = this.buildRequestOptions(def, signal);

    try {
      await client.connect(transport, reqOpts);
      const tools = await this.fetchAllTools(client, reqOpts);

      const conn: ServerConnection = {
        name,
        client,
        transport,
        definition: def,
        tools,
        lastUsedAt: Date.now(),
        status: "connected",
      };

      if (def.lifecycle === "keep-alive") {
        this.startHealthCheck(conn);
      }

      return conn;
    } catch (err) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});

      const conn: ServerConnection = {
        name,
        client,
        transport,
        definition: def,
        tools: [],
        lastUsedAt: Date.now(),
        status: "error",
      };
      (conn as any)._errorText = extractErrorText(err);
      return conn;
    }
  }

  async loadServer(name: string, signal?: AbortSignal): Promise<LoadedServer> {
    const conn = await this.connect(name, signal);
    return {
      name,
      status: conn.status,
      error: conn.status === "error" ? (conn as any)._errorText : undefined,
      tools: conn.tools,
    };
  }

  async callTool(
    name: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<CallOutcome> {
    let conn: ServerConnection;
    try {
      conn = await this.connect(name, signal);
    } catch (err) {
      return {
        success: false,
        kind: "connection",
        errorText: extractErrorText(err),
      };
    }
    if (conn.status === "needs-auth") {
      return {
        success: false,
        kind: "needs-auth",
        errorText: `Server "${name}" requires authentication. Run /mcp-auth login ${name} to start the OAuth flow.`,
      };
    }
    if (conn.status !== "connected") {
      return {
        success: false,
        kind: "connection",
        errorText: `Server "${name}" is not connected (status: ${conn.status}).`,
      };
    }

    const reqOpts = this.buildRequestOptions(conn.definition, signal, timeoutMs);
    try {
      this.touch(name);
      const res = await conn.client.callTool({ name: tool, arguments: args }, undefined, reqOpts);
      const content: ContentBlock[] = (res.content ?? [])
        .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
        .map((b: any) => ({ type: "text", text: b.text }));
      this.touch(name);
      return { success: true, content, isError: res.isError === true };
    } catch (err) {
      // A: transport still healthy (session id intact) → transient server-side flap.
      // Retry in place on the same transport/session up to IN_PLACE_RETRIES more times
      // (total 3 attempts) with linear backoff. No close, no reconnect — server-side
      // session state is fully preserved.
      if (hasLiveSession(conn) && !isTimeoutLike(err)) {
        for (let attempt = 1; attempt <= IN_PLACE_RETRIES; attempt++) {
          if (signal?.aborted) return { success: false, kind: classify(err), errorText: extractErrorText(err) };
          await delay(IN_PLACE_BACKOFF_MS * attempt).catch(() => {});
          try {
            this.touch(name);
            const res2 = await conn.client.callTool(
              { name: tool, arguments: args },
              undefined,
              this.buildRequestOptions(conn.definition, signal, timeoutMs),
            );
            const content2: ContentBlock[] = (res2.content ?? [])
              .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
              .map((b: any) => ({ type: "text", text: b.text }));
            this.touch(name);
            return { success: true, content: content2, isError: res2.isError === true };
          } catch (err2) {
            err = err2;
            // If the transport died mid-retry, session is gone → fall through to B (carry-over reconnect).
            if (!hasLiveSession(conn)) break;
          }
        }
        // In-place retries exhausted on a still-live session: surface the last error.
        return { success: false, kind: classify(err), errorText: extractErrorText(err) };
      }

      // B+C: transport genuinely dead (live session id cleared). Reconnect carrying
      // the stale session id (cached while the transport was healthy) so a server that
      // still recognizes it re-adopts the prior session (preserving server-side state).
      const carriedId = conn.knownSessionId;
      await this.close(name).catch(() => {});
      try {
        const conn2 = await this.connect(name, signal, carriedId);
        if (conn2.status !== "connected") {
          return { success: false, kind: "connection", errorText: `Reconnect failed (status: ${conn2.status}).` };
        }
        const res2 = await conn2.client.callTool(
          { name: tool, arguments: args },
          undefined,
          this.buildRequestOptions(conn2.definition, signal, timeoutMs),
        );
        const content2: ContentBlock[] = (res2.content ?? [])
          .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
          .map((b: any) => ({ type: "text", text: b.text }));
        this.touch(name);
        return { success: true, content: content2, isError: res2.isError === true };
      } catch (err2) {
        return { success: false, kind: classify(err2), errorText: extractErrorText(err2) };
      }
    }
  }

  protected async connect(name: string, signal?: AbortSignal, carrySessionId?: string): Promise<ServerConnection> {
    const existing = this.connections.get(name);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    // needs-auth / disconnected / error → reconnect fresh (carrying session id if provided)
    if (existing && existing.status !== "connected") {
      await this.tearDown(existing).catch(() => {});
      this.connections.delete(name);
    }
    if (this.connecting.has(name)) {
      return this.connecting.get(name)!;
    }
    const def = this.config.servers[name];
    if (!def) {
      throw new Error(`No MCP server named "${name}". Available: ${this.discoverServerNames().join(", ") || "none"}.`);
    }
    if (!isHttpServer(def) && !isStdioServer(def)) {
      throw new Error(`Server "${name}" has neither a url nor a command. Cannot connect.`);
    }
    const p = this.createConnection(name, def, signal, carrySessionId);
    this.connecting.set(name, p);
    try {
      const conn = await p;
      this.connections.set(name, conn);
      return conn;
    } finally {
      this.connecting.delete(name);
    }
  }

  protected async createConnection(
    name: string,
    def: ServerEntry,
    signal?: AbortSignal,
    carrySessionId?: string,
  ): Promise<ServerConnection> {
    // Stdio path
    if (isStdioServer(def)) {
      return this.createStdioConnection(name, def, signal);
    }

    // HTTP path
    let transportResult: { transport: any; authNeeded: boolean };
    try {
      transportResult = await this.createHttpTransport(def, carrySessionId);
    } catch (err) {
      const conn: ServerConnection = {
        name,
        client: new Client({ name: `pi-mcp-${name}`, version: "1.0.0" }),
        transport: null as any,
        definition: def,
        tools: [],
        lastUsedAt: Date.now(),
        status: "error",
      };
      (conn as any)._errorText = extractErrorText(err);
      return conn;
    }

    if (transportResult.authNeeded) {
      const conn: ServerConnection = {
        name,
        client: new Client({ name: `pi-mcp-${name}`, version: "1.0.0" }),
        transport: null as any,
        definition: def,
        tools: [],
        lastUsedAt: Date.now(),
        status: "needs-auth",
      };
      return conn;
    }

    const client = new Client({ name: `pi-mcp-${name}`, version: "1.0.0" });
    const transport = transportResult.transport;
    const reqOpts = this.buildRequestOptions(def, signal);
    try {
      await client.connect(transport, reqOpts);
      const tools = await this.fetchAllTools(client, this.buildRequestOptions(def, signal));
      const conn: ServerConnection = {
        name,
        client,
        transport,
        definition: def,
        tools,
        lastUsedAt: Date.now(),
        status: "connected",
        knownSessionId: transportSessionId(transport),
      };
      if (def.lifecycle === "keep-alive") {
        this.startHealthCheck(conn);
      }
      return conn;
    } catch (err) {
      await client.close().catch(() => {});
      await transport?.close().catch(() => {});
      if (err instanceof UnauthorizedError) {
        return {
          name,
          client,
          transport: null as any,
          definition: def,
          tools: [],
          lastUsedAt: Date.now(),
          status: "needs-auth",
        };
      }
      const conn: ServerConnection = {
        name,
        client,
        transport,
        definition: def,
        tools: [],
        lastUsedAt: Date.now(),
        status: "error",
      };
      (conn as any)._errorText = extractErrorText(err);
      return conn;
    }
  }

  private startHealthCheck(conn: ServerConnection): void {
    if (conn.healthTimer) return;
    conn.healthTimer = setInterval(async () => {
      try {
        await conn.client.listTools(undefined, this.buildRequestOptions(conn.definition));
        // healthy — leave connection alone
      } catch {
        // stale: mark + tear down so next call reconnects
        if (this.connections.get(conn.name) === conn) {
          conn.status = "disconnected";
          this.connections.delete(conn.name);
          this.tearDown(conn).catch(() => {});
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    // Don't keep the event loop alive solely for keep-alive pings.
    if (typeof conn.healthTimer?.unref === "function") conn.healthTimer.unref();
  }

  private touch(name: string): void {
    const c = this.connections.get(name);
    if (c) {
      c.lastUsedAt = Date.now();
      // Refresh cached session id while the transport is healthy.
      const sid = transportSessionId(c.transport);
      if (sid !== undefined) c.knownSessionId = sid;
    }
  }

  private async tearDown(conn: ServerConnection): Promise<void> {
    if (conn.healthTimer) {
      clearInterval(conn.healthTimer);
      conn.healthTimer = undefined;
    }
    await conn.client.close().catch(() => {});
    await conn.transport?.close().catch(() => {});
  }

  async close(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    if (conn.healthTimer) {
      clearInterval(conn.healthTimer);
      conn.healthTimer = undefined;
    }
    this.connections.delete(name);
    await this.tearDown(conn);
  }

  /** Lightweight probe: connect and immediately close. Does NOT fetch tools. */
  async probeServer(name: string, signal?: AbortSignal): Promise<ProbeResult> {
    const def = this.config.servers[name];
    if (!def) return { status: "unreachable", error: `No MCP server named "${name}" in config.` };

    // Stdio probe: just try to connect and close
    if (isStdioServer(def)) {
      try {
        const conn = await this.createStdioConnection(name, def, signal);
        await this.tearDown(conn).catch(() => {});
        if (conn.status === "connected") return { status: "connected" };
        return { status: "unreachable", error: (conn as any)._errorText ?? "Unknown error" };
      } catch (err) {
        return { status: "unreachable", error: extractErrorText(err) };
      }
    }

    // HTTP probe
    if (!isHttpServer(def)) {
      return { status: "unreachable", error: `Server "${name}" has neither a url nor a command.` };
    }

    try {
      const { transport, authNeeded } = await this.createHttpTransport(def);
      if (authNeeded) {
        return { status: "unreachable", error: `Server requires OAuth authentication. Run /mcp-auth login ${name} to start the OAuth flow.` };
      }
      const client = new Client({ name: `pi-mcp-probe-${name}`, version: "1.0.0" });
      try {
        await client.connect(transport, this.buildRequestOptions(def, signal));
        return { status: "connected" };
      } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      }
    } catch (err) {
      return { status: "unreachable", error: extractErrorText(err) };
    }
  }

  /** Get the URL of a configured server. */
  getServerUrl(name: string): string | undefined {
    return this.config.servers[name]?.url;
  }

  /** Get the OAuth configuration for a configured server. */
  getServerOAuthConfig(name: string): McpOAuthConfig | undefined {
    const def = this.config.servers[name];
    if (!def?.oauth || def.oauth === false || typeof def.oauth !== "object") return undefined;
    const o = def.oauth as Record<string, unknown>;
    const config: McpOAuthConfig = {};
    if (o.grantType === "authorization_code" || o.grantType === "client_credentials") config.grantType = o.grantType;
    if (typeof o.clientId === "string") config.clientId = o.clientId;
    if (typeof o.clientSecret === "string") config.clientSecret = o.clientSecret;
    if (typeof o.scope === "string") config.scope = o.scope;
    if (typeof o.redirectUri === "string") config.redirectUri = o.redirectUri;
    if (typeof o.clientName === "string") config.clientName = o.clientName;
    if (typeof o.clientUri === "string") config.clientUri = o.clientUri;
    return config;
  }

  async closeAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map((n) => this.close(n).catch(() => {})));
  }
}

// ── env interpolation ───────────────────────────────────────────────────────

/**
 * Merge server-specific env vars over process.env, with \${VAR} interpolation.
 * Returns undefined when env is empty/undefined, so StdioClientTransport
 * inherits the parent process environment by default.
 */
export function resolveStdioEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env || Object.keys(env).length === 0) return undefined;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value;
  }

  for (const [key, rawValue] of Object.entries(env)) {
    result[key] = rawValue.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
      return process.env[varName] ?? "";
    });
  }

  return result;
}

// ── error classification helpers ────────────────────────────────────────────

function signalAborted(_def: ServerEntry, err: unknown): boolean {
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: string }).name;
    if (name === "AbortError") return true;
  }
  return false;
}

function isTimeoutLike(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  const blob = `${e?.name ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return blob.includes("timeout") || blob.includes("timed out");
}

function isTransient(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  const blob = `${e?.name ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return (
    blob.includes("econnreset") ||
    blob.includes("econnrefused") ||
    blob.includes("socket hang up") ||
    blob.includes("fetch failed") ||
    blob.includes("connection closed") ||
    blob.includes("client closed") ||
    blob.includes("not connected") ||
    blob.includes("disconnected") ||
    blob.includes("transport closed")
  );
}

function classify(err: unknown): Exclude<CallOutcome, { success: true }>["kind"] {
  if (err instanceof UnauthorizedError) return "needs-auth";
  if (isTimeoutLike(err)) return "timeout";
  if (isTransient(err)) return "connection";
  const e = err as { message?: string };
  const msg = (e?.message ?? "").toLowerCase();
  if (msg.includes("unknown tool")) return "unknown-tool";
  if (msg.includes("validation")) return "validation";
  return "other";
}