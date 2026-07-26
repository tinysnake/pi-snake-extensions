/**
 * mcp-auth-flow.ts — OAuth authentication flow for pi-mcp.
 *
 * High-level flow: startAuth (returns authorization URL) → user visits URL →
 * completeAuth (with authorization code) → tokens stored.
 *
 * Adapted from pi-mcp-adapter's mcp-auth-flow.ts but simplified: no automatic
 * browser opening (the agent tool returns the URL for the user to visit).
 */

import { auth as runSdkAuth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { McpOAuthProvider, type McpOAuthConfig } from "./mcp-oauth-provider.ts";
import {
  ensureCallbackServer,
  waitForCallback,
  cancelPendingCallback,
  stopCallbackServer,
  releaseCallbackServer,
} from "./mcp-callback-server.ts";
import {
  getAuthForUrl,
  isTokenExpired,
  hasStoredTokens,
  clearAllCredentials,
  clearClientInfo,
  clearTokens,
  clearCodeVerifier,
  updateOAuthState,
  getOAuthState,
  clearOAuthState,
  type StoredTokens,
} from "./mcp-auth.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

export type AuthStatus = "authenticated" | "expired" | "not_authenticated";

export interface AuthFlowOptions {
  /** Override for the authorization URL callback. Default prints to stderr. */
  onAuthorizationUrl?: (url: string) => void | Promise<void>;
}

// ── State ──────────────────────────────────────────────────────────────────────

/** Pending transports waiting for auth completion. */
const pendingTransports = new Map<string, StreamableHTTPClientTransport>();
const pendingAuthStates = new Map<string, string>();
const pendingAuthCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Deduplicate concurrent authenticate() calls per server. */
const pendingAuthentications = new Map<string, Promise<AuthStatus>>();

const MANUAL_AUTH_TIMEOUT_MS = 5 * 60 * 1000;

// ── Helpers ─────────────────────────────────────────────────────────────────────

function generateState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseRedirectUri(redirectUri: string): { port: number; callbackHost: string; callbackPath: string } {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch (error) {
    throw new Error(`Invalid OAuth redirectUri: ${redirectUri}`, { cause: error });
  }

  const hostname = url.hostname.toLowerCase();
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  if (url.protocol !== "http:" || !isLocalhost) {
    throw new Error("OAuth redirectUri must be an http:// localhost or loopback URI");
  }
  if (url.username || url.password) throw new Error("OAuth redirectUri must not include credentials");
  if (url.hash) throw new Error("OAuth redirectUri must not include a fragment");
  if (!url.port) throw new Error("OAuth redirectUri must include an explicit numeric port");

  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("OAuth redirectUri must include an explicit numeric port");
  }

  return { port, callbackHost: hostname === "[::1]" ? "::1" : hostname, callbackPath: url.pathname };
}

/** Extract OAuth config from a server entry's `oauth` field. */
export function extractOAuthConfig(oauthField: unknown): McpOAuthConfig {
  if (!oauthField || typeof oauthField !== "object") return {};

  const obj = oauthField as Record<string, unknown>;
  const config: McpOAuthConfig = {};

  if (obj.grantType === "authorization_code" || obj.grantType === "client_credentials") {
    config.grantType = obj.grantType;
  }
  if (typeof obj.clientId === "string") config.clientId = obj.clientId;
  if (typeof obj.clientSecret === "string") config.clientSecret = obj.clientSecret;
  if (typeof obj.scope === "string") config.scope = obj.scope;
  if (typeof obj.redirectUri === "string" && obj.redirectUri.trim()) config.redirectUri = obj.redirectUri.trim();
  if (typeof obj.clientName === "string" && obj.clientName.trim()) config.clientName = obj.clientName.trim();
  if (typeof obj.clientUri === "string" && obj.clientUri.trim()) config.clientUri = obj.clientUri.trim();

  return config;
}

/** Determine whether OAuth should be used for a server definition. */
export function supportsOAuth(oauthField: unknown, hasHeaders: boolean): boolean {
  if (oauthField === false) return false;
  if (oauthField && typeof oauthField === "object") return true;
  // If no explicit oauth config but no headers, auto-detect (server may advertise OAuth).
  if (hasHeaders) return false;
  return true;
}

// ── Pending transport management ────────────────────────────────────────────────

async function setPendingTransport(serverName: string, transport: StreamableHTTPClientTransport, oauthState: string): Promise<void> {
  await clearPendingAuth(serverName);
  pendingTransports.set(serverName, transport);
  pendingAuthStates.set(serverName, oauthState);

  const cleanupTimer = setTimeout(() => {
    void clearPendingAuth(serverName, oauthState);
  }, MANUAL_AUTH_TIMEOUT_MS);
  cleanupTimer.unref?.();
  pendingAuthCleanupTimers.set(serverName, cleanupTimer);
}

async function clearPendingAuth(serverName: string, oauthState?: string): Promise<void> {
  const pendingState = pendingAuthStates.get(serverName);
  if (oauthState && pendingState && pendingState !== oauthState) return;

  const timer = pendingAuthCleanupTimers.get(serverName);
  if (timer) { clearTimeout(timer); pendingAuthCleanupTimers.delete(serverName); }

  const transport = pendingTransports.get(serverName);
  pendingTransports.delete(serverName);
  pendingAuthStates.delete(serverName);

  const stateToRelease = pendingState ?? oauthState;
  if (stateToRelease) {
    releaseCallbackServer(stateToRelease);
    const storedState = getOAuthState(serverName);
    if (storedState === stateToRelease) await clearOAuthState(serverName);
  }

  if (transport) await transport.close().catch(() => {});
}

// ── Auth code parsing ───────────────────────────────────────────────────────────

function getSearchParamsFromInput(input: string): URLSearchParams | undefined {
  try {
    const url = new URL(input);
    const params = new URLSearchParams(url.search);
    if (url.hash) {
      const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
      for (const [key, value] of hashParams) {
        if (!params.has(key)) params.set(key, value);
      }
    }
    return params;
  } catch {
    const query = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input;
    const params = new URLSearchParams(query.startsWith("#") ? query.slice(1) : query);
    return params.has("code") || params.has("state") || params.has("error") ? params : undefined;
  }
}

/**
 * Extract an OAuth authorization code from a raw code, query string,
 * or the full localhost redirect URL copied from the browser address bar.
 */
export function parseAuthorizationCodeInput(input: string, expectedState?: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Authorization code or redirect URL is required");

  const params = getSearchParamsFromInput(trimmed);
  if (params) {
    const error = params.get("error");
    if (error) {
      const description = params.get("error_description");
      throw new Error(description ? `${error}: ${description}` : error);
    }

    const state = params.get("state");
    if (expectedState && !state) throw new Error("OAuth state missing from redirect URL");
    if (expectedState && state !== expectedState) throw new Error("OAuth state mismatch - potential CSRF attack");

    const code = params.get("code");
    if (code) return code;
  }

  if (/^[A-Za-z0-9._~+/=-]+$/.test(trimmed)) return trimmed;
  throw new Error("Could not find an OAuth authorization code in the provided input");
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Start the OAuth authentication flow for a server.
 * Returns the authorization URL the user needs to visit.
 *
 * If the server uses client_credentials grant, returns empty string
 * (no user interaction needed).
 */
export async function startAuth(
  serverName: string,
  serverUrl: string,
  oauthConfig?: McpOAuthConfig,
): Promise<{ authorizationUrl: string }> {
  const config = oauthConfig ?? {};

  if (config.grantType === "client_credentials") {
    const storedAuth = getAuthForUrl(serverName, serverUrl);
    if (storedAuth?.clientInfo && !storedAuth.tokens && !config.clientId) {
      clearClientInfo(serverName);
      clearCodeVerifier(serverName);
      await clearOAuthState(serverName);
    }

    const authProvider = new McpOAuthProvider(serverName, serverUrl, config, {
      onRedirect: async () => { throw new Error("Browser redirect is not used for client_credentials flow"); },
    });
    const result = await runSdkAuth(authProvider, { serverUrl });
    if (result !== "AUTHORIZED") throw new UnauthorizedError("Failed to authorize");
    return { authorizationUrl: "" };
  }

  // authorization_code flow
  const redirectCallback = config.redirectUri !== undefined ? parseRedirectUri(config.redirectUri) : undefined;
  const oauthState = generateState();

  try {
    await ensureCallbackServer({
      strictPort: Boolean(config.clientId) || config.redirectUri !== undefined,
      oauthState,
      reserveState: true,
      ...(redirectCallback ? {
        port: redirectCallback.port,
        callbackHost: redirectCallback.callbackHost,
        callbackPath: redirectCallback.callbackPath,
      } : {}),
    });
  } catch (error) {
    await clearOAuthState(serverName);
    throw error;
  }

  let capturedUrl: URL | undefined;
  const authProvider = new McpOAuthProvider(serverName, serverUrl, config, {
    onRedirect: async (url: URL) => { capturedUrl = url; },
  });

  try {
    const storedAuth = getAuthForUrl(serverName, serverUrl);
    if (storedAuth?.clientInfo && !config.clientId) {
      if (!storedAuth.tokens) {
        clearClientInfo(serverName);
        clearCodeVerifier(serverName);
        await clearOAuthState(serverName);
      } else {
        const redirectUris = storedAuth.clientInfo.redirectUris;
        if (!Array.isArray(redirectUris) || !redirectUris.includes(authProvider.redirectUrl ?? "")) {
          clearClientInfo(serverName);
          clearTokens(serverName);
          clearCodeVerifier(serverName);
          await clearOAuthState(serverName);
        }
      }
    }

    await updateOAuthState(serverName, oauthState, serverUrl);

    const result = await runSdkAuth(authProvider, { serverUrl });
    if (result === "AUTHORIZED") {
      releaseCallbackServer(oauthState);
      await clearOAuthState(serverName);
      return { authorizationUrl: "" };
    }

    if (!capturedUrl) throw new UnauthorizedError("OAuth authorization URL was not provided");

    // Create a pending transport that will carry the auth state
    const pendingTransport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider });
    await setPendingTransport(serverName, pendingTransport, oauthState);

    return { authorizationUrl: capturedUrl.toString() };
  } catch (error) {
    await clearPendingAuth(serverName, oauthState);
    throw error;
  }
}

/**
 * Complete OAuth authentication with an authorization code.
 * The code can be a raw code string or a redirect URL containing `?code=...`.
 */
export async function completeAuth(serverName: string, input: string): Promise<AuthStatus> {
  const oauthState = getOAuthState(serverName);
  const code = parseAuthorizationCodeInput(input, oauthState);

  const transport = pendingTransports.get(serverName);
  if (!transport) throw new Error(`No pending OAuth flow for server: ${serverName}`);

  try {
    // Use finishAuth on the transport to complete the authorization_code exchange
    await transport.finishAuth(code);
    return "authenticated";
  } finally {
    await clearPendingAuth(serverName, oauthState);
  }
}

/**
 * Perform the full OAuth authentication flow: start → open URL → complete.
 *
 * This is an all-in-one convenience that returns the authorization URL
 * for the tool to show the user. The caller must then provide the
 * authorization code/redirect URL via completeAuth.
 */
export async function authenticate(
  serverName: string,
  serverUrl: string,
  oauthConfig?: McpOAuthConfig,
  options: AuthFlowOptions = {},
): Promise<AuthStatus> {
  const inFlight = pendingAuthentications.get(serverName);
  if (inFlight) return inFlight;

  const operation = (async (): Promise<AuthStatus> => {
    const { authorizationUrl } = await startAuth(serverName, serverUrl, oauthConfig);

    // No URL means client_credentials or already authenticated
    if (!authorizationUrl) return "authenticated";

    const savedState = getOAuthState(serverName);
    if (!savedState) throw new Error("OAuth state not found - this should not happen");

    // Register callback listener BEFORE opening the URL
    const callbackPromise = waitForCallback(savedState);

    try {
      if (options.onAuthorizationUrl) {
        await options.onAuthorizationUrl(authorizationUrl);
      }

      // Wait for the callback to deliver the authorization code
      const code = await callbackPromise;

      // Validate state
      const storedState = getOAuthState(serverName);
      if (storedState !== savedState) {
        await clearOAuthState(serverName);
        throw new Error("OAuth state mismatch - potential CSRF attack");
      }
      await clearOAuthState(serverName);

      return await completeAuth(serverName, code);
    } catch (error) {
      cancelPendingCallback(savedState);
      await clearPendingAuth(serverName, savedState);
      throw error;
    }
  })();

  pendingAuthentications.set(serverName, operation);
  try {
    return await operation;
  } finally {
    if (pendingAuthentications.get(serverName) === operation) {
      pendingAuthentications.delete(serverName);
    }
  }
}

/** Get a valid access token for a server, refreshing if necessary. */
export async function getValidToken(serverName: string, serverUrl: string): Promise<StoredTokens | null> {
  const entry = getAuthForUrl(serverName, serverUrl);
  if (!entry?.tokens) return null;

  const expired = isTokenExpired(serverName);
  if (expired === false) return entry.tokens;

  if (expired === true && entry.tokens.refreshToken) {
    try {
      const authProvider = new McpOAuthProvider(serverName, serverUrl, {}, {
        onRedirect: async () => {},
      });
      const clientInfo = await authProvider.clientInformation();
      if (!clientInfo) return null;

      const result = await runSdkAuth(authProvider, { serverUrl });
      if (result !== "AUTHORIZED") return null;

      const refreshed = getAuthForUrl(serverName, serverUrl);
      return refreshed?.tokens ?? null;
    } catch {
      return null;
    }
  }

  return entry.tokens;
}

/** Check authentication status for a server. */
export async function getAuthStatus(serverName: string): Promise<AuthStatus> {
  const hasTokens = hasStoredTokens(serverName);
  if (!hasTokens) return "not_authenticated";

  const expired = isTokenExpired(serverName);
  return expired ? "expired" : "authenticated";
}

/** Remove all stored credentials for a server. */
export async function removeAuth(serverName: string): Promise<void> {
  const oauthState = getOAuthState(serverName);
  if (oauthState) cancelPendingCallback(oauthState);
  await clearPendingAuth(serverName, oauthState);
  clearAllCredentials(serverName);
  await clearOAuthState(serverName);
}

/** Initialize the OAuth system (no-op in v1, callback startup is lazy). */
export async function initializeOAuth(): Promise<void> {}

/** Shutdown the OAuth system (stop callback server, cancel pending auths). */
export async function shutdownOAuth(): Promise<void> {
  for (const serverName of Array.from(pendingTransports.keys())) {
    await clearPendingAuth(serverName);
  }
  await stopCallbackServer();
}
