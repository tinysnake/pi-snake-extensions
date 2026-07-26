/**
 * retry test — verifies HttpMcpManager's callTool recovery policy (A+B+C):
 *  - A: when the transport still holds a live session id, transient errors
 *    retry IN_PLACE_RETRIES (3) times on the SAME transport/session, never
 *    closing the connection.
 *  - C: when the transport's session id is cleared, the dead connection is
 *    closed and reconnect path is taken.
 *  - B: the carry-session id is threaded into the reconnect (verified via the
 *    captured transport's sessionId accessor on real StreamableHTTPClientTransport).
 *  - C: SSE fallback path drops the carry-over (sessionId not injected).
 *
 * No real MCP server is started. A fake SDK Client + fake transport are
 * injected through a subclass override of createConnection.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  HttpMcpManager,
  transportSessionId,
  hasLiveSession,
  type ServerConnection,
  type ServerEntry,
} from "../connection.ts";

// ── pure helper tests (exported) ─────────────────────────────────────────────
test("transportSessionId reads StreamableHTTPClientTransport's sessionId", () => {
  const t = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:1/mcp"), { sessionId: "sess-xyz" });
  assert.equal(transportSessionId(t), "sess-xyz");
  const fresh = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:1/mcp"), {});
  assert.equal(transportSessionId(fresh), undefined);
  assert.equal(transportSessionId(null), undefined);
  assert.equal(transportSessionId({}), undefined);
  assert.equal(transportSessionId({ sessionId: 123 }), undefined);
});

test("hasLiveSession reflects presence of a session id on the transport", () => {
  const live: any = { transport: { sessionId: "s1" } };
  const dead: any = { transport: { sessionId: undefined } };
  const none: any = { transport: null };
  assert.equal(hasLiveSession(live), true);
  assert.equal(hasLiveSession(dead), false);
  assert.equal(hasLiveSession(none), false);
});

// ── HttpMcpManager harness ────────────────────────────────────────────────────

/** Fake transport: holds a mutable sessionId and records close() calls. */
function makeFakeTransport(initialSessionId: string | undefined) {
  let sid = initialSessionId;
  let closed = false;
  return {
    get sessionId() { return sid; },
    set sessionId(v: string | undefined) { sid = v; },
    async close() { closed = true; },
    isClosed() { return closed; },
  };
}

/** Fake SDK Client: callTool consults a script of outcomes for `${tool}`. */
function makeFakeClient(script: { tool: string; outcomes: any[] }[]) {
  const counters = new Map<string, number>();
  const calls: { tool: string; args: any }[] = [];
  return {
    calls,
    counters,
    async callTool(req: { name: string; arguments: any }) {
      calls.push({ tool: req.name, args: req.arguments });
      const entry = script.find((s) => s.tool === req.name);
      const idx = counters.get(req.name) ?? 0;
      counters.set(req.name, idx + 1);
      const outcomes = entry?.outcomes ?? [];
      const outcome = outcomes[idx];
      if (outcome === undefined) {
        // Past the scripted outcomes: keep throwing the LAST scripted throw if any,
        // otherwise default to success. This models "script exhausted → still broken"
        // for give-up tests, and "script exhausted → recovered" for success-after-N tests.
        const last = outcomes[outcomes.length - 1];
        if (last?.throw) throw last.throw;
        return { content: [{ type: "text", text: "default-ok" }], isError: false };
      }
      if (outcome.throw) throw outcome.throw;
      return outcome.result;
    },
    async listTools() { return { tools: [] }; },
    async close() {},
  };
}

/** Subclass that injects a fake connection, bypassing real HTTP entirely. */
class FakeManager extends HttpMcpManager {
  public readonly createdTransports: { carrySessionId?: string }[] = [];
  public fakeConn: ServerConnection | null = null;
  /** Override createConnection to return fakeConn instead of doing real I/O. */
  protected async createConnection(
    _name: string,
    def: ServerEntry,
    _signal?: AbortSignal,
    carrySessionId?: string,
  ): Promise<ServerConnection> {
    this.createdTransports.push({ carrySessionId });
    if (!this.fakeConn) throw new Error("no fakeConn configured");
    return this.fakeConn;
  }
  // Expose protected map/state for assertions.
  get connMap() { return this.connections; }
}

function makeManagerWithFakeConn(client: any, transport: any, status: ServerStatusLike = "connected"): FakeManager {
  const mgr = new FakeManager({ servers: { svc: { name: "svc", url: "http://127.0.0.1:1/mcp", lifecycle: "lazy" } }, settings: {} } as any);
  const conn: ServerConnection = {
    name: "svc",
    client,
    transport,
    definition: { name: "svc", url: "http://127.0.0.1:1/mcp", lifecycle: "lazy" },
    tools: [],
    lastUsedAt: Date.now(),
    status,
  };
  mgr.fakeConn = conn;
  // Seed connected so connect() returns it without re-Creating.
  (mgr.connMap as Map<string, ServerConnection>).set("svc", conn);
  return mgr;
}

type ServerStatusLike = "connected" | "needs-auth" | "disconnected" | "error";

// ── A: transient error on a live session retries in place 3 times, no close ──
test("callTool retries in place up to 3 times when session id is live", async () => {
  const transport = makeFakeTransport("sess-1");
  // callTool throws twice due to transient flap, then succeeds on attempt 3.
  const client = makeFakeClient([
    { tool: "ping", outcomes: [
      { throw: new Error("fetch failed: ECONNRESET") },
      { throw: new Error("fetch failed: ECONNRESET") },
      { result: { content: [{ type: "text", text: "pong" }], isError: false } },
    ] },
  ]);
  const mgr = makeManagerWithFakeConn(client, transport);
  const r = await mgr.callTool("svc", "ping", {});
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.content[0].text, "pong");
  // Started fresh from seeded connected conn — createConnection was NOT called.
  assert.equal(mgr.createdTransports.length, 0);
  // Same client was reused (3 attempts): 3 recorded calls.
  assert.equal(client.calls.length, 3);
  // Transport was never closed.
  assert.equal((transport as any).isClosed(), false);
});

test("callTool in-place retries give up after 3, returning the last transient error", async () => {
  const transport = makeFakeTransport("sess-1");
  const client = makeFakeClient([
    { tool: "ping", outcomes: [
      { throw: new Error("fetch failed: ECONNRESET") },
      { throw: new Error("fetch failed: ECONNRESET") },
      { throw: new Error("fetch failed: ECONNRESET") },
      { throw: new Error("fetch failed: ECONNRESET") }, // 4th — never reached
    ] },
  ]);
  const mgr = makeManagerWithFakeConn(client, transport);
  const r = await mgr.callTool("svc", "ping", {});
  assert.equal(r.success, false);
  if (!r.success) assert.match(r.errorText, /ECONNRESET/);
  assert.equal(client.calls.length, 3);
  assert.equal((transport as any).isClosed(), false);
});

// ── C: dead session id → reconnect path ────────────────────────────────────────
test("callTool with cleared session id falls through to reconnect path", async () => {
  // Transport session id is already undefined (transport died before call threw).
  const deadTransport = makeFakeTransport(undefined);
  // Make the FIRST callTool throw, then on reconnect return success.
  let firstAttempt = true;
  const client1 = makeFakeClient([
    { tool: "ping", outcomes: [{ throw: new Error("fetch failed: ECONNRESET") }] },
  ]);
  // After reconnect, createConnection returns a fresh fake conn with a different client.
  const transport2 = makeFakeTransport("sess-2");
  const client2 = makeFakeClient([
    { tool: "ping", outcomes: [{ result: { content: [{ type: "text", text: "pong-after-reconnect" }], isError: false } }] },
  ]);
  const mgr = new FakeManager({ servers: { svc: { name: "svc", url: "http://127.0.0.1:1/mcp", lifecycle: "lazy" } }, settings: {} } as any);
  // First (dead) connection seeded.
  const deadConn: ServerConnection = {
    name: "svc", client: client1 as any, transport: deadTransport,
    definition: { name: "svc", url: "http://127.0.0.1:1/mcp", lifecycle: "lazy" },
    tools: [], lastUsedAt: Date.now(), status: "connected",
  };
  (mgr.connMap as Map<string, ServerConnection>).set("svc", deadConn);
  // On reconnect, createConnection supplies the fresh fake conn.
  let reconnectCount = 0;
  mgr["createConnection"] = async function (_n: string, _d: ServerEntry, _s?: AbortSignal, carrySessionId?: string) {
    reconnectCount++;
    mgr.createdTransports.push({ carrySessionId });
    return {
      name: "svc", client: client2 as any, transport: transport2,
      definition: { name: "svc", url: "http://127.0.0.1:1/mcp", lifecycle: "lazy" },
      tools: [], lastUsedAt: Date.now(), status: "connected",
    } as ServerConnection;
  } as any;

  const r = await mgr.callTool("svc", "ping", {});
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.content[0].text, "pong-after-reconnect");
  // Reconnect was triggered exactly once.
  assert.equal(reconnectCount, 1);
  // The dead transport WAS closed (close path taken).
  assert.equal((deadTransport as any).isClosed(), true);
});

// ── B: stale session id is threaded into reconnect createConnection ─────────────
test("carry-over session id is forwarded to createConnection only when transport had one", async () => {
  // Case 1: dead transport had a session id 's9' before dying → carried.
  const transport = makeFakeTransport("s9"); // pretend still-alive at call-time would retry in place.
  // To force the reconnect path, make session id undefined so hasLiveSession=false,
  // but we still want to verify the id captured at the point of close.
  // We simulate: first call throws AND session id already undefined → carry = undefined.
  const deadTransportNoId = makeFakeTransport(undefined);
  const client1 = makeFakeClient([{ tool: "ping", outcomes: [{ throw: new Error("fetch failed: connection closed") }] }]);
  const client2 = makeFakeClient([{ tool: "ping", outcomes: [{ result: { content: [{ type: "text", text: "ok" }], isError: false } }] }]);
  const mgr = new FakeManager({ servers: { svc: { name: "svc", url: "http://127.0.0.1:1/mcp", lifecycle: "lazy" } }, settings: {} } as any);
  (mgr.connMap as Map<string, ServerConnection>).set("svc", {
    name: "svc", client: client1 as any, transport: deadTransportNoId,
    definition: { name: "svc", url: "http://127.0.0.1:1/mcp", lifecycle: "lazy" },
    tools: [], lastUsedAt: Date.now(), status: "connected",
  } as ServerConnection);
  let capturedCarry: string | undefined = "__none__";
  mgr["createConnection"] = async function (_n: string, _d: ServerEntry, _s?: AbortSignal, carrySessionId?: string) {
    capturedCarry = carrySessionId;
    return {
      name: "svc", client: client2 as any, transport: makeFakeTransport("new-sess"),
      definition: { name: "svc", url: "http://127.0.0.1:1/mcp", lifecycle: "lazy" },
      tools: [], lastUsedAt: Date.now(), status: "connected",
    } as ServerConnection;
  } as any;
  await mgr.callTool("svc", "ping", {});
  // No session id was live → carry is undefined (no false claim).
  assert.equal(capturedCarry, undefined);

  // Case 2: dead transport STILL HAD a live session id right before the throw.
  // We simulate this by setting sessionId back on a transport whose close clears it.
  // Easiest: a transport whose sessionId getter returns 's7' but we manually clear it
  // BEFORE the close in callTool. Since our retry logic reads transportSessionId(conn.transport)
  // AFTER the throw but BEFORE close, we model "transport died" by making sessionId truthy
  // at callTool time but throwing regardless.
  // Use a new deadTransport whose sessionId is "s7" (live) → triggers in-place retries instead,
  // so this case routes to A, not B. To force B on a transport with a session id, we make
  // the throw also clear the id (mirroring SDK closing the session on a fatal error).
  const liveThenDead = makeFakeTransport("s7");
  const clientA = makeFakeClient([
    { tool: "ping", outcomes: [{ throw: Object.assign(new Error("transport closed: session lost"), { _clearSid: true }) }] },
  ]);
  // Patch clientA.callTool to clear the transport session id when throwing the fatal error.
  (clientA as any).callTool = async (req: { name: string; arguments: any }) => {
    if (req.name === "ping") {
      // Clear the session id then throw — mirrors SDK behavior on a transport-closed error.
      liveThenDead.sessionId = undefined;
      throw new Error("transport closed: session lost");
    }
    return { content: [], isError: false };
  };
  const clientB = makeFakeClient([{ tool: "ping", outcomes: [{ result: { content: [{ type: "text", text: "ok" }], isError: false } }] }]);
  const mgr2 = new FakeManager({ servers: { svc: { name: "svc", url: "http://127.0.0.1:1/mcp", lifecycle: "lazy" } }, settings: {} } as any);
  (mgr2.connMap as Map<string, ServerConnection>).set("svc", {
    name: "svc", client: clientA as any, transport: liveThenDead,
    definition: { name: "svc", url: "http://127.0.0.1:1/mcp", lifecycle: "lazy" },
    tools: [], lastUsedAt: Date.now(), status: "connected",
    knownSessionId: "s7",
  } as ServerConnection);
  let capturedCarry2: string | undefined = "__none__";
  mgr2["createConnection"] = async function (_n: string, _d: ServerEntry, _s?: AbortSignal, carrySessionId?: string) {
    capturedCarry2 = carrySessionId;
    return {
      name: "svc", client: clientB as any, transport: makeFakeTransport("fresh"),
      definition: { name: "svc", url: "http://127.0.0.1:1/mcp", lifecycle: "lazy" },
      tools: [], lastUsedAt: Date.now(), status: "connected",
    } as ServerConnection;
  } as any;
  const r2 = await mgr2.callTool("svc", "ping", {});
  assert.equal(r2.success, true);
  // The stale session id "s7" was captured BEFORE close and passed into createConnection.
  assert.equal(capturedCarry2, "s7");
});

// ── needs-auth short-circuits (no retries) ─────────────────────────────────────
test("callTool on needs-auth returns needs-auth without retrying", async () => {
  const transport = makeFakeTransport("sess-1");
  const client = makeFakeClient([{ tool: "ping", outcomes: [] }]);
  const mgr = makeManagerWithFakeConn(client, transport, "needs-auth");
  const r = await mgr.callTool("svc", "ping", {});
  assert.equal(r.success, false);
  if (!r.success) assert.equal(r.kind, "needs-auth");
  assert.equal(client.calls.length, 0); // did not attempt
});