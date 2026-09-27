/**
 * Persistent state for pi-context-window-cap.
 *
 * Stored at `<agent-dir>/context-window-cap.json`, outside every session:
 *   { "enabled": true, "cap": 300000 }
 *
 * A missing or malformed file falls back to the defaults (enabled, 300K) so a
 * corrupt state file can never leave the extension dead. Writes are atomic
 * (tmp + rename) because the command handler writes while events may read.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_STATE, formatCapValue, type CapState } from "./cap.ts";

export const STATE_FILE_NAME = "context-window-cap.json";

/**
 * Parse state text. A missing, malformed, or wrong-typed field falls back to
 * that field's default — `enabled` defaults true, `cap` defaults 300000.
 */
export function parseCapState(raw: string | undefined): CapState {
	if (raw === undefined) return { ...DEFAULT_STATE };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ...DEFAULT_STATE };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ...DEFAULT_STATE };
	}
	const obj = parsed as Record<string, unknown>;

	const enabled = typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_STATE.enabled;
	let cap = DEFAULT_STATE.cap;
	if (typeof obj.cap === "number" && Number.isSafeInteger(obj.cap) && obj.cap > 0) {
		cap = obj.cap;
	}
	return { enabled, cap };
}

/** Read and parse the state file; any read failure yields the defaults. */
export function readCapState(path: string): CapState {
	try {
		return parseCapState(readFileSync(path, "utf8"));
	} catch {
		return { ...DEFAULT_STATE };
	}
}

/**
 * Write state atomically. Throws on failure so the command handler can report
 * it — a silently-lost toggle would be worse than an error message.
 */
export function writeCapState(path: string, state: CapState): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, "\t")}\n`);
	renameSync(tmp, path);
}

/** One-line human summary used by /context-window-cap status and notifications. */
export function describeCapState(state: CapState): string {
	return state.enabled
		? `enabled, cap ${formatCapValue(state.cap)}`
		: `disabled (cap ${formatCapValue(state.cap)} retained)`;
}
