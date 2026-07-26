/**
 * Tests for mcp-callback-server.ts — local HTTP OAuth callback server.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  ensureCallbackServer,
  waitForCallback,
  cancelPendingCallback,
  stopCallbackServer,
  isCallbackServerRunning,
  getPendingAuthCount,
  releaseCallbackServer,
} from "../mcp-callback-server.ts";
import { getConfiguredOAuthCallbackPort, getOAuthCallbackPath, getOAuthCallbackPort } from "../mcp-oauth-provider.ts";

async function getFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "localhost", resolve);
  });
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Failed to reserve a free test port");
  return address.port;
}

describe("mcp-callback-server", () => {
  beforeEach(async () => {
    await stopCallbackServer().catch(() => {});
  });

  afterEach(async () => {
    await stopCallbackServer().catch(() => {});
  });

  // ── ensureCallbackServer ──────────────────────────────────────────────────────

  describe("ensureCallbackServer", () => {
    it("starts the callback server", async () => {
      await ensureCallbackServer();
      assert.equal(isCallbackServerRunning(), true);
    });

    it("is idempotent", async () => {
      await ensureCallbackServer();
      await ensureCallbackServer();
      await ensureCallbackServer();
      assert.equal(isCallbackServerRunning(), true);
    });

    it("reserves callback state atomically with initial bind", async () => {
      await ensureCallbackServer({ oauthState: "reserved-init", reserveState: true });

      await assert.rejects(
        async () => await ensureCallbackServer({ callbackHost: "127.0.0.1" }),
        /cannot be switched while authorizations are pending/,
      );

      releaseCallbackServer("reserved-init");
    });

    it("does not switch callback hosts while state is reserved", async () => {
      await ensureCallbackServer({ oauthState: "reserved-host", reserveState: true });

      await assert.rejects(
        async () => await ensureCallbackServer({ callbackHost: "127.0.0.1" }),
        /cannot be switched while authorizations are pending/,
      );

      releaseCallbackServer("reserved-host");
    });

    it("does not switch callback paths while state is reserved", async () => {
      await ensureCallbackServer({ callbackPath: "/first/cb", oauthState: "reserved-path", reserveState: true });

      await assert.rejects(
        async () => await ensureCallbackServer({ callbackPath: "/second/cb" }),
        /cannot be switched while authorizations are pending/,
      );
      assert.equal(getOAuthCallbackPath(), "/first/cb");

      releaseCallbackServer("reserved-path");
    });

    it("releases reserved state when strict binding fails", async () => {
      const port = await getFreePort();
      const blocker = createServer((_req, res) => { res.writeHead(200); res.end("blocked"); });
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(port, "localhost", resolve);
      });

      try {
        await assert.rejects(
          async () => await ensureCallbackServer({ strictPort: true, port, oauthState: "fail-bind", reserveState: true }),
          /already in use/,
        );
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }

      // After failure, path switch should work (reservation was released)
      await ensureCallbackServer({ callbackPath: "/after-fail" });
      assert.equal(getOAuthCallbackPath(), "/after-fail");
    });

    it("binds explicit strict host, port, and custom callback path", async () => {
      const port = await getFreePort();

      await ensureCallbackServer({ strictPort: true, port, callbackHost: "127.0.0.1", callbackPath: "/my/cb" });
      assert.equal(getOAuthCallbackPort(), port);
      assert.equal(getOAuthCallbackPath(), "/my/cb");

      // Wrong path -> 404
      const r1 = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=s`);
      assert.equal(r1.status, 404);

      // Right path -> 200 with code
      const cb = waitForCallback("strict-state");
      const r2 = await fetch(`http://127.0.0.1:${port}/my/cb?code=ok&state=strict-state`);
      assert.equal(r2.status, 200);
      assert.equal(await cb, "ok");
    });

    it("rejects an occupied explicit strict port", async () => {
      const port = await getFreePort();
      const blocker = createServer((_req, res) => { res.writeHead(200); res.end("blocked"); });
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(port, "localhost", resolve);
      });

      try {
        await assert.rejects(
          async () => await ensureCallbackServer({ strictPort: true, port }),
          /already in use/,
        );
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });

    it("uses OS-assigned port when configured non-strict port is occupied", async () => {
      const configuredPort = getConfiguredOAuthCallbackPort();
      const blocker = createServer((_req, res) => { res.writeHead(200); res.end("blocked"); });
      try {
        await new Promise<void>((resolve, reject) => {
          blocker.once("error", reject);
          blocker.listen(configuredPort, "localhost", resolve);
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return; // port already taken, skip
        throw error;
      }

      try {
        await ensureCallbackServer();
        assert.notEqual(getOAuthCallbackPort(), configuredPort);

        const state = "occupied-port";
        const cb = waitForCallback(state);
        const res = await fetch(`http://localhost:${getOAuthCallbackPort()}/callback?code=ok&state=${state}`);
        assert.equal(res.status, 200);
        assert.equal(await cb, "ok");
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });
  });

  // ── waitForCallback / callback handling ─────────────────────────────────────

  describe("waitForCallback / callback handling", () => {
    it("resolves with code on successful callback", async () => {
      await ensureCallbackServer();

      const state = "test-state-ok";
      const cb = waitForCallback(state);
      const port = getOAuthCallbackPort();

      const res = await fetch(`http://localhost:${port}/callback?code=mycode&state=${state}`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes("Authorization Successful"));
      assert.equal(await cb, "mycode");
    });

    it("rejects on error parameter", async () => {
      await ensureCallbackServer();

      const state = "test-state-err";
      const cb = waitForCallback(state);
      // Attach rejection handler BEFORE fetch to avoid unhandled rejection
      // (the HTTP handler rejects synchronously via queueMicrotask)
      const rejectPromise = assert.rejects(cb, /access_denied/);

      const port = getOAuthCallbackPort();
      const res = await fetch(`http://localhost:${port}/callback?error=access_denied&state=${state}`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes("Authorization Failed"));
      await rejectPromise;
    });

    it("escapes provider-controlled error details", async () => {
      await ensureCallbackServer();

      const state = "escape-state";
      const cb = waitForCallback(state);
      // Attach rejection handler BEFORE fetch to avoid unhandled rejection
      const rejectPromise = assert.rejects(cb, /<script>alert\("x"\)<\/script>&reason=bad/);

      const port = getOAuthCallbackPort();
      const desc = `<script>alert("x")</script>&reason=bad`;
      const res = await fetch(
        `http://localhost:${port}/callback?error=denied&error_description=${encodeURIComponent(desc)}&state=${state}`,
      );
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(!html.includes("<script>"));
      assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;reason=bad"));

      await rejectPromise;
    });

    it("does not reflect error details for invalid state", async () => {
      await ensureCallbackServer();

      const port = getOAuthCallbackPort();
      const res = await fetch(
        `http://localhost:${port}/callback?error=denied&error_description=${encodeURIComponent("<script>bad()</script>")}&state=invalid-state`,
      );
      assert.equal(res.status, 400);
      const html = await res.text();
      assert.ok(html.includes("Invalid or expired state parameter"));
      assert.ok(!html.includes("<script>"));
    });

    it("returns 400 for missing state", async () => {
      await ensureCallbackServer();
      const res = await fetch(`http://localhost:${getOAuthCallbackPort()}/callback?code=x`);
      assert.equal(res.status, 400);
      const html = await res.text();
      assert.ok(html.includes("Missing required state parameter"));
    });

    it("returns 400 for invalid state", async () => {
      await ensureCallbackServer();
      const cb = waitForCallback("good-state");
      const port = getOAuthCallbackPort();

      const res = await fetch(`http://localhost:${port}/callback?code=x&state=bad-state`);
      assert.equal(res.status, 400);
      const html = await res.text();
      assert.ok(html.includes("Invalid or expired state parameter"));

      cancelPendingCallback("good-state");
      await assert.rejects(cb, /Authorization cancelled/);
    });

    it("returns 400 for missing code", async () => {
      await ensureCallbackServer();
      const state = "no-code";
      const cb = waitForCallback(state);
      const port = getOAuthCallbackPort();

      const res = await fetch(`http://localhost:${port}/callback?state=${state}`);
      assert.equal(res.status, 400);
      const html = await res.text();
      assert.ok(html.includes("No authorization code provided"));

      cancelPendingCallback(state);
      await assert.rejects(cb, /Authorization cancelled/);
    });

    it("does not switch paths while callbacks are pending", async () => {
      await ensureCallbackServer({ callbackPath: "/first/cb" });
      const state = "pending-path";
      const cb = waitForCallback(state);

      await assert.rejects(
        async () => await ensureCallbackServer({ callbackPath: "/second/cb" }),
        /cannot be switched while authorizations are pending/,
      );
      assert.equal(getOAuthCallbackPath(), "/first/cb");

      cancelPendingCallback(state);
      await assert.rejects(cb, /Authorization cancelled/);
    });

    it("returns 404 for wrong path", async () => {
      await ensureCallbackServer();
      const res = await fetch(`http://localhost:${getOAuthCallbackPort()}/wrong/path`);
      assert.equal(res.status, 404);
    });
  });

  // ── cancelPendingCallback ─────────────────────────────────────────────────────

  describe("cancelPendingCallback", () => {
    it("rejects pending callback", async () => {
      await ensureCallbackServer();
      const state = "cancel-me";
      const cb = waitForCallback(state);

      cancelPendingCallback(state);
      await assert.rejects(cb, /Authorization cancelled/);
    });
  });

  // ── stopCallbackServer ───────────────────────────────────────────────────────

  describe("stopCallbackServer", () => {
    it("stops the server", async () => {
      await ensureCallbackServer();
      assert.equal(isCallbackServerRunning(), true);

      await stopCallbackServer();
      assert.equal(isCallbackServerRunning(), false);
    });

    it("rejects all pending callbacks", async () => {
      await ensureCallbackServer();
      const p1 = waitForCallback("s1");
      const p2 = waitForCallback("s2");

      await stopCallbackServer();

      await assert.rejects(p1, /OAuth callback server stopped/);
      await assert.rejects(p2, /OAuth callback server stopped/);
    });
  });

  // ── getPendingAuthCount ──────────────────────────────────────────────────────

  describe("getPendingAuthCount", () => {
    it("returns 0 when no pending auths", async () => {
      await ensureCallbackServer();
      assert.equal(getPendingAuthCount(), 0);
    });

    it("returns correct count", async () => {
      await ensureCallbackServer();
      const p1 = waitForCallback("c1");
      assert.equal(getPendingAuthCount(), 1);
      const p2 = waitForCallback("c2");
      assert.equal(getPendingAuthCount(), 2);

      cancelPendingCallback("c1");
      cancelPendingCallback("c2");
      await assert.rejects(p1, /Authorization cancelled/);
      await assert.rejects(p2, /Authorization cancelled/);
    });
  });
});
