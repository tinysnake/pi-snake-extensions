/**
 * pi-think-twice.json — global config, read once at extension load.
 * Changing it requires restarting pi.
 */
import { readFileSync } from "node:fs";
import { normalizeCommandName } from "./decide.ts";

export const CONFIG_FILE_NAME = "pi-think-twice.json";
export const DEFAULT_DELAY_SECONDS = 3;
/** Commands that force the countdown even though they are built in. */
export const SEED_ALWAYS_COUNTDOWN: readonly string[] = ["compact"];

export interface ThinkTwiceConfig {
	/** Seconds the send countdown lasts; 0 disables pi-think-twice entirely. */
	readonly delaySeconds: number;
	/** Normalized command names (no leading slash): built-ins that still count down. */
	readonly alwaysCountdown: readonly string[];
}

function defaults(): ThinkTwiceConfig {
	return {
		delaySeconds: DEFAULT_DELAY_SECONDS,
		alwaysCountdown: [...SEED_ALWAYS_COUNTDOWN],
	};
}

/**
 * Parse config text. A missing, malformed, or wrong-typed file falls back to
 * the defaults (3 s); `delaySeconds: 0` is a valid, explicit opt-out.
 */
export function parseThinkTwiceConfig(raw: string | undefined): ThinkTwiceConfig {
	if (raw === undefined) return defaults();

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return defaults();
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return defaults();
	}
	const obj = parsed as Record<string, unknown>;

	let delaySeconds = DEFAULT_DELAY_SECONDS;
	const delay = obj.delaySeconds;
	if (typeof delay === "number" && Number.isFinite(delay)) {
		delaySeconds = Math.max(0, delay);
	}

	let alwaysCountdown = [...SEED_ALWAYS_COUNTDOWN];
	const extra = obj.alwaysCountdown;
	if (Array.isArray(extra)) {
		const names = extra
			.filter((entry): entry is string => typeof entry === "string")
			.map(normalizeCommandName)
			.filter((name) => name.length > 0);
		alwaysCountdown = [...new Set([...alwaysCountdown, ...names])];
	}

	return { delaySeconds, alwaysCountdown };
}

/** Read and parse the config file; any read failure yields the defaults. */
export function readThinkTwiceConfig(path: string): ThinkTwiceConfig {
	try {
		return parseThinkTwiceConfig(readFileSync(path, "utf8"));
	} catch {
		return defaults();
	}
}
