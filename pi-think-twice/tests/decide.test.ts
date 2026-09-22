import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCommandName, shouldCountdown, slashCommandName } from "../decide.ts";

const policy = {
	alwaysCountdown: ["compact"],
	// Stands in for the dynamically reflected list.
	builtinCommands: ["settings", "model", "new", "compact"],
	extensionCommands: ["review", "mycmd"],
};

test("plain text counts down", () => {
	assert.equal(shouldCountdown("fix the typo", policy), true);
	assert.equal(shouldCountdown("multiline\nmessage", policy), true);
});

test("empty or whitespace submissions never count down", () => {
	assert.equal(shouldCountdown("", policy), false);
	assert.equal(shouldCountdown("   \n ", policy), false);
});

test("built-in commands are exempt", () => {
	assert.equal(shouldCountdown("/settings", policy), false);
	assert.equal(shouldCountdown("/model gpt", policy), false);
	assert.equal(shouldCountdown("/new", policy), false);
});

test("alwaysCountdown forces a built-in through the countdown", () => {
	assert.equal(shouldCountdown("/compact", policy), true);
	assert.equal(shouldCountdown("/compact keep comments", policy), true);
});

test("registered extension commands are exempt", () => {
	assert.equal(shouldCountdown("/review src/", policy), false);
	assert.equal(shouldCountdown("/mycmd", policy), false);
});

test("skills, templates and unknown slash input count down", () => {
	// Skills/templates are not extension commands: they become messages.
	assert.equal(shouldCountdown("/skill:code-review this PR", policy), true);
	assert.equal(shouldCountdown("/template release-notes", policy), true);
	// Mistyped command → goes to the model as text → countdown.
	assert.equal(shouldCountdown("/setings", policy), true);
});

test("bash submissions count down", () => {
	assert.equal(shouldCountdown("!git status", policy), true);
	assert.equal(shouldCountdown("!!rm -rf /tmp/x", policy), true);
});

test("slashCommandName takes the first token without the slash", () => {
	assert.equal(slashCommandName("/compact foo bar"), "compact");
	assert.equal(slashCommandName("  /settings  "), "settings");
	assert.equal(slashCommandName("not a command"), undefined);
	assert.equal(slashCommandName("/"), "");
});

test("normalizeCommandName accepts entries with or without slashes", () => {
	assert.equal(normalizeCommandName("/compact"), "compact");
	assert.equal(normalizeCommandName("compact"), "compact");
	assert.equal(normalizeCommandName("  /tree  "), "tree");
});
