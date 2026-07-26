/**
 * Utility functions for the pi-mcp extension: MCP output truncation, tool list
 * formatting, error hinting, and TUI rendering for tool call/result display.
 *
 * This module is pure presentation — no MCP I/O, no SDK, no CLI. Ported from the
 * pi-mcporter extension's utils.ts, with all mcporter CLI wrappers removed.
 */

import { Container, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ── types ────────────────────────────────────────────────────────────────────
export interface McpToolSchema {
  type?: string;
  properties?: Record<
    string,
    {
      type?: string;
      description?: string;
      enum?: string[];
      default?: unknown;
      anyOf?: Array<{ type?: string; items?: Record<string, unknown> }>;
      [key: string]: unknown;
    }
  >;
  required?: string[];
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: McpToolSchema;
}

export interface McpServer {
  name: string;
  status?: string;
  transport?: string;
  /** Populated when the server reports a non-ok status. */
  error?: string;
  tools: McpTool[];
}

export interface McpErrorHint {
  text: string;
  isValidationError: boolean;
}

export interface TruncationResult {
  content: string;
  truncated: boolean;
  outputLines: number;
  totalLines: number;
  outputBytes: number;
  totalBytes: number;
}

// ── truncation helper ────────────────────────────────────────────────────────
export function truncateOutput(text: string, maxLines = 2000, maxBytes = 50 * 1024): TruncationResult {
  const totalBytes = Buffer.byteLength(text, "utf-8");
  const totalLines = text.split("\n").length;

  if (totalBytes <= maxBytes && totalLines <= maxLines) {
    return { content: text, truncated: false, outputLines: totalLines, totalLines, outputBytes: totalBytes, totalBytes };
  }

  // Truncate by lines first
  const lines = text.split("\n");
  const truncatedLines = lines.slice(0, maxLines);
  let content = truncatedLines.join("\n");

  // Then by bytes
  const buf = Buffer.from(content, "utf-8");
  if (buf.length > maxBytes) {
    content = buf.slice(0, maxBytes).toString("utf-8");
    // Strip replacement characters introduced by multi-byte splits
    content = content.replace(/\uFFFD/g, "");
  }

  const outputBytes = Buffer.byteLength(content, "utf-8");
  return { content, truncated: true, outputLines: truncatedLines.length, totalLines, outputBytes, totalBytes };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── format type for display ──────────────────────────────────────────────────
function describeType(prop: Record<string, unknown>): string {
  if (typeof prop.type === "string") return prop.type;
  if (Array.isArray(prop.anyOf)) {
    return prop.anyOf.map((a: Record<string, unknown>) => (a.type as string) ?? "any").join("|");
  }
  if (Array.isArray(prop.enum)) return "enum";
  return "any";
}

// ── format tool list for LLM ─────────────────────────────────────────────────
export function formatToolList(servers: McpServer[], serverFilter?: string, mode: "overview" | "detail" = "overview"): string {
  const filtered = serverFilter ? servers.filter((s) => s.name === serverFilter) : servers;

  if (serverFilter && filtered.length === 0) {
    const available = servers.map((s) => s.name).join(", ");
    return `No MCP server found named "${serverFilter}". Available: ${available || "none"}.`;
  }

  if (filtered.length === 0) {
    return "No MCP servers configured.";
  }

  const parts: string[] = [];

  for (const server of filtered) {
    parts.push(`## ${server.name}`);
    if (server.tools.length === 0) {
      parts.push("  (no tools)");
      continue;
    }
    for (const tool of server.tools) {
      parts.push(`### ${server.name}.${tool.name}`);
      if (tool.description) {
        // Show only the first paragraph
        const firstPara = tool.description.split("\n\n")[0].split("\n")[0];
        parts.push(`  ${firstPara}`);
      }
      // Only show parameter details in detail mode
      if (mode === "detail" && tool.inputSchema?.properties) {
        const props = tool.inputSchema.properties;
        const required = tool.inputSchema.required ?? [];
        for (const [pname, pval] of Object.entries(props)) {
          const typeLabel = describeType(pval);
          const reqLabel = required.includes(pname) ? "required" : "optional";
          let line = `    ${pname}: ${typeLabel} (${reqLabel})`;
          if (pval.description) {
            const desc = pval.description.split("\n")[0];
            line += ` — ${desc}`;
          }
          if (pval.enum) {
            line += ` [${pval.enum.join(", ")}]`;
          }
          parts.push(line);
        }
      }
    }
  }

  return parts.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TUI rendering helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format a pi-mcp tool call for TUI display.
 * mcp_call: ▶ params (inline compact JSON) if it fits terminal width,
 * ▼ params (prettified multi-line) otherwise.
 */
export function formatMcpCall(
  toolName: string,
  args: Record<string, unknown>,
  theme: any,
): string {
  let text = theme.fg("toolTitle", theme.bold(toolName));

  switch (toolName) {
    case "mcp_load": {
      const server = args.server as string | undefined;
      if (server) text += ` ${theme.fg("accent", server)}`;
      break;
    }
    case "mcp_call": {
      const selector = (args.selector as string) ?? "";
      text += ` ${theme.fg("accent", selector)}`;
      if (args.args !== undefined && args.args !== null) {
        let parsed: unknown;
        if (typeof args.args === "string") {
          try {
            parsed = JSON.parse(args.args);
          } catch {
            parsed = args.args;
          }
        } else {
          parsed = args.args;
        }

        if (typeof parsed === "string") {
          // Not valid JSON — ▶ (sent as-is)
          text += `\n\n${theme.fg("toolTitle", "\u25B6 params")}  ${theme.fg("dim", parsed)}`;
        } else {
          const compact = JSON.stringify(parsed);
          // Dynamic terminal width: measure remaining space on the params line
          const termWidth = process.stdout.columns ?? 80;
          const labelLen = "\u25B6 params  ".length; // ▶ and ▼ are same width
          if (labelLen + compact.length <= termWidth) {
            // Short: ▶ inline (sent as-is)
            text += `\n\n${theme.fg("toolTitle", "\u25B6 params")}  ${theme.fg("dim", compact)}`;
          } else {
            // Long: ▼ expanded (prettified multi-line)
            const pretty = JSON.stringify(parsed, null, 2);
            text += `\n\n${theme.fg("toolTitle", "\u25BC params")}\n${theme.fg("dim", pretty)}`;
          }
        }
      } else {
        // No args, default to ▶
        text += `\n\n${theme.fg("toolTitle", "\u25B6 params")}`;
      }
      break;
    }
    case "mcp_refresh":
      break;
  }

  return text;
}

/**
 * Format a pi-mcp tool result summary prefix for TUI display.
 */
export function formatMcpResult(
  toolName: string,
  meta: Record<string, unknown> | undefined,
  theme: any,
): string {
  if (!meta) return theme.fg("success", "\u2713 done");

  switch (toolName) {
    case "mcp_load": {
      const servers = (meta.serverCount as number) ?? 0;
      const tools = (meta.toolCount as number) ?? 0;
      return theme.fg(
        "success",
        `\u2713 mcp_load \u2014 ${servers} server${servers !== 1 ? "s" : ""}, ${tools} tool${tools !== 1 ? "s" : ""}`,
      );
    }
    case "mcp_call": {
      const selector = (meta.selector as string) ?? "";
      return theme.fg("success", `\u2713 mcp_call \u2014 ${selector} (completed)`);
    }
    case "mcp_refresh": {
      const count = (meta.serverCount as number) ?? 0;
      return theme.fg(
        "success",
        `\u2713 mcp_refresh \u2014 ${count} server${count !== 1 ? "s" : ""} refreshed`,
      );
    }
  }

  return theme.fg("success", `\u2713 ${toolName}`);
}

/**
 * Format a pi-mcp tool partial result for TUI display (in-progress state).
 */
export function formatMcpPartialResult(
  _toolName: string,
  _args: Record<string, unknown>,
  theme: any,
): string {
  return theme.fg("dim", `  \u23F3 processing...`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bash-Style Result Container (collapse/expand + timing)
// ═══════════════════════════════════════════════════════════════════════════════

const PREVIEW_LINES = 20;

/**
 * Container with caching state for bash-style result rendering.
 * Supports preview truncation with expand hint, full output path footer,
 * and live duration display.
 */
export class ToolResultContainer extends Container {
  state: {
    cachedWidth?: number;
    cachedLines?: string[];
    cachedSkipped?: number;
  } = {};
}

/**
 * Rebuild a bash-style result container for pi-mcp tools.
 * Shows an optional resultLabel (e.g. "▼ result") with toolTitle color,
 * a preview with "... (N lines, ctrl+o to expand)" hint when content
 * exceeds PREVIEW_LINES, a [Full output: /path] footer when a temp file
 * was saved to disk, and a duration line (Elapsed/Took).
 */
export function rebuildToolResultContainer(
  container: ToolResultContainer,
  result: { content?: { type: string; text: string }[]; details?: Record<string, unknown> },
  options: { isPartial?: boolean; expanded?: boolean },
  theme: any,
  startedAt?: number,
  endedAt?: number,
  resultLabel?: string,
): void {
  const state = container.state;
  container.clear();

  // Optional result label (e.g. "▼ result") with toolTitle color
  if (resultLabel) {
    container.addChild(new Text(theme.fg("toolTitle", resultLabel), 0, 0));
  }

  // Extract raw output text from result content
  const outputText = (result.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n")
    .trim();

  if (!outputText) return;

  const allLines = outputText.split("\n");
  const styledLines = allLines.map((l: string) => theme.fg("toolOutput", l));

  // Use custom render for both collapsed and expanded views
  container.addChild({
    render: (width: number) => {
      if (state.cachedLines === undefined || state.cachedWidth !== width) {
        // Word-wrap each line to available width (properly handles ANSI codes)
        const wrappedLines: string[] = [];
        for (const line of styledLines) {
          const wrapped = wrapTextWithAnsi(line, width);
          wrappedLines.push(...wrapped);
        }

        const preview = wrappedLines.slice(0, options.expanded ? wrappedLines.length : PREVIEW_LINES);
        const totalWrapped = wrappedLines.length;
        const skipped = Math.max(0, totalWrapped - PREVIEW_LINES);
        state.cachedLines = preview;
        state.cachedSkipped = skipped;
        state.cachedWidth = width;
      }

      // Blank first line for spacing unless resultLabel already provides it
      const lines: string[] = resultLabel ? [] : [""];
      lines.push(...(state.cachedLines ?? []));

      // Show expand hint after preview content (collapsed mode only)
      if (!options.expanded && state.cachedSkipped && state.cachedSkipped > 0) {
        const hint = theme.fg("muted", `... (${state.cachedSkipped} lines, ctrl+o to expand)`);
        lines.push(truncateToWidth(hint, width, "..."));
      }
      return lines;
    },
    invalidate: () => {
      state.cachedWidth = undefined;
      state.cachedLines = undefined;
      state.cachedSkipped = undefined;
    },
  });

  // Footer: full output path (when content was saved to disk)
  const tempFile = result.details?.tempFilePath as string | undefined;
  if (tempFile) {
    container.addChild(
      new Text(`\n${theme.fg("warning", `[Full output: ${tempFile}]`)}`, 0, 0),
    );
  }

  // Footer: duration
  if (startedAt !== undefined) {
    const label = options.isPartial ? "Elapsed" : "Took";
    const end = endedAt ?? Date.now();
    const duration = ((end - startedAt) / 1000).toFixed(1);
    container.addChild(
      new Text(`\n${theme.fg("muted", `${label} ${duration}s`)}`, 0, 0),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Intelligent error hint builder
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build an actionable error message from an MCP tool error string.
 * Detects common error patterns and adds hints for the agent to self-correct.
 */
export function buildMcpErrorHint(
  rawText: string,
  serverName: string,
  toolName: string,
): McpErrorHint {
  const lines = rawText.split("\n");

  // ── Pattern 1: Unknown tool ──────────────────────────────────────────────
  const unknownToolMatch = rawText.match(/^Unknown tool: '(.+)'$/);
  if (unknownToolMatch) {
    const badTool = unknownToolMatch[1];
    return {
      text: [
        `Unknown tool '${badTool}' on server '${serverName}'.`,
        `Use \`mcp_load ${serverName}\` to see available tools with full parameter schemas.`,
      ].join("\n"),
      isValidationError: false,
    };
  }

  // ── Pattern 2: Validation errors (pydantic style from mcp-for-unity) ───
  const validationMatch = rawText.match(/(\d+) validation errors? for call\[(\w+)\]/);
  if (validationMatch) {
    const paramName = lines.length >= 2 ? lines[1].trim() : "";
    const errorDetail = lines.length >= 3 ? lines.slice(2).filter(Boolean).join(" ").trim() : rawText;

    // Missing required argument
    if (errorDetail.includes("Missing required argument")) {
      return {
        text: [
          `Missing required argument '${paramName}' for '${serverName}.${toolName}'.`,
          `Pass the required parameter '${paramName}'.`,
          `Use \`mcp_load ${serverName}\` to check all parameter schemas.`,
        ].join("\n"),
        isValidationError: true,
      };
    }

    // Input should be a valid <type> (type mismatch)
    const typeMatch = errorDetail.match(/Input should be a valid (\w+)/);
    if (typeMatch) {
      const expectedType = typeMatch[1];
      return {
        text: [
          `Parameter '${paramName}' for '${serverName}.${toolName}' expects type '${expectedType}'.`,
          `Fix the value of '${paramName}' to be a valid ${expectedType}.`,
          `Use \`mcp_load ${serverName}\` to check parameter schemas.`,
        ].join("\n"),
        isValidationError: true,
      };
    }

    // Enum/literal error: Input should be 'a', 'b' or 'c'
    const enumMatch = errorDetail.match(/Input should be /);
    if (enumMatch) {
      const enumPortion = errorDetail.match(/Input should be (.+?)(?:\s*\[|$)/);
      if (enumPortion) {
        const enumValues = enumPortion[1].match(/'([^']+)'/g)?.map((v) => v.replace(/'/g, "")) ?? [];
        if (enumValues.length > 0) {
          return {
            text: [
              `Parameter '${paramName}' for '${serverName}.${toolName}' expects one of: ${enumValues.join(", ")}.`,
              `Use \`mcp_load ${serverName}\` to check parameter schemas.`,
            ].join("\n"),
            isValidationError: true,
          };
        }
      }
    }

    // Generic validation error
    return {
      text: [
        `Validation error for '${serverName}.${toolName}': ${errorDetail}`,
        `Use \`mcp_load ${serverName}\` to check parameter schemas.`,
      ].join("\n"),
      isValidationError: true,
    };
  }

  // ── Pattern 3: Generic error text ──────────────────────────────────────
  if (rawText) {
    return {
      text: [
        `${rawText}`,
        `Use \`mcp_load <server>\` to load tool schemas before calling mcp_call.`,
      ].join("\n"),
      isValidationError: false,
    };
  }

  // ── Fallback ─────────────────────────────────────────────────────────────
  return {
    text: `Call to '${serverName}.${toolName}' failed. Use \`mcp_load ${serverName}\` to load tool schemas, then retry.`,
    isValidationError: false,
  };
}

// ── format tool parameter schema snippet ──────────────────────────────────────

/**
 * Format a tool's parameter schema as a compact mini-list for embedding in
 * mcp_call error messages.
 */
export function formatSchemaSnippet(tool: McpTool): string {
  const props = tool.inputSchema?.properties;
  if (!props || Object.keys(props).length === 0) {
    return `Expected parameters:\n  (no parameters required)`;
  }
  const required = tool.inputSchema!.required ?? [];
  const lines: string[] = ["Expected parameters:"];
  for (const [pname, pval] of Object.entries(props)) {
    const typeLabel = describeType(pval);
    const reqLabel = required.includes(pname) ? "required" : "optional";
    let line = `  - ${pname}: ${typeLabel} (${reqLabel})`;
    if (pval.description) {
      const desc = pval.description.split("\n")[0];
      line += ` — ${desc}`;
    }
    if (pval.enum) {
      line += ` [enum: ${pval.enum.join(", ")}]`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}