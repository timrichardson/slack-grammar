/** Composer watcher: debounce typing pauses, request checks, show suggestions. */
import { diffWords, hasRealDiff } from "./diff.ts";
import {
	CHECK_RULES,
	type CheckState,
	normalizeForCompare,
	skipReason,
} from "./rules.ts";
import { caretInCode, isComposer } from "./selectors.ts";
import { replaceComposerText } from "./texty.ts";
import {
	hideSuggestion,
	setStatus,
	showAppliedFlash,
	showSuggestion,
} from "./ui.ts";

interface Bridge {
	call(type: string, text?: string): Promise<unknown>;
	connected: boolean;
}

interface CheckResult {
	corrected: string;
	changed: boolean;
	ms?: number;
	note?: string;
}

export interface WatcherState {
	enabled: boolean;
	checks: number;
	applied: number;
	lastOutcome?: string;
}

export function startWatcher(bridge: Bridge): WatcherState {
	const state: CheckState = { ignored: new Set<string>() };
	const exposed: WatcherState = { enabled: true, checks: 0, applied: 0 };

	let activeComposer: HTMLElement | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlight = false;
	let inFlightText: string | null = null;
	let applying = false;

	async function runCheck(composer: HTMLElement): Promise<void> {
		if (!exposed.enabled || applying || inFlight) return;
		const text = composer.innerText;
		if (skipReason(text, state)) return;
		if (caretInCode(composer)) return;
		const normalized = normalizeForCompare(text);
		state.lastChecked = normalized;
		inFlight = true;
		inFlightText = text;
		setStatus("checking", composer);
		exposed.checks++;
		try {
			const res = (await bridge.call("check", text)) as CheckResult;
			// stale? user kept typing — discard silently
			if (applying || !composer.isConnected || composer.innerText !== text)
				return;
			if (res?.changed && hasRealDiff(text, res.corrected)) {
				const segs = diffWords(text, res.corrected);
				showSuggestion({
					composer,
					original: text,
					corrected: res.corrected,
					segs,
					actions: {
						onApply: () => {
							applying = true;
							const snapshot = text;
							const ok = replaceComposerText(composer, res.corrected);
							applying = false;
							if (ok) {
								exposed.applied++;
								state.ignored.add(normalizeForCompare(res.corrected));
								state.lastChecked = normalizeForCompare(res.corrected);
								showAppliedFlash(composer);
								void snapshot; // Ctrl+Z restores this via the editor's own undo stack
							}
						},
						onIgnore: () => {
							state.ignored.add(normalized);
							hideSuggestion();
						},
						onDismiss: () => hideSuggestion(),
					},
				});
			} else {
				exposed.lastOutcome =
					res?.note ?? (res?.changed ? "no-visible-diff" : "clean");
			}
		} catch (e) {
			exposed.lastOutcome = `error: ${(e as Error).message}`;
			setStatus("error", composer);
			return; // keep error glyph until next activity
		} finally {
			inFlight = false;
			inFlightText = null;
			if (composer.isConnected) setStatus("idle", composer);
		}
	}

	function onInput(ev: Event): void {
		const composer = isComposer(ev.target);
		if (!composer) return;
		activeComposer = composer;
		if (!exposed.enabled) return;
		setStatus("idle");
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void runCheck(composer);
		}, CHECK_RULES.debounceMs);
	}

	document.addEventListener("input", onInput, true);
	document.addEventListener(
		"keydown",
		(ev: KeyboardEvent) => {
			// Ctrl+Shift+G toggles checking for this page
			if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "g") {
				ev.preventDefault();
				ev.stopImmediatePropagation();
				exposed.enabled = !exposed.enabled;
				hideSuggestion();
				setStatus(exposed.enabled ? "idle" : "off", activeComposer);
				if (!exposed.enabled) setTimeout(() => setStatus("idle"), 1200);
			}
			if (ev.key === "Escape") hideSuggestion();
		},
		true,
	);

	return exposed;
}
