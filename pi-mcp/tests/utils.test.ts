/**
 * utils test — shape contracts for pure display/formatting helpers (seam B).
 * Ported from pi-mcporter's utils.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMcpErrorHint,
  formatSchemaSnippet,
  truncateOutput,
  formatSize,
  formatToolList,
  type McpTool,
} from "../utils.ts";

// ── helpers ──────────────────────────────────────────────────────────────────
function makeTool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: "test_tool",
    description: "A test tool",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name parameter" },
        count: { type: "integer", description: "The count parameter" },
        flag: { type: "boolean", description: "A boolean flag" },
      },
      required: ["name", "count"],
    },
    ...overrides,
  };
}

// ── truncateOutput ───────────────────────────────────────────────────────────
test("truncateOutput returns content unchanged when within limits", () => {
  const r = truncateOutput("hello\nworld");
  assert.equal(r.truncated, false);
  assert.equal(r.content, "hello\nworld");
  assert.equal(r.totalLines, 2);
});

test("truncateOutput truncates long text by lines", () => {
  const big = Array(3000).fill("line").join("\n");
  const r = truncateOutput(big);
  assert.equal(r.truncated, true);
  assert.ok(r.outputLines <= 2000);
  assert.equal(r.totalLines, 3000);
});

// ── formatSize ───────────────────────────────────────────────────────────────
test("formatSize formats bytes compactly", () => {
  assert.equal(formatSize(0), "0B");
  assert.equal(formatSize(512), "512B");
  assert.ok(formatSize(2048).endsWith("KB"));
  assert.ok(formatSize(2 * 1024 * 1024).endsWith("MB"));
});

// ── formatToolList ────────────────────────────────────────────────────────────
test("formatToolList detail mode lists tools with parameter schemas", () => {
  const text = formatToolList(
    [{ name: "svc", tools: [makeTool()] }],
    undefined,
    "detail",
  );
  assert.match(text, /## svc/);
  assert.match(text, /### svc\.test_tool/);
  assert.match(text, /name: string \(required\)/);
  assert.match(text, /flag: boolean \(optional\)/);
});

test("formatToolList returns not-found message for unknown server filter", () => {
  const text = formatToolList([{ name: "svc", tools: [makeTool()] }], "missing");
  assert.match(text, /No MCP server found named "missing"/);
  assert.match(text, /Available: svc/);
});

test("formatToolList returns empty message when no servers configured", () => {
  assert.equal(formatToolList([]), "No MCP servers configured.");
});

// ── buildMcpErrorHint ──────────────────────────────────────────────────────────
test("buildMcpErrorHint - unknown tool", () => {
  const hint = buildMcpErrorHint("Unknown tool: 'nonexistent_tool'", "my-server", "nonexistent_tool");
  assert.equal(hint.isValidationError, false);
  assert.match(hint.text, /Unknown tool/);
  assert.match(hint.text, /mcp_load/);
});

test("buildMcpErrorHint - missing required argument", () => {
  const hint = buildMcpErrorHint(
    "1 validation error for call[test_tool]\n  name\n    Missing required argument [type=missing, input_value=null, input_type=null]",
    "my-server",
    "test_tool",
  );
  assert.equal(hint.isValidationError, true);
  assert.match(hint.text, /Missing required argument 'name'/);
});

test("buildMcpErrorHint - type mismatch", () => {
  const hint = buildMcpErrorHint(
    "1 validation error for call[test_tool]\n  count\n    Input should be a valid integer [type=int_type]",
    "my-server",
    "test_tool",
  );
  assert.equal(hint.isValidationError, true);
  assert.match(hint.text, /expects type 'integer'/);
});

test("buildMcpErrorHint - enum mismatch", () => {
  const hint = buildMcpErrorHint(
    "1 validation error for call[test_tool]\n  mode\n    Input should be 'a', 'b' or 'c' [type=enum]",
    "my-server",
    "test_tool",
  );
  assert.equal(hint.isValidationError, true);
  assert.match(hint.text, /one of: a, b, c/);
});

// ── formatSchemaSnippet ───────────────────────────────────────────────────────
test("formatSchemaSnippet lists every parameter with required/optional", () => {
  const text = formatSchemaSnippet(makeTool());
  assert.match(text, /Expected parameters:/);
  assert.match(text, /- name: string \(required\)/);
  assert.match(text, /- count: integer \(required\)/);
  assert.match(text, /- flag: boolean \(optional\)/);
});

test("formatSchemaSnippet handles no parameters", () => {
  const text = formatSchemaSnippet({ name: "t", description: "d" });
  assert.match(text, /no parameters required/);
});