/**
 * pi-context-window-cap — a hard global cap on every model's context window.
 *
 * One global number (default 300K) bounds the effective context window of
 * every model pi uses. While the cap is enabled, the active model's window is
 * min(original, cap); compaction, the footer context meter, and overflow
 * recovery all read that window, so sessions stop growing at the cap. While
 * disabled, the original window is restored.
 *
 * Restore never needs a per-model map: registry model objects are treated as
 * pristine and are never mutated — the active model may itself be a shared
 * catalog entry, and identity checks cannot reliably prove otherwise. Every
 * effective-window change swaps in a clone via setModel(); the registry keeps
 * the original, so the original window is always recoverable.
 *
 * Config: `~/.pi/agent/context-window-cap.json`
 *   { "enabled": true, "cap": 300000 }
 * `enabled` defaults true, `cap` defaults 300000 (minimum 40000).
 *
 * Commands:
 *   /context-window-cap            show status
 *   /context-window-cap toggle     flip the global switch
 *   /context-window-cap on | off   set the global switch
 *   /context-window-cap set 300k   change the cap (300k / 1.5m / 300000)
 *
 * The footer shows `ctx-cap 300K` while enabled and `ctx-cap off` while disabled.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
	formatCapValue,
	parseCapValue,
	planClamp,
	validateCap,
	type CapState,
} from "./cap.ts";
import { STATE_FILE_NAME, describeCapState, readCapState, writeCapState } from "./state.ts";

const STATUS_KEY = "ctxcap";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	const statePath = join(getAgentDir(), STATE_FILE_NAME);
	let state: CapState = readCapState(statePath);

	const persist = (): string | undefined => {
		try {
			writeCapState(statePath, state);
			return undefined;
		} catch (error) {
			return errorMessage(error);
		}
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		ctx.ui.setStatus(STATUS_KEY, state.enabled ? `ctx-cap ${formatCapValue(state.cap)}` : "ctx-cap off");
	};

	/**
	 * Bring the active model's window to its target for the current state.
	 * Idempotent: a no-op when the window already matches, so it is safe to
	 * call from every event without producing transcript noise. The swap never
	 * mutates model objects — the active one may be shared with the catalog
	 * snapshot, and identity checks cannot reliably prove it is a private copy.
	 */
	const applyCap = async (ctx: ExtensionContext): Promise<void> => {
		const current = ctx.model;
		if (!current) return;
		const pristine = ctx.modelRegistry.find(current.provider, current.id);
		const plan = planClamp(current, pristine, state);
		if (plan.kind === "noop") return;

		// Swap in a clone with the target window; the registry keeps the original
		// so restore and cap-raises always re-read it. setModel re-derives the
		// thinking level from defaults, so pin back the session's choice — only
		// when it actually changed, to avoid a spurious transcript entry.
		const level = pi.getThinkingLevel();
		try {
			const ok = await pi.setModel({ ...current, contextWindow: plan.window });
			if (ok && pi.getThinkingLevel() !== level) pi.setThinkingLevel(level);
		} catch {
			// Auth race or shutdown — the next event retries the clamp.
		}
		// ok === false: the provider has no configured auth; the model cannot
		// run, so leaving it uncapped costs nothing.
	};

	pi.on("session_start", (_event, ctx) => {
		// Re-read: another pi process may have toggled the state file.
		state = readCapState(statePath);
		updateStatus(ctx);
		return applyCap(ctx);
	});

	pi.on("model_select", (_event, ctx) => applyCap(ctx));

	// Safety nets: a registry refresh can replace state.model with the pristine
	// catalog object between user actions; re-clamp before it is ever used.
	pi.on("before_agent_start", (_event, ctx) => applyCap(ctx));
	pi.on("turn_start", (_event, ctx) => applyCap(ctx));

	pi.registerCommand("context-window-cap", {
		description: "Toggle or set the global context-window cap",
		getArgumentCompletions: (argumentPrefix) => {
			if (argumentPrefix.includes(" ")) {
				if (!argumentPrefix.startsWith("set")) return null;
				const values = ["64k", "128k", "256k", "300k", "500k", "1m"];
				const items = values
					.map((value) => `set ${value}`)
					.filter((value) => value.startsWith(argumentPrefix))
					.map((value) => ({ value, label: value }));
				return items.length > 0 ? items : null;
			}
			const subcommands = ["toggle", "on", "off", "set", "status"];
			const items = subcommands
				.filter((value) => value.startsWith(argumentPrefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const notify = (message: string, type: "info" | "warning" | "error" = "info") =>
				ctx.ui.notify(message, type);

			const report = async () => {
				// Re-apply so `status` also repairs a window a registry refresh
				// reset behind our back, then describe what is actually in effect.
				await applyCap(ctx);
				updateStatus(ctx);
				const model = ctx.model;
				if (!model) {
					notify(`context-window-cap: ${describeCapState(state)} (no active model)`);
					return;
				}
				const pristine = ctx.modelRegistry.find(model.provider, model.id);
				const original = pristine?.contextWindow ?? model.contextWindow;
				const effect =
					original !== model.contextWindow
						? ` — ${model.provider}/${model.id}: ${formatCapValue(original)} → ${formatCapValue(model.contextWindow)}`
						: ` — ${model.provider}/${model.id}: ${formatCapValue(model.contextWindow)}`;
				notify(`context-window-cap: ${describeCapState(state)}${effect}`);
			};

			switch (subcommand) {
				case undefined:
				case "status":
					await report();
					return;

				case "toggle":
					state.enabled = !state.enabled;
					break;

				case "on":
					state.enabled = true;
					break;

				case "off":
					state.enabled = false;
					break;

				case "set": {
					const raw = rest.join(" ");
					const value = parseCapValue(raw);
					if (value === undefined) {
						notify(
							`context-window-cap: invalid cap "${raw}" — use e.g. 300k, 1.5m, 300000`,
							"warning",
						);
						return;
					}
					const error = validateCap(value);
					if (error) {
						notify(`context-window-cap: ${error}`, "warning");
						return;
					}
					state.cap = value;
					break;
				}

				default:
					notify(
						`context-window-cap: unknown subcommand "${subcommand}" — usage: /context-window-cap [status|toggle|on|off|set <cap>]`,
						"warning",
					);
					return;
			}

			const saveError = persist();
			await applyCap(ctx);
			updateStatus(ctx);
			if (saveError) {
				notify(
					`context-window-cap: ${describeCapState(state)} (state saved failed: ${saveError})`,
					"error",
				);
				return;
			}
			notify(`context-window-cap: ${describeCapState(state)}`);
		},
	});
}
