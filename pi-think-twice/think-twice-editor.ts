/**
 * The pi-think-twice editor: intercepts Enter, keeps the text in the box, and runs
 * the send countdown in the editor's top border.
 *
 * Key handling, per the design:
 * - Enter while idle (non-exempt text): start the countdown, text stays put.
 * - Any key while counting down: cancel (text stays — keep editing).
 * - Enter while counting down: ignored (no send, no restart, no cancel).
 * - Ctrl+Enter: send now — skips the countdown when idle, finishes it early
 *   while active.
 *
 * Failure policy: every pi-think-twice code path that could break (decision,
 * reflection, ticking, rendering) degrades to stock pi behavior — fail open to
 * an immediate submit, or keep the text and stop the timer. No failure path
 * leaves pi stuck or crashes the TUI.
 */
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	visibleWidth,
	type AutocompleteProvider,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { resolveBuiltinCommands } from "./builtins.ts";

/** Same braille frames as pi's own working spinner (pi-tui Loader defaults). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 80;
/** Plain Enter for replaying a submit; "\r" matches "enter" in every key mode. */
const SUBMIT_KEY = "\r";
const TAB_KEY = "\t";

export interface ThinkTwiceEditorOptions {
	/** Countdown length in seconds (> 0; the extension is not installed at 0). */
	delaySeconds: number;
	/**
	 * Decides whether this submission opens the countdown. Receives the
	 * built-in command names reflected from pi's autocomplete provider.
	 */
	shouldCountdown: (text: string, builtinCommands: readonly string[]) => boolean;
	/**
	 * Every current `pi.getCommands()` name — subtracted from the provider's
	 * list to isolate the built-ins.
	 */
	liveCommandNames: () => readonly string[];
	/** Spinner color; falls back to the editor border color. */
	accent?: (text: string) => string;
	/** Countdown text color; falls back to the editor border color. */
	muted?: (text: string) => string;
}

export class ThinkTwiceEditor extends CustomEditor {
	private readonly kb: KeybindingsManager;
	private readonly delayMs: number;
	private readonly shouldCountdownFn: ThinkTwiceEditorOptions["shouldCountdown"];
	private readonly liveCommandNames: () => readonly string[];
	private readonly accent: (text: string) => string;
	private readonly muted: (text: string) => string;

	/** pi's autocomplete provider, captured for built-in reflection. */
	private receivedProvider: AutocompleteProvider | undefined;

	private countdownTimer: ReturnType<typeof setInterval> | undefined;
	private deadline = 0;
	private frameIndex = 0;
	/** The original Enter sequence, replayed when the countdown completes. */
	private pendingKey: string | undefined;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options: ThinkTwiceEditorOptions) {
		// embedWorkingStatus matches the stock editor's border spinner.
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.kb = keybindings;
		this.delayMs = Math.max(0, options.delaySeconds) * 1000;
		this.shouldCountdownFn = options.shouldCountdown;
		this.liveCommandNames = options.liveCommandNames;
		this.accent = options.accent ?? ((text) => theme.borderColor(text));
		this.muted = options.muted ?? ((text) => theme.borderColor(text));
	}

	/**
	 * pi hands its autocomplete provider to every custom editor — both when
	 * the editor component is swapped and whenever the provider is rebuilt.
	 * Capturing it here is what makes the built-in list reflectable.
	 */
	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.receivedProvider = provider;
		super.setAutocompleteProvider(provider);
	}

	private get countdownActive(): boolean {
		return this.countdownTimer !== undefined;
	}

	override handleInput(data: string): void {
		try {
			this.handleInputImpl(data);
		} catch {
			// Fail open: any pi-think-twice bug behaves exactly like stock pi.
			this.hardStopCountdown();
			super.handleInput(data);
		}
	}

	private handleInputImpl(data: string): void {
		// pi disables submission in some states; respect that completely.
		if (this.disableSubmit) {
			super.handleInput(data);
			return;
		}

		// Mirror pi's own precedence: newline wins over submit, so Shift+Enter
		// and Ctrl+J keep inserting new lines instead of starting a countdown.
		const isSubmit =
			this.kb.matches(data, "tui.input.submit") &&
			!this.kb.matches(data, "tui.input.newLine");
		const isSendNow = matchesKey(data, "ctrl+enter");

		if (this.countdownActive) {
			if (isSendNow) {
				this.finishNow();
				return;
			}
			if (isSubmit) {
				// Enter during the countdown is ignored entirely.
				return;
			}
			// Any other key interrupts; the text stays in the box.
			this.cancelCountdown();
			super.handleInput(data);
			return;
		}

		if (isSendNow) {
			this.submitNow();
			return;
		}

		if (isSubmit) {
			if (this.isShowingAutocomplete()) {
				// pi would complete AND submit on one Enter (choose = run). Split
				// it: Tab applies the suggestion without submitting, then the
				// normal countdown decision runs on the completed text.
				super.handleInput(TAB_KEY);
			}
			// Stock backslash workaround: a trailing "\" + Enter inserts a
			// newline instead of submitting (pi does this when Shift+Enter is
			// unavailable). Cursor position is private, so approximate with the
			// buffer ending in a backslash — the common end-of-line case.
			if (this.getText().endsWith("\\")) {
				super.handleInput(data);
				return;
			}
			const text = this.getText().trim();
			if (!text || !this.decideShouldCountdown(text)) {
				// Empty or exempt (built-in / registered command): submit as usual.
				super.handleInput(data);
				return;
			}
			this.startCountdown(data);
			return;
		}

		super.handleInput(data);
	}

	/**
	 * The countdown decision, with both failure layers folded in:
	 * reflection failures fall back to the reserved built-in list inside
	 * `resolveBuiltinCommands`; anything else (getCommands, policy bugs)
	 * fails open to `false` = stock immediate submit.
	 */
	private decideShouldCountdown(text: string): boolean {
		try {
			const builtinCommands = resolveBuiltinCommands(
				this.receivedProvider,
				this.liveCommandNames(),
			);
			return this.shouldCountdownFn(text, builtinCommands);
		} catch {
			return false;
		}
	}

	/** Ctrl+Enter: apply any open suggestion, then submit without a countdown. */
	private submitNow(): void {
		if (this.isShowingAutocomplete()) {
			super.handleInput(TAB_KEY);
		}
		super.handleInput(SUBMIT_KEY);
	}

	private startCountdown(pendingKey: string): void {
		this.pendingKey = pendingKey;
		this.deadline = Date.now() + this.delayMs;
		this.frameIndex = 0;
		this.countdownTimer = setInterval(() => this.tick(), TICK_MS);
		this.tick();
	}

	private tick(): void {
		try {
			if (this.countdownTimer === undefined) return;
			if (Date.now() >= this.deadline) {
				this.finishNow();
				return;
			}
			this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
			this.tui.requestRender();
		} catch {
			// Breakdown mid-countdown: stop the timer, leave the text untouched.
			// The user just presses Enter again (which then fails open if the
			// fault persists) — no deadlock, no crash.
			this.hardStopCountdown();
		}
	}

	private cancelCountdown(): void {
		if (this.countdownTimer === undefined) return;
		this.hardStopCountdown();
		this.tui.requestRender();
	}

	private finishNow(): void {
		if (this.countdownTimer === undefined) return;
		const key = this.pendingKey ?? SUBMIT_KEY;
		this.hardStopCountdown();
		this.tui.requestRender();
		// super skips this override, so the replay reaches pi's real submit.
		super.handleInput(key);
	}

	/** Stop the timer without rendering — safe to call from any failure path. */
	private hardStopCountdown(): void {
		if (this.countdownTimer !== undefined) {
			clearInterval(this.countdownTimer);
			this.countdownTimer = undefined;
		}
		this.pendingKey = undefined;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (!this.countdownActive || width <= 0) {
			return super.renderTopBorder(width, hiddenLineCount);
		}
		try {
			const remaining = Math.max(0, this.deadline - Date.now());
			const seconds = Math.max(1, Math.ceil(remaining / 1000));
			const spinner = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];

			// Widest → narrowest; pick the first variant that fits inside the
			// border ("── " prefix plus at least two trailing dashes).
			const variants = [
				`${spinner} sending in ${seconds}s · ESC to cancel · Ctrl+Enter send now`,
				`${spinner} sending in ${seconds}s · ESC to cancel`,
				`${spinner} ${seconds}s`,
			];
			const content = variants.find((variant) => visibleWidth(variant) + 3 + 2 <= width);
			if (content === undefined) {
				// Too narrow to show anything meaningful: plain border.
				return this.borderColor("─".repeat(width));
			}

			const pad = Math.max(0, width - 3 - visibleWidth(content));
			const spaceIndex = content.indexOf(" ");
			const head = spaceIndex === -1 ? content : content.slice(0, spaceIndex);
			const tail = spaceIndex === -1 ? "" : content.slice(spaceIndex);
			return (
				this.borderColor("── ") +
				this.accent(head) +
				this.muted(tail) +
				this.borderColor("─".repeat(pad))
			);
		} catch {
			// Never let a rendering fault take down the TUI's render loop.
			return super.renderTopBorder(width, hiddenLineCount);
		}
	}
}
