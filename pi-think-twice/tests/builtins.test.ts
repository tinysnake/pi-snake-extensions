import { test } from "node:test";
import assert from "node:assert/strict";
import { RESERVED_BUILTIN_COMMANDS, resolveBuiltinCommands } from "../builtins.ts";

const live = ["review", "release", "mycmd", "skill:code-review"];

function provider(commands: unknown) {
	return { commands };
}

test("reflects built-ins by subtracting getCommands() from the provider's list", () => {
	const reflected = resolveBuiltinCommands(
		provider([
			{ name: "settings" }, // builtin
			{ name: "compact" }, // builtin
			{ name: "release" }, // prompt template (in getCommands)
			{ name: "review" }, // extension command (in getCommands)
			{ name: "skill:code-review" }, // skill — excluded by prefix
			{ name: "mycmd" }, // extension command (in getCommands)
		]),
		live,
	);
	assert.deepEqual([...reflected], ["settings", "compact"]);
});

test("skills stay excluded even when getCommands() reports them unprefixed", () => {
	const reflected = resolveBuiltinCommands(
		provider([{ name: "settings" }, { name: "skill:foo" }, { name: "foo" }]),
		["foo"], // hypothetical unprefixed skill name from getCommands()
	);
	assert.deepEqual([...reflected], ["settings"]);
});

test("malformed entries are skipped, duplicates deduped", () => {
	const reflected = resolveBuiltinCommands(
		provider([null, 42, { name: 42 }, { name: "" }, { name: "settings" }, { name: "settings" }]),
		[],
	);
	assert.deepEqual([...reflected], ["settings"]);
});

test("missing or malformed provider falls back to the reserved list", () => {
	for (const bad of [undefined, null, 7, "x", {}, { commands: "nope" }, { commands: [] }]) {
		assert.deepEqual([...resolveBuiltinCommands(bad, live)], [...RESERVED_BUILTIN_COMMANDS]);
	}
});

test("all-names-subtracted-empty counts as reflection failure, not 'no builtins'", () => {
	const onlyLive = provider(live.map((name) => ({ name })));
	assert.deepEqual([...resolveBuiltinCommands(onlyLive, live)], [...RESERVED_BUILTIN_COMMANDS]);
});

test("a throwing property access falls back to the reserved list", () => {
	const evil = {
		get commands(): never {
			throw new Error("field renamed or privatized");
		},
	};
	assert.deepEqual([...resolveBuiltinCommands(evil, live)], [...RESERVED_BUILTIN_COMMANDS]);
});

test("reserved snapshot covers the known built-ins", () => {
	assert.ok(RESERVED_BUILTIN_COMMANDS.includes("settings"));
	assert.ok(RESERVED_BUILTIN_COMMANDS.includes("compact"));
	assert.ok(RESERVED_BUILTIN_COMMANDS.length >= 20);
});
