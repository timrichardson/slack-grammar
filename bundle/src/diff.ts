/** Word-level diff for rendering corrections inline. Pure, no DOM. */

export interface DiffSeg {
	type: "same" | "del" | "ins";
	text: string;
}

function tokenize(s: string): string[] {
	// words with their trailing whitespace kept, so re-joining is lossless
	return s.match(/\S+\s*|\s+/g) ?? [];
}

export function diffWords(a: string, b: string): DiffSeg[] {
	const ta = tokenize(a);
	const tb = tokenize(b);
	const n = ta.length;
	const m = tb.length;

	// LCS table
	const dp: number[][] = Array.from({ length: n + 1 }, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = n - 1; i >= 0; i--) {
		const rowI = dp[i] as number[];
		const rowI1 = dp[i + 1] as number[];
		const ai = ta[i] as string;
		for (let j = m - 1; j >= 0; j--) {
			const bj = tb[j] as string;
			rowI[j] =
				ai === bj
					? (rowI1[j + 1] as number) + 1
					: Math.max(rowI1[j] as number, rowI[j + 1] as number);
		}
	}

	// Walk: emit same/del/ins, merging consecutive segments of equal type
	const segs: DiffSeg[] = [];
	let i = 0;
	let j = 0;
	const push = (type: DiffSeg["type"], text: string) => {
		const last = segs[segs.length - 1];
		if (last && last.type === type) last.text += text;
		else segs.push({ type, text });
	};
	while (i < n && j < m) {
		const ai = ta[i] as string;
		const bj = tb[j] as string;
		if (ai === bj) {
			push("same", ai);
			i++;
			j++;
		} else if (
			((dp[i + 1] as number[])[j] as number) >=
			((dp[i] as number[])[j + 1] as number)
		) {
			push("del", ai);
			i++;
		} else {
			push("ins", bj);
			j++;
		}
	}
	while (i < n) push("del", ta[i++] as string);
	while (j < m) push("ins", tb[j++] as string);
	return segs;
}

/** True when any non-whitespace difference exists between the two texts. */
export function hasRealDiff(a: string, b: string): boolean {
	const norm = (s: string) => s.replace(/\s+/g, " ").trim();
	if (norm(a) === norm(b)) return false;
	return diffWords(a, b).some(
		(s) => s.type !== "same" && s.text.trim().length > 0,
	);
}
