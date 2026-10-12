import { describe, expect, test } from "bun:test";
import { protect, restore, sentinelsIntact } from "./protect.ts";

test("mentions, urls, code, emoji are masked and restored", () => {
	const input =
		"@tim can you check URL0 — wait, https://example.com/x?a=1 — and `fix_typo()` and :tada: in #general";
	const p = protect(input);
	for (const s of p.spans.keys()) expect(p.text).toContain(s);
	expect(p.text).not.toContain("@tim");
	expect(p.text).not.toContain("https://");
	expect(restore(p.text, p.spans)).toBe(input);
});

test("code fences are masked whole (multiline)", () => {
	const input = "before\n```\ndef broken(:\n  pass\n```\nafter wards";
	const p = protect(input);
	expect(p.text).not.toContain("def broken");
	expect(p.text).toContain("BLOCK0");
	expect(restore(p.text, p.spans)).toBe(input);
});

test("special mentions masked", () => {
	const input = "@channel the deploy is at www.example.com/deploy, ping @here";
	const p = protect(input);
	expect(p.text).not.toContain("@channel");
	expect(restore(p.text, p.spans)).toBe(input);
});

test("sentinelsIntact detects drops and duplication", () => {
	const p = protect("@tim went to https://example.com today");
	const mentionSentinel = [...p.spans.keys()].find((k) =>
		k.startsWith("MENTION"),
	) as string;
	expect(sentinelsIntact(p.text, p.spans)).toBe(true);
	expect(sentinelsIntact(p.text.replace(mentionSentinel, ""), p.spans)).toBe(
		false,
	);
	expect(sentinelsIntact(`${p.text} and ${mentionSentinel} too`, p.spans)).toBe(
		false,
	);
});

test("URLs do not swallow trailing punctuation (regression: ',;' artifact)", () => {
	const input = "the docs are at https://docs.example.com/setup, theres a typo";
	const p = protect(input);
	// the comma must remain in the text after the sentinel
	expect(p.text).toMatch(/URL0, theres/);
	expect(p.spans.get("URL0")).toBe("https://docs.example.com/setup");
	expect(restore(p.text, p.spans)).toBe(input);
});

test("plain text passes through untouched", () => {
	const input = "just a normal sentence with nothing special";
	const p = protect(input);
	expect(p.text).toBe(input);
	expect(p.spans.size).toBe(0);
	expect(sentinelsIntact(input, p.spans)).toBe(true);
});
