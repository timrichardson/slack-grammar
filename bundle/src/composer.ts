import type { ApplyDiagnostic } from "../../shared/apply-diagnostic.ts";
import { BUNDLE_VERSION } from "../../shared/bundle-version.ts";
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
	showApplyError,
	showSuggestion,
} from "./ui.ts";

interface Bridge {
	call(type: string, text?: string, data?: unknown): Promise<unknown>;
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
	applyAttempts: number;
	applyDiagnostics: (ApplyDiagnostic & { attempt: number })[];
	lastOutcome?: string;
}

export function startWatcher(bridge: Bridge): WatcherState {
	const state: CheckState = { ignored: new Set<string>() };
	const exposed: WatcherState = {
		enabled: true,
		checks: 0,
		applied: 0,
		applyAttempts: 0,
		applyDiagnostics: [],
	};

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
						onApply: async () => {
							if (applying || !exposed.enabled) return;
							if (!composer.isConnected || composer.innerText !== text) {
								hideSuggestion();
								return;
							}
							applying = true;
							const attempt = ++exposed.applyAttempts;
							try {
								const result = await replaceComposerText(
									composer,
									res.corrected,
									text,
									(diagnostic) => {
										exposed.applyDiagnostics.push({ ...diagnostic, attempt });
										if (exposed.applyDiagnostics.length > 50)
											exposed.applyDiagnostics.shift();
										void bridge
											.call("apply-diagnostic", undefined, {
												version: BUNDLE_VERSION,
												attempt,
												diagnostic,
											})
											.catch(() => undefined);
									},
								);
								exposed.lastOutcome = `apply-${result}`;
								if (result === "applied") {
									exposed.applied++;
									state.ignored.add(normalizeForCompare(composer.innerText));
									state.lastChecked = normalizeForCompare(composer.innerText);
									showAppliedFlash(composer);
								} else if (result === "interrupted") {
									if (composer.isConnected && !composer.innerText.trim())
										showApplyError(
											"Apply interrupted. Use Copy original to recover the saved draft.",
										);
									else hideSuggestion();
								} else {
									showApplyError(
										result === "failed"
											? "Apply failed. Use Copy original to recover the saved draft."
											: "Could not apply safely. Draft preserved — use Copy instead.",
									);
								}
							} finally {
								applying = false;
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
		if (applying) return;
		hideSuggestion(); // a visible suggestion must never outlive its draft
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
