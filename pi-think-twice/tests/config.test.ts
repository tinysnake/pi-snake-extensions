import { test } from "node:test";
import assert from "node:assert/strict";
import { parseThinkTwiceConfig, DEFAULT_DELAY_SECONDS, DEFAULT_DOUBLE_ENTER_SECONDS, SEED_ALWAYS_COUNTDOWN } from "../config.ts";

test("missing config falls back to defaults", () => {
	const config = parseThinkTwiceConfig(undefined);
	assert.equal(config.delaySeconds, 3);
	assert.equal(config.doubleEnterSeconds, 1);
	assert.deepEqual([...config.alwaysCountdown], [...SEED_ALWAYS_COUNTDOWN]);
});

test("malformed JSON falls back to defaults", () => {
	const config = parseThinkTwiceConfig("{not json");
	assert.equal(config.delaySeconds, DEFAULT_DELAY_SECONDS);
});

test("non-object JSON falls back to defaults", () => {
	assert.equal(parseThinkTwiceConfig("null").delaySeconds, DEFAULT_DELAY_SECONDS);
	assert.equal(parseThinkTwiceConfig("[1,2]").delaySeconds, DEFAULT_DELAY_SECONDS);
	assert.equal(parseThinkTwiceConfig('"hi"').delaySeconds, DEFAULT_DELAY_SECONDS);
});

test("explicit 0 disables", () => {
	assert.equal(parseThinkTwiceConfig('{"delaySeconds": 0}').delaySeconds, 0);
});

test("valid delay is honored, negative clamps to 0, invalid type falls back to 3", () => {
	assert.equal(parseThinkTwiceConfig('{"delaySeconds": 7}').delaySeconds, 7);
	assert.equal(parseThinkTwiceConfig('{"delaySeconds": -1}').delaySeconds, 0);
	assert.equal(parseThinkTwiceConfig('{"delaySeconds": "5"}').delaySeconds, DEFAULT_DELAY_SECONDS);
	assert.equal(parseThinkTwiceConfig('{"delaySeconds": null}').delaySeconds, DEFAULT_DELAY_SECONDS);
});

test("doubleEnterSeconds: valid values honored, negative clamps to 0, wrong type falls back to 1", () => {
	assert.equal(parseThinkTwiceConfig("{}").doubleEnterSeconds, DEFAULT_DOUBLE_ENTER_SECONDS);
	assert.equal(parseThinkTwiceConfig('{"doubleEnterSeconds": 2.5}').doubleEnterSeconds, 2.5);
	assert.equal(parseThinkTwiceConfig('{"doubleEnterSeconds": 0}').doubleEnterSeconds, 0);
	assert.equal(parseThinkTwiceConfig('{"doubleEnterSeconds": -1}').doubleEnterSeconds, 0);
	assert.equal(parseThinkTwiceConfig('{"doubleEnterSeconds": "1"}').doubleEnterSeconds, 1);
	assert.equal(parseThinkTwiceConfig('{"doubleEnterSeconds": null}').doubleEnterSeconds, 1);
	assert.equal(parseThinkTwiceConfig('{"doubleEnterSeconds": NaN-ish}').doubleEnterSeconds, 1);
});

test("alwaysCountdown unions with the seed and normalizes entries", () => {
	const config = parseThinkTwiceConfig('{"alwaysCountdown": ["/resume", "tree", "/compact", 42, "  "]}');
	// seed + extras, deduped; non-strings and empties dropped; slashes stripped
	assert.deepEqual([...config.alwaysCountdown].sort(), ["compact", "resume", "tree"]);
});

test("absent or wrong-typed alwaysCountdown keeps the seed", () => {
	assert.deepEqual([...parseThinkTwiceConfig("{}").alwaysCountdown], [...SEED_ALWAYS_COUNTDOWN]);
	assert.deepEqual([...parseThinkTwiceConfig('{"alwaysCountdown": "compact"}').alwaysCountdown], [
		...SEED_ALWAYS_COUNTDOWN,
	]);
});
