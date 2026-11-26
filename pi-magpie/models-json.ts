/**
 * pi-magpie — writing magpie's catalog into pi's `models.json`.
 *
 * With the `modelsJson` switch on, the extension freezes the live catalog into
 * `providers.magpie`, the same block magpie's own writer puts there, so the
 * models still work in a pi that cannot load this extension. Each model carries
 * its own `api` and `baseUrl`, so native paths survive (`providers.magpie`'s
 * one baseUrl would point an Anthropic model at `/v1/v1/messages`).
 *
 * The file is read with `//` and block comments stripped (pi does the same),
 * every other key and provider is kept in place, and the block is replaced
 * only when it differs, so an unchanged catalog never churns the file.
 */

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseUrlFor, type PiMagpieModel } from "./catalog.ts";
import { DEFAULT_TOKEN, PROVIDER_ID, PROVIDER_NAME } from "./constants.ts";

/** A model as it appears in models.json: pi's schema keys, nothing private. */
export interface ModelsJsonModel {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	reasoning: boolean;
	input: readonly string[];
	cost: PiMagpieModel["cost"];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: PiMagpieModel["thinkingLevelMap"];
	compat?: PiMagpieModel["compat"];
}

/** The `providers.magpie` block this extension writes. */
export interface MagpieProviderBlock {
	api: string;
	apiKey: string;
	baseUrl: string;
	compat: { sendSessionAffinityHeaders: true };
	models: ModelsJsonModel[];
	name: string;
}

/** What a write did, for the report. */
export interface WriteResult {
	path: string;
	/** How many models the block holds. */
	models: number;
	/** Whether the file on disk changed. */
	changed: boolean;
}

/** One pi model as a models.json entry, dropping this extension's own fields. */
export function toModelsJsonModel(model: PiMagpieModel): ModelsJsonModel {
	const entry: ModelsJsonModel = {
		id: model.id,
		name: model.name,
		api: model.api,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
	if (model.thinkingLevelMap) entry.thinkingLevelMap = model.thinkingLevelMap;
	if (model.compat) entry.compat = model.compat;
	return entry;
}

/**
 * The `providers.magpie` block for a catalog and a gateway. The provider-level
 * `api` and `baseUrl` are the block's defaults; every model carries its own.
 */
export function magpieProviderBlock(
	root: string,
	models: readonly PiMagpieModel[],
): MagpieProviderBlock {
	return {
		api: "openai-completions",
		apiKey: DEFAULT_TOKEN,
		baseUrl: baseUrlFor(root, "v1"),
		compat: { sendSessionAffinityHeaders: true },
		models: models.map(toModelsJsonModel),
		name: PROVIDER_NAME,
	};
}

/** JSON with the comments pi's loader strips: `//` lines and block comments. */
export function parseJsonc(text: string): unknown {
	return JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, "")));
}

/**
 * Comments, and quotes inside them, are tracked so a `//` in a string is not a
 * comment and a quote in a comment does not open a string.
 */
function stripJsonComments(text: string): string {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
			continue;
		}
		out += ch;
	}
	return out;
}

/**
 * Write `providers.magpie` into the agent dir's models.json.
 *
 * Creates the file when absent. Throws, leaving the file byte-identical, when
 * it exists but does not parse or is not a JSON object. Writes atomically — a
 * temp file in the same directory, then a rename — and only when the block
 * differs from what is there, reporting `changed: false` otherwise.
 */
export async function writeMagpieModels(
	agentDir: string,
	root: string,
	models: readonly PiMagpieModel[],
): Promise<WriteResult> {
	const path = join(agentDir, "models.json");
	const block = magpieProviderBlock(root, models);
	let raw: string | undefined;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		raw = undefined;
	}
	let document: Record<string, unknown> = {};
	if (raw !== undefined) {
		const parsed = parseJsonc(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${path} is not a JSON object`);
		}
		document = parsed as Record<string, unknown>;
	}
	const providers = plainObject(document.providers) ?? {};
	if (raw !== undefined && jsonEqual(providers[PROVIDER_ID], block)) {
		return { path, models: block.models.length, changed: false };
	}
	providers[PROVIDER_ID] = block;
	document.providers = providers;
	await writeAtomic(path, `${JSON.stringify(document, null, 2)}\n`);
	return { path, models: block.models.length, changed: true };
}

/** The `providers.magpie` block already on disk, when there is one. */
export async function readMagpieProviderBlock(
	agentDir: string,
): Promise<MagpieProviderBlock | undefined> {
	try {
		const parsed = parseJsonc(await readFile(join(agentDir, "models.json"), "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const providers = plainObject((parsed as Record<string, unknown>).providers);
		const block = providers?.[PROVIDER_ID];
		return plainObject(block) ? (block as unknown as MagpieProviderBlock) : undefined;
	} catch {
		return undefined;
	}
}

/** How many models the block on disk holds, or undefined when there is none. */
export async function countMagpieModels(agentDir: string): Promise<number | undefined> {
	const block = await readMagpieProviderBlock(agentDir);
	return Array.isArray(block?.models) ? block.models.length : undefined;
}

/** Atomic write in one directory: a temp file, then a rename; the temp is dropped on failure. */
export async function writeAtomic(path: string, content: string): Promise<void> {
	const temp = `${path}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2)}.tmp`;
	try {
		await writeFile(temp, content, "utf8");
		await rename(temp, path);
	} catch (error) {
		await unlink(temp).catch(() => {});
		throw error;
	}
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Structural equality, key order ignored: an unchanged block is not rewritten. */
function jsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => jsonEqual(item, b[i]));
	}
	if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
		const left = a as Record<string, unknown>;
		const right = b as Record<string, unknown>;
		const keys = Object.keys(left);
		if (keys.length !== Object.keys(right).length) return false;
		return keys.every((key) => jsonEqual(left[key], right[key]));
	}
	return false;
}
