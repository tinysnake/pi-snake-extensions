/**
 * Countdown decision for one piece of submitted text.
 *
 * The rule: a submit either *executes an action* (exempt — no countdown) or
 * *becomes a message the model sees* (countdown). Skills, prompt templates and
 * mistyped slash commands are messages, so they count down. See CONTEXT.md
 * ("Command" vs "Message").
 *
 * No command list lives here: built-ins arrive from pi itself (reflected from
 * the autocomplete provider, see builtins.ts), registered commands from
 * `pi.getCommands()`, and users can force either side through the
 * `alwaysCountdown` config.
 */

export interface CountdownPolicy {
	/** Command names (no leading slash) that always count down, even when built in or registered. */
	alwaysCountdown: readonly string[];
	/** Built-in command names (no leading slash), dynamically from pi. */
	builtinCommands: readonly string[];
	/** Registered extension command names (no leading slash), from `pi.getCommands()`. */
	extensionCommands: readonly string[];
}

/** Normalize a command entry: trim, drop the leading slash, drop empties. */
export function normalizeCommandName(entry: string): string {
	return entry.trim().replace(/^\/+/, "");
}

/**
 * The first slash-command token of a trimmed submission, or `undefined` when
 * the text is not slash-prefixed. `/compact foo` → `"compact"`.
 */
export function slashCommandName(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	return trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
}

/** Whether this submission should open the send countdown. */
export function shouldCountdown(text: string, policy: CountdownPolicy): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;

	const name = slashCommandName(trimmed);
	if (name !== undefined) {
		// alwaysCountdown wins outright: the /compact exception is unconditional.
		if (policy.alwaysCountdown.includes(name)) return true;
		if (policy.builtinCommands.includes(name)) return false;
		if (policy.extensionCommands.includes(name)) return false;
		// Unknown slash input, skills, templates: this becomes a message.
		return true;
	}
	// Plain text and `!bash` submissions are messages/actions the model feels.
	return true;
}
