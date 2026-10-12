/** Skip-rules for whether a draft should be sent for checking. Pure, no DOM. */

export interface CheckSettings {
	minWords: number;
	debounceMs: number;
}

/** Mutable at runtime: the daemon overrides these from user config via hello-ok. */
export const CHECK_RULES: CheckSettings = {
	minWords: 3,
	debounceMs: 1000,
};

export function applyConfig(cfg: Partial<CheckSettings> | undefined): void {
	if (!cfg) return;
	if (typeof cfg.debounceMs === "number" && cfg.debounceMs >= 0)
		CHECK_RULES.debounceMs = cfg.debounceMs;
	if (typeof cfg.minWords === "number" && cfg.minWords >= 1)
		CHECK_RULES.minWords = cfg.minWords;
}

export interface CheckState {
	/** texts the user dismissed with "Ignore" or already applied this session */
	ignored: Set<string>;
	/** text currently in flight (handled by caller) */
	lastChecked?: string;
}

export function normalizeForCompare(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** Reason a check is skipped, or null when it should run. */
export function skipReason(text: string, state: CheckState): string | null {
	const norm = normalizeForCompare(text);
	if (!norm) return "empty";
	if (state.ignored.has(norm)) return "ignored";
	if (norm === state.lastChecked) return "unchanged";
	const words = norm.split(" ").length;
	if (words < CHECK_RULES.minWords) return "too-short";
	if (norm.endsWith(":")) return "command";
	if (/```/.test(text) && (text.match(/```/g) ?? []).length % 2 === 1)
		return "open-code-fence";
	if (/^\/\w/.test(norm)) return "slash-command";
	return null;
}
