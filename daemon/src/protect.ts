/**
 * Sentinel protection: mask spans the LLM must never alter
 * (code, URLs, mentions, channels, emoji shortcodes) behind stable tokens,
 * and restore them afterwards. If the model altered or dropped a sentinel,
 * `sentinelsIntact` reports false and the caller returns the original text.
 */

export interface Protected {
	text: string;
	spans: Map<string, string>; // sentinel -> original span
}

// Order matters: code fences before inline code; longest/most-specific first.
// URL/email matches must not swallow trailing punctuation (.,;:) — it stays in
// the text around the sentinel.
const URL_TRAILING = /[.,;:!?)\]}'"]+$/;
const PATTERNS: { re: RegExp; kind: string; trimTrailing?: boolean }[] = [
	{ re: /```[\s\S]*?```/g, kind: "BLOCK" },
	{ re: /`[^`\n]+`/g, kind: "CODE" },
	{
		re: /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/g,
		kind: "URL",
		trimTrailing: true,
	},
	{ re: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, kind: "MAIL" },
	{ re: /@(?:channel|here|everyone)\b|@[A-Za-z0-9._-]+\b/g, kind: "MENTION" },
	{ re: /#[A-Za-z0-9_-]+\b/g, kind: "CHAN" },
	{ re: /:[A-Za-z0-9_+-]+:/g, kind: "EMOJI" },
];

export function protect(text: string): Protected {
	const spans = new Map<string, string>();
	let counter = 0;
	let out = text;
	for (const { re, kind, trimTrailing } of PATTERNS) {
		out = out.replace(re, (m) => {
			let span = m;
			let tail = "";
			if (trimTrailing) {
				const trimmed = m.replace(URL_TRAILING, "");
				if (trimmed.length > 0 && trimmed.length < m.length) {
					span = trimmed;
					tail = m.slice(trimmed.length);
				}
			}
			const sentinel = `${kind}${counter}`;
			counter++;
			spans.set(sentinel, span);
			return sentinel + tail;
		});
	}
	return { text: out, spans };
}

export function restore(text: string, spans: Map<string, string>): string {
	let out = text;
	for (const [sentinel, original] of spans)
		out = out.split(sentinel).join(original);
	return out;
}

/** True when every sentinel from the input survives unchanged in the output. */
export function sentinelsIntact(
	output: string,
	spans: Map<string, string>,
): boolean {
	for (const sentinel of spans.keys()) {
		if (!output.includes(sentinel)) return false;
	}
	// A sentinel appearing twice (model duplicated it) is also corruption.
	for (const sentinel of spans.keys()) {
		if (output.split(sentinel).length - 1 > 1) return false;
	}
	return true;
}
