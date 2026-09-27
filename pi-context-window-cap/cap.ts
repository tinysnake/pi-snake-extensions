/**
 * Pure cap logic — no pi imports, fully unit-testable.
 *
 * The cap is a single global number. The effective (target) context window for
 * a model is `min(original, cap)` while enabled, and the untouched original
 * while disabled — restoring never needs a stored per-model map because the
 * registry keeps pristine values (index.ts never mutates registry objects).
 */

/** Minimum accepted cap: must exceed compaction reserve (16384) + keepRecent (20000) with headroom. */
export const MIN_CAP = 40_000;
/** Default cap applied when no state file exists: 300K tokens. */
export const DEFAULT_CAP = 300_000;

export interface CapState {
	/** Whether the cap is enforced right now. */
	enabled: boolean;
	/** Upper bound in tokens; effective window is min(original, cap). */
	cap: number;
}

/** Defaults: enabled on first run, 300K cap. */
export const DEFAULT_STATE: CapState = { enabled: true, cap: DEFAULT_CAP };

/**
 * Parse a cap value like "300k", "300K", "1.5m", "300000", " 300k ".
 * Returns a positive integer token count, or undefined when the input is not a
 * valid cap expression (caller decides how to report it).
 */
export function parseCapValue(raw: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(raw.trim());
	if (!match) return undefined;
	const scale = match[2] ? match[2].toLowerCase() === "k" ? 1_000 : 1_000_000 : 1;
	const value = Math.round(Number(match[1]) * scale);
	if (!Number.isSafeInteger(value) || value <= 0) return undefined;
	return value;
}

/**
 * Format a token count for humans: 300000 → "300K", 1500000 → "1.5M",
 * 1048576 → "1M", 65536 → "65.5K". Rounds to one decimal, strips trailing ".0".
 */
export function formatCapValue(tokens: number): string {
	const scaled = (value: number, suffix: string): string => {
		const rounded = Math.round(value * 10) / 10;
		return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${suffix}`;
	};
	if (tokens >= 1_000_000) return scaled(tokens / 1_000_000, "M");
	if (tokens >= 1_000) return scaled(tokens / 1_000, "K");
	return String(tokens);
}

/**
 * Effective context window for a model given its original window.
 * Enabled: min(original, cap). Disabled: original (full restore).
 */
export function targetContextWindow(original: number, state: CapState): number {
	return state.enabled ? Math.min(original, state.cap) : original;
}

/**
 * Validate a parsed cap against the floor. Returns an error message or undefined.
 * The floor keeps compaction reserve + keepRecent comfortably below the cap so
 * auto-compaction cannot thrash (trigger and post-compact size would overlap).
 */
export function validateCap(cap: number): string | undefined {
	if (cap < MIN_CAP) {
		return `cap ${formatCapValue(cap)} is below the minimum ${formatCapValue(MIN_CAP)} (compaction needs reserve+keepRecent headroom)`;
	}
	return undefined;
}

/** Minimal shape of a model this module reasons about — structural, so real Model objects fit. */
export interface Windowed {
	contextWindow: number;
}

export type ClampPlan =
	/** Window already at the target; do nothing. */
	| { kind: "noop" }
	/** Window must change: swap in a clone carrying the target window. */
	| { kind: "clone"; window: number };

/**
 * Decide how to bring `current`'s window to its target for `state`.
 *
 * The plan is always a clone swap, never an in-place mutation: the active
 * model object may be shared with the catalog snapshot, while `find()` can
 * rebuild objects per call — so identity checks cannot prove a copy is
 * private (a mutating variant polluted the registry intermittently). The
 * registry's pristine values stay readable for restore either way.
 */
export function planClamp(
	current: Windowed,
	pristine: Windowed | undefined,
	state: CapState,
): ClampPlan {
	const original = pristine?.contextWindow ?? current.contextWindow;
	const target = targetContextWindow(original, state);
	if (current.contextWindow === target) return { kind: "noop" };
	return { kind: "clone", window: target };
}
