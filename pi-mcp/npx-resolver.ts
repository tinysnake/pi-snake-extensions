/**
 * npx-resolver.ts — Resolve npx/npm exec commands to direct binary paths.
 *
 * When a server is configured as `npx @modelcontextprotocol/server-foo`,
 * we resolve it to the cached npm binary path so we can spawn it directly
 * instead of going through an npm parent process (which adds latency and
 * a noisy stderr stream).
 *
 * Adapted from pi-mcp-adapter's npx-resolver.ts.
 */

import { existsSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname, extname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_VERSION = 1;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface NpxCacheEntry {
  resolvedBin: string;
  resolvedAt: number;
  packageVersion?: string;
  isJs: boolean;
}

interface NpxCache {
  version: number;
  entries: Record<string, NpxCacheEntry>;
}

export interface NpxResolution {
  binPath: string;
  extraArgs: string[];
  isJs: boolean;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Given a `command` and its `args`, determine if this is an npx/npm exec
 * invocation and resolve it to the cached binary path.
 *
 * Returns null if the command is not npx/npm or if resolution fails
 * (the caller should fall back to running the original command as-is).
 */
export async function resolveNpxBinary(command: string, args: string[]): Promise<NpxResolution | null> {
  const parsed = command === "npx"
    ? parseNpxArgs(args)
    : command === "npm"
      ? parseNpmExecArgs(args)
      : null;

  if (!parsed) return null;

  const cacheKey = JSON.stringify([command, ...args]);
  const cache = loadCache();
  const cached = cache?.entries?.[cacheKey];

  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS && existsSync(cached.resolvedBin)) {
    return { binPath: cached.resolvedBin, extraArgs: parsed.extraArgs, isJs: cached.isJs };
  }

  const resolved = resolveFromNpmCache(parsed.packageSpec, parsed.binName);
  if (resolved) {
    saveCacheEntry(cacheKey, resolved);
    return { binPath: resolved.resolvedBin, extraArgs: parsed.extraArgs, isJs: resolved.isJs };
  }

  // Slow path: force npx cache population by running npm exec once
  await forceNpxCache(parsed.packageSpec);
  const resolvedAfterInstall = resolveFromNpmCache(parsed.packageSpec, parsed.binName);
  if (resolvedAfterInstall) {
    saveCacheEntry(cacheKey, resolvedAfterInstall);
    return { binPath: resolvedAfterInstall.resolvedBin, extraArgs: parsed.extraArgs, isJs: resolvedAfterInstall.isJs };
  }

  return null;
}

// ── Parsing ────────────────────────────────────────────────────────────────────

interface ParsedInvocation {
  packageSpec: string;
  binName?: string;
  extraArgs: string[];
}

function parseNpxArgs(args: string[]): ParsedInvocation | null {
  const separatorIndex = args.indexOf("--");
  const before = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
  const after = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];

  const positionals: string[] = [];
  let packageSpec: string | undefined;
  let sawPackageFlag = false;
  let foundFirstPositional = false;

  for (let i = 0; i < before.length; i++) {
    const arg = before[i];
    if (foundFirstPositional) { positionals.push(arg); continue; }
    if (arg === "-y" || arg === "--yes") continue;
    if (arg === "-p" || arg === "--package") {
      const value = before[i + 1];
      if (!value || value.startsWith("-")) return null;
      if (!packageSpec) packageSpec = value;
      sawPackageFlag = true;
      i++;
      continue;
    }
    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length);
      if (!value) return null;
      if (!packageSpec) packageSpec = value;
      sawPackageFlag = true;
      continue;
    }
    if (arg.startsWith("-")) return null;
    positionals.push(arg);
    foundFirstPositional = true;
  }

  const separatedAfter = separatorIndex >= 0 && after.length > 0 ? ["--", ...after] : after;

  if (sawPackageFlag) {
    const binName = positionals[0];
    if (!packageSpec || !binName) return null;
    return { packageSpec, binName, extraArgs: positionals.slice(1).concat(separatedAfter) };
  }

  const pkg = positionals[0];
  if (!pkg) return null;
  return { packageSpec: pkg, extraArgs: positionals.slice(1).concat(separatedAfter) };
}

function parseNpmExecArgs(args: string[]): ParsedInvocation | null {
  if (args[0] !== "exec") return null;
  const execArgs = args.slice(1);
  const separatorIndex = execArgs.indexOf("--");
  if (separatorIndex < 0) return null;

  const before = execArgs.slice(0, separatorIndex);
  const after = execArgs.slice(separatorIndex + 1);

  let packageSpec: string | undefined;
  for (let i = 0; i < before.length; i++) {
    const arg = before[i];
    if (arg === "-y" || arg === "--yes") continue;
    if (arg === "--package") {
      const value = before[i + 1];
      if (!value || value.startsWith("-")) return null;
      if (!packageSpec) packageSpec = value;
      i++;
      continue;
    }
    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length);
      if (!value) return null;
      if (!packageSpec) packageSpec = value;
      continue;
    }
    if (arg.startsWith("-")) return null;
  }

  const binName = after[0];
  if (!packageSpec || !binName) return null;
  return { packageSpec, binName, extraArgs: after.slice(1) };
}

// ── Cache resolution ───────────────────────────────────────────────────────────

function resolveFromNpmCache(packageSpec: string, binName?: string): NpxCacheEntry | null {
  const cacheDir = getNpmCacheDir();
  if (!cacheDir) return null;

  const packageName = extractPackageName(packageSpec);
  if (!packageName) return null;

  const packageDir = findCachedPackageDir(cacheDir, packageName);
  if (!packageDir) return null;

  const pkgJsonPath = join(packageDir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;

  let pkg: { bin?: string | Record<string, string>; version?: string } | null = null;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch { return null; }

  const binField = pkg?.bin;
  if (!binField) return null;

  const candidates = buildBinCandidates(packageName, binName);
  let chosenBinName: string | undefined;
  let binRel: string | undefined;

  if (typeof binField === "string") {
    chosenBinName = defaultBinName(packageName);
    binRel = binField;
  } else {
    for (const candidate of candidates) {
      if (binField[candidate]) { chosenBinName = candidate; binRel = binField[candidate]; break; }
    }
    if (!binRel) {
      const first = Object.entries(binField)[0];
      if (first) { chosenBinName = first[0]; binRel = first[1]; }
    }
  }

  if (!binRel) return null;

  const nodeModulesDir = findNodeModulesDir(packageDir);
  const binLink = chosenBinName ? join(nodeModulesDir, ".bin", chosenBinName) : null;
  let resolvedBin = binLink && existsSync(binLink) ? safeRealpath(binLink) : "";
  if (!resolvedBin) {
    resolvedBin = resolve(packageDir, binRel);
    if (!existsSync(resolvedBin)) return null;
  }

  return { resolvedBin, resolvedAt: Date.now(), packageVersion: pkg?.version, isJs: detectJsBinary(resolvedBin) };
}

// ── npm cache helpers ──────────────────────────────────────────────────────────

let npmCacheDirCached: string | null | undefined;

function getNpmCacheDir(): string | null {
  if (npmCacheDirCached !== undefined) return npmCacheDirCached;
  if (process.env.NPM_CONFIG_CACHE) {
    npmCacheDirCached = process.env.NPM_CONFIG_CACHE;
    return npmCacheDirCached;
  }
  try {
    const result = spawnSync("npm", ["config", "get", "cache"], { encoding: "utf-8", timeout: 10000 });
    if (result.status === 0) {
      const path = String(result.stdout).trim();
      npmCacheDirCached = path || null;
      return npmCacheDirCached;
    }
  } catch { /* fallback */ }
  npmCacheDirCached = null;
  return null;
}

function findCachedPackageDir(cacheDir: string, packageName: string): string | null {
  const npxDir = join(cacheDir, "_npx");
  if (!existsSync(npxDir)) return null;

  const pkgPathParts = packageName.startsWith("@") ? packageName.split("/") : [packageName];
  const entries = readdirSync(npxDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({ name: e.name, mtime: safeStatMtime(join(npxDir, e.name)) }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const entry of entries) {
    const pkgDir = join(npxDir, entry.name, "node_modules", ...pkgPathParts);
    if (existsSync(join(pkgDir, "package.json"))) return pkgDir;
  }
  return null;
}

// ── Package helpers ────────────────────────────────────────────────────────────

function buildBinCandidates(packageName: string, explicitBin?: string): string[] {
  const candidates: string[] = [];
  if (explicitBin) candidates.push(explicitBin);
  if (packageName.startsWith("@")) {
    const namePart = packageName.split("/")[1] ?? "";
    const scopePart = packageName.split("/")[0]?.replace("@", "") ?? "";
    if (namePart) candidates.push(namePart);
    if (scopePart && namePart) candidates.push(`${scopePart}-${namePart}`);
  } else {
    candidates.push(packageName);
  }
  return [...new Set(candidates.filter(Boolean))];
}

function extractPackageName(spec: string): string | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("@")) {
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx < 0) return null;
    const atIdx = trimmed.lastIndexOf("@");
    return atIdx > slashIdx ? trimmed.slice(0, atIdx) : trimmed;
  }
  const atIdx = trimmed.indexOf("@");
  return atIdx >= 0 ? trimmed.slice(0, atIdx) : trimmed;
}

function defaultBinName(packageName: string): string {
  if (packageName.startsWith("@")) {
    const parts = packageName.split("/");
    return parts[1] ?? packageName.replace("@", "").replace("/", "-");
  }
  return packageName;
}

function findNodeModulesDir(packageDir: string): string {
  const parts = packageDir.split(sep);
  const idx = parts.lastIndexOf("node_modules");
  return idx >= 0 ? parts.slice(0, idx + 1).join(sep) : join(packageDir, "..");
}

function detectJsBinary(binPath: string): boolean {
  const ext = extname(binPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return true;
  try {
    const buf = new Uint8Array(256);
    const fd = (process as any).binding("fs").open(binPath, 0, 0o666);
    (process as any).binding("fs").read(fd, buf, 0, 256, 0);
    (process as any).binding("fs").close(fd);
    const firstLine = new TextDecoder().decode(buf).split("\n")[0] ?? "";
    return firstLine.startsWith("#!") && firstLine.includes("node");
  } catch { return false; }
}

// ── Force cache ────────────────────────────────────────────────────────────────

const FORCE_CACHE_TIMEOUT_MS = 30_000;

async function forceNpxCache(packageSpec: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const { spawn } = require("node:child_process") as typeof import("node:child_process");
      const proc = spawn("npm", ["exec", "--yes", "--package", packageSpec, "--", "node", "-e", "1"], { stdio: "ignore" });
      const timer = setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, FORCE_CACHE_TIMEOUT_MS);
      if (typeof (timer as any)?.unref === "function") (timer as any).unref();
      proc.on("close", () => { clearTimeout(timer); resolve(); });
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  } catch { /* Ignore failures — caller will fall back to original command */ }
}

// ── Persistence ────────────────────────────────────────────────────────────────

function cachePath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(dir, "mcp-npx-cache.json");
}

function loadCache(): NpxCache | null {
  try {
    if (!existsSync(cachePath())) return null;
    const raw = JSON.parse(readFileSync(cachePath(), "utf-8"));
    if (!raw || typeof raw !== "object" || raw.version !== CACHE_VERSION || !raw.entries) return null;
    return raw as NpxCache;
  } catch { return null; }
}

function saveCacheEntry(key: string, entry: NpxCacheEntry): void {
  const path = cachePath();
  mkdirSync(dirname(path), { recursive: true });
  let merged: NpxCache = { version: CACHE_VERSION, entries: {} };
  try {
    if (existsSync(path)) {
      const existing = JSON.parse(readFileSync(path, "utf-8")) as NpxCache;
      if (existing?.version === CACHE_VERSION && existing.entries) merged.entries = { ...existing.entries };
    }
  } catch { /* ignore */ }
  merged.entries[key] = entry;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf-8");
  renameSync(tmp, path);
}

// ── Misc ───────────────────────────────────────────────────────────────────────

function safeRealpath(p: string): string {
  try { return realpathSync(p); } catch { return ""; }
}
function safeStatMtime(p: string): number {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}
