/**
 * pi-mcp extension entry point.
 *
 * Reproduces the pi-mcporter three-tool UX (mcp_load / mcp_call / mcp_refresh)
 * backed by a self-contained in-process MCP SDK connector instead of an
 * external `mcporter` CLI and daemon. See README.md for rationale.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Text } from "@earendil-works/pi-tui";

import {
  formatToolList,
  truncateOutput,
  formatMcpCall,
  ToolResultContainer,
  rebuildToolResultContainer,
  buildMcpErrorHint,
  formatSchemaSnippet,
  type McpServer,
  type McpTool,
} from "./utils.ts";
import {
  HttpMcpManager,
  clampTimeout,
  parseSelector,
  extractErrorText,
  type McpConnector,
  type LoadedServer,
  type CallOutcome,
} from "./connection.ts";

import { execSync } from "node:child_process";

import {
  startAuth as flowStartAuth,
  completeAuth as flowCompleteAuth,
  removeAuth,
  getAuthStatus,
  initializeOAuth,
  shutdownOAuth,
} from "./mcp-auth-flow.ts";

import { waitForCallback } from "./mcp-callback-server.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// Registry factory — wires tools + command against an injected McpConnector.
// Exported so tests can drive the seam with a fake connector + stub pi.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ServerInfo {
  name: string;
  status: "connected" | "unreachable";
  error?: string;
  /** Tools are undefined until mcp_load successfully fetches them. */
  tools?: McpTool[];
  /** Authentication status (undefined means not checked yet). */
  auth?: "authenticated" | "expired" | "not_authenticated";
}

export interface McpRegistry {
  performDiscovery(ctx: any): Promise<void>;
  serverNames(): string[];
  loadedCount(): number;
  shutdown(): Promise<void>;
}

export function createMcpRegistry(pi: ExtensionAPI, connector: McpConnector): McpRegistry {
  let serverInfos = new Map<string, ServerInfo>();
  let discoveryComplete = false;
  let discoveryPromise: Promise<void> | null = null;

  function serverNamesSnapshot(): string[] {
    return [...serverInfos.keys()];
  }

  /** Trigger async background discovery: probe each configured server. */
  async function performDiscovery(ctx: any): Promise<void> {
    if (discoveryPromise) return discoveryPromise;
    discoveryPromise = (async () => {
      const configNames = connector.discoverServerNames();
      if (configNames.length === 0) {
        discoveryComplete = true;
        try {
          ctx?.ui?.setStatus?.("pi-mcp", `⚠️ pi-mcp: no servers configured`);
          const t = setTimeout(() => {
            try { ctx?.ui?.setStatus?.("pi-mcp", undefined); } catch { /* ctx stale */ }
          }, 10000);
          if (typeof (t as any)?.unref === "function") (t as any).unref();
        } catch { /* ctx stale */ }
        try {
          pi.sendMessage({
            customType: "mcp-init",
            content: "pi-mcp initialisation complete. No MCP servers configured.",
            display: true,
          }, { deliverAs: "steer" });
        } catch { /* pi may be disposed */ }
        return;
      }

      // Probe all servers in parallel (lightweight: connect only, no tools)
      const probes: Promise<{ name: string; result: ProbeResult }>[] = configNames.map((name) =>
        connector.probeServer(name).then((result) => ({ name, result })).catch((err) => ({
          name,
          result: { status: "unreachable" as const, error: extractErrorText(err) },
        })),
      );
      const results = await Promise.all(probes);

      // Populate unified state
      serverInfos.clear();
      const available: string[] = [];
      const unavailable: string[] = [];
      for (const { name, result } of results) {
        const info: ServerInfo = {
          name,
          status: result.status,
          error: result.status === "unreachable" ? result.error : undefined,
        };
        serverInfos.set(name, info);
        if (result.status === "connected") {
          available.push(name);
        } else {
          unavailable.push(name);
        }
      }

      discoveryComplete = true;

      // Build the formatted message
      let listMsg: string;
      if (available.length > 0 && unavailable.length > 0) {
        listMsg = `✅ Available servers: ${available.join(", ")}\n❌ Unavailable servers: ${unavailable.join(", ")}`;
      } else if (available.length > 0) {
        listMsg = `✅ Available servers: ${available.join(", ")}`;
      } else {
        listMsg = `❌ All servers unreachable: ${unavailable.join(", ")}`;
      }
      listMsg += `\nYou must call \`mcp_load <server>\` to load tool schemas before using \`mcp_call\`. Never guess tool names or parameters.`;

      try {
        pi.sendMessage({ customType: "mcp-init", content: listMsg, display: true }, { deliverAs: "steer" });
      } catch { /* pi may be disposed */ }

      try {
        ctx?.ui?.setStatus?.("pi-mcp", `✅ pi-mcp: ${available.length} available, ${unavailable.length} unreachable`);
        const t = setTimeout(() => {
          try { ctx?.ui?.setStatus?.("pi-mcp", undefined); } catch { /* ctx stale */ }
        }, 10000);
        if (typeof (t as any)?.unref === "function") (t as any).unref();
      } catch { /* ctx stale */ }
    })();
    return discoveryPromise;
  }

  // ── session lifecycle (non-blocking background discovery) ─────────────
  pi.on("session_start", async (event, ctx) => {
    // Skip reload/resume/fork
    if (event.reason !== "new" && event.reason !== "startup") return;

    // Initialize OAuth system on fresh session
    try { await initializeOAuth(); } catch { /* best effort */ }

    try { ctx.ui.setStatus("pi-mcp", "🔍 pi-mcp: discovering..."); } catch { /* ctx stale */ }

    // Fire-and-forget: discovery probes all MCP servers in the background.
    // Do NOT await — pi dispatches event handlers sequentially, and server
    // probes (TCP/TLS + protocol handshake) can take seconds per server.
    // Tools gracefully return "still discovering" until discovery completes.
    performDiscovery(ctx).catch(() => {});
  });

  pi.on("before_agent_start", (event, _ctx) => {
    // NOTE: pushing to event.systemPromptOptions.promptGuidelines is NOT effective
    // because pi builds the system prompt BEFORE firing this event and does NOT
    // rebuild it from mutated options. The only way to modify the system prompt is
    // to return { systemPrompt: modified } from this handler.
    // (Confirmed in agent-session.js ~line 888-922)
    const guidelines: string[] = [
      "MCP tools require a load-before-call workflow. You MUST call mcp_load <server> to load the complete tool schemas (names, descriptions, full parameter types) for a server before calling mcp_call for any tool on that server. Calling mcp_call without a prior mcp_load for that server will fail with an error. Never guess tool names, parameter names, or parameter types — load the server first.",
      "When an MCP server is unavailable (❌), do NOT investigate why. Immediately tell the user the server is unreachable and ask if they want help troubleshooting — do not attempt any diagnosis yourself.",
    ];

    // Append guidelines after the last known guideline sentinel
    const sentinel = "Show file paths clearly when working with files";
    const idx = event.systemPrompt.indexOf(sentinel);
    if (idx !== -1) {
      const additional = guidelines.map((g) => `\n- ${g}`).join("");
      return {
        systemPrompt:
          event.systemPrompt.slice(0, idx + sentinel.length) +
          additional +
          event.systemPrompt.slice(idx + sentinel.length),
      };
    }
    // Fallback: append at the end
    return {
      systemPrompt: event.systemPrompt + "\n" + guidelines.map((g) => `- ${g}`).join("\n"),
    };
  });

  pi.on("session_shutdown", async () => {
    try {
      await Promise.all([
        connector.closeAll(),
        shutdownOAuth(),
      ]);
    } catch { /* best effort */ }
  });

  // ── mcp_load ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "mcp_load",
    label: "MCP Load",
    description:
      "Load complete tool schemas for an MCP server. Call this BEFORE mcp_call. " +
      "Returns all tool names, descriptions, and full parameter schemas (types, " +
      "required/optional flags, enum values) for the specified server at once.",
    promptSnippet: "Load MCP server tool schemas before calling mcp_call",
    parameters: Type.Object({
      server: Type.String({ description: "MCP server name to load (e.g. 'unityMCP')" }),
    }),
    renderCall(args, theme, context) {
      const state = context.state;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text: Text = (context.lastComponent ?? new Text("", 0, 0)) as Text;
      text.setText(formatMcpCall("mcp_load", args, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      if (context.isError) throw new Error("error");
      const state = context.state;
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) { clearInterval(state.interval); state.interval = undefined; }
      }
      const container: ToolResultContainer = (context.lastComponent ?? new ToolResultContainer()) as ToolResultContainer;
      rebuildToolResultContainer(container, result, options, theme, state.startedAt, state.endedAt);
      container.invalidate();
      return container;
    },
    async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
      const server = params.server as string;
      if (!server) {
        return {
          content: [{ type: "text" as const, text: "mcp_load requires a server name." }],
          details: { serverCount: 0, toolCount: 0 },
        };
      }
      if (!discoveryComplete) {
        return {
          content: [{ type: "text" as const, text: "pi-mcp is still discovering servers. Try again in a moment, or call mcp_refresh." }],
          details: { serverCount: 0, toolCount: 0 },
        };
      }
      if (!serverInfos.has(server)) {
        const available = [...serverInfos.keys()].join(", ");
        return {
          content: [{ type: "text" as const, text: `No MCP server found named "${server}". Available: ${available || "none"}.` }],
          details: { serverCount: 0, toolCount: 0 },
        };
      }

      // Clear any cached tools for this server, then reload
      onUpdate?.({
        content: [{ type: "text" as const, text: "Loading..." }],
        details: { serverCount: 0, toolCount: 0, status: "in-progress" },
      });

      let loaded: LoadedServer;
      try {
        loaded = await connector.loadServer(server, _signal);
      } catch (err: unknown) {
        serverInfos.set(server, {
          name: server,
          status: "unreachable",
          error: extractErrorText(err),
        });
        throw new Error(
          `[pi-mcp] server "${server}" is unreachable. ` +
          `This may be a persistent issue \u2014 report to the user rather than retrying.`,
        );
      }

      if (loaded.status !== "connected" || loaded.tools.length === 0) {
        // Connected but no tools, or error status
        serverInfos.set(server, {
          name: server,
          status: "unreachable",
          error: loaded.error || "No tools reported",
        });
        throw new Error(
          `[pi-mcp] server "${server}" is unreachable (${loaded.status}: ${loaded.error ?? "no tools"}). ` +
          `This may be a persistent issue \u2014 report to the user rather than retrying.`,
        );
      }

      // Success: update unified state with tools
      serverInfos.set(server, {
        name: server,
        status: "connected",
        tools: loaded.tools,
      });

      const mcpServer: McpServer = {
        name: loaded.name,
        status: loaded.status,
        tools: loaded.tools,
      };
      const text = formatToolList([mcpServer], undefined, "detail");
      return {
        content: [{ type: "text" as const, text }],
        details: { servers: [mcpServer], serverCount: 1, toolCount: mcpServer.tools.length },
      };
    },
  });

  // ── mcp_call ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "mcp_call",
    label: "MCP Call",
    description:
      "Call an MCP server tool. Use mcp_load first to load the server's tool schemas. " +
      "Selector format: server.tool (e.g. github.list_issues). " +
      "Pass arguments as a JSON object matching the tool's parameter schema.",
    promptSnippet: "Call an MCP tool with selector server.tool and JSON arguments",
    parameters: Type.Object({
      selector: Type.String({ description: "Server and tool in format server.tool (e.g. github.list_issues)" }),
      args: Type.Any({
        description:
          "Tool arguments as a JSON object (e.g. {\"owner\": \"user\", \"repo\": \"repo\"}). Default: {}",
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30, max: 300)" })),
    }),
    renderCall(args, theme, context) {
      const state = context.state;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text: Text = (context.lastComponent ?? new Text("", 0, 0)) as Text;
      text.setText(formatMcpCall("mcp_call", args, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      if (context.isError) throw new Error("error");
      const state = context.state;
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) { clearInterval(state.interval); state.interval = undefined; }
      }
      const container: ToolResultContainer = (context.lastComponent ?? new ToolResultContainer()) as ToolResultContainer;
      rebuildToolResultContainer(container, result, options, theme, state.startedAt, state.endedAt, "\u25BC result");
      container.invalidate();
      return container;
    },
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const selector = params.selector ?? "";
      const parsed = parseSelector(selector);
      if (!parsed) {
        return {
          content: [{ type: "text" as const, text: `Invalid selector "${selector}". Use format server.tool (e.g. github.list_issues).` }],
          details: { selector },
        };
      }
      const { server: serverName, tool: toolName } = parsed;

      if (!discoveryComplete) {
        return {
          content: [{ type: "text" as const, text: "pi-mcp is still discovering servers. Try again in a moment, or call mcp_refresh." }],
          details: { selector },
        };
      }

      const serverInfo = serverInfos.get(serverName);
      if (!serverInfo) {
        const available = [...serverInfos.keys()].join(", ");
        return {
          content: [{ type: "text" as const, text: `Server "${serverName}" not found. Available: ${available || "none"}.` }],
          details: { selector },
        };
      }

      if (serverInfo.status === "unreachable") {
        return {
          content: [{ type: "text" as const, text: `Server "${serverName}" is unreachable. Call mcp_load ${serverName} to retry.` }],
          details: { selector },
        };
      }

      // Gate: must have loaded schemas for this server
      if (!serverInfo.tools) {
        return {
          content: [{ type: "text" as const, text: `Server '${serverName}' has not been loaded. You must call mcp_load ${serverName} first to load its tool schemas before calling mcp_call.` }],
          details: { selector },
        };
      }

      const timeoutMs = clampTimeout(params.timeout as number | undefined);
      const argsObj: Record<string, unknown> =
        params.args !== undefined && params.args !== null
          ? typeof params.args === "string"
            ? safeParseArgs(params.args as string)
            : (params.args as Record<string, unknown>)
          : {};

      onUpdate?.({
        content: [{ type: "text" as const, text: "Processing..." }],
        details: { selector, status: "in-progress" },
      });

      try {
        const outcome: CallOutcome = await connector.callTool(serverName, toolName, argsObj, signal, timeoutMs);

        if (!outcome.success) {
          const { text, isValidationError } = buildMcpErrorHint(outcome.errorText, serverName, toolName);
          let errorMsg = text;
          if (isValidationError) {
            const si = serverInfos.get(serverName);
            if (si?.tools) {
              const tool = si.tools.find((t: McpTool) => t.name === toolName);
              if (tool) {
                const snippet = formatSchemaSnippet(tool);
                errorMsg = text + "\n---\n" + snippet;
              }
            }
          }
          return {
            content: [{ type: "text" as const, text: `[${selector}] error: ${errorMsg}` }],
            details: { selector, error: outcome.errorText, kind: outcome.kind },
          };
        }

        // Success — format content text (pretty JSON when possible)
        const rawText = outcome.content.map((c) => c.text).join("\n");
        const trunc = truncateOutput(rawText);
        let formatted: string;
        try {
          const parsedJson = JSON.parse(trunc.content);
          formatted = JSON.stringify(parsedJson, null, 2);
        } catch {
          formatted = trunc.content || "(empty output)";
        }
        if (outcome.isError) {
          // MCP tool-level error: surface via buildMcpErrorHint for actionable hint
          const hint = buildMcpErrorHint(formatted, serverName, toolName);
          return {
            content: [{ type: "text" as const, text: `[${selector}] error: ${hint.text}` }],
            details: { selector, error: formatted, isError: true },
          };
        }

        // Save to temp file only when truncated
        let tempFilePath: string | undefined;
        if (trunc.truncated) {
          const tempDir = await mkdtemp(join(tmpdir(), "pi-mcp-"));
          const safe = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
          tempFilePath = join(tempDir, `${safe}_result.txt`);
          await writeFile(tempFilePath, rawText, "utf-8");
        }
        return {
          content: [{ type: "text" as const, text: formatted }],
          details: { selector, tempFilePath },
        };
      } catch (error: unknown) {
        const errorMsg = `[${selector}] error: ${extractErrorText(error)}`;
        return { content: [{ type: "text" as const, text: errorMsg }], details: { selector, error: extractErrorText(error) } };
      }
    },
  });

  // ── mcp_refresh ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "mcp_refresh",
    label: "MCP Refresh",
    description:
      "Refresh the MCP server list (re-reads config) and tool cache. Use when MCP " +
      "configuration has changed or a server is not found.",
    promptSnippet: "Refresh MCP server cache",
    parameters: Type.Object({}),
    renderCall(_args, theme, context) {
      const state = context.state;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text: Text = (context.lastComponent ?? new Text("", 0, 0)) as Text;
      text.setText(formatMcpCall("mcp_refresh", {}, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      if (context.isError) throw new Error("error");
      const state = context.state;
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) { clearInterval(state.interval); state.interval = undefined; }
      }
      const container: ToolResultContainer = (context.lastComponent ?? new ToolResultContainer()) as ToolResultContainer;
      rebuildToolResultContainer(container, result, options, theme, state.startedAt, state.endedAt);
      container.invalidate();
      return container;
    },
    async execute(_toolCallId, _params, _signal, onUpdate, _ctx) {
      onUpdate?.({
        content: [{ type: "text" as const, text: "Refreshing..." }],
        details: { serverCount: 0, status: "in-progress" },
      });

      // Reload config, then re-discover all servers (full reset)
      connector.reloadConfig();
      discoveryComplete = false;
      discoveryPromise = null;
      serverInfos.clear();

      const configNames = connector.discoverServerNames();
      if (configNames.length === 0) {
        discoveryComplete = true;
        return {
          content: [{ type: "text" as const, text: "pi-mcp cache refreshed. No MCP servers configured." }],
          details: { serverCount: 0 },
        };
      }

      // Probe all servers
      const probes = configNames.map((name) =>
        connector.probeServer(name).then((result) => ({ name, result })).catch((err) => ({
          name,
          result: { status: "unreachable" as const, error: extractErrorText(err) },
        })),
      );
      const results = await Promise.all(probes);

      const available: string[] = [];
      const unavailable: string[] = [];
      for (const { name, result } of results) {
        serverInfos.set(name, {
          name,
          status: result.status,
          error: result.status === "unreachable" ? result.error : undefined,
        });
        if (result.status === "connected") {
          available.push(name);
        } else {
          unavailable.push(name);
        }
      }
      discoveryComplete = true;

      return {
        content: [{
          type: "text" as const,
          text: `pi-mcp cache refreshed. ✅ Available: ${available.join(", ") || "none"}${unavailable.length > 0 ? ` ❌ Unavailable: ${unavailable.join(", ")}` : ""}. 0 server(s) with loaded schemas.`,
        }],
        details: { serverCount: configNames.length },
      };
    },
  });

  // ── /mcp-refresh command (async background) ─────────────────────────────
  pi.registerCommand("mcp-refresh", {
    description: "Refresh pi-mcp server cache (full reset)",
    handler: async (_args, ctx) => {
      try { ctx.ui.setStatus("pi-mcp", "🔄 pi-mcp: refreshing cache..."); } catch { /* ctx stale */ }
      try {
        connector.reloadConfig();
        discoveryComplete = false;
        discoveryPromise = null;
        serverInfos.clear();

        const configNames = connector.discoverServerNames();
        if (configNames.length === 0) {
          discoveryComplete = true;
          try {
            ctx.ui.setStatus("pi-mcp", `⚠️ pi-mcp: no servers configured`);
            setTimeout(() => { try { ctx.ui.setStatus("pi-mcp", undefined); } catch {} }, 10000);
          } catch { /* ctx stale */ }
          const msg = "pi-mcp cache refreshed. No MCP servers configured.";
          try { pi.sendMessage({ customType: "mcp-refresh", content: msg, display: true }, { deliverAs: "steer" }); } catch {}
          return;
        }

        const probes = configNames.map((name) =>
          connector.probeServer(name).then((result) => ({ name, result })).catch((err) => ({
            name,
            result: { status: "unreachable" as const, error: extractErrorText(err) },
          })),
        );
        const results = await Promise.all(probes);

        const available: string[] = [];
        const unavailable: string[] = [];
        for (const { name, result } of results) {
          serverInfos.set(name, {
            name,
            status: result.status,
            error: result.status === "unreachable" ? result.error : undefined,
          });
          if (result.status === "connected") {
            available.push(name);
          } else {
            unavailable.push(name);
          }
        }
        discoveryComplete = true;

        let listMsg: string;
        if (available.length > 0 && unavailable.length > 0) {
          listMsg = `✅ Available servers: ${available.join(", ")}\n❌ Unavailable servers: ${unavailable.join(", ")}`;
        } else if (available.length > 0) {
          listMsg = `✅ Available servers: ${available.join(", ")}`;
        } else {
          listMsg = `❌ All servers unreachable: ${unavailable.join(", ")}`;
        }
        listMsg += `\nUse \`mcp_load <server>\` to load tool schemas before calling \`mcp_call\`. 0 server(s) with loaded schemas.`;

        try { pi.sendMessage({ customType: "mcp-refresh", content: listMsg, display: true }, { deliverAs: "steer" }); } catch {}
        try {
          ctx.ui.setStatus("pi-mcp", `🔄 pi-mcp: ${available.length} available, ${unavailable.length} unreachable`);
          setTimeout(() => { try { ctx.ui.setStatus("pi-mcp", undefined); } catch {} }, 10000);
        } catch {}
      } catch (error: unknown) {
        try {
          ctx.ui.setStatus("pi-mcp", `❌ pi-mcp refresh failed`);
          setTimeout(() => { try { ctx.ui.setStatus("pi-mcp", undefined); } catch {} }, 10000);
        } catch { /* ctx stale */ }
      }
    },
  });

  // ── /mcp-auth command (user-only, not exposed to agent) ─────────────────
  pi.registerCommand("mcp-auth", {
    description:
      "Authenticate with an MCP server (OAuth). " +
      "Usage: /mcp-auth login <server> | /mcp-auth complete <server> <code> | /mcp-auth status <server> | /mcp-auth logout <server>",
    getArgumentCompletions: (prefix: string): { value: string; label: string }[] | null => {
      const parts = prefix.split(/\s+/);
      const typed = parts[parts.length - 1] ?? "";

      if (parts.length <= 1) {
        // Completing the subcommand
        const verbs = [
          { value: "login ", label: "Start OAuth login flow" },
          { value: "complete ", label: "Complete auth with code/redirect URL" },
          { value: "status ", label: "Check auth status" },
          { value: "logout ", label: "Clear stored credentials" },
        ];
        return verbs.filter((v) => v.value.startsWith(typed));
      }

      if (parts.length === 2 || (parts.length === 3 && parts[0] === "complete")) {
        // Completing server name
        const names = connector.discoverServerNames();
        const items = names.map((n) => ({ value: n, label: n }));
        return items.filter((i) => i.value.startsWith(typed));
      }

      return null;
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const verb = parts[0] ?? "";

      if (!verb || !["login", "complete", "status", "logout"].includes(verb)) {
        const available = [...serverInfos.keys()].join(", ");
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Usage: /mcp-auth login <server> | complete <server> <code> | status <server> | logout <server>. Available: ${available || "none"}`,
            "warning",
          );
        }
        return;
      }

      const targetServer = parts[1] ?? "";
      const codeInput = verb === "complete" ? parts.slice(2).join(" ") : undefined;

      if (!targetServer) {
        if (ctx.hasUI) ctx.ui.notify(`Usage: /mcp-auth ${verb} <server>`, "warning");
        return;
      }

      if (!targetServer) {
        if (ctx.hasUI) ctx.ui.notify(`Usage: /mcp-auth ${verb} <server>`, "warning");
        return;
      }

      if (!serverInfos.has(targetServer)) {
        const available = [...serverInfos.keys()].join(", ");
        if (ctx.hasUI) ctx.ui.notify(`Server "${targetServer}" not found. Available: ${available || "none"}`, "error");
        return;
      }

      const serverUrl = connector.getServerUrl(targetServer);
      if (!serverUrl) {
        if (ctx.hasUI) ctx.ui.notify(`Server "${targetServer}" has no URL configured.`, "error");
        return;
      }

      // ── complete subcommand ────────────────────────────────────────────────
      if (verb === "complete") {
        if (!codeInput) {
          if (ctx.hasUI) ctx.ui.notify(`Usage: /mcp-auth complete <server> <code-or-redirect-url>`, "warning");
          return;
        }
        try {
          const status = await flowCompleteAuth(targetServer, codeInput);
          if (status === "authenticated") {
            const info = serverInfos.get(targetServer);
            if (info) info.auth = "authenticated";
            ctx.ui.setStatus("pi-mcp", `✅ ${targetServer} authenticated`);
            setTimeout(() => { try { ctx.ui.setStatus("pi-mcp", undefined); } catch {} }, 10000);
            if (ctx.hasUI) ctx.ui.notify(`Authenticated with "${targetServer}". Ask the agent to retry.`, "success");
            try {
              pi.sendMessage({
                customType: "mcp-auth-complete",
                content: `✅ Successfully authenticated with "${targetServer}". Call mcp_load ${targetServer} to load its tools.`,
                display: true,
              }, { deliverAs: "steer" });
            } catch { /* best effort */ }
          } else {
            if (ctx.hasUI) ctx.ui.notify(`Auth status: ${status}`, "warning");
          }
        } catch (err: unknown) {
          ctx.ui.setStatus("pi-mcp", `❌ Auth failed for ${targetServer}`);
          setTimeout(() => { try { ctx.ui.setStatus("pi-mcp", undefined); } catch {} }, 10000);
          if (ctx.hasUI) ctx.ui.notify(`Auth failed: ${extractErrorText(err)}`, "error");
        }
        return;
      }

      // ── status subcommand ──────────────────────────────────────────────────
      if (verb === "status") {
        const status = await getAuthStatus(targetServer);
        const info = serverInfos.get(targetServer);
        if (info) info.auth = status;
        let msg: string;
        switch (status) {
          case "authenticated": msg = `✅ "${targetServer}" is authenticated.`; break;
          case "expired": msg = `⚠️ "${targetServer}" has expired credentials. Run /mcp-auth login ${targetServer} to re-authenticate.`; break;
          case "not_authenticated": msg = `🔓 "${targetServer}" is not authenticated. Run /mcp-auth login ${targetServer} to begin OAuth flow.`; break;
        }
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        return;
      }

      // ── logout subcommand ──────────────────────────────────────────────────
      if (verb === "logout") {
        await removeAuth(targetServer);
        const info = serverInfos.get(targetServer);
        if (info) info.auth = "not_authenticated";
        ctx.ui.setStatus("pi-mcp", `✅ ${targetServer} credentials cleared`);
        setTimeout(() => { try { ctx.ui.setStatus("pi-mcp", undefined); } catch {} }, 10000);
        if (ctx.hasUI) ctx.ui.notify(`Credentials cleared for "${targetServer}".`, "success");
        return;
      }

      // ── login flow (default) ───────────────────────────────────────────────
      try {
        ctx.ui.setStatus("pi-mcp", `🔐 Starting OAuth for ${targetServer}...`);

        const oauthConfig = connector.getServerOAuthConfig(targetServer);
        const { authorizationUrl } = await flowStartAuth(targetServer, serverUrl, oauthConfig);

        if (!authorizationUrl) {
          ctx.ui.setStatus("pi-mcp", `✅ ${targetServer} authenticated`);
          setTimeout(() => { try { ctx.ui.setStatus("pi-mcp", undefined); } catch {} }, 10000);
          if (ctx.hasUI) ctx.ui.notify(`"${targetServer}" is already authenticated.`, "success");
          return;
        }

        // Get the OAuth state generated during startAuth
        const { getOAuthState } = await import("./mcp-auth.ts");
        const oauthState = getOAuthState(targetServer);
        if (!oauthState) {
          if (ctx.hasUI) ctx.ui.notify(`No OAuth state found. Try running startAuth again.`, "error");
          return;
        }

        // Register callback listener BEFORE opening the browser
        const callbackPromise = waitForCallback(oauthState);

        // Try to open browser (best-effort)
        let browserOpened = false;
        try {
          const cmd = process.platform === "win32"
            ? `start "" "${authorizationUrl.replace(/"/g, "\"")}"`
            : process.platform === "darwin"
              ? `open "${authorizationUrl.replace(/"/g, "\"")}"`
              : `xdg-open "${authorizationUrl.replace(/"/g, "\"")}"`;
          execSync(cmd, { timeout: 5000, windowsHide: true });
          browserOpened = true;
        } catch { /* browser open failed */ }

        // Print the authorization URL
        ctx.ui.setStatus("pi-mcp", `🔐 Waiting for auth from ${targetServer}...`);
        try {
          let urlMsg = `🔐 Open this URL to authenticate "${targetServer}":\n${authorizationUrl}`;
          if (browserOpened) {
            urlMsg += `\n\n(Browser opened for you.)`;
          }
          urlMsg += `\n\n⏳ Waiting for authorization (auto-completes when you authorize, timeout 5 min)...`;
          pi.sendMessage({ customType: "mcp-auth-url", content: urlMsg, display: true }, { deliverAs: "steer" });
        } catch { /* pi may be disposed */ }

        // Block awaiting the callback (up to 5 minutes)
        let callbackCode: string;
        try {
          callbackCode = await Promise.race([
            callbackPromise,
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), 5 * 60 * 1000),
            ),
          ]);
        } catch (err: unknown) {
          const errMsg = extractErrorText(err);
          if (errMsg === "timeout") {
            ctx.ui.setStatus("pi-mcp", `⏰ Auth wait timed out for ${targetServer}`);
            setTimeout(() => { try { ctx.ui.setStatus("pi-mcp", undefined); } catch {} }, 10000);
            if (ctx.hasUI) ctx.ui.notify(`Timed out. If you already authorized, run: /mcp-auth complete ${targetServer} <code>`, "warning");
            return;
          }
          throw err;
        }

        // Callback received — complete the auth
        const status = await flowCompleteAuth(targetServer, callbackCode);
        if (status === "authenticated") {
          const info = serverInfos.get(targetServer);
          if (info) info.auth = "authenticated";
          ctx.ui.setStatus("pi-mcp", `✅ ${targetServer} authenticated`);
          setTimeout(() => { try { ctx.ui.setStatus("pi-mcp", undefined); } catch {} }, 10000);
          if (ctx.hasUI) ctx.ui.notify(`Authenticated with "${targetServer}". Ask the agent to retry.`, "success");
          try {
            pi.sendMessage({
              customType: "mcp-auth-complete",
              content: `✅ Successfully authenticated with "${targetServer}". Call mcp_load ${targetServer} to load its tools.`,
              display: true,
            }, { deliverAs: "steer" });
          } catch { /* best effort */ }
        } else {
          if (ctx.hasUI) ctx.ui.notify(`Auth completed but status is "${status}".`, "warning");
        }
      } catch (err: unknown) {
        ctx.ui.setStatus("pi-mcp", `❌ Auth failed for ${targetServer}`);
        setTimeout(() => { try { ctx.ui.setStatus("pi-mcp", undefined); } catch {} }, 10000);
        if (ctx.hasUI) ctx.ui.notify(`Auth failed: ${extractErrorText(err)}`, "error");
      }
    },
  });

  return {
    performDiscovery,
    serverNames: serverNamesSnapshot,
    loadedCount: () => [...serverInfos.values()].filter((s) => s.tools !== undefined).length,
    shutdown: async () => { try { await Promise.all([connector.closeAll(), shutdownOAuth()]); } catch { /* best effort */ } },
  };
}

function safeParseArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return { _value: v };
  } catch {
    return { _raw: s };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extension entry point — builds a real HttpMcpManager and registers tools.
// ═══════════════════════════════════════════════════════════════════════════════

export default async function (pi: ExtensionAPI) {
  const connector = new HttpMcpManager();
  createMcpRegistry(pi, connector);
}