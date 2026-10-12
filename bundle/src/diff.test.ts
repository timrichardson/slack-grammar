import { expect, test } from "bun:test";
import { diffWords, hasRealDiff } from "./diff.ts";

test("identical texts produce only same segments", () => {
	const segs = diffWords("hello world", "hello world");
	expect(segs.every((s) => s.type === "same")).toBe(true);
});

test("single word fix produces del+ins around same text", () => {
	const segs = diffWords("we was thinking", "we were thinking");
	expect(segs.map((s) => s.type)).toEqual(["same", "del", "ins", "same"]);
	expect(segs.find((s) => s.type === "del")?.text.trim()).toBe("was");
	expect(segs.find((s) => s.type === "ins")?.text.trim()).toBe("were");
});

test("adjacent del/ins merge, whitespace-only diffs ignored", () => {
	expect(hasRealDiff("hello  world", "hello world")).toBe(false);
	expect(hasRealDiff("we was thinking", "we were thinking")).toBe(true);
	expect(hasRealDiff("same text", "same text.")).toBe(true);
});

test("insertion at end", () => {
	const segs = diffWords("going to the store", "going to the store tomorrow");
	expect(segs.at(-1)?.type).toBe("ins");
});
