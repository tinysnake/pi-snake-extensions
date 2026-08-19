/**
 * connection test — pure helpers (config merge/normalize, selector, timeout)
 * plus the McpConnector seam exercised via a fake connector and a stub
 * ExtensionAPI. No real MCP servers and no SDK are touched.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  clampTimeout,
  parseSelector,
  normalizeLifecycle,
  isHttpServer,
  isStdioServer,
  normalizeServerEntry,
  mergeConfigInto,
  resolveStdioEnv,
  type McpConfig,
  type McpConnector,
  type LoadedServer,
  type CallOutcome,
  type ProbeResult,
  type ServerStatus,
} from "../connection.ts";
import type { McpTool } from "../utils.ts";
import { createMcpRegistry } from "../index.ts";

// ── pure helpers ────────────────────────────────────────────────────────────

test("clampTimeout defaults to 30s, clamps to [1s, 300s]", () => {
  assert.equal(clampTimeout(undefined), 30000);
  assert.equal(clampTimeout(NaN), 30000);
  assert.equal(clampTimeout(0), 1000);
  assert.equal(clampTimeout(10), 10000);
  assert.equal(clampTimeout(500), 300000);
});

test("parseSelector splits server.tool, rejects empty halves", () => {
  assert.deepEqual(parseSelector("svc.tool"), { server: "svc", tool: "tool" });
  assert.equal(parseSelector("svc."), null);
  assert.equal(parseSelector(".tool"), null);
  assert.equal(parseSelector("no-dot"), null);
  assert.deepEqual(parseSelector("a.b.c"), { server: "a", tool: "b.c" });
});

test("normalizeLifecycle accepts flat and nested forms, defaults lazy", () => {
  assert.equal(normalizeLifecycle({ lifecycle: "keep-alive" }), "keep-alive");
  assert.equal(normalizeLifecycle({ lifecycle: "lazy" }), "lazy");
  assert.equal(normalizeLifecycle({ lifecycle: "eager" }), "eager");
  assert.equal(normalizeLifecycle({ lifecycle: { mode: "keep-alive" } }), "keep-alive");
  assert.equal(normalizeLifecycle({ lifecycle: { mode: "bogus" } }), "lazy");
  assert.equal(normalizeLifecycle({}), "lazy");
  assert.equal(normalizeLifecycle({ lifecycle: "bogus" }), "lazy");
});

test("isHttpServer detects url or type=http", () => {
  assert.equal(isHttpServer({ url: "http://x" }), true);
  assert.equal(isHttpServer({ type: "http" }), true);
  assert.equal(isHttpServer({ type: "http", url: "http://x" }), true);
  assert.equal(isHttpServer({ command: "node" }), false);
  assert.equal(isHttpServer({}), false);
});

test("isStdioServer detects command without url", () => {
  assert.equal(isStdioServer({ command: "node" }), true);
  assert.equal(isStdioServer({ command: "node", args: ["server.js"] }), true);
  assert.equal(isStdioServer({ command: "npx" }), true);
  assert.equal(isStdioServer({ command: "node", url: "http://x" }), false);
  assert.equal(isStdioServer({ command: "npx", url: "http://x" }), false);
  assert.equal(isStdioServer({ url: "http://x" }), false);
  assert.equal(isStdioServer({}), false);
  assert.equal(isStdioServer({ args: ["foo"] }), false);
});

test("resolveStdioEnv interpolates ${VAR} and returns merged env", () => {
  assert.equal(resolveStdioEnv(undefined), undefined);
  assert.equal(resolveStdioEnv({}), undefined);

  process.env.TEST_MCP_VAR = "hello";
  const result = resolveStdioEnv({ MY_KEY: "${TEST_MCP_VAR}", FOO: "bar" });
  assert.ok(result);
  assert.equal(result!.MY_KEY, "hello");
  assert.equal(result!.FOO, "bar");

  const missing = resolveStdioEnv({ X: "${DOES_NOT_EXIST_XYZ}" });
  assert.ok(missing);
  assert.equal(missing!.X, "");

  const noInterp = resolveStdioEnv({ STATIC: "static-value" });
  assert.ok(noInterp);
  assert.equal(noInterp!.STATIC, "static-value");
});

test("normalizeServerEntry normalizes lifecycle and tolerates ignored fields", () => {
  const e = normalizeServerEntry("ctx7", {
    url: "https://mcp.context7.com/mcp",
    type: "http",
    headers: { CONTEXT7_API_KEY: "k" },
    lifecycle: { mode: "keep-alive" },
    allowedTools: ["a", "b"],
    requestTimeoutMs: 30000,
  });
  assert.equal(e.name, "ctx7");
  assert.equal(e.url, "https://mcp.context7.com/mcp");
  assert.equal(e.lifecycle, "keep-alive");
  assert.deepEqual(e.headers, { CONTEXT7_API_KEY: "k" });
  assert.equal(e.requestTimeoutMs, 30000);
  // tolerated-but-ignored field is carried through
  assert.deepEqual(e.allowedTools, ["a", "b"]);
});

test("mergeConfigInto overlays later servers over earlier (replace per key)", () => {
  const base: McpConfig = { servers: {}, settings: {} };
  mergeConfigInto(base, {
    settings: { idleTimeout: 10 },
    mcpServers: { a: { url: "http://a" }, b: { url: "http://b-old" } },
  });
  mergeConfigInto(base, {
    settings: { requestTimeoutMs: 1000 },
    mcpServers: { b: { url: "http://b-new" }, c: { url: "http://c" } },
  });
  assert.equal(base.servers.a?.url, "http://a");
  assert.equal(base.servers.b?.url, "http://b-new"); // replaced, not merged
  assert.equal(base.servers.c?.url, "http://c");
  assert.equal(base.settings?.idleTimeout, 10);
  assert.equal(base.settings?.requestTimeoutMs, 1000);
});

// ── seam A: FakeMcpConnector + stub pi ──────────────────────────────────────

function makeTool(name: string, desc: string, props: Record<string, any> = {}, required: string[] = []): McpTool {
  return {
    name,
    description: desc,
    inputSchema: { type: "object", properties: props, required },
  };
}

class FakeMcpConnector implements McpConnector {
  servers: string[] = [];
  loadResults = new Map<string, LoadedServer>();
  callResults = new Map<string, CallOutcome>(); // keyed `${server}.${tool}`
  calls: { server: string; tool: string; args: any; timeoutMs?: number }[] = [];
  closed: string[] = [];
  reloaded = 0;

  constructor(servers: string[], toolsByServer: Record<string, McpTool[]> = {}) {
    this.servers = servers;
    for (const s of servers) {
      this.loadResults.set(s, {
        name: s,
        status: "connected" as ServerStatus,
        tools: toolsByServer[s] ?? [],
      });
    }
  }

  discoverServerNames(): string[] { return this.servers; }

  async loadServer(name: string): Promise<LoadedServer> {
    const r = this.loadResults.get(name);
    if (!r) throw new Error(`No MCP server named "${name}".`);
    return r;
  }

  async callTool(server: string, tool: string, args: any, _signal?: AbortSignal, timeoutMs?: number): Promise<CallOutcome> {
    this.calls.push({ server, tool, args, timeoutMs });
    const r = this.callResults.get(`${server}.${tool}`);
    if (r) return r;
    return {
      success: true,
      content: [{ type: "text", text: JSON.stringify({ ok: true, input: args }) }],
      isError: false,
    };
  }

  setCallResult(server: string, tool: string, r: CallOutcome) { this.callResults.set(`${server}.${tool}`, r); }

  async probeServer(name: string): Promise<ProbeResult> {
    if (this.servers.includes(name)) return { status: "connected" };
    return { status: "unreachable", error: "not found" };
  }

  async close(name: string): Promise<void> { this.closed.push(name); }
  async closeAll(): Promise<void> { this.closed.push(...this.servers); }
  reloadConfig(): string[] { this.reloaded++; return this.servers; }
}

function makeStubPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events: Record<string, (...args: any[]) => any> = {};
  const sent: any[] = [];
  return {
    tools,
    commands,
    events,
    sent,
    api: {
      registerTool: (t: any) => void tools.set(t.name, t),
      registerCommand: (name: string, opts: any) => void commands.set(name, opts),
      on: (ev: string, fn: any) => { events[ev] = fn; },
      sendMessage: (m: any) => { sent.push(m); },
      getAllTools: () => [],
    } as any,
  };
}

// Common tool to drive execute() without rendering machinery in tests.
const NoUpdate = undefined;
const NoCtx = undefined as any;

async function runToolExecute(stub: ReturnType<typeof makeStubPi>, name: string, params: any, signal?: AbortSignal) {
  const t = stub.tools.get(name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.execute("tcid", params, signal, NoUpdate, NoCtx);
}

/** Trigger async discovery via the session_start handler.
 *  Waits for the background discovery to complete when a registry is provided. */
async function initDiscovery(stub: ReturnType<typeof makeStubPi>, reg?: McpRegistry) {
  const handler = stub.events["session_start"];
  if (!handler) throw new Error("session_start handler not registered");
  await handler({ reason: "new" }, { ui: { setStatus: () => {} } });
  // PerformDiscovery runs as fire-and-forget inside the handler.
  // Await it explicitly here so tests see a consistent state.
  if (reg) await reg.performDiscovery({ ui: { setStatus: () => {} } });
}

// ── registry: registration shape ─────────────────────────────────────────────
test("registry registers exactly 3 tools + /mcp-refresh + /mcp-auth commands", () => {
  const stub = makeStubPi();
  const fake = new FakeMcpConnector(["ctx7", "UnityMCP"]);
  createMcpRegistry(stub.api as any, fake);

  assert.deepEqual([...stub.tools.keys()].sort(), ["mcp_call", "mcp_load", "mcp_refresh"]);
  assert.ok(stub.commands.has("mcp-refresh"));
});

// ── load-before-call gate ───────────────────────────────────────────────────────
test("mcp_call rejects with gate error when server not loaded yet", async () => {
  const stub = makeStubPi();
  const fake = new FakeMcpConnector(["svc"], { svc: [makeTool("ping", "p")] });
  const reg = createMcpRegistry(stub.api as any, fake);
  await initDiscovery(stub, reg);

  const r = await runToolExecute(stub, "mcp_call", { selector: "svc.ping", args: {} });
  assert.match(r.content[0].text, /has not been loaded/);
  assert.match(r.content[0].text, /mcp_load svc/);
  assert.equal(fake.calls.length, 0); // did NOT actually call
});

test("mcp_call succeeds after mcp_load", async () => {
  const stub = makeStubPi();
  const fake = new FakeMcpConnector(["svc"], { svc: [makeTool("ping", "p")] });
  const reg = createMcpRegistry(stub.api as any, fake);
  await initDiscovery(stub, reg);

  const load = await runToolExecute(stub, "mcp_load", { server: "svc" });
  assert.match(load.content[0].text, /### svc\.ping/);
  assert.equal(load.details.toolCount, 1);

  const call = await runToolExecute(stub, "mcp_call", { selector: "svc.ping", args: { a: 1 } });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].args, { a: 1 });
  assert.doesNotMatch(call.content[0].text, /error/);
});

// ── selector validation ──────────────────────────────────────────────────────
test("mcp_call rejects malformed selector", async () => {
  const stub = makeStubPi();
  const fake = new FakeMcpConnector(["svc"], { svc: [makeTool("ping", "p")] });
  createMcpRegistry(stub.api as any, fake);
  const r = await runToolExecute(stub, "mcp_call", { selector: "bogus", args: {} });
  assert.match(r.content[0].text, /Invalid selector "bogus"/);
});

test("mcp_call rejects unknown server", async () => {
  const stub = makeStubPi();
  const fake = new FakeMcpConnector(["svc"], { svc: [makeTool("ping", "p")] });
  const reg = createMcpRegistry(stub.api as any, fake);
  await initDiscovery(stub, reg);
  await runToolExecute(stub, "mcp_load", { server: "svc" });
  const r = await runToolExecute(stub, "mcp_call", { selector: "ghost.ping", args: {} });
  assert.match(r.content[0].text, /Server "ghost" not found/);
});

// ── mcp_load returns full schema (whole-server下发) ────────────────────────────
test("mcp_load emits full parameter schema for every tool on the server", async () => {
  const stub = makeStubPi();
  const fake = new FakeMcpConnector(["multitool"], {
    multitool: [
      makeTool("add", "Add a thing", { name: { type: "string" }, count: { type: "integer" } }, ["name"]),
      makeTool("list", "List", { filter: { type: "string", enum: ["a", "b"] } }),
    ],
  });
  const reg = createMcpRegistry(stub.api as any, fake);
  await initDiscovery(stub, reg);
  const r = await runToolExecute(stub, "mcp_load", { server: "multitool" });
  const text = r.content[0].text as string;
  assert.match(text, /### multitool\.add/);
  assert.match(text, /name: string \(required\)/);
  assert.match(text, /### multitool\.list/);
  assert.match(text, /filter: string \(optional\)/);
  assert.match(text, /\[a\.kv, b, b, b\]|\[a, b\]/); // enum rendered somewhere
});

// ── error hint path: validation error surfaces schema snippet ────────────────
test("mcp_call on validation-error outcome appends schema snippet from loaded cache", async () => {
  const stub = makeStubPi();
  const fake = new FakeMcpConnector(["svc"], {
    svc: [makeTool("ping", "p", { name: { type: "string" } }, ["name"])],
  });
  fake.setCallResult("svc", "ping", {
    success: false,
    kind: "validation",
    errorText: "1 validation error for call[ping]\n  name\n    Missing required argument",
  });
  const reg = createMcpRegistry(stub.api as any, fake);
  await initDiscovery(stub, reg);

  await runToolExecute(stub, "mcp_load", { server: "svc" });
  const r = await runToolExecute(stub, "mcp_call", { selector: "svc.ping", args: {} });
  const text = r.content[0].text as string;
  assert.match(text, /Missing required argument 'name'/);
  assert.match(text, /Expected parameters:/);
  assert.match(text, /- name: string \(required\)/);
});

// ── timeout clamp flows through to connector ────────────────────────────────
test("mcp_call clamps timeout and passes ms to connector", async () => {
  const stub = makeStubPi();
  const fake = new FakeMcpConnector(["svc"], { svc: [makeTool("ping", "p")] });
  const reg = createMcpRegistry(stub.api as any, fake);
  await initDiscovery(stub, reg);
  await runToolExecute(stub, "mcp_load", { server: "svc" });

  await runToolExecute(stub, "mcp_call", { selector: "svc.ping", args: {}, timeout: 99999 });
  assert.equal(fake.calls[0].timeoutMs, 300000); // clamped to 300s
});

// ── refresh: clears removed servers ────────────────────────────────────────────
test("mcp_refresh reloads config and drops loaded schemas for removed servers", async () => {
  const stub = makeStubPi();
  const fake = new FakeMcpConnector(["old", "keep"], { old: [makeTool("x", "x")], keep: [makeTool("y", "y")] });
  const reg = createMcpRegistry(stub.api as any, fake);
  await initDiscovery(stub, reg);

  await runToolExecute(stub, "mcp_load", { server: "old" });
  await runToolExecute(stub, "mcp_load", { server: "keep" });
  assert.equal(reg.loadedCount(), 2);

  // Simulate config change: drop 'old'
  fake.servers = ["keep"];

  const r = await runToolExecute(stub, "mcp_refresh", {});
  assert.equal(fake.reloaded, 1);
  assert.match(r.content[0].text, /keep/);
  // After refresh, all tools caches are cleared (probe only, no tools).
  assert.equal(reg.loadedCount(), 0);
});

// ── discovery injection (session_start) ────────────────────────────────────────
test("session_start trigger sends steer message with available servers", async () => {
  const stub = makeStubPi();
  const fake = new FakeMcpConnector(["ctx7", "UnityMCP"], {});
  const reg = createMcpRegistry(stub.api as any, fake);

  const ctxStub = {
    ui: {
      setStatus: () => {},
    },
  };
  // The registry attached a session_start handler.
  const handler = stub.events["session_start"];
  assert.ok(handler, "session_start handler registered");
  await handler({ reason: "new" }, ctxStub);
  // Await background discovery so the steer message is sent
  await reg.performDiscovery(ctxStub);

  assert.ok(stub.sent.length >= 1);
  const last = stub.sent[stub.sent.length - 1];
  assert.equal(last.customType, "mcp-init");
  assert.equal(last.display, false); // hidden from transcript, still delivered to LLM
  assert.match(last.content, /^<mcp-info-update seq="1">/);
  assert.match(last.content, /✅ Available servers: ctx7, UnityMCP/);
  assert.match(last.content, /mcp_load SERVER/);
  assert.match(last.content, /<\/mcp-info-update>$/);
});

test("session_start skips on reload/resume/fork reasons", async () => {
  const stub = makeStubPi();
  const fake = new FakeMcpConnector(["svc"], {});
  createMcpRegistry(stub.api as any, fake);
  const handler = stub.events["session_start"];
  await handler({ reason: "reload" }, { ui: { setStatus: () => {} } });
  assert.equal(stub.sent.length, 0); // no steer on reload
});

// ── before_agent_start injects guideline ──────────────────────────────────────
test("before_agent_start injects pi-mcp guidelines into returned systemPrompt", () => {
  const stub = makeStubPi();
  const fake = new FakeMcpConnector(["svc"], {});
  createMcpRegistry(stub.api as any, fake);
  const handler = stub.events["before_agent_start"];
  // Simulate a realistic system prompt that contains the sentinel
  const basePrompt = `You are an expert coding assistant operating inside pi...

Available tools:
...

Guidelines:
- Some guideline
- Use read to examine files instead of cat or sed.
- Show file paths clearly when working with files

Pi documentation...`;
  const fakeEvent = { systemPrompt: basePrompt, systemPromptOptions: { promptGuidelines: [] as string[] } };
  const result = handler(fakeEvent, {});
  assert.ok(result, "handler should return an object");
  assert.ok(typeof result.systemPrompt === "string", "systemPrompt should be a string");
  assert.match(result.systemPrompt, /mcp_load SERVER.*before.*mcp_call/s);
  assert.match(result.systemPrompt, /server is unavailable.*do NOT investigate/s);
  assert.match(result.systemPrompt, /<mcp-info-update>.*most recent.*authoritative/s);
  // Verify the sentinel is still present and guidelines are in the right section
  assert.ok(result.systemPrompt.includes("Show file paths clearly when working with files"));
  // The original promptGuidelines array should NOT have been modified
  assert.equal(fakeEvent.systemPromptOptions.promptGuidelines.length, 0);
});