import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	STATE_FILE_NAME,
	describeCapState,
	parseCapState,
	readCapState,
	writeCapState,
} from "../state.ts";
import { DEFAULT_CAP, DEFAULT_STATE } from "../cap.ts";

test("parseCapState: missing file falls back to defaults (enabled, 300K)", () => {
	assert.deepEqual(parseCapState(undefined), { enabled: true, cap: 300_000 });
});

test("parseCapState: malformed JSON falls back to defaults", () => {
	assert.deepEqual(parseCapState("{not json"), { ...DEFAULT_STATE });
	assert.deepEqual(parseCapState("null"), { ...DEFAULT_STATE });
	assert.deepEqual(parseCapState("[1,2]"), { ...DEFAULT_STATE });
	assert.deepEqual(parseCapState('"hi"'), { ...DEFAULT_STATE });
});

test("parseCapState: valid fields are honored", () => {
	assert.deepEqual(parseCapState('{"enabled": false, "cap": 500000}'), {
		enabled: false,
		cap: 500_000,
	});
});

test("parseCapState: wrong-typed or invalid fields fall back per-field", () => {
	assert.deepEqual(parseCapState('{"enabled": "yes"}'), { enabled: true, cap: DEFAULT_CAP });
	assert.deepEqual(parseCapState('{"cap": "300k"}'), { enabled: true, cap: DEFAULT_CAP });
	assert.deepEqual(parseCapState('{"cap": -1}'), { enabled: true, cap: DEFAULT_CAP });
	assert.deepEqual(parseCapState('{"cap": 1.5}'), { enabled: true, cap: DEFAULT_CAP });
	assert.deepEqual(parseCapState('{"enabled": false}'), { enabled: false, cap: DEFAULT_CAP });
});

test("readCapState: missing file yields defaults; write/read round-trips", () => {
	const dir = mkdtempSync(join(tmpdir(), "cwc-"));
	try {
		const path = join(dir, STATE_FILE_NAME);
		assert.deepEqual(readCapState(path), { ...DEFAULT_STATE });

		writeCapState(path, { enabled: false, cap: 640_000 });
		assert.deepEqual(readCapState(path), { enabled: false, cap: 640_000 });

		// No stray temp files left behind by the atomic write.
		writeCapState(path, { enabled: true, cap: 300_000 });
		assert.deepEqual(readCapState(path), { ...DEFAULT_STATE });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("describeCapState reads naturally in both states", () => {
	assert.equal(describeCapState({ enabled: true, cap: 300_000 }), "enabled, cap 300K");
	assert.equal(
		describeCapState({ enabled: false, cap: 300_000 }),
		"disabled (cap 300K retained)",
	);
});
