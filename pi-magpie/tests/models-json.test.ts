import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toPiModels, type MagpieModelEntry } from "../catalog.ts";
import { DEFAULT_TOKEN, PROVIDER_ID, PROVIDER_NAME } from "../constants.ts";
import {
	countMagpieModels,
	magpieProviderBlock,
	parseJsonc,
	readMagpieProviderBlock,
	writeMagpieModels,
} from "../models-json.ts";

const ROOT = "http://127.0.0.1:3425";

const ENTRIES: MagpieModelEntry[] = [
	{
		id: "codex/gpt-6.2-sol",
		display_name: "GPT-6.2 Sol",
		native_endpoints: ["/v1/responses"],
		owned_by: "codex",
		reasoning: true,
		supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
		max_output_tokens: 128000,
		context_length: 400000,
	},
	{
		id: "remote-magpie/claude-opus-5-5",
		display_name: "Claude Opus 5.5",
		native_endpoints: ["/v1/messages"],
		owned_by: "remote-magpie",
		reasoning: true,
		supported_reasoning_levels: [{ effort: "low" }],
	},
	{ id: "group/auto-gpt-6-sol", display_name: "Auto GPT-6 Sol" },
];

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "pi-magpie-models-json-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("parseJsonc: strips line and block comments, keeps // inside strings", () => {
	const text = `{
		// a line comment
		"a": "http://example.com/x", // a trailing comment
		/* a block
		   comment */
		"b": [1, 2, /* inline */ 3],
		"c": "// not a comment"
	}`;
	assert.deepEqual(parseJsonc(text), {
		a: "http://example.com/x",
		b: [1, 2, 3],
		c: "// not a comment",
	});
});

test("parseJsonc: ignores a byte order mark", () => {
	assert.deepEqual(parseJsonc('\uFEFF{"a":1}'), { a: 1 });
});

test("block: the provider block carries pi's schema keys", () => {
	const block = magpieProviderBlock(ROOT, toPiModels(ENTRIES, ROOT));
	assert.equal(block.api, "openai-completions");
	assert.equal(block.apiKey, DEFAULT_TOKEN);
	assert.equal(block.baseUrl, `${ROOT}/v1`);
	assert.deepEqual(block.compat, { sendSessionAffinityHeaders: true });
	assert.equal(block.name, PROVIDER_NAME);
	assert.equal(block.models.length, 3);
});

test("block: each model keeps its own protocol, so native paths survive", () => {
	const block = magpieProviderBlock(ROOT, toPiModels(ENTRIES, ROOT));
	const byId = new Map(block.models.map((model) => [model.id, model]));

	const responses = byId.get("codex/gpt-6.2-sol");
	assert.ok(responses);
	assert.equal(responses.api, "openai-responses");
	assert.equal(responses.baseUrl, `${ROOT}/v1`);

	const claude = byId.get("remote-magpie/claude-opus-5-5");
	assert.ok(claude);
	assert.equal(claude.api, "anthropic-messages");
	assert.equal(claude.baseUrl, ROOT, "a Claude talks to the root, never to /v1");
	assert.notEqual(claude.baseUrl, `${ROOT}/v1`);
	assert.deepEqual(claude.compat, { forceAdaptiveThinking: true });

	const group = byId.get("group/auto-gpt-6-sol");
	assert.ok(group);
	assert.equal(group.api, "openai-completions");
	assert.equal(group.baseUrl, `${ROOT}/v1`);
});

test("block: an extension-private field never reaches the file", () => {
	const block = magpieProviderBlock(ROOT, toPiModels(ENTRIES, ROOT));
	for (const model of block.models) {
		assert.ok(!("magpieOwnedBy" in model), `${model.id} carries magpieOwnedBy`);
		assert.ok(!("provider" in model), `${model.id} carries provider`);
	}
	const responses = block.models.find((model) => model.id === "codex/gpt-6.2-sol");
	assert.ok(responses);
	assert.deepEqual(Object.keys(responses).sort(), [
		"api",
		"baseUrl",
		"contextWindow",
		"cost",
		"id",
		"input",
		"maxTokens",
		"name",
		"reasoning",
		"thinkingLevelMap",
	]);
});

test("write: creates models.json when there is none", async () => {
	await withTemp(async (dir) => {
		const result = await writeMagpieModels(dir, ROOT, toPiModels(ENTRIES, ROOT));
		assert.equal(result.changed, true);
		assert.equal(result.models, 3);
		assert.equal(result.path, join(dir, "models.json"));
		const written = JSON.parse(await readFile(result.path, "utf8"));
		assert.equal(written.providers[PROVIDER_ID].models.length, 3);
		assert.equal(written.providers[PROVIDER_ID].api, "openai-completions");
	});
});

test("write: a second identical write is byte-identical and reports changed: false", async () => {
	await withTemp(async (dir) => {
		const models = toPiModels(ENTRIES, ROOT);
		const first = await writeMagpieModels(dir, ROOT, models);
		const before = await readFile(first.path, "utf8");
		const second = await writeMagpieModels(dir, ROOT, models);
		assert.equal(second.changed, false);
		assert.equal(await readFile(second.path, "utf8"), before);
	});
});

test("write: keeps every other key and provider", async () => {
	await withTemp(async (dir) => {
		const path = join(dir, "models.json");
		const seed = {
			$schema: "https://example.test/schema.json",
			note: "keep me",
			providers: {
				other: {
					api: "openai-completions",
					baseUrl: "http://other:1111/v1",
					models: [{ id: "x", name: "X" }],
				},
			},
		};
		await writeFile(path, `${JSON.stringify(seed, null, 2)}\n`);
		await writeMagpieModels(dir, ROOT, toPiModels(ENTRIES, ROOT));
		const written = JSON.parse(await readFile(path, "utf8"));
		assert.equal(written.$schema, seed.$schema);
		assert.equal(written.note, "keep me");
		assert.deepEqual(written.providers.other, seed.providers.other);
		assert.equal(written.providers[PROVIDER_ID].models.length, 3);
		assert.deepEqual(Object.keys(written), ["$schema", "note", "providers"]);
		assert.deepEqual(Object.keys(written.providers), ["other", PROVIDER_ID]);
	});
});

test("write: replaces a stale block that sits among comments", async () => {
	await withTemp(async (dir) => {
		const path = join(dir, "models.json");
		await writeFile(
			path,
			`{
	// a hand-written comment
	"providers": {
		"magpie": {
			"api": "openai-completions",
			"baseUrl": "http://old:1111/v1",
			"models": [{ "id": "old/one", "name": "Old" }]
		},
		"kept": { "api": "openai-completions", "baseUrl": "http://kept:1111/v1", "models": [{ "id": "k", "name": "K" }] }
	}
}\n`,
			"utf8",
		);
		const result = await writeMagpieModels(dir, ROOT, toPiModels(ENTRIES, ROOT));
		assert.equal(result.changed, true);
		const written = JSON.parse(await readFile(path, "utf8"));
		assert.equal(written.providers[PROVIDER_ID].models.length, 3);
		assert.equal(written.providers[PROVIDER_ID].baseUrl, `${ROOT}/v1`);
		assert.deepEqual(written.providers.kept.models, [{ id: "k", name: "K" }]);
		assert.ok(!(await readFile(path, "utf8")).includes("hand-written comment"));
	});
});

test("write: a file that is not an object throws and is left alone", async () => {
	await withTemp(async (dir) => {
		const path = join(dir, "models.json");
		for (const raw of ["[1, 2]", '"a string"', "{ not json"]) {
			await writeFile(path, raw);
			await assert.rejects(() => writeMagpieModels(dir, ROOT, toPiModels(ENTRIES, ROOT)));
			assert.equal(await readFile(path, "utf8"), raw, raw);
		}
	});
});

test("write: no temp file is left behind", async () => {
	await withTemp(async (dir) => {
		await writeMagpieModels(dir, ROOT, toPiModels(ENTRIES, ROOT));
		assert.deepEqual(await readdir(dir), ["models.json"]);
	});
});

test("read: countMagpieModels reports the block's size, or nothing without one", async () => {
	await withTemp(async (dir) => {
		assert.equal(await countMagpieModels(dir), undefined);
		await writeMagpieModels(dir, ROOT, toPiModels(ENTRIES, ROOT));
		assert.equal(await countMagpieModels(dir), 3);
		const block = await readMagpieProviderBlock(dir);
		assert.equal(block?.name, PROVIDER_NAME);
	});
});
