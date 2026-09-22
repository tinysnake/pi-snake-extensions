import { test } from "node:test";
import assert from "node:assert/strict";
import { ThinkTwiceEditor } from "../think-twice-editor.ts";
import { RESERVED_BUILTIN_COMMANDS } from "../builtins.ts";

/**
 * Headless behavioral tests: drive ThinkTwiceEditor.handleInput with a stubbed
 * TUI/keybindings and observe what reaches pi's real submit (onSubmit).
 */

const ENTER = "\r";
const CTRL_ENTER = "\x1b[13;5u"; // kitty CSI-u: enter + ctrl

interface MakeOptions {
	shouldCountdown?: (text: string, builtinCommands: readonly string[]) => boolean;
	liveCommandNames?: () => readonly string[];
	delaySeconds?: number;
}

function makeEditor(options?: MakeOptions) {
	const tui = { requestRender() {} };
	const theme = {
		borderColor: (s: string) => s,
		selectList: {
			selectedPrefix: (s: string) => s,
			selectedText: (s: string) => s,
			description: (s: string) => s,
			scrollInfo: (s: string) => s,
			noMatch: (s: string) => s,
		},
	};
	const keybindings = {
		matches: (data: string, id: string) => (id === "tui.input.submit" ? data === ENTER : false),
		getKeys: (id: string) => (id === "tui.input.submit" ? ["enter"] : []),
	};
	const editor = new ThinkTwiceEditor(tui as never, theme as never, keybindings as never, {
		delaySeconds: options?.delaySeconds ?? 0.4,
		shouldCountdown: options?.shouldCountdown ?? (() => true),
		liveCommandNames: options?.liveCommandNames ?? (() => []),
	});
	const submitted: string[] = [];
	editor.onSubmit = (text: string) => submitted.push(text);
	editor.setText("hello");
	return { editor, submitted };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Enter keeps the text in the box and submits only after the countdown", async () => {
	const { editor, submitted } = makeEditor();
	editor.handleInput(ENTER);
	// Stock pi clears the editor here; pi-think-twice keeps it until the timer ends.
	assert.equal(editor.getText(), "hello");
	assert.deepEqual(submitted, []);

	await sleep(600); // delay is 400ms
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
});

test("Enter during the countdown is ignored: no send, no restart, no cancel", async () => {
	const { editor, submitted } = makeEditor({ delaySeconds: 0.4 });
	editor.handleInput(ENTER);
	await sleep(150);
	editor.handleInput(ENTER); // ignored
	await sleep(350); // 500ms total: past the original 400ms deadline, well before a restarted one
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
	await sleep(300);
	assert.equal(submitted.length, 1);
});

test("any other key interrupts the countdown and leaves the text editable", async () => {
	const { editor, submitted } = makeEditor({ delaySeconds: 0.25 });
	editor.handleInput(ENTER);
	editor.handleInput("X"); // cancels and inserts
	await sleep(450); // past the original deadline
	assert.deepEqual(submitted, []);
	// Text was never sent and the edit landed — user keeps typing.
	assert.equal(editor.getText(), "helloX");
});

test("exempt submissions go through immediately", () => {
	const { editor, submitted } = makeEditor({ shouldCountdown: () => false });
	editor.handleInput(ENTER);
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
});

test("Ctrl+Enter sends immediately without starting a countdown", () => {
	const { editor, submitted } = makeEditor();
	editor.handleInput(CTRL_ENTER);
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
	assert.equal((editor as unknown as { countdownTimer?: unknown }).countdownTimer, undefined);
});

test("Ctrl+Enter during a countdown finishes it immediately", () => {
	const { editor, submitted } = makeEditor();
	editor.handleInput(ENTER);
	assert.equal(editor.getText(), "hello");
	editor.handleInput(CTRL_ENTER);
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
});

test("decision receives built-ins reflected from pi's captured provider", () => {
	let seen: readonly string[] | undefined;
	const { editor } = makeEditor({
		shouldCountdown: (_text, builtinCommands) => {
			seen = builtinCommands;
			return false;
		},
		liveCommandNames: () => ["review", "skill:foo"],
	});
	// What pi does: hand the editor its CombinedAutocompleteProvider.
	editor.setAutocompleteProvider({
		commands: [{ name: "settings" }, { name: "compact" }, { name: "review" }, { name: "skill:foo" }],
	} as never);
	editor.handleInput(ENTER);
	assert.ok(seen !== undefined);
	assert.deepEqual([...seen], ["settings", "compact"]);
});

test("without a provider the decision gets the reserved snapshot", () => {
	let seen: readonly string[] | undefined;
	const { editor } = makeEditor({
		shouldCountdown: (_text, builtinCommands) => {
			seen = builtinCommands;
			return false;
		},
	});
	editor.handleInput(ENTER);
	assert.ok(seen !== undefined);
	assert.deepEqual([...seen], [...RESERVED_BUILTIN_COMMANDS]);
});

test("a throwing decision fails open to an immediate stock submit", () => {
	const { editor, submitted } = makeEditor({
		shouldCountdown: () => {
			throw new Error("reflection or policy blew up");
		},
	});
	// Must not throw, must not wedge: stock pi submits right away.
	editor.handleInput(ENTER);
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
	assert.equal((editor as unknown as { countdownTimer?: unknown }).countdownTimer, undefined);
});

test("a throwing liveCommandNames fails open too", () => {
	const { editor, submitted } = makeEditor({
		liveCommandNames: () => {
			throw new Error("getCommands blew up");
		},
	});
	editor.handleInput(ENTER);
	assert.deepEqual(submitted, ["hello"]);
});
