import { expect, test } from "bun:test";
import { defaultConfig } from "./config.ts";
import { Checker, runCheck } from "./gateway.ts";
import type { CheckResult } from "./gateway.ts";

const cfg = defaultConfig();

function fakeLlm(reply: (text: string) => string, delayMs = 0) {
	return {
		chat: async (messages: Array<{ role: string; content: string }>) => {
			if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
			const userText = messages.at(-1)?.content ?? "";
			return { content: reply(userText) };
		},
	};
}

test("too-short text is skipped without an LLM call", async () => {
	let called = false;
	const res = await runCheck("hi", cfg, {
		chat: async () => {
			called = true;
			return { content: "x" };
		},
	});
	expect(called).toBe(false);
	expect(res.note).toBe("too-short");
	expect(res.corrected).toBe("hi");
});

test("guardrail rejection returns original text", async () => {
	const input = "can you review the docs when you get a chance, its not urgent";
	const llm = fakeLlm(
		() => "Sure, I can review the docs when I get a chance — it's not urgent.",
	);
	const res = await runCheck(input, cfg, llm);
	expect(res.note).toBe("guardrail");
	expect(res.corrected).toBe(input);
	expect(res.changed).toBe(false);
});

test("good correction flows through, sentinels restored", async () => {
	const input = "@tim we shoud of went with option two";
	const llm = fakeLlm(() => "MENTION0 We should have gone with option two.");
	const res = await runCheck(input, cfg, llm);
	expect(res.changed).toBe(true);
	expect(res.corrected).toBe("@tim We should have gone with option two.");
});

test("llm error returns original", async () => {
	const input = "this is a perfectly fine sentence";
	const llm = { chat: async () => ({ content: "" }) };
	const res = await runCheck(input, cfg, llm);
	expect(res.note).toBe("llm-error");
	expect(res.corrected).toBe(input);
});

test("checker caches by text and dedups in-flight", async () => {
	let calls = 0;
	const llm = fakeLlm((t) => {
		calls++;
		return t === "first message with a typo heare"
			? "First message with a typo here."
			: "Other corrected text.";
	}, 30);
	const checker = new Checker(cfg, llm);
	const a = await checker.check("first message with a typo heare");
	const b = await checker.check("first message with a typo heare"); // cache hit
	const [c, d] = await Promise.all([
		checker.check("second message to check naow"),
		checker.check("second message to check naow"), // in-flight dedup
	]);
	expect(calls).toBe(2);
	expect(b.cached).toBe(true);
	expect(b.corrected).toBe(a.corrected);
	expect(c.corrected).toBe(d.corrected);
	expect(c.cached).toBe(false);
});

test("checker serializes concurrent different texts", async () => {
	const order: string[] = [];
	const llm = fakeLlm((t) => {
		order.push(t);
		return `${t} (fixed)`;
	}, 20);
	const checker = new Checker(cfg, llm);
	const results = await Promise.all([
		checker.check("alpha message one"),
		checker.check("beta message two"),
	]);
	expect(order.length).toBe(2);
	expect(results[0]?.changed).toBe(true);
});
