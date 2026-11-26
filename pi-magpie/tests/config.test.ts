import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { magpieConfigPath, readMagpieConfig } from "../config.ts";

const realConfigEnv = process.env.PI_MAGPIE_CONFIG;
let dir: string;

before(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-magpie-config-"));
});

after(async () => {
	if (realConfigEnv === undefined) delete process.env.PI_MAGPIE_CONFIG;
	else process.env.PI_MAGPIE_CONFIG = realConfigEnv;
	await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
	delete process.env.PI_MAGPIE_CONFIG;
});

test("config: a missing file leaves the switch off", () => {
	assert.deepEqual(readMagpieConfig(join(dir, "no-such-agent")), { modelsJson: false });
});

test("config: only a plain object with modelsJson true turns the switch on", async () => {
	const cases: Array<[unknown, boolean]> = [
		[{ modelsJson: true }, true],
		[{ modelsJson: false }, false],
		[{ modelsJson: "true" }, false],
		[{ modelsJson: 1 }, false],
		[{ modelsJson: null }, false],
		[{}, false],
		[[], false],
		[[{ modelsJson: true }], false],
		["on", false],
		[null, false],
		[42, false],
	];
	let index = 0;
	for (const [value, expected] of cases) {
		const path = join(dir, `case-${index++}.json`);
		await writeFile(path, JSON.stringify(value));
		process.env.PI_MAGPIE_CONFIG = path;
		assert.equal(readMagpieConfig(dir).modelsJson, expected, JSON.stringify(value));
	}
});

test("config: a malformed file leaves the switch off", async () => {
	const path = join(dir, "malformed.json");
	await writeFile(path, "{ modelsJson: true, // not json");
	process.env.PI_MAGPIE_CONFIG = path;
	assert.equal(readMagpieConfig(dir).modelsJson, false);
});

test("config: PI_MAGPIE_CONFIG overrides the agent dir", async () => {
	await writeFile(join(dir, "pi-magpie.json"), JSON.stringify({ modelsJson: false }));
	const other = join(dir, "elsewhere.json");
	await writeFile(other, JSON.stringify({ modelsJson: true }));
	assert.equal(readMagpieConfig(dir).modelsJson, false, "the agent dir's file is the default");
	process.env.PI_MAGPIE_CONFIG = other;
	assert.equal(readMagpieConfig(dir).modelsJson, true, "the env override wins");
});

test("config: the default path is pi-magpie.json in the agent dir", () => {
	assert.equal(magpieConfigPath(dir), join(dir, "pi-magpie.json"));
	process.env.PI_MAGPIE_CONFIG = "  /tmp/pi-magpie-test.json  ";
	assert.equal(magpieConfigPath(dir), "/tmp/pi-magpie-test.json");
});
