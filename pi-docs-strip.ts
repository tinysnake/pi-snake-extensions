import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

/**
 * Global extension to control Pi documentation in system prompt.
 *
 * Default: Pi documentation section is STRIPPED from the system prompt.
 *
 * Opt OUT of stripping (i.e. KEEP the docs) via either mechanism:
 *  1. Marker file: create `<project>/.pi/pi-enable-docs` (empty file is fine).
 *     Walked up from cwd, so a repo-root marker covers every subfolder.
 *  2. Environment variable: set `PI_ENABLE_DOCS=1` (or `true`/`yes`/`on`).
 *     Cheapest option — no filesystem change needed, applies process-wide.
 *
 * How the block is located
 * ------------------------
 * Pi renders its documentation as a named system-prompt section, so the
 * assembled prompt literally contains `\n<docs>\n…doctext…\n</docs>`. We strip
 * that whole section straight from the rendered prompt. This survives Pi
 * rewording the docs, changing the resolved paths, or shipping a bundled build
 * (no source file to read). A hardcoded regex matching the current wording is
 * kept as a fallback for the (unlikely) case where the `<docs>` wrapper changes.
 */
export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    // Short-circuit: if a marker file or env flag opts docs in, leave untouched
    if (piDocsEnabled(ctx.cwd) || piDocsEnabledEnv()) return;

    const cleaned = stripPiDocs(event.systemPrompt);
    if (cleaned === event.systemPrompt) return; // nothing matched, no-op

    return { systemPrompt: cleaned };
  });
}

/**
 * Remove the Pi documentation block, returning the prompt unchanged if nothing
 * matched:
 *  1. The rendered `<docs>…</docs>` section from the live prompt (primary).
 *  2. A hardcoded regex matching the current wording (fallback).
 */
function stripPiDocs(prompt: string): string {
  for (const re of STRIP_REGEXES) {
    const cleaned = prompt.replace(re, "");
    if (cleaned !== prompt) return cleaned;
  }
  return prompt;
}

const STRIP_REGEXES: RegExp[] = [
  // Primary: the whole <docs> section Pi renders into the prompt.
  /\n<docs>[\s\S]*?<\/docs>/,
  // Fallback: current wording, in case Pi ever drops the <docs> wrapper.
  /\nPi documentation \(read only when the user asks about pi itself[\s\S]*?tui\.md for TUI API details\)/,
];

/* ------------------------------------------------------------------ *
 * Opt-out detectors
 * ------------------------------------------------------------------ */

/** Walk up from `cwd` looking for `.pi/pi-enable-docs` */
function piDocsEnabled(cwd: string): boolean {
  let dir = path.resolve(cwd);
  const { root } = path.parse(dir);

  while (true) {
    const marker = path.join(dir, ".pi", "pi-enable-docs");
    try {
      if (fs.statSync(marker).isFile()) return true;
    } catch {
      // file doesn't exist or can't access — continue climbing
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return false;
}

/**
 * True when `PI_ENABLE_DOCS` is set to an affirmative value.
 * Accepts "1", "true", "yes", "on" (case-insensitive). Any other value
 * (including "0"/"false") means docs stay stripped (the default).
 */
function piDocsEnabledEnv(): boolean {
  const raw = process.env.PI_ENABLE_DOCS;
  if (!raw) return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}
