/**
 * mcp-callback-server.ts — HTTP callback server for MCP OAuth redirects.
 *
 * Listens on localhost for the authorization code callback from the
 * OAuth provider during the authorization_code grant flow.
 *
 * Adapted from pi-mcp-adapter's mcp-callback-server.ts.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import {
  DEFAULT_OAUTH_CALLBACK_PATH,
  getConfiguredOAuthCallbackPort,
  getOAuthCallbackPath,
  getOAuthCallbackPort,
  setOAuthCallbackPath,
  setOAuthCallbackPort,
} from "./mcp-oauth-provider.ts";

// ── HTML templates ─────────────────────────────────────────────────────────────

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Pi - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Pi.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html>
<head>
  <title>Pi - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${escapeHtml(error)}</div>
  </div>
</body>
</html>`;

// ── State ──────────────────────────────────────────────────────────────────────

interface PendingAuth {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

let server: Server | undefined;
let bindingPromise: Promise<void> | undefined;
const pendingAuths = new Map<string, PendingAuth>();
const reservedAuthStates = new Set<string>();

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_OAUTH_CALLBACK_HOST = "localhost";
let callbackServerHost = DEFAULT_OAUTH_CALLBACK_HOST;

// ── Request handler ─────────────────────────────────────────────────────────────

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname !== getOAuthCallbackPath()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (!state) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(HTML_ERROR("Missing required state parameter"));
    return;
  }

  const pending = pendingAuths.get(state);
  const isReserved = reservedAuthStates.has(state);

  if (error) {
    if (!pending && !isReserved) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(HTML_ERROR("Invalid or expired state parameter"));
      return;
    }
    const errorMsg = errorDescription || error;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML_ERROR(errorMsg));
    reservedAuthStates.delete(state);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingAuths.delete(state);
      // queueMicrotask so Node doesn't detect an unhandled rejection
      // before the caller attaches a .catch() / await assert.rejects().
      queueMicrotask(() => pending.reject(new Error(errorMsg)));
    }
    return;
  }

  if (!pending) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(HTML_ERROR("Invalid or expired state parameter"));
    return;
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(HTML_ERROR("No authorization code provided"));
    return;
  }

  clearTimeout(pending.timeout);
  pendingAuths.delete(state);
  pending.resolve(code);

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML_SUCCESS);
}

// ── Public API ──────────────────────────────────────────────────────────────────

export interface EnsureCallbackServerOptions {
  strictPort?: boolean;
  port?: number;
  callbackHost?: string;
  callbackPath?: string;
  oauthState?: string;
  reserveState?: boolean;
}

export async function ensureCallbackServer(options: EnsureCallbackServerOptions = {}): Promise<void> {
  while (bindingPromise) await bindingPromise.catch(() => {});

  const operation = ensureCallbackServerLocked(options);
  bindingPromise = operation;
  try {
    await operation;
  } finally {
    if (bindingPromise === operation) bindingPromise = undefined;
  }
}

async function ensureCallbackServerLocked(options: EnsureCallbackServerOptions = {}): Promise<void> {
  const requiredPort = options.port ?? getConfiguredOAuthCallbackPort();
  const strictPort = options.strictPort === true;
  const requestedHost = options.callbackHost ?? DEFAULT_OAUTH_CALLBACK_HOST;
  const rawRequestedPath = options.callbackPath ?? DEFAULT_OAUTH_CALLBACK_PATH;
  const requestedPath = rawRequestedPath.startsWith("/") ? rawRequestedPath : `/${rawRequestedPath}`;

  if (options.reserveState && !options.oauthState) {
    throw new Error("OAuth callback reservation requires an oauthState");
  }

  const previousServer = server;
  const needsRebind = Boolean(previousServer && (
    (strictPort && getOAuthCallbackPort() !== requiredPort) ||
    callbackServerHost !== requestedHost
  ));
  const needsPathSwitch = Boolean(previousServer && getOAuthCallbackPath() !== requestedPath);

  if (previousServer && !needsRebind) {
    if (needsPathSwitch) {
      if (pendingAuths.size > 0 || reservedAuthStates.size > 0) {
        throw new Error(
          `OAuth callback server is using ${getOAuthCallbackPath()} but ${requestedPath} is required and cannot be switched while authorizations are pending`,
        );
      }
      setOAuthCallbackPath(requestedPath);
    }
    if (options.reserveState && options.oauthState) {
      reservedAuthStates.add(options.oauthState);
    }
    return;
  }

  if (previousServer && (pendingAuths.size > 0 || reservedAuthStates.size > 0)) {
    throw new Error(
      `OAuth callback server is running on ${callbackServerHost}:${getOAuthCallbackPort()} but ${requestedHost}:${requiredPort} is required and cannot be switched while authorizations are pending`,
    );
  }

  const candidateServer = createServer(handleRequest);
  const listenPort = strictPort ? requiredPort : 0;

  try {
    await new Promise<void>((resolve, reject) => {
      candidateServer.once("error", reject);
      candidateServer.listen(listenPort, requestedHost, () => resolve());
    });

    if (strictPort) {
      setOAuthCallbackPort(requiredPort);
    } else {
      const address = candidateServer.address();
      if (!address || typeof address === "string" || typeof address.port !== "number") {
        throw new Error("Callback server did not report an assigned port");
      }
      setOAuthCallbackPort(address.port);
    }

    if (previousServer && needsRebind) {
      await new Promise<void>((resolve) => previousServer.close(() => resolve()));
    }

    callbackServerHost = requestedHost;
    setOAuthCallbackPath(requestedPath);
    server = candidateServer;
    if (options.reserveState && options.oauthState) {
      reservedAuthStates.add(options.oauthState);
    }
    server.unref();
  } catch (error) {
    if (options.oauthState) reservedAuthStates.delete(options.oauthState);
    await new Promise<void>((resolve) => candidateServer.close(() => resolve()));

    const nodeError = error as NodeJS.ErrnoException;
    if (strictPort && nodeError.code === "EADDRINUSE") {
      throw new Error(
        `OAuth callback port ${requiredPort} is already in use. Set MCP_OAUTH_CALLBACK_PORT or free port ${requiredPort}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export function reserveCallbackServer(oauthState: string): void {
  reservedAuthStates.add(oauthState);
}

export function releaseCallbackServer(oauthState: string): void {
  reservedAuthStates.delete(oauthState);
}

export function waitForCallback(oauthState: string): Promise<string> {
  reservedAuthStates.delete(oauthState);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuths.has(oauthState)) {
        pendingAuths.delete(oauthState);
        reject(new Error("OAuth callback timeout - authorization took too long"));
      }
    }, CALLBACK_TIMEOUT_MS);

    pendingAuths.set(oauthState, { resolve, reject, timeout });
  });
}

export function cancelPendingCallback(oauthState: string): void {
  reservedAuthStates.delete(oauthState);
  const pending = pendingAuths.get(oauthState);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingAuths.delete(oauthState);
    pending.reject(new Error("Authorization cancelled"));
  }
}

export async function stopCallbackServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
    server = undefined;
  }

  setOAuthCallbackPort(getConfiguredOAuthCallbackPort());
  callbackServerHost = DEFAULT_OAUTH_CALLBACK_HOST;
  setOAuthCallbackPath(DEFAULT_OAUTH_CALLBACK_PATH);

  const pendingList = Array.from(pendingAuths.entries());
  pendingAuths.clear();
  reservedAuthStates.clear();
  for (const [, pending] of pendingList) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("OAuth callback server stopped"));
  }
}

export function isCallbackServerRunning(): boolean {
  return server !== undefined;
}

export function getPendingAuthCount(): number {
  return pendingAuths.size;
}
