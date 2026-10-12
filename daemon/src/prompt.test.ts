import { expect, test } from "bun:test";
import { buildCheckMessages, maxTokensFor } from "./prompt.ts";

test("messages end with the user text and carry the few-shot pair", () => {
	const msgs = buildCheckMessages("we was thinking about it");
	expect(msgs[0]?.role).toBe("system");
	expect(msgs.at(-1)).toEqual({
		role: "user",
		content: "we was thinking about it",
	});
	const roles = msgs.map((m) => m.role);
	expect(roles[0]).toBe("system");
	expect(msgs.at(-1)).toEqual({
		role: "user",
		content: "we was thinking about it",
	});
	for (let i = 1; i < roles.length; i++) {
		expect(roles[i]).toBe(i % 2 === 1 ? "user" : "assistant");
	}
	// imperative few-shot: corrected, not answered
	const shot = msgs.find(
		(m) => m.content === "can you send me the report tommorow",
	);
	expect(shot).toBeDefined();
});

test("maxTokensFor scales with input and clamps", () => {
	expect(maxTokensFor("hi there")).toBe(48); // clamp min
	expect(maxTokensFor("word ".repeat(400))).toBe(512); // clamp max
});

test("system prompt forbids answering", () => {
	expect(buildCheckMessages("x")[0]?.content).toContain("Never answer");
});
