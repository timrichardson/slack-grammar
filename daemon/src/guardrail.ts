/**
 * Guardrail: reject "corrections" that rewrite rather than edit the input —
 * the observed failure mode where the model answers or rewrites a message.
 * Rejected corrections return the user's original text (never eat the text).
 */

export function tokenize(s: string): string[] {
	return s.match(/\w+|[^\s\w]/g) ?? [];
}

/** Fraction of tokens that differ between a and b (0 = identical, 1 = all changed). */
export function diffRatio(a: string, b: string): number {
	const ta = tokenize(a);
	const tb = tokenize(b);
	if (ta.length === 0 && tb.length === 0) return 0;
	// LCS over token arrays (messages are short; O(n*m) is fine).
	const n = ta.length;
	const m = tb.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = n - 1; i >= 0; i--) {
		const ai = ta[i] as string;
		const rowI = dp[i] as number[];
		const rowI1 = dp[i + 1] as number[];
		for (let j = m - 1; j >= 0; j--) {
			const bj = tb[j] as string;
			rowI[j] =
				ai === bj
					? (rowI1[j + 1] as number) + 1
					: Math.max(rowI1[j] as number, rowI[j + 1] as number);
		}
	}
	const lcs = (dp[0] as number[])[0] as number;
	const changed = Math.max(n, m) - lcs;
	return changed / Math.max(n, m, 1);
}

export interface GuardrailResult {
	ok: boolean;
	reason?: string;
	ratio: number;
}

/**
 * Accept a correction when it is plausibly an *edit* of the input:
 * few absolute token changes (short messages legitimately hit high ratios:
 * fixing 5 words in an 11-word draft is 0.45) OR a low overall ratio
 * (long messages must stay proportionally close). Answers/rewrites of
 * short messages blow both thresholds.
 */
export function validateCorrection(
	original: string,
	corrected: string,
	maxDiffRatio: number,
	maxDiffTokens: number,
): GuardrailResult {
	if (corrected.trim().length === 0) {
		return { ok: false, reason: "empty", ratio: 1 };
	}
	const ta = tokenize(original);
	const tb = tokenize(corrected);
	const ratio = diffRatio(original, corrected);
	const changed = Math.max(ta.length, tb.length) - lcsLength(ta, tb);
	if (changed > maxDiffTokens && ratio > maxDiffRatio) {
		return { ok: false, reason: "diff", ratio };
	}
	const lenRatio = corrected.length / Math.max(original.length, 1);
	if (lenRatio > 2.5 || lenRatio < 0.4) {
		return { ok: false, reason: "length", ratio };
	}
	return { ok: true, ratio };
}

function lcsLength(a: string[], b: string[]): number {
	const n = a.length;
	const m = b.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = n - 1; i >= 0; i--) {
		const ai = a[i] as string;
		const rowI = dp[i] as number[];
		const rowI1 = dp[i + 1] as number[];
		for (let j = m - 1; j >= 0; j--) {
			const bj = b[j] as string;
			rowI[j] =
				ai === bj
					? (rowI1[j + 1] as number) + 1
					: Math.max(rowI1[j] as number, rowI[j + 1] as number);
		}
	}
	return (dp[0] as number[])[0] as number;
}
