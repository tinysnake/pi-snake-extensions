/**
 * /mcp-list overlay panel — user-only MCP server status readout.
 *
 * Rendered via ctx.ui.custom({ overlay: true }) as a floating panel, globally
 * centered (footer/header heights are dynamic, so a fixed edge anchor would
 * misplace it). The content is display-only: it is never written into the
 * session and never participates in LLM context.
 *
 * Layout contract (per design decisions):
 * - one row per server, truncated to fit the panel width (no wrapping)
 * - full detail always shown (status, tool count, auth, error)
 * - Esc closes the panel; the panel shows a key hint
 */

import { Box, TruncatedText, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** One server's state within a /mcp-list snapshot. */
export interface McpListServer {
  name: string;
  status: "connected" | "unreachable";
  error?: string;
  /** Number of tools loaded via mcp_load (undefined = never loaded). */
  toolCount?: number;
  /** Auth status, when previously checked via /mcp-auth actions. */
  auth?: "authenticated" | "expired" | "not_authenticated";
}

/** Snapshot payload shown by the /mcp-list panel. */
export interface McpListSnapshot {
  /** Epoch ms when the snapshot was captured. */
  at: number;
  /** False while background discovery is still probing — show cache as-is. */
  discoveryComplete: boolean;
  servers: McpListServer[];
}

/** Empty-state line while background discovery is still in flight. */
export const DISCOVERING_LINE =
  "Still discovering servers… run /mcp-list again in a moment.";
/** Empty-state line after discovery found nothing configured. */
export const NONE_CONFIGURED_LINE = "No MCP servers configured.";

/**
 * Build the styled display lines for the panel.
 *
 * `hint` is injected (normally "Esc close", styled by the caller) so tests can
 * pass a plain string; the rest of the styling goes through `theme`.
 */
export function buildMcpServersPanelLines(
  snapshot: McpListSnapshot,
  theme: Theme,
  hint: string,
): string[] {
  const lines: string[] = [];

  if (snapshot.servers.length === 0) {
    const empty = snapshot.discoveryComplete ? NONE_CONFIGURED_LINE : DISCOVERING_LINE;
    lines.push(theme.bold(`🔌 MCP servers — ${empty}`));
  } else {
    const available = snapshot.servers.filter((s) => s.status === "connected").length;
    const time = snapshot.at ? ` · ${new Date(snapshot.at).toLocaleTimeString()}` : "";
    lines.push(
      theme.bold(`🔌 MCP servers — ${available}/${snapshot.servers.length} available${time}`),
    );
    for (const s of snapshot.servers) {
      if (s.status === "connected") {
        const meta: string[] = [];
        meta.push(
          s.toolCount !== undefined ? `${s.toolCount} tool(s) loaded` : "tools not loaded",
        );
        if (s.auth === "authenticated") meta.push("authenticated");
        else if (s.auth === "expired") meta.push("auth expired");
        const metaText = meta.length > 0 ? ` · ${theme.fg("dim", meta.join(" · "))}` : "";
        lines.push(`  ${theme.fg("success", "✓")} ${s.name}${metaText}`);
      } else {
        const err = s.error ? ` — ${theme.fg("warning", s.error)}` : "";
        lines.push(`  ${theme.fg("error", "✗")} ${s.name}${err}`);
      }
    }
  }

  lines.push(theme.fg("dim", hint));
  return lines;
}

/**
 * Build the overlay panel component: a Box (customMessageBg background) holding
 * one TruncatedText row per line. Esc closes via `onClose`; once the overlay is
 * focused (onHandle.focus()), `handleInput` keeps input ownership off the editor.
 */
export function buildMcpServersPanel(
  snapshot: McpListSnapshot,
  theme: Theme,
  onClose: () => void,
): Component {
  // Format the close hint from the injected theme directly — the global theme
  // singleton (used by rawKeyHint) is not initialized in tests/headless runs.
  const hint = `${theme.fg("dim", "Esc")}${theme.fg("muted", " close")}`;
  const lines = buildMcpServersPanelLines(snapshot, theme, hint);
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  for (const line of lines) box.addChild(new TruncatedText(line, 0, 0));
  return {
    render: (width: number) => box.render(width),
    invalidate: () => box.invalidate(),
    handleInput: (data: string) => {
      if (matchesKey(data, "escape")) onClose();
    },
  };
}