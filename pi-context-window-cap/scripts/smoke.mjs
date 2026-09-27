#!/usr/bin/env node
/**
 * End-to-end smoke test over pi's RPC mode. Zero LLM calls: every check uses
 * get_state / get_available_models / get_commands and extension commands sent
 * through `prompt` (extension commands never reach the model).
 *
 * Usage:
 *   node scripts/smoke.mjs              # loads ../index.ts via -e (dev mode)
 *   node scripts/smoke.mjs --installed  # expects the package to be installed
 *
 * Verifies:
 *   - extension loads and registers /context-window-cap
 *   - session_start clamps the active model to the default 300K cap
 *   - registry catalog objects stay pristine (never mutated)
 *   - `set 600k` raises, `off` fully restores originals, `on` re-clamps
 *   - invalid caps and unknown subcommands warn instead of applying
 *   - models smaller than the cap keep their original window
 *   - model_select re-clamps when switching back to a large model
 *   - footer status and state file end in the canonical shape
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const installed = process.argv.includes("--installed");
const INDEX_PATH = join(here, "..", "index.ts");
const STATE_PATH = join(homedir(), ".pi", "agent", "context-window-cap.json");
const STATUS_KEY = "ctxcap";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function pass(message) {
	console.log(`  ok   ${message}`);
}
function fail(message, detail) {
	failures += 1;
	console.error(`  FAIL ${message}${detail !== undefined ? ` — ${detail}` : ""}`);
}
async function check(label, fn) {
	try {
		await fn();
	} catch (error) {
		fail(label, error instanceof Error ? error.message : error);
	}
}
/** Poll until fn() resolves without throwing (or the deadline passes). */
async function eventually(label, fn, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			await fn();
			pass(label);
			return;
		} catch (error) {
			lastError = error;
			await sleep(120);
		}
	}
	throw lastError ?? new Error("timed out");
}

// --- Preserve the user's real state file; the test forces a known state. ---
const hadStateFile = existsSync(STATE_PATH);
const originalState = hadStateFile ? readFileSync(STATE_PATH) : null;
// Write BEFORE spawning so session_start's state re-read cannot race us.
writeFileSync(STATE_PATH, `${JSON.stringify({ enabled: true, cap: 300000 }, null, "\t")}\n`);

// --- Minimal JSONL RPC client -------------------------------------------
const args = ["--mode", "rpc", "--no-session"];
if (!installed) args.push("-e", INDEX_PATH);

const child = spawn(process.env.PI_BIN ?? "pi", args, {
	stdio: ["pipe", "pipe", "pipe"],
	cwd: join(here, ".."),
});
let stderrTail = "";
child.stderr.on("data", (chunk) => {
	stderrTail = (stderrTail + chunk.toString()).slice(-4000);
});
child.on("exit", (code, signal) => {
	if (!shuttingDown) {
		stderrTail += `\nchild exited unexpectedly (code=${code}, signal=${signal})`;
	}
});

let buffer = "";
let nextId = 0;
let shuttingDown = false;
const pending = new Map();
const notifies = [];
const statuses = new Map();

child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let newline;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue; // non-JSONL noise on stdout
		}
		if (record.type === "response" && record.id !== undefined && pending.has(record.id)) {
			const { resolve, reject, timer } = pending.get(record.id);
			pending.delete(record.id);
			clearTimeout(timer);
			if (record.success) resolve(record.data);
			else reject(new Error(`${record.command ?? record.type} failed: ${record.error ?? "unknown error"}`));
		} else if (record.type === "extension_ui_request") {
			if (record.method === "notify") notifies.push(record.message ?? "");
			if (record.method === "setStatus") statuses.set(record.statusKey, record.statusText);
		}
		// session events and anything else: ignored
	}
});

function send(command, timeoutMs = 15000) {
	const id = `smoke-${++nextId}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`timeout waiting for response to ${command.type}`));
		}, timeoutMs);
		pending.set(id, { resolve, reject, timer });
		child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
	});
}

const getState = () => send({ type: "get_state" });
const getModels = async () => (await send({ type: "get_available_models" })).models;
const runCommand = (message) => send({ type: "prompt", message });

async function activeModel() {
	const state = await getState();
	if (!state.model) throw new Error("no active model in get_state");
	return state.model;
}
function findNotify(substr, from) {
	return notifies.slice(from).find((message) => message.includes(substr));
}
async function expectNotify(substr, from, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const hit = findNotify(substr, from);
		if (hit !== undefined) return hit;
		await sleep(120);
	}
	throw new Error(`no notify containing "${substr}" (notifies so far: ${JSON.stringify(notifies.slice(from))})`);
}

// --- Test ----------------------------------------------------------------
const originalWindowOf = (id) => {
	const model = registryModels.find((entry) => entry.provider === id.provider && entry.id === id.id);
	return model?.contextWindow;
};

let registryModels = [];

async function main() {
	await eventually("extension registers /context-window-cap", async () => {
		const { commands } = await send({ type: "get_commands" });
		const command = commands.find((entry) => entry.name === "context-window-cap");
		if (!command) throw new Error("command not registered yet");
		if (command.source !== "extension") throw new Error(`unexpected source: ${command.source}`);
	});
	registryModels = await getModels();

	// --- initial clamp (session_start) ---
	const model = await activeModel();
	const provider = { provider: model.provider, id: model.id };
	const pristine = originalWindowOf(provider);
	if (pristine === undefined) throw new Error(`cannot find ${model.provider}/${model.id} in available models`);
	if (pristine <= 300000) throw new Error(`test needs a default model >300K; ${provider.id} has ${pristine}`);
	await eventually(`session_start clamps ${model.provider}/${model.id} (${pristine} → 300000)`, async () => {
		const active = await activeModel();
		if (active.contextWindow !== 300000) throw new Error(`got ${active.contextWindow}`);
	});

	await check("registry catalog stays pristine after clamp", async () => {
		registryModels = await getModels();
		const window = originalWindowOf(provider);
		if (window !== pristine) throw new Error(`registry was mutated: ${window} !== ${pristine}`);
	});

	// --- status command ---
	let mark = notifies.length;
	await runCommand("/context-window-cap status");
	await expectNotify(`enabled, cap 300K`, mark);
	await expectNotify(`→ 300K`, mark);
	pass("status reports enabled, cap 300K, and the clamp arrow");

	// --- set 600k ---
	mark = notifies.length;
	await runCommand("/context-window-cap set 600k");
	await eventually("set 600k raises the window to 600000", async () => {
		const active = await activeModel();
		if (active.contextWindow !== 600000) throw new Error(`got ${active.contextWindow}`);
	});
	await expectNotify("enabled, cap 600K", mark);
	pass("set 600k notifies enabled, cap 600K");

	// --- off: full restore to the original ---
	mark = notifies.length;
	await runCommand("/context-window-cap off");
	await eventually("off restores the original window", async () => {
		const active = await activeModel();
		if (active.contextWindow !== pristine) throw new Error(`got ${active.contextWindow}, want ${pristine}`);
	});
	await expectNotify("disabled (cap 600K retained)", mark);
	pass("off notifies disabled with the retained cap");

	// --- on: re-clamp with the retained cap ---
	mark = notifies.length;
	await runCommand("/context-window-cap on");
	await eventually("on re-clamps to the retained 600k cap", async () => {
		const active = await activeModel();
		if (active.contextWindow !== 600000) throw new Error(`got ${active.contextWindow}`);
	});
	await expectNotify("enabled, cap 600K", mark);
	pass("on notifies enabled, cap 600K");

	// --- invalid inputs warn and change nothing ---
	mark = notifies.length;
	await runCommand("/context-window-cap set 10k");
	await expectNotify("below the minimum", mark);
	await runCommand("/context-window-cap set bogus");
	await expectNotify("invalid cap", mark);
	await runCommand("/context-window-cap frobnicate");
	await expectNotify("unknown subcommand", mark);
	const afterBadInput = await activeModel();
	if (afterBadInput.contextWindow !== 600000) {
		fail("invalid input left the window alone", `got ${afterBadInput.contextWindow}`);
	} else {
		pass("invalid set/unknown subcommand warn without applying");
	}

	// --- back to the default cap ---
	await runCommand("/context-window-cap set 300k");
	await eventually("set 300k returns the window to 300000", async () => {
		const active = await activeModel();
		if (active.contextWindow !== 300000) throw new Error(`got ${active.contextWindow}`);
	});

	// --- a model smaller than the cap keeps its original window ---
	// Only models whose provider has configured auth can be selected via set_model.
	const authProviders = new Set(
		Object.keys(JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))),
	);
	const small = registryModels.find(
		(entry) =>
			entry.contextWindow > 0 &&
			entry.contextWindow < 300000 &&
			entry.id !== provider.id &&
			authProviders.has(entry.provider),
	);
	if (!small) {
		fail("no <300K model available for the small-model check");
	} else {
		await send({ type: "set_model", provider: small.provider, modelId: small.id });
		await eventually(`small model ${small.provider}/${small.id} keeps ${small.contextWindow}`, async () => {
			const active = await activeModel();
			if (active.id !== small.id) throw new Error(`model is ${active.id}`);
			if (active.contextWindow !== small.contextWindow) {
				throw new Error(`got ${active.contextWindow}, want ${small.contextWindow}`);
			}
		});
	}

	// --- switching back re-clamps via model_select ---
	await send({ type: "set_model", provider: provider.provider, modelId: provider.id });
	await eventually("model_select re-clamps the large model to 300000", async () => {
		const active = await activeModel();
		if (active.id !== provider.id) throw new Error(`model is ${active.id}`);
		if (active.contextWindow !== 300000) throw new Error(`got ${active.contextWindow}`);
	});

	// --- footer status reflects the final state ---
	await eventually('footer status reads "ctx-cap 300K"', async () => {
		const text = statuses.get(STATUS_KEY);
		if (text !== "ctx-cap 300K") throw new Error(`status is ${JSON.stringify(text)}`);
	});

	// --- registry still pristine after all of that ---
	registryModels = await getModels();
	await check("registry catalog still pristine at the end", async () => {
		const window = originalWindowOf(provider);
		if (window !== pristine) throw new Error(`registry was mutated: ${window} !== ${pristine}`);
	});

	// --- state file ends canonical ---
	await check("state file ends enabled/300000", async () => {
		const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
		if (state.enabled !== true || state.cap !== 300000) throw new Error(JSON.stringify(state));
	});
}

const overallTimer = setTimeout(() => {
	fail("overall watchdog", "test exceeded 120s");
	shutdown(1);
}, 120000);

async function shutdown(code) {
	clearTimeout(overallTimer);
	shuttingDown = true;
	try {
		child.stdin.end();
		child.kill("SIGTERM");
	} catch {
		// already gone
	}
	await sleep(400);
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");

	// Restore the user's state file exactly as it was.
	if (hadStateFile) writeFileSync(STATE_PATH, originalState);
	else rmSync(STATE_PATH, { force: true });

	if (code !== 0 && stderrTail.trim()) console.error(`\n--- pi stderr (tail) ---\n${stderrTail.trim()}`);
	console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures} failure${failures === 1 ? "" : "s"})`);
	process.exit(code !== 0 || failures > 0 ? 1 : 0);
}

try {
	await main();
	await shutdown(failures > 0 ? 1 : 0);
} catch (error) {
	fail("test run", error instanceof Error ? error.stack ?? error.message : error);
	await shutdown(1);
}
