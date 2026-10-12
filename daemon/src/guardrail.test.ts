import { describe, expect, test } from "bun:test";
import { diffRatio, validateCorrection } from "./guardrail.ts";

test("diffRatio: identical is 0, total rewrite is 1", () => {
	expect(diffRatio("hello world", "hello world")).toBe(0);
	expect(diffRatio("hello world", "goodbye planet earth")).toBeGreaterThan(0.9);
});

test("diffRatio: moderate edit of a short message lands in a sane range", () => {
	// 5 word fixes + 2 insertions in an 11-token draft = ~0.5 ratio;
	// this is why validateCorrection also has an absolute-token allowance.
	const r = diffRatio(
		"i definately think we shoud of went with the second option",
		"I definitely think we should have gone with the second option.",
	);
	expect(r).toBeGreaterThan(0.3);
	expect(r).toBeLessThan(0.6);
});

test("validateCorrection accepts small edits", () => {
	expect(
		validateCorrection(
			"i definately think we shoud of went with the second option",
			"I definitely think we should have gone with the second option.",
			0.4,
			8,
		).ok,
	).toBe(true);
});

test("validateCorrection rejects answers/rewrites (the observed failure mode)", () => {
	// model answered the message instead of correcting it
	const r = validateCorrection(
		"can you review the docs when you get a chance, its not urgent",
		"Sure, I can review the docs when I get a chance — it's not urgent.",
		0.4,
		8,
	);
	expect(r.ok).toBe(false);
	expect(r.reason).toBe("diff");
});

test("validateCorrection rejects empty and length blowups", () => {
	expect(validateCorrection("some message here", "   ", 0.4, 8).ok).toBe(false);
	expect(
		validateCorrection("hi", `hi ${"padding ".repeat(50)}`, 0.4, 8).ok,
	).toBe(false);
});
