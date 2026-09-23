/**
 * pi-think-twice — send countdown for the pi coding agent.
 *
 * Enter no longer sends immediately: it opens a send countdown (default 3 s)
 * with the text staying in the editor. Any key interrupts and leaves you
 * editing; Enter alone is ignored until `doubleEnterSeconds` (default 1 s)
 * have elapsed since the first one, after which Enter sends immediately;
 * Ctrl+Enter sends immediately. Exempt commands (built-in and registered)
 * submit as before — unless listed in `alwaysCountdown` (seeded with
 * `/compact`).
 *
 * Built-in commands are not hardcoded: they are reflected from the live
 * autocomplete provider pi hands to our editor (see builtins.ts), with a
 * reserved snapshot and fail-open behavior behind it, so a broken reflection
 * never affects pi.
 *
 * Config: `~/.pi/agent/pi-think-twice.json`
 *   { "delaySeconds": 3, "doubleEnterSeconds": 1, "alwaysCountdown": ["/compact"] }
 * `delaySeconds: 0` disables the extension. Restart pi after editing.
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { CONFIG_FILE_NAME, readThinkTwiceConfig } from "./config.ts";
import { shouldCountdown } from "./decide.ts";
import { ThinkTwiceEditor } from "./think-twice-editor.ts";

export default function (pi: ExtensionAPI) {
	// Read once per process: config changes take effect on restart.
	const config = readThinkTwiceConfig(join(getAgentDir(), CONFIG_FILE_NAME));
	if (config.delaySeconds <= 0) return;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const theme = ctx.ui.theme;
		ctx.ui.setEditorComponent(
			(tui, editorTheme, keybindings) =>
				new ThinkTwiceEditor(tui, editorTheme, keybindings, {
					delaySeconds: config.delaySeconds,
					doubleEnterSeconds: config.doubleEnterSeconds,
					shouldCountdown: (text, builtinCommands) =>
						shouldCountdown(text, {
							alwaysCountdown: config.alwaysCountdown,
							builtinCommands,
							// Live on every decision: commands can register at runtime.
							extensionCommands: pi
								.getCommands()
								.filter((command) => command.source === "extension")
								.map((command) => command.name),
						}),
					liveCommandNames: () => pi.getCommands().map((command) => command.name),
					// Whole countdown text in the theme's warning color (yellow/orange).
					warning: (s) => theme.fg("warning", s),
				}),
		);
	});
}
