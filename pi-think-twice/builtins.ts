/**
 * pi's built-in slash commands, obtained by reflecting on the live object pi
 * hands to our editor — no hardcoded list, no internal file paths.
 *
 * How the reflection works:
 * - pi builds its `/` autocomplete from `BUILTIN_SLASH_COMMANDS` + templates +
 *   extension commands + skills, and stores that merged array as the
 *   autocomplete provider's `commands` own property (TypeScript `private` is
 *   compile-time only; at runtime it is a plain property).
 * - pi pushes that provider into every custom editor via
 *   `setAutocompleteProvider`, so our editor holds the instance.
 * - Classification is a set subtraction, not a guess:
 *     builtins = provider.commands names − pi.getCommands() names
 *   Skill entries are skipped by their `skill:` prefix regardless of which
 *   naming convention `getCommands()` uses for them.
 *
 * Error handling (a broken reflection must never affect pi): missing or
 * renamed field, non-object provider, throwing getter, empty result — every
 * failure falls back to RESERVED_BUILTIN_COMMANDS, and the caller treats any
 * decision failure as "do not countdown" (stock pi behavior).
 */

/**
 * Snapshot of pi's built-ins as of pi 0.86 — including the three easter-egg
 * commands the central metadata deliberately hides (`debug`, `arminsayshi`,
 * `dementedelves`). Used only when reflection fails; `tests/builtins.test.ts`
 * and `tests/editor.test.ts` exercise that path.
 */
export const RESERVED_BUILTIN_COMMANDS: readonly string[] = [
	"arminsayshi",
	"bug",
	"changelog",
	"clone",
	"compact",
	"copy",
	"debug",
	"dementedelves",
	"export",
	"fork",
	"hotkeys",
	"import",
	"login",
	"logout",
	"model",
	"name",
	"new",
	"quit",
	"reload",
	"resume",
	"scoped-models",
	"session",
	"settings",
	"share",
	"thinking",
	"tree",
	"trust",
];

/**
 * Built-in command names for the current provider, or the reserved snapshot
 * when reflection cannot produce a usable answer. Never throws.
 *
 * @param provider the autocomplete provider instance pi gave our editor
 * @param liveCommandNames every current `pi.getCommands()` name
 *   (extensions + templates + skills) — subtracted from the provider's list
 */
export function resolveBuiltinCommands(
	provider: unknown,
	liveCommandNames: readonly string[],
): readonly string[] {
	try {
		if (provider === null || typeof provider !== "object") return RESERVED_BUILTIN_COMMANDS;
		const commands: unknown = (provider as { commands?: unknown }).commands;
		if (!Array.isArray(commands)) return RESERVED_BUILTIN_COMMANDS;

		const live = new Set(liveCommandNames);
		const seen = new Set<string>();
		const builtins: string[] = [];
		for (const entry of commands) {
			if (entry === null || typeof entry !== "object") continue;
			const name = (entry as { name?: unknown }).name;
			if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
			seen.add(name);
			if (name.startsWith("skill:")) continue; // skills are messages, never built-ins
			if (live.has(name)) continue; // template / extension / skill from getCommands()
			builtins.push(name);
		}
		// An empty result means the shape we reflected on was not what we
		// expect — treat it as a reflection failure, not "pi has no commands".
		if (builtins.length > 0) return builtins;
		return RESERVED_BUILTIN_COMMANDS;
	} catch {
		return RESERVED_BUILTIN_COMMANDS;
	}
}
