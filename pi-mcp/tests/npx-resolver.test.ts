/**
 * Tests for npx-resolver.ts — npx/npm exec binary resolution.
 *
 * Tests the fast paths: non-npx commands return null immediately,
 * and npx/npm commands that fail parsing return null without
 * touching the npm cache.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resolveNpxBinary } from "../npx-resolver.ts";

test("returns null for non-npx commands (direct binary)", async () => {
  const r = await resolveNpxBinary("node", ["server.js"]);
  assert.equal(r, null);
});

test("returns null for non-npm-exec npm subcommands", async () => {
  const r = await resolveNpxBinary("npm", ["install", "foo"]);
  assert.equal(r, null);
});

test("returns null for npx with no positional args", async () => {
  const r = await resolveNpxBinary("npx", []);
  assert.equal(r, null);
});

test("returns null for npx with flags but no package (e.g. --version)", async () => {
  const r = await resolveNpxBinary("npx", ["--version"]);
  assert.equal(r, null);
});

test("returns null for npx with unknown flag (invalid syntax)", async () => {
  const r = await resolveNpxBinary("npx", ["--unknown-flag", "pkg"]);
  assert.equal(r, null);
});
