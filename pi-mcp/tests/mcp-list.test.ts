/**
 * /mcp-list tests — pure panel line builder, handler guards (non-TUI no-op),
 * overlay options, and Esc-to-close on the panel component.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMcpServersPanel,
  buildMcpServersPanelLines,
  DISCOVERING_LINE,
  NONE_CONFIGURED_LINE,
  type McpListSnapshot,
} from "../mcp-list-panel.ts";
import { createMcpRegistry, type McpRegistry } from "../index.ts";
import type {
  CallOutcome,
  LoadedServer,
  McpConnector,
  McpOAuthConfig,
  ProbeResult,
} from "../connection.ts";

// Passthrough theme: returns text unchanged so assertions see plain strings.
const plainTheme = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
  italic: (s: string) => s,
  underline: (s: string) => s,
  inverse: (s: string) => s,
  strikethrough: (s: string) => s,
} as any;

const HINT = "Esc close";

const snap = (over: Partial<McpListSnapshot> = {}): McpListSnapshot => ({
  at: 0,
  discoveryComplete: true,
  servers: [],
  ...over,
});

// ── pure line builder ─────────────────────────────────────────────────────────

test("lines: header with available/total, detail per server, hint at end", () => {
  const lines = buildMcpServersPanelLines(
    snap({
      at: 0,
      servers: [
        { name: "ctx7", status: "connected", toolCount: 12 },
        { name: "unity", status: "connected" },
        { name: "dark", status: "unreachable", error: "connect ECONNREFUSED 127.0.0.1:3000" },
      ],
    }),
    plainTheme,
    HINT,
  );
  assert.deepEqual(lines, [
    "🔌 MCP servers — 2/3 available",
    "  ✓ ctx7 · 12 tool(s) loaded",
    "  ✓ unity · tools not loaded",
    "  ✗ dark — connect ECONNREFUSED 127.0.0.1:3000",
    HINT,
  ]);
});

test("lines: auth status appended when known, omitted when not", () => {
  const lines = buildMcpServersPanelLines(
    snap({
      servers: [
        { name: "a", status: "connected", toolCount: 3, auth: "authenticated" },
        { name: "b", status: "connected", auth: "expired" },
        { name: "c", status: "connected", auth: "not_authenticated" },
      ],
    }),
    plainTheme,
    HINT,
  );
  assert.deepEqual(lines, [
    "🔌 MCP servers — 3/3 available",
    "  ✓ a · 3 tool(s) loaded · authenticated",
    "  ✓ b · tools not loaded · auth expired",
    "  ✓ c · tools not loaded",
    HINT,
  ]);
});

test("lines: discovery incomplete shows discovering hint, not 'none'", () => {
  const lines = buildMcpServersPanelLines(
    snap({ discoveryComplete: false }),
    plainTheme,
    HINT,
  );
  assert.match(lines[0], new RegExp(DISCOVERING_LINE));
  assert.equal(lines[1], HINT);
});

test("lines: discovery complete but empty shows none-configured", () => {
  const lines = buildMcpServersPanelLines(
    snap({ discoveryComplete: true }),
    plainTheme,
    HINT,
  );
  assert.match(lines[0], new RegExp(NONE_CONFIGURED_LINE));
});

test("lines: timestamp appears when snapshot has one", () => {
  const lines = buildMcpServersPanelLines(
    snap({ at: 1_700_000_000_000, servers: [{ name: "s", status: "connected" }] }),
    plainTheme,
    HINT,
  );
  assert.ok(lines[0].startsWith("🔌 MCP servers — 1/1 available · "));
});

// ── panel component: Esc closes, other input ignored ──────────────────────────

test("panel: escape closes, other keys ignored", () => {
  let closed = 0;
  const panel = buildMcpServersPanel(snap(), plainTheme, () => void closed++);
  const comp = panel as { handleInput?: (data: string) => void };
  assert.ok(comp.handleInput, "panel implements handleInput");

  comp.handleInput!("a");
  assert.equal(closed, 0);
  comp.handleInput!("\x1b"); // escape
  assert.equal(closed, 1);
  comp.handleInput!("b");
  assert.equal(closed, 1);
});

test("panel: render truncates each row to width", () => {
  const panel = buildMcpServersPanel(
    snap({
      servers: [
        { name: "a-very-long-server-name-that-definitely-overflows", status: "connected", toolCount: 99 },
      ],
    }),
    plainTheme,
    () => {},
  );
  const comp = panel as { render?: (width: number) => string[] };
  const lines = comp.render!(40);
  assert.ok(lines.length >= 2);
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  for (const line of lines) {
    const visible = stripAnsi(line);
    assert.ok(visible.length <= 40, `line too long: ${visible.length} > 40 (${JSON.stringify(visible)})`);
  }
  // The long server row is actually truncated (decision B: one row, cut at width).
  assert.ok(stripAnsi(lines[2]).includes("..."), "long row truncated with ellipsis");
});

// ── command handler ───────────────────────────────────────────────────────────

class FakeConnector implements McpConnector {
  servers: string[];
  constructor(servers: string[]) { this.servers = servers; }
  discoverServerNames(): string[] { return this.servers; }
  async probeServer(name: string): Promise<ProbeResult> {
    if (this.servers.includes(name)) return { status: "connected" };
    return { status: "unreachable", error: "not found" };
  }
  async loadServer(name: string): Promise<LoadedServer> {
    return {
      name,
      status: "connected" as const,
      tools: [{ name: "ping", description: "ping tool", inputSchema: { type: "object" } }],
    };
  }
  async callTool(): Promise<CallOutcome> {
    return { success: true, content: [{ type: "text", text: "ok" }], isError: false };
  }
  async close(): Promise<void> {}
  async closeAll(): Promise<void> {}
  reloadConfig(): string[] { return this.servers; }
  getServerUrl(name: string): string | undefined { return undefined; }
  getServerOAuthConfig(): McpOAuthConfig | undefined { return undefined; }
}

function makeStubPi() {
  const commands = new Map<string, any>();
  const events: Record<string, (...args: any[]) => any> = {};
  return {
    commands,
    api: {
      registerTool: () => {},
      registerCommand: (name: string, opts: any) => void commands.set(name, opts),
      on: (ev: string, fn: any) => { events[ev] = fn; },
      sendMessage: () => {},
      getAllTools: () => [],
    } as any,
    events,
  };
}

/** Run background discovery to completion, as session_start + join does. */
async function initDiscovery(stub: ReturnType<typeof makeStubPi>, reg: McpRegistry) {
  const handler = stub.events["session_start"];
  await handler({ reason: "new" }, { ui: { setStatus: () => {} } });
  await reg.performDiscovery({ ui: { setStatus: () => {} } });
}

test("handler: non-TUI (rpc/print/json) does nothing", async () => {
  const stub = makeStubPi();
  createMcpRegistry(stub.api as any, new FakeConnector(["ctx7"]));
  const cmd = stub.commands.get("mcp-list");
  assert.ok(cmd, "/mcp-list registered");

  for (const mode of ["rpc", "print", "json"]) {
    let customCalled = false;
    const ctx = { mode, hasUI: mode === "rpc", ui: { custom: () => { customCalled = true; } } };
    await cmd.handler("", ctx);
    assert.equal(customCalled, false, `${mode} must not open the panel`);
  }
});

test("handler: TUI opens a bottom-center overlay with cached snapshot", async () => {
  const stub = makeStubPi();
  const reg = createMcpRegistry(stub.api as any, new FakeConnector(["ctx7", "unity"]));
  await initDiscovery(stub, reg);

  // Note: this stub does not capture tools, so mcp_load never runs and
  // toolCount stays undefined in the snapshot ("tools not loaded").
  const cmd = stub.commands.get("mcp-list");
  const customCalls: Array<{ opts: any; panel: any }> = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: async (factory: any, opts: any) => {
        const panel = factory({}, plainTheme, {}, () => {});
        customCalls.push({ opts, panel });
      },
    },
  };
  await cmd.handler("", ctx);

  assert.equal(customCalls.length, 1);
  const { opts, panel } = customCalls[0];
  assert.equal(opts.overlay, true);
  // Global center (default anchor): no fixed edge anchor that would clash with
  // the dynamic footer height.
  assert.equal(opts.overlayOptions.anchor, undefined);
  assert.equal(opts.overlayOptions.minWidth, 40);
  assert.equal(typeof opts.onHandle, "function");

  const lines = panel.render(120);
  const text = lines.join("\n");
  assert.ok(text.includes("MCP servers — 2/2 available"), text);
  assert.ok(text.includes("✓ ctx7 · tools not loaded"), text);
  assert.ok(text.includes("✓ unity · tools not loaded"), text);
  assert.ok(text.includes("Esc"), "hint line present");
});

test("handler: shows discovering line when discovery has not completed", async () => {
  const stub = makeStubPi();
  const reg = createMcpRegistry(stub.api as any, new FakeConnector(["ctx7"]));
  // No initDiscovery — serverInfos stays empty, discoveryComplete stays false.

  const cmd = stub.commands.get("mcp-list");
  let panel: any;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { custom: async (factory: any) => { panel = factory({}, plainTheme, {}, () => {}); } },
  };
  await cmd.handler("", ctx);
  void reg;

  const lines = panel.render(120);
  const text = lines.join("\n");
  assert.ok(text.includes("Still discovering"), text);
});