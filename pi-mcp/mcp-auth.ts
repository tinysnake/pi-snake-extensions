/**
 * mcp-auth.ts — OAuth token storage for pi-mcp.
 *
 * Stores OAuth credentials, tokens, PKCE state in
 * <agentDir>/mcp-oauth/sha256-<server-hash>/tokens.json.
 *
 * Adapted from pi-mcp-adapter's mcp-auth.ts.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Storage helpers ────────────────────────────────────────────────────────────

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function getAuthBaseDir(): string {
  const override = process.env.MCP_OAUTH_DIR?.trim();
  return override || join(agentDir(), "mcp-oauth");
}

function getServerDir(serverName: string): string {
  const storageKey = createHash("sha256").update(serverName, "utf-8").digest("hex");
  return join(getAuthBaseDir(), `sha256-${storageKey}`);
}

export function getAuthEntryFilePath(serverName: string): string {
  return join(getServerDir(serverName), "tokens.json");
}

function ensureServerDir(serverName: string): void {
  const dir = getServerDir(serverName);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // Unix timestamp in seconds
  scope?: string;
}

export interface StoredClientInfo {
  clientId: string;
  clientSecret?: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
  redirectUris?: string[];
}

export interface AuthEntry {
  tokens?: StoredTokens;
  clientInfo?: StoredClientInfo;
  codeVerifier?: string;
  oauthState?: string;
  serverUrl?: string;
}

// ── Read / Write ────────────────────────────────────────────────────────────────

function readAuthEntry(serverName: string): AuthEntry | undefined {
  const filePath = getAuthEntryFilePath(serverName);
  try {
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, "utf-8")) as AuthEntry;
  } catch {
    return undefined;
  }
}

function writeAuthEntry(serverName: string, entry: AuthEntry): void {
  ensureServerDir(serverName);
  const filePath = getAuthEntryFilePath(serverName);
  writeFileSync(filePath, JSON.stringify(entry, null, 2), { mode: 0o600 });
}

// ── Public API ──────────────────────────────────────────────────────────────────

/** Get the full auth entry for a server (tokens + client info + PKCE state). */
export function getAuthEntry(serverName: string): AuthEntry | undefined {
  return readAuthEntry(serverName);
}

/** Get auth entry, but only if it matches the expected server URL. */
export function getAuthForUrl(serverName: string, serverUrl: string): AuthEntry | undefined {
  const entry = getAuthEntry(serverName);
  if (!entry) return undefined;
  if (!entry.serverUrl || entry.serverUrl !== serverUrl) return undefined;
  return entry;
}

/** Save a full auth entry. */
export function saveAuthEntry(serverName: string, entry: AuthEntry, serverUrl?: string): void {
  if (serverUrl) entry.serverUrl = serverUrl;
  writeAuthEntry(serverName, entry);
}

/** Update stored tokens. Clears stale client info / PKCE state if URL changed. */
export function updateTokens(serverName: string, tokens: StoredTokens, serverUrl?: string): void {
  const entry = getAuthEntry(serverName) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.clientInfo;
    delete entry.codeVerifier;
    delete entry.oauthState;
  }
  entry.tokens = tokens;
  saveAuthEntry(serverName, entry, serverUrl);
}

/** Update stored client info (dynamic registration). */
export function updateClientInfo(serverName: string, clientInfo: StoredClientInfo, serverUrl?: string): void {
  const entry = getAuthEntry(serverName) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.codeVerifier;
    delete entry.oauthState;
  }
  entry.clientInfo = clientInfo;
  saveAuthEntry(serverName, entry, serverUrl);
}

/** Update PKCE code verifier. */
export function updateCodeVerifier(serverName: string, codeVerifier: string, serverUrl?: string): void {
  const entry = getAuthEntry(serverName) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.clientInfo;
    delete entry.oauthState;
  }
  entry.codeVerifier = codeVerifier;
  saveAuthEntry(serverName, entry, serverUrl);
}

/** Clear PKCE code verifier. */
export function clearCodeVerifier(serverName: string): void {
  const entry = getAuthEntry(serverName);
  if (entry) {
    delete entry.codeVerifier;
    saveAuthEntry(serverName, entry);
  }
}

/** Update OAuth CSRF state. */
export function updateOAuthState(serverName: string, state: string, serverUrl?: string): void {
  const entry = getAuthEntry(serverName) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.clientInfo;
    delete entry.codeVerifier;
  }
  entry.oauthState = state;
  saveAuthEntry(serverName, entry, serverUrl);
}

/** Get stored OAuth CSRF state. */
export function getOAuthState(serverName: string): string | undefined {
  return getAuthEntry(serverName)?.oauthState;
}

/** Clear OAuth CSRF state. */
export function clearOAuthState(serverName: string): void {
  const entry = getAuthEntry(serverName);
  if (entry) {
    delete entry.oauthState;
    saveAuthEntry(serverName, entry);
  }
}

/** Check whether stored tokens are expired. Returns null if no tokens exist. */
export function isTokenExpired(serverName: string): boolean | null {
  const entry = getAuthEntry(serverName);
  if (!entry?.tokens) return null;
  if (!entry.tokens.expiresAt) return false;
  return entry.tokens.expiresAt < Date.now() / 1000;
}

/** Check if server has stored tokens. */
export function hasStoredTokens(serverName: string): boolean {
  return !!getAuthEntry(serverName)?.tokens;
}

/** Remove all credentials (tokens + client info + PKCE state + directory). */
export function clearAllCredentials(serverName: string): void {
  const dir = getServerDir(serverName);
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true }); } catch { /* best effort */ }
  }
}

/** Clear only client info for a server. */
export function clearClientInfo(serverName: string): void {
  const entry = getAuthEntry(serverName);
  if (entry) {
    delete entry.clientInfo;
    saveAuthEntry(serverName, entry);
  }
}

/** Clear only tokens for a server. */
export function clearTokens(serverName: string): void {
  const entry = getAuthEntry(serverName);
  if (entry) {
    delete entry.tokens;
    saveAuthEntry(serverName, entry);
  }
}
