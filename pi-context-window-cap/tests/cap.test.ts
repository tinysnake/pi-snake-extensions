import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CAP,
	MIN_CAP,
	formatCapValue,
	parseCapValue,
	planClamp,
	targetContextWindow,
	validateCap,
} from "../cap.ts";

test("parseCapValue: k/m suffixes, case-insensitive, whitespace tolerant", () => {
	assert.equal(parseCapValue("300k"), 300_000);
	assert.equal(parseCapValue("300K"), 300_000);
	assert.equal(parseCapValue("300000"), 300_000);
	assert.equal(parseCapValue(" 300k "), 300_000);
	assert.equal(parseCapValue("1.5m"), 1_500_000);
	assert.equal(parseCapValue("1M"), 1_000_000);
	assert.equal(parseCapValue("64k"), 64_000);
	assert.equal(parseCapValue("0.5k"), 500);
});

test("parseCapValue: invalid input returns undefined", () => {
	assert.equal(parseCapValue(""), undefined);
	assert.equal(parseCapValue("abc"), undefined);
	assert.equal(parseCapValue("-300k"), undefined);
	assert.equal(parseCapValue("300kk"), undefined);
	assert.equal(parseCapValue("k"), undefined);
	assert.equal(parseCapValue("300k tokens"), undefined);
	assert.equal(parseCapValue("0"), undefined);
});

test("formatCapValue rounds to one decimal and strips .0", () => {
	assert.equal(formatCapValue(300_000), "300K");
	assert.equal(formatCapValue(1_500_000), "1.5M");
	assert.equal(formatCapValue(1_048_576), "1M");
	assert.equal(formatCapValue(65_536), "65.5K");
	assert.equal(formatCapValue(64_000), "64K");
	assert.equal(formatCapValue(420), "420");
});

test("targetContextWindow: enabled caps down to min(original, cap)", () => {
	const on = { enabled: true, cap: 300_000 };
	assert.equal(targetContextWindow(1_048_576, on), 300_000);
	assert.equal(targetContextWindow(300_000, on), 300_000);
	// Smaller-than-cap models are never inflated up to the cap.
	assert.equal(targetContextWindow(128_000, on), 128_000);
});

test("targetContextWindow: disabled fully restores the original", () => {
	const off = { enabled: false, cap: 300_000 };
	assert.equal(targetContextWindow(1_048_576, off), 1_048_576);
	assert.equal(targetContextWindow(128_000, off), 128_000);
});

test("targetContextWindow: raising the cap frees previously capped models", () => {
	// set 600k: a 500k model goes back to 500k, a 1M model goes to 600k.
	const raised = { enabled: true, cap: 600_000 };
	assert.equal(targetContextWindow(500_000, raised), 500_000);
	assert.equal(targetContextWindow(1_048_576, raised), 600_000);
});

test("validateCap rejects caps below the floor", () => {
	assert.equal(validateCap(MIN_CAP), undefined);
	assert.notEqual(validateCap(MIN_CAP - 1), undefined);
	assert.notEqual(validateCap(1_000), undefined);
	assert.equal(validateCap(DEFAULT_CAP), undefined);
});

test("planClamp: registry-owned object plans a clone, never a mutation", () => {
	const shared = { contextWindow: 1_048_576 };
	const plan = planClamp(shared, shared, { enabled: true, cap: 300_000 });
	assert.deepEqual(plan, { kind: "clone", window: 300_000 });
});

test("planClamp: a window needing a change always plans a clone", () => {
	const shared = { contextWindow: 1_048_576 };
	// Identity is deliberately ignored: the active object may be shared with
	// the catalog even when find() hands back a rebuilt copy.
	const copy = { contextWindow: 1_048_576 };
	assert.deepEqual(planClamp(copy, shared, { enabled: true, cap: 300_000 }), {
		kind: "clone",
		window: 300_000,
	});
});

test("planClamp: disabled state plans restoring the pristine original", () => {
	const shared = { contextWindow: 1_048_576 };
	const cappedCopy = { contextWindow: 300_000 };
	const plan = planClamp(cappedCopy, shared, { enabled: false, cap: 300_000 });
	assert.deepEqual(plan, { kind: "clone", window: 1_048_576 });
});

test("planClamp: raising the cap re-opens a copy to its original", () => {
	const shared = { contextWindow: 500_000 };
	const cappedCopy = { contextWindow: 300_000 };
	const plan = planClamp(cappedCopy, shared, { enabled: true, cap: 600_000 });
	assert.deepEqual(plan, { kind: "clone", window: 500_000 });
});

test("planClamp: window already at target is a noop", () => {
	const shared = { contextWindow: 128_000 };
	assert.equal(planClamp(shared, shared, { enabled: true, cap: 300_000 }).kind, "noop");

	const alreadyCapped = { contextWindow: 300_000 };
	assert.equal(
		planClamp(alreadyCapped, { contextWindow: 1_048_576 }, { enabled: true, cap: 300_000 }).kind,
		"noop",
	);
});

test("planClamp: unknown-provenance model (not in registry) plans a clone", () => {
	// No pristine to compare against: the clone swap keeps the unknown object
	// itself untouched.
	const orphan = { contextWindow: 1_048_576 };
	assert.deepEqual(planClamp(orphan, undefined, { enabled: true, cap: 300_000 }), {
		kind: "clone",
		window: 300_000,
	});
});
