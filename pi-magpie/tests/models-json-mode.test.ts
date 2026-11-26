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

/**
 * The real factory against a recording API, dispatching to every handler of an
 * event. The registered provider is dropped: this run has no catalog.
 */
function loadExtension(): (event: string, payload: unknown, ctx: ExtensionContext) => Promise<void> {
	const handlers = new Map<string, Array<(payload: unknown, ctx: unknown) => unknown>>();
	const api = {
		registerProvider() {},
		registerCommand() {},
		on(event: string, handler: (payload: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	magpieExtension(api);
	return async (event, payload, ctx) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
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

/** A throwaway agent dir with the switch on, and the env and listeners put back after. */
async function withTempAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-magpie-models-json-"));
	const config = join(agentDir, "pi-magpie.json");
	writeFileSync(config, "{ \"modelsJson\": true }\n");
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
