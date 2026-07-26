/**
 * Tests for mcp-auth.ts — OAuth token storage.
 *
 * Uses isolated MCP_OAUTH_DIR to avoid touching real credentials.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const TEST_DIR = join(tmpdir(), `pi-mcp-auth-test-${randomBytes(4).toString("hex")}`);
process.env.MCP_OAUTH_DIR = TEST_DIR;

import {
  getAuthEntry,
  getAuthForUrl,
  saveAuthEntry,
  updateTokens,
  updateClientInfo,
  updateCodeVerifier,
  clearCodeVerifier,
  updateOAuthState,
  getOAuthState,
  clearOAuthState,
  isTokenExpired,
  hasStoredTokens,
  clearAllCredentials,
  clearClientInfo,
  clearTokens,
  type AuthEntry,
} from "../mcp-auth.ts";

describe("mcp-auth (storage)", () => {
  before(() => {
    try {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
    } catch { /* best effort */ }
  });

  after(() => {
    try { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // ── getAuthEntry ──────────────────────────────────────────────────────────────

  describe("getAuthEntry", () => {
    it("returns undefined for non-existent entry", () => {
      assert.equal(getAuthEntry("no-such-server"), undefined);
    });
  });

  // ── saveAuthEntry / getAuthEntry ──────────────────────────────────────────────

  describe("saveAuthEntry / getAuthEntry", () => {
    it("saves and retrieves a full auth entry", () => {
      const entry: AuthEntry = {
        tokens: { accessToken: "tok1", refreshToken: "ref1", expiresAt: 1234567890, scope: "read" },
        clientInfo: { clientId: "cid1", clientSecret: "sec1" },
        codeVerifier: "vrf1",
        oauthState: "st1",
        serverUrl: "https://example.com/mcp",
      };
      saveAuthEntry("svc1", entry, "https://example.com/mcp");
      assert.deepEqual(getAuthEntry("svc1"), entry);
    });

    it("overwrites on subsequent saves", () => {
      saveAuthEntry("svc2", { tokens: { accessToken: "old" } });
      saveAuthEntry("svc2", { tokens: { accessToken: "new" } });
      assert.equal(getAuthEntry("svc2")?.tokens?.accessToken, "new");
    });
  });

  // ── getAuthForUrl ─────────────────────────────────────────────────────────────

  describe("getAuthForUrl", () => {
    it("returns entry when URL matches", () => {
      saveAuthEntry("url-match", { tokens: { accessToken: "t" }, serverUrl: "https://a.com/mcp" }, "https://a.com/mcp");
      assert.ok(getAuthForUrl("url-match", "https://a.com/mcp"));
    });

    it("returns undefined when URL differs", () => {
      saveAuthEntry("url-mismatch", { tokens: { accessToken: "t" }, serverUrl: "https://old.com/mcp" }, "https://old.com/mcp");
      assert.equal(getAuthForUrl("url-mismatch", "https://new.com/mcp"), undefined);
    });

    it("returns undefined when no serverUrl stored", () => {
      saveAuthEntry("no-url", { tokens: { accessToken: "t" } });
      assert.equal(getAuthForUrl("no-url", "https://x.com/mcp"), undefined);
    });
  });

  // ── removeAuthEntry ─────────────────────────────────────────────────────────

  describe("removeAuthEntry", () => {
    it("removes the entry", () => {
      saveAuthEntry("to-remove", { tokens: { accessToken: "t" } });
      clearAllCredentials("to-remove");
      assert.equal(getAuthEntry("to-remove"), undefined);
    });
  });

  // ── updateTokens ─────────────────────────────────────────────────────────────

  describe("updateTokens", () => {
    it("sets tokens on a fresh server", () => {
      updateTokens("fresh", { accessToken: "at1", refreshToken: "rt1", expiresAt: 99, scope: "x" });
      const e = getAuthEntry("fresh");
      assert.equal(e?.tokens?.accessToken, "at1");
      assert.equal(e?.tokens?.refreshToken, "rt1");
      assert.equal(e?.tokens?.expiresAt, 99);
      assert.equal(e?.tokens?.scope, "x");
    });

    it("preserves existing client info when URL unchanged", () => {
      updateClientInfo("preserve", { clientId: "cid" });
      updateTokens("preserve", { accessToken: "at" });
      assert.equal(getAuthEntry("preserve")?.clientInfo?.clientId, "cid");
      assert.equal(getAuthEntry("preserve")?.tokens?.accessToken, "at");
    });

    it("clears client info / PKCE state when URL changes", () => {
      saveAuthEntry("url-change-tokens", {
        tokens: { accessToken: "old" },
        clientInfo: { clientId: "cid" },
        codeVerifier: "vrf",
        oauthState: "st",
        serverUrl: "https://old.com/mcp",
      }, "https://old.com/mcp");

      updateTokens("url-change-tokens", { accessToken: "new" }, "https://new.com/mcp");

      const fresh = getAuthForUrl("url-change-tokens", "https://new.com/mcp");
      assert.equal(fresh?.tokens?.accessToken, "new");
      assert.equal(fresh?.clientInfo, undefined);
      assert.equal(fresh?.codeVerifier, undefined);
      assert.equal(fresh?.oauthState, undefined);
    });
  });

  // ── updateClientInfo ─────────────────────────────────────────────────────────

  describe("updateClientInfo", () => {
    it("saves client info", () => {
      updateClientInfo("ci1", { clientId: "cid1", clientSecret: "s1", clientIdIssuedAt: 100, clientSecretExpiresAt: 200 });
      const e = getAuthEntry("ci1");
      assert.equal(e?.clientInfo?.clientId, "cid1");
      assert.equal(e?.clientInfo?.clientSecret, "s1");
    });

    it("clears tokens / PKCE state when URL changes", () => {
      saveAuthEntry("url-change-ci", {
        tokens: { accessToken: "old" },
        clientInfo: { clientId: "old" },
        codeVerifier: "vrf",
        oauthState: "st",
        serverUrl: "https://old.com/mcp",
      }, "https://old.com/mcp");

      updateClientInfo("url-change-ci", { clientId: "new" }, "https://new.com/mcp");

      const fresh = getAuthForUrl("url-change-ci", "https://new.com/mcp");
      assert.equal(fresh?.clientInfo?.clientId, "new");
      assert.equal(fresh?.tokens, undefined);
      assert.equal(fresh?.codeVerifier, undefined);
      assert.equal(fresh?.oauthState, undefined);
    });
  });

  // ── updateCodeVerifier / clearCodeVerifier ───────────────────────────────────

  describe("updateCodeVerifier / clearCodeVerifier", () => {
    it("saves and retrieves code verifier", () => {
      updateCodeVerifier("cv", "verifier-abc");
      assert.equal(getAuthEntry("cv")?.codeVerifier, "verifier-abc");
    });

    it("clears code verifier", () => {
      updateCodeVerifier("cv-clear", "v");
      clearCodeVerifier("cv-clear");
      assert.equal(getAuthEntry("cv-clear")?.codeVerifier, undefined);
    });
  });

  // ── updateOAuthState / getOAuthState / clearOAuthState ───────────────────────

  describe("updateOAuthState / getOAuthState / clearOAuthState", () => {
    it("saves and retrieves state", () => {
      updateOAuthState("state-test", "state-xyz");
      assert.equal(getOAuthState("state-test"), "state-xyz");
    });

    it("clears state", () => {
      updateOAuthState("state-clear", "s");
      clearOAuthState("state-clear");
      assert.equal(getOAuthState("state-clear"), undefined);
    });
  });

  // ── isTokenExpired ───────────────────────────────────────────────────────────

  describe("isTokenExpired", () => {
    it("returns null when no tokens", () => {
      assert.equal(isTokenExpired("exp-null"), null);
    });

    it("returns false when no expiry", () => {
      updateTokens("exp-no-expiry", { accessToken: "t" });
      assert.equal(isTokenExpired("exp-no-expiry"), false);
    });

    it("returns true for expired token", () => {
      updateTokens("exp-yes", { accessToken: "t", expiresAt: 1 });
      assert.equal(isTokenExpired("exp-yes"), true);
    });

    it("returns false for future token", () => {
      updateTokens("exp-no", { accessToken: "t", expiresAt: Date.now() / 1000 + 3600 });
      assert.equal(isTokenExpired("exp-no"), false);
    });
  });

  // ── hasStoredTokens ──────────────────────────────────────────────────────────

  describe("hasStoredTokens", () => {
    it("returns false when no tokens", () => {
      assert.equal(hasStoredTokens("has-none"), false);
    });

    it("returns true when tokens exist", () => {
      updateTokens("has-yes", { accessToken: "t" });
      assert.equal(hasStoredTokens("has-yes"), true);
    });
  });

  // ── clearAllCredentials ─────────────────────────────────────────────────────

  describe("clearAllCredentials", () => {
    it("removes everything", () => {
      updateTokens("clear-all", { accessToken: "t" });
      updateClientInfo("clear-all", { clientId: "c" });
      updateCodeVerifier("clear-all", "v");
      clearAllCredentials("clear-all");
      assert.equal(getAuthEntry("clear-all"), undefined);
    });
  });

  // ── clearClientInfo / clearTokens ────────────────────────────────────────────

  describe("clearClientInfo", () => {
    it("removes only client info", () => {
      updateTokens("ci-clear", { accessToken: "tok" });
      updateClientInfo("ci-clear", { clientId: "cid" });
      clearClientInfo("ci-clear");
      assert.equal(getAuthEntry("ci-clear")?.clientInfo, undefined);
      assert.equal(getAuthEntry("ci-clear")?.tokens?.accessToken, "tok");
    });
  });

  describe("clearTokens", () => {
    it("removes only tokens", () => {
      updateTokens("tok-clear", { accessToken: "tok" });
      updateClientInfo("tok-clear", { clientId: "cid" });
      clearTokens("tok-clear");
      assert.equal(getAuthEntry("tok-clear")?.tokens, undefined);
      assert.equal(getAuthEntry("tok-clear")?.clientInfo?.clientId, "cid");
    });
  });

  // ── updateTokens clears codeVerifier/oauthState on URL change ────────────────

  describe("URL change detection across update functions", () => {
    it("updateTokens clears stale verifier/state when URL changes (legacy entry)", () => {
      saveAuthEntry("legacy-tok", {
        tokens: { accessToken: "old" },
        clientInfo: { clientId: "cid" },
        codeVerifier: "v",
        oauthState: "s",
      });
      updateTokens("legacy-tok", { accessToken: "new" }, "https://new.com/mcp");
      const e = getAuthForUrl("legacy-tok", "https://new.com/mcp");
      assert.equal(e?.tokens?.accessToken, "new");
      assert.equal(e?.clientInfo, undefined);
      assert.equal(e?.codeVerifier, undefined);
      assert.equal(e?.oauthState, undefined);
    });

    it("updateClientInfo clears stale tokens/verifier/state when URL changes (legacy entry)", () => {
      saveAuthEntry("legacy-ci", {
        tokens: { accessToken: "old" },
        clientInfo: { clientId: "cid" },
        codeVerifier: "v",
        oauthState: "s",
      });
      updateClientInfo("legacy-ci", { clientId: "new" }, "https://new.com/mcp");
      const e = getAuthForUrl("legacy-ci", "https://new.com/mcp");
      assert.equal(e?.clientInfo?.clientId, "new");
      assert.equal(e?.tokens, undefined);
      assert.equal(e?.codeVerifier, undefined);
      assert.equal(e?.oauthState, undefined);
    });
  });
});
