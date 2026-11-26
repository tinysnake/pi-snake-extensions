import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toPiModel, toPiModels, type PiMagpieModel } from "../catalog.ts";
import { PROVIDER_ID } from "../constants.ts";
import magpieExtension from "../index.ts";
import { writeMagpieModels } from "../models-json.ts";
import { createMagpieProvider } from "../provider.ts";

const ROOT = "http://127.0.0.1:3425";

const CATALOG: PiMagpieModel[] = [
	toPiModel({ id: "codex/gpt-6.2-sol", native_endpoints: ["/v1/responses"] }, ROOT),
	toPiModel({ id: "group/auto-gpt-6-sol" }, ROOT),
];

test("models.json mode: the provider keeps its id but serves no list of its own", () => {
	const magpie = createMagpieProvider({ modelsJson: true });
	magpie.install(CATALOG);
	assert.equal(magpie.provider.id, PROVIDER_ID);
	assert.deepEqual(magpie.provider.getModels?.(), []);
	assert.deepEqual(magpie.provider.getAllModels?.(), []);
	assert.equal(typeof magpie.provider.stream, "function");
	assert.equal(typeof magpie.provider.streamSimple, "function");
});

test("default mode: the provider serves the installed catalog", () => {
	const magpie = createMagpieProvider();
	magpie.install(CATALOG);
	assert.deepEqual(
		magpie.provider.getAllModels?.().map((model) => model.id),
		["codex/gpt-6.2-sol", "group/auto-gpt-6-sol"],
	);
	assert.deepEqual(
		magpie.provider.getModels?.().map((model) => model.id),
		["codex/gpt-6.2-sol", "group/auto-gpt-6-sol"],
	);
});

test("models.json mode keeps the owned-by map, so quota attribution still works", () => {
	const magpie = createMagpieProvider({ modelsJson: true });
	magpie.install([
		toPiModel({ id: "codex/gpt-6.2-sol", owned_by: "codex" }, ROOT),
	]);
	assert.equal(magpie.ownedBy("codex/gpt-6.2-sol"), "codex");
});

/**
 * The startup write must never replace a good block with nothing. A pi that
 * loads this extension refreshes its providers with `allowNetwork: false`
 * before `session_start`, so with no stored catalog the handle is empty there.
 */
test("models.json mode: a startup with no catalog leaves the block on disk alone", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeMagpieModels(
			agentDir,
			ROOT,
			toPiModels([{ id: "codex/gpt-6.2-sol", native_endpoints: ["/v1/responses"] }], ROOT),
		);
		const path = join(agentDir, "models.json");
		const before = readFileSync(path);

		const dispatch = loadExtension();
		await dispatch("session_start", { type: "session_start", reason: "startup" }, fakeContext());

		assert.deepEqual(readFileSync(path), before);
	});
});

test("models-json on: writes the switch, does refresh's work, and leaves the block", async () => {
	await withTempAgentDir(
		async (agentDir) => {
			const modelsPath = join(agentDir, "models.json");
			await writeMagpieModels(agentDir, ROOT, CATALOG);
			const block = readFileSync(modelsPath);

			const extension = loadExtension();
			const { ctx, notices } = recordingContext();
			await extension.command("models-json on", ctx);

			assert.equal(
				readFileSync(join(agentDir, "pi-magpie.json"), "utf8"),
				`${JSON.stringify({ modelsJson: true }, null, 2)}\n`,
			);
			assert.deepEqual(readFileSync(modelsPath), block);
			assert.equal(notices.length, 1);
			const lines = notices[0]!.message.split("\n");
			assert.match(lines[0]!, /^models\.json mode: on — /);
			assert.match(lines[1]!, /left alone/);
			assert.equal(lines.at(-1), "the switch applies on the next pi start");
			assert.equal(notices[0]!.severity, "warning");
		},
		'{ "modelsJson": false }\n',
	);
});

test("models-json off: writes the switch and leaves the block", async () => {
	await withTempAgentDir(async (agentDir) => {
		const modelsPath = join(agentDir, "models.json");
		await writeMagpieModels(agentDir, ROOT, CATALOG);
		const block = readFileSync(modelsPath);

		const extension = loadExtension();
		const { ctx, notices } = recordingContext();
		await extension.command("models-json off", ctx);

		assert.equal(
			readFileSync(join(agentDir, "pi-magpie.json"), "utf8"),
			`${JSON.stringify({ modelsJson: false }, null, 2)}\n`,
		);
		assert.deepEqual(readFileSync(modelsPath), block);
		const lines = notices[0]!.message.split("\n");
		assert.match(lines[0]!, /^models\.json mode: off — /);
		assert.match(lines[1]!, /providers\.magpie stays/);
		assert.match(lines[1]!, /delete the block by hand/);
		assert.equal(lines.at(-1), "the switch applies on the next pi start");
		assert.equal(notices[0]!.severity, "warning");
	});
});

test("models-json with a bad value names the accepted ones and writes nothing", async () => {
	await withTempAgentDir(
		async (agentDir) => {
			const configPath = join(agentDir, "pi-magpie.json");
			writeFileSync(configPath, '{ "modelsJson": false, "keep": 1 }\n');
			const before = readFileSync(configPath);

			const extension = loadExtension();
			const { ctx, notices } = recordingContext();
			await extension.command("models-json maybe", ctx);

			assert.deepEqual(readFileSync(configPath), before);
			assert.equal(notices.length, 1);
			assert.match(notices[0]!.message, /accepted: on, off/);
			assert.equal(notices[0]!.severity, "info");
		},
		'{ "modelsJson": false }\n',
	);
});

test("models-json with no argument reports the switch and what models.json holds", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeMagpieModels(agentDir, ROOT, CATALOG);
		const extension = loadExtension();
		const { ctx, notices } = recordingContext();

		await extension.command("models-json", ctx);
		const on = notices[0]!.message.split("\n");
		assert.match(on[0]!, /^models\.json mode: on — /);
		assert.match(on[1]!, /\(2 models\)/);
		assert.equal(notices[0]!.severity, "info");

		writeFileSync(join(agentDir, "pi-magpie.json"), '{ "modelsJson": false }\n');
		await extension.command("models-json", ctx);
		const off = notices[1]!.message.split("\n");
		assert.equal(off.length, 1);
		assert.match(off[0]!, /^models\.json mode: off — /);
	});
});

/**
 * The real factory against a recording API, dispatching to every handler of an
 * event. The registered provider is dropped: this run has no catalog. The
 * registered command handler is kept, so `/magpie` replies stay assertable.
 */
function loadExtension(): ((event: string, payload: unknown, ctx: ExtensionContext) => Promise<void>) & {
	command: (args: string, ctx: ExtensionContext) => Promise<void>;
} {
	const handlers = new Map<string, Array<(payload: unknown, ctx: unknown) => unknown>>();
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const api = {
		registerProvider() {},
		registerCommand(_name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			command = options.handler;
		},
		on(event: string, handler: (payload: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	magpieExtension(api);
	return Object.assign(
		async (event: string, payload: unknown, ctx: ExtensionContext) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
		{ command: command as (args: string, ctx: ExtensionContext) => Promise<void> },
	);
}

const REMOTE_AUTH = { env: { MAGPIE_GW_URL: "http://remote.example:7777" }, auth: { apiKey: "key" } };

/** A remote gateway, so the footer renders from plain data and reaches no network. */
function fakeContext(): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
		model: { provider: PROVIDER_ID, id: "group/auto-gpt-6-sol", name: "Auto", api: "openai-completions" },
		modelRegistry: {
			getAll: () => [],
			getProviderAuth: async () => REMOTE_AUTH,
			getProviderAuthStatus: () => ({ configured: true }),
			refresh: async () => ({ aborted: false, errors: new Map() }),
		},
	} as unknown as ExtensionContext;
}

/** The fake context with its notifications kept, so a command's reply is assertable. */
function recordingContext(): { ctx: ExtensionContext; notices: Array<{ message: string; severity?: string }> } {
	const ctx = fakeContext();
	const notices: Array<{ message: string; severity?: string }> = [];
	(ctx.ui as unknown as { notify(message: string, severity?: string): void }).notify = (message, severity) => {
		notices.push({ message, severity });
	};
	return { ctx, notices };
}

/** A throwaway agent dir, with the switch's initial value, and the env and listeners put back after. */
async function withTempAgentDir(
	run: (agentDir: string) => Promise<void>,
	initial = '{ "modelsJson": true }\n',
): Promise<void> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-magpie-models-json-"));
	const config = join(agentDir, "pi-magpie.json");
	writeFileSync(config, initial);
	const env: Record<string, string> = {
		PI_CODING_AGENT_DIR: agentDir,
		PI_MAGPIE_CONFIG: config,
		MAGPIE_BIN: "/nonexistent/magpie-for-tests",
	};
	const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
	const foreign = process.stdout.listeners("resize").slice();
	Object.assign(process.env, env);
	try {
		await run(agentDir);
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		// session_start arms a raw stdout listener; drop the ones this test added.
		for (const listener of process.stdout.listeners("resize")) {
			if (!foreign.includes(listener)) process.stdout.off("resize", listener);
		}
		rmSync(agentDir, { recursive: true, force: true });
	}
}
