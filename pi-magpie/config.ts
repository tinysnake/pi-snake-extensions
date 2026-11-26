/**
 * pi-magpie — the extension's own config file.
 *
 * One switch so far: write magpie's catalog into pi's models.json, so the
 * models survive a pi that cannot load this extension. Read synchronously at
 * load, before any async work exists, because whether the extension serves its
 * own model list is decided when the provider is built. `/magpie models-json`
 * writes this file through the same reader, so nobody edits it by hand.
 *
 * The file is `PI_MAGPIE_CONFIG` when set (the test seam), else
 * `pi-magpie.json` in pi's agent directory.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./models-json.ts";

/** Where the extension's config lives: the env override, else the agent dir. */
export function magpieConfigPath(agentDir: string): string {
	const override = process.env.PI_MAGPIE_CONFIG?.trim();
	return override ? override : join(agentDir, "pi-magpie.json");
}

/** The extension's config, every field defaulted. */
export interface MagpieConfig {
	/** Write the live catalog into pi's models.json, and serve no models of our own. */
	modelsJson: boolean;
}

/**
 * Read the config. A missing, unreadable or malformed file, a non-object, or
 * an array is the default: the switch is off.
 */
export function readMagpieConfig(agentDir: string): MagpieConfig {
	try {
		const parsed = JSON.parse(readFileSync(magpieConfigPath(agentDir), "utf8")) as unknown;
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { modelsJson: (parsed as { modelsJson?: unknown }).modelsJson === true };
		}
	} catch {
		// Missing, unreadable or malformed: the default applies.
	}
	return { modelsJson: false };
}

/**
 * Merge a patch into the config file, keeping every other key, and answer the
 * path written. A missing, unreadable, malformed or non-object file is
 * replaced from an empty object; a plain object is the starting point. Writes
 * atomically, like models.json: a temp file in the same directory, then a
 * rename.
 */
export async function writeMagpieConfig(
	agentDir: string,
	patch: Partial<MagpieConfig>,
): Promise<string> {
	const path = magpieConfigPath(agentDir);
	let current: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			current = parsed as Record<string, unknown>;
		}
	} catch {
		// Missing, unreadable or malformed: start from an empty object.
	}
	const next = { ...current, ...patch };
	await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
	return path;
}
