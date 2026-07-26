/**
 * mcp-oauth-provider.ts — MCP SDK OAuthClientProvider implementation.
 *
 * Implements the MCP SDK's OAuthClientProvider interface for the
 * StreamableHTTPClientTransport to use during OAuth token negotiation.
 *
 * Adapted from pi-mcp-adapter's mcp-oauth-provider.ts.
 * NOTE: Uses explicit class fields (not TS parameter properties) because
 * Node's strip-only TypeScript mode doesn't support parameter properties.
 */

import type { AddClientAuthentication, OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import {
  getAuthForUrl,
  updateTokens,
  updateClientInfo,
  updateCodeVerifier,
  updateOAuthState,
  clearAllCredentials,
  clearClientInfo,
  clearTokens,
  type StoredTokens,
  type StoredClientInfo,
} from "./mcp-auth.ts";

// ── Callback server configuration ──────────────────────────────────────────────

export const DEFAULT_OAUTH_CALLBACK_PORT = 19876;
export const DEFAULT_OAUTH_CALLBACK_PATH = "/callback";

let configuredCallbackPort = DEFAULT_OAUTH_CALLBACK_PORT;
try {
  const envPort = process.env.MCP_OAUTH_CALLBACK_PORT?.trim();
  if (envPort) {
    const p = Number.parseInt(envPort, 10);
    if (Number.isInteger(p) && p > 0 && p <= 65535) configuredCallbackPort = p;
  }
} catch { /* ignore env parse errors */ }

let activeCallbackPort = configuredCallbackPort;
let activeCallbackPath = DEFAULT_OAUTH_CALLBACK_PATH;

export function getConfiguredOAuthCallbackPort(): number {
  return configuredCallbackPort;
}
export function getOAuthCallbackPort(): number {
  return activeCallbackPort;
}
export function setOAuthCallbackPort(port: number): void {
  activeCallbackPort = port;
}
export function getOAuthCallbackPath(): string {
  return activeCallbackPath;
}
export function setOAuthCallbackPath(path: string): void {
  activeCallbackPath = path.startsWith("/") ? path : `/${path}`;
}

// ── OAuth configuration ────────────────────────────────────────────────────────

export interface McpOAuthConfig {
  grantType?: "authorization_code" | "client_credentials";
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
  clientName?: string;
  clientUri?: string;
}

export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>;
}

// ── Provider implementation ─────────────────────────────────────────────────────

export class McpOAuthProvider implements OAuthClientProvider {
  private serverName: string;
  private serverUrl: string;
  private config: McpOAuthConfig;
  private callbacks: McpOAuthCallbacks;
  private redirectUrlSnapshot: string | undefined;

  constructor(
    serverName: string,
    serverUrl: string,
    config: McpOAuthConfig,
    callbacks: McpOAuthCallbacks,
  ) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.config = config;
    this.callbacks = callbacks;
    this.redirectUrlSnapshot = config.grantType === "client_credentials"
      ? undefined
      : config.redirectUri ?? `http://localhost:${getOAuthCallbackPort()}${getOAuthCallbackPath()}`;
  }

  private get usesClientCredentials(): boolean {
    return this.config.grantType === "client_credentials";
  }

  get redirectUrl(): string | undefined {
    return this.redirectUrlSnapshot;
  }

  get clientMetadata(): OAuthClientMetadata {
    if (this.usesClientCredentials) {
      return {
        client_name: this.config.clientName ?? "Pi Coding Agent",
        client_uri: this.config.clientUri ?? "https://pi.earendil.dev",
        redirect_uris: [],
        grant_types: ["client_credentials"],
        token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      };
    }

    const redirectUrl = this.redirectUrl;
    if (!redirectUrl) throw new Error("redirectUrl is required for authorization_code flow");

    return {
      redirect_uris: [redirectUrl],
      client_name: this.config.clientName ?? "Pi Coding Agent",
      client_uri: this.config.clientUri ?? "https://pi.earendil.dev",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      ...(this.config.scope !== undefined ? { scope: this.config.scope } : {}),
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this.config.clientId) {
      return { client_id: this.config.clientId, client_secret: this.config.clientSecret };
    }

    const entry = getAuthForUrl(this.serverName, this.serverUrl);
    if (entry?.clientInfo) {
      if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
        return undefined;
      }
      return { client_id: entry.clientInfo.clientId, client_secret: entry.clientInfo.clientSecret };
    }

    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    const redirectUris = info.redirect_uris ?? (this.redirectUrl ? [this.redirectUrl] : undefined);
    const clientInfo: StoredClientInfo = {
      clientId: info.client_id,
      clientSecret: info.client_secret,
      clientIdIssuedAt: info.client_id_issued_at,
      clientSecretExpiresAt: info.client_secret_expires_at,
      redirectUris,
    };
    updateClientInfo(this.serverName, clientInfo, this.serverUrl);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const entry = getAuthForUrl(this.serverName, this.serverUrl);
    if (!entry?.tokens) return undefined;

    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      refresh_token: entry.tokens.refreshToken,
      expires_in: entry.tokens.expiresAt
        ? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
        : undefined,
      scope: entry.tokens.scope,
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const stored: StoredTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
      scope: tokens.scope,
    };
    updateTokens(this.serverName, stored, this.serverUrl);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.usesClientCredentials) {
      throw new Error("redirectToAuthorization is not used for client_credentials flow");
    }
    const entry = getAuthForUrl(this.serverName, this.serverUrl);
    if (!entry?.oauthState) {
      throw new UnauthorizedError(`Re-authentication required for MCP server: ${this.serverName}`);
    }
    await this.callbacks.onRedirect(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    updateCodeVerifier(this.serverName, codeVerifier, this.serverUrl);
  }

  async codeVerifier(): Promise<string> {
    if (this.usesClientCredentials) {
      throw new Error("codeVerifier is not used for client_credentials flow");
    }
    const entry = getAuthForUrl(this.serverName, this.serverUrl);
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.serverName}`);
    }
    return entry.codeVerifier;
  }

  async saveState(state: string): Promise<void> {
    updateOAuthState(this.serverName, state, this.serverUrl);
  }

  async state(): Promise<string> {
    if (this.usesClientCredentials) {
      throw new Error("state is not used for client_credentials flow");
    }
    const entry = getAuthForUrl(this.serverName, this.serverUrl);
    if (!entry?.oauthState) {
      throw new UnauthorizedError(`Re-authentication required for MCP server: ${this.serverName}`);
    }
    return entry.oauthState;
  }

  async invalidateCredentials(type: "all" | "client" | "tokens"): Promise<void> {
    switch (type) {
      case "all":
        clearAllCredentials(this.serverName);
        break;
      case "client":
        clearClientInfo(this.serverName);
        break;
      case "tokens":
        clearTokens(this.serverName);
        break;
    }
  }

  addClientAuthentication: AddClientAuthentication = async (headers, params, _url, metadata) => {
    if (params.get("grant_type") === "authorization_code" && !params.has("scope") && this.config.scope) {
      params.set("scope", this.config.scope);
    }

    const clientInfo = await this.clientInformation();
    if (!clientInfo) return;

    const supportedMethods = metadata?.token_endpoint_auth_methods_supported ?? [];
    const hasClientSecret = clientInfo.client_secret !== undefined;
    let authMethod: "client_secret_basic" | "client_secret_post" | "none";

    if (supportedMethods.length === 0) {
      authMethod = hasClientSecret ? "client_secret_post" : "none";
    } else if (hasClientSecret && supportedMethods.includes("client_secret_basic")) {
      authMethod = "client_secret_basic";
    } else if (hasClientSecret && supportedMethods.includes("client_secret_post")) {
      authMethod = "client_secret_post";
    } else if (supportedMethods.includes("none")) {
      authMethod = "none";
    } else {
      authMethod = hasClientSecret ? "client_secret_post" : "none";
    }

    if (authMethod === "client_secret_basic") {
      if (!clientInfo.client_secret) {
        throw new Error("client_secret_basic requires a client_secret");
      }
      headers.set(
        "Authorization",
        `Basic ${Buffer.from(`${clientInfo.client_id}:${clientInfo.client_secret}`).toString("base64")}`,
      );
      return;
    }

    if (!params.has("client_id")) {
      params.set("client_id", clientInfo.client_id);
    }
    if (authMethod === "client_secret_post" && clientInfo.client_secret && !params.has("client_secret")) {
      params.set("client_secret", clientInfo.client_secret);
    }
  };

  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    if (!this.usesClientCredentials) return undefined;

    const params = new URLSearchParams({ grant_type: "client_credentials" });
    const requestedScope = scope ?? this.config.scope;
    if (requestedScope) params.set("scope", requestedScope);
    return params;
  }
}
