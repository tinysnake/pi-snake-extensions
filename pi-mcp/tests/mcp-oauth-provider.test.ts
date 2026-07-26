/**
 * Tests for mcp-oauth-provider.ts — MCP SDK OAuthClientProvider implementation.
 *
 * Uses isolated MCP_OAUTH_DIR to avoid touching real credentials.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const TEST_DIR = join(tmpdir(), `pi-mcp-oauth-provider-test-${randomBytes(4).toString("hex")}`);
process.env.MCP_OAUTH_DIR = TEST_DIR;

import {
  McpOAuthProvider,
  setOAuthCallbackPort,
  setOAuthCallbackPath,
  getOAuthCallbackPort,
  getOAuthCallbackPath,
  type McpOAuthConfig,
} from "../mcp-oauth-provider.ts";
import { saveAuthEntry, clearAllCredentials } from "../mcp-auth.ts";

describe("McpOAuthProvider", () => {
  const serverName = "test-server";
  const serverUrl = "https://api.example.com";
  let redirectCaptured: URL | undefined;

  before(() => {
    try {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
    } catch { /* best effort */ }
  });

  after(() => {
    try { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
    redirectCaptured = undefined;
  });

  // Clear stored credentials between tests so state doesn't leak.
  beforeEach(() => {
    clearAllCredentials(serverName);
    redirectCaptured = undefined;
  });

  function createProvider(config: McpOAuthConfig = {}): McpOAuthProvider {
    return new McpOAuthProvider(serverName, serverUrl, config, {
      onRedirect: async (url: URL) => { redirectCaptured = url; },
    });
  }

  // ── redirectUrl ───────────────────────────────────────────────────────────────

  describe("redirectUrl", () => {
    it("returns default callback URL", () => {
      const p = createProvider();
      assert.equal(p.redirectUrl, "http://localhost:19876/callback");
    });

    it("uses configured redirectUri", () => {
      const p = createProvider({ redirectUri: "http://localhost:3999/my/cb" });
      assert.equal(p.redirectUrl, "http://localhost:3999/my/cb");
    });

    it("is undefined for client_credentials grant", () => {
      const p = createProvider({ grantType: "client_credentials" });
      assert.equal(p.redirectUrl, undefined);
    });

    it("snapshots redirect URL at construction", () => {
      const origPort = getOAuthCallbackPort();
      const origPath = getOAuthCallbackPath();
      setOAuthCallbackPort(41234);
      setOAuthCallbackPath("/snapshot/cb");

      try {
        const p = createProvider();
        setOAuthCallbackPort(52345);
        setOAuthCallbackPath("/changed/cb");

        assert.equal(p.redirectUrl, "http://localhost:41234/snapshot/cb");
        assert.deepEqual(p.clientMetadata.redirect_uris, ["http://localhost:41234/snapshot/cb"]);
      } finally {
        setOAuthCallbackPort(origPort);
        setOAuthCallbackPath(origPath);
      }
    });
  });

  // ── clientMetadata ────────────────────────────────────────────────────────────

  describe("clientMetadata", () => {
    it("returns metadata for public auth_code client", () => {
      const p = createProvider();
      const meta = p.clientMetadata;
      assert.deepEqual(meta.redirect_uris, ["http://localhost:19876/callback"]);
      assert.deepEqual(meta.grant_types, ["authorization_code", "refresh_token"]);
      assert.deepEqual(meta.response_types, ["code"]);
      assert.equal(meta.token_endpoint_auth_method, "none");
    });

    it("includes client_secret for confidential client", () => {
      const p = createProvider({ clientSecret: "s3cret" });
      assert.equal(p.clientMetadata.token_endpoint_auth_method, "client_secret_post");
    });

    it("includes scope when configured", () => {
      const p = createProvider({ scope: "openid profile" });
      assert.equal(p.clientMetadata.scope, "openid profile");
    });

    it("returns metadata for client_credentials grant", () => {
      const p = createProvider({ grantType: "client_credentials", clientName: "MyApp", clientUri: "https://my.app" });
      const meta = p.clientMetadata;
      assert.deepEqual(meta.redirect_uris, []);
      assert.deepEqual(meta.grant_types, ["client_credentials"]);
      assert.equal(meta.client_name, "MyApp");
      assert.equal(meta.client_uri, "https://my.app");
    });
  });

  // ── clientInformation ─────────────────────────────────────────────────────────

  describe("clientInformation", () => {
    it("returns undefined when no client info stored and no config", async () => {
      const p = createProvider();
      assert.equal(await p.clientInformation(), undefined);
    });

    it("returns config-provided clientId/secret", async () => {
      const p = createProvider({ clientId: "pre-registered-id", clientSecret: "pre-registered-secret" });
      const info = await p.clientInformation();
      assert.equal(info?.client_id, "pre-registered-id");
      assert.equal(info?.client_secret, "pre-registered-secret");
    });

    it("returns stored client info for same URL", async () => {
      saveAuthEntry(serverName, {
        clientInfo: { clientId: "dyn-id", clientSecret: "dyn-secret" },
        serverUrl,
      }, serverUrl);
      const p = createProvider();
      const info = await p.clientInformation();
      assert.equal(info?.client_id, "dyn-id");
      assert.equal(info?.client_secret, "dyn-secret");
    });

    it("returns undefined when stored client secret has expired", async () => {
      saveAuthEntry(serverName, {
        clientInfo: { clientId: "expired", clientSecret: "secret", clientSecretExpiresAt: 1 },
        serverUrl,
      }, serverUrl);
      const p = createProvider();
      assert.equal(await p.clientInformation(), undefined);
    });

    it("returns undefined when server URL changed", async () => {
      saveAuthEntry(serverName, {
        clientInfo: { clientId: "old" },
        serverUrl: "https://old.com/mcp",
      }, "https://old.com/mcp");
      const p = new McpOAuthProvider(serverName, "https://new.com/mcp", {}, { onRedirect: async () => {} });
      assert.equal(await p.clientInformation(), undefined);
    });
  });

  // ── saveClientInformation ─────────────────────────────────────────────────────

  describe("saveClientInformation", () => {
    it("stores client info from dynamic registration", async () => {
      const p = createProvider();
      const future = Math.floor(Date.now() / 1000) + 86400; // 24h from now
      const full: OAuthClientInformationFull = {
        client_id: "reg-id",
        client_secret: "reg-secret",
        client_id_issued_at: Math.floor(Date.now() / 1000) - 3600,
        client_secret_expires_at: future,
        redirect_uris: ["http://localhost:19876/callback"],
      };
      await p.saveClientInformation(full);

      const info = await p.clientInformation();
      assert.equal(info?.client_id, "reg-id");
      assert.equal(info?.client_secret, "reg-secret");
    });
  });

  // ── tokens / saveTokens ──────────────────────────────────────────────────────

  describe("tokens / saveTokens", () => {
    it("returns undefined when no tokens stored", async () => {
      const p = createProvider();
      assert.equal(await p.tokens(), undefined);
    });

    it("stores and retrieves tokens", async () => {
      const p = createProvider();
      const tokens: OAuthTokens = {
        access_token: "at1",
        token_type: "Bearer",
        refresh_token: "rt1",
        expires_in: 3600,
        scope: "read",
      };
      await p.saveTokens(tokens);

      const got = await p.tokens();
      assert.equal(got?.access_token, "at1");
      assert.equal(got?.refresh_token, "rt1");
      assert.equal(got?.token_type, "Bearer");
      assert.equal(got?.scope, "read");
      assert.ok(got!.expires_in! > 3590); // near 3600
    });

    it("returns undefined when server URL changed", async () => {
      saveAuthEntry(serverName, {
        tokens: { accessToken: "old-token" },
        serverUrl: "https://old.com/mcp",
      }, "https://old.com/mcp");
      const p = new McpOAuthProvider(serverName, "https://new.com/mcp", {}, { onRedirect: async () => {} });
      assert.equal(await p.tokens(), undefined);
    });
  });

  // ── redirectToAuthorization ───────────────────────────────────────────────────

  describe("redirectToAuthorization", () => {
    it("captures the authorization URL and throws UnauthorizedError when no oauthState", async () => {
      const p = createProvider();
      const url = new URL("https://auth.example.com/authorize?state=x");

      await assert.rejects(
        async () => await p.redirectToAuthorization(url),
        (err: unknown) => err instanceof UnauthorizedError && (err as Error).message.includes("Re-authentication"),
      );
    });

    it("captures the URL when oauthState is present", async () => {
      saveAuthEntry(serverName, {
        oauthState: "active-state",
        serverUrl,
      }, serverUrl);
      const p = createProvider();
      const url = new URL("https://auth.example.com/authorize?code=x");

      await p.redirectToAuthorization(url);
      assert.equal(redirectCaptured?.toString(), "https://auth.example.com/authorize?code=x");
    });

    it("throws for client_credentials grant", async () => {
      const p = createProvider({ grantType: "client_credentials" });
      await assert.rejects(
        async () => await p.redirectToAuthorization(new URL("https://x.com")),
        /not used for client_credentials/,
      );
    });
  });

  // ── codeVerifier / saveCodeVerifier / clearCodeVerifier ───────────────────────

  describe("saveCodeVerifier / codeVerifier", () => {
    it("saves and retrieves code verifier", async () => {
      const p = createProvider();
      await p.saveCodeVerifier("pkce-verifier-abc");
      assert.equal(await p.codeVerifier(), "pkce-verifier-abc");
    });

    it("throws when no verifier stored", async () => {
      const p = createProvider();
      await assert.rejects(async () => await p.codeVerifier(), /No code verifier/);
    });

    it("throws for client_credentials grant", async () => {
      const p = createProvider({ grantType: "client_credentials" });
      await assert.rejects(async () => await p.codeVerifier(), /not used for client_credentials/);
    });
  });

  // ── state / saveState ────────────────────────────────────────────────────────

  describe("saveState / state", () => {
    it("saves and retrieves OAuth state", async () => {
      const p = createProvider();
      await p.saveState("csrf-state-123");
      assert.equal(await p.state(), "csrf-state-123");
    });

    it("throws UnauthorizedError when no state stored", async () => {
      const p = createProvider();
      await assert.rejects(
        async () => await p.state(),
        (err: unknown) => err instanceof UnauthorizedError,
      );
    });
  });

  // ── invalidateCredentials ─────────────────────────────────────────────────────

  describe("invalidateCredentials", () => {
    it("clears all credentials", async () => {
      const p = createProvider();
      await p.saveTokens({ access_token: "t", token_type: "Bearer" });
      await p.invalidateCredentials("all");
      assert.equal(await p.tokens(), undefined);
    });

    it("clears only tokens", async () => {
      const p = createProvider();
      await p.saveTokens({ access_token: "t", token_type: "Bearer" });
      await p.saveClientInformation({ client_id: "c" } as OAuthClientInformationFull);
      await p.invalidateCredentials("tokens");
      assert.equal(await p.tokens(), undefined);
      assert.ok((await p.clientInformation())?.client_id);
    });

    it("clears only client info", async () => {
      const p = createProvider();
      await p.saveTokens({ access_token: "t", token_type: "Bearer" });
      await p.saveClientInformation({ client_id: "c" } as OAuthClientInformationFull);
      await p.invalidateCredentials("client");
      assert.equal(await p.clientInformation(), undefined);
      assert.ok((await p.tokens())?.access_token);
    });
  });

  // ── prepareTokenRequest ──────────────────────────────────────────────────────

  describe("prepareTokenRequest", () => {
    it("returns undefined for auth_code flow", () => {
      const p = createProvider();
      assert.equal(p.prepareTokenRequest(), undefined);
    });

    it("returns params for client_credentials flow", () => {
      const p = createProvider({ grantType: "client_credentials", scope: "read write" });
      const params = p.prepareTokenRequest();
      assert.equal(params?.get("grant_type"), "client_credentials");
      assert.equal(params?.get("scope"), "read write");
    });

    it("allows scope override", () => {
      const p = createProvider({ grantType: "client_credentials" });
      const params = p.prepareTokenRequest("override-scope");
      assert.equal(params?.get("scope"), "override-scope");
    });
  });
});
