import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import { validateCorrection } from "./guardrail.ts";
import type { LlmClient } from "./llm.ts";
import { buildCheckMessages, maxTokensFor } from "./prompt.ts";
import { protect, restore, sentinelsIntact } from "./protect.ts";

export interface CheckResult {
	corrected: string;
	changed: boolean;
	cached: boolean;
	ms: number;
	note?:
		| "too-short"
		| "too-long"
		| "timeout"
		| "superseded"
		| "guardrail"
		| "llm-error";
}

/** Pure check pipeline (LLM call injected for testability). */
export async function runCheck(
	text: string,
	cfg: Config,
	llm: { chat: LlmClient["chat"] },
): Promise<CheckResult> {
	const t0 = performance.now();
	const done = (
		corrected: string,
		changed: boolean,
		cached: boolean,
		note?: CheckResult["note"],
	): CheckResult => ({
		corrected,
		changed,
		cached,
		ms: Math.round(performance.now() - t0),
		note,
	});

	const trimmed = text.trim();
	const words = trimmed.split(/\s+/).filter(Boolean).length;
	if (words < cfg.check.minWords) return done(text, false, false, "too-short");
	if (text.length > cfg.check.maxChars)
		return done(text, false, false, "too-long");

	const { text: masked, spans } = protect(text);
	const res = await llm.chat(buildCheckMessages(masked), maxTokensFor(masked));
	if (!res.content) return done(text, false, false, "llm-error");

	// Post-process model quirks: trailing whitespace per line (markdown hard
	// breaks), stray wrapping quotes.
	let content = res.content
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/, ""))
		.join("\n")
		.trim();
	if (
		content.length >= 2 &&
		((content.startsWith('"') && content.endsWith('"')) ||
			(content.startsWith("`") && content.endsWith("`")))
	) {
		content = content.slice(1, -1).trim();
	}
	// Model artifact: doubled mixed punctuation around protected tokens (",;").
	content = content.replace(/,\s*;/g, ",").replace(/;\s*,/g, ";");

	if (!sentinelsIntact(content, spans))
		return done(text, false, false, "guardrail");

	const guard = validateCorrection(
		masked,
		content,
		cfg.check.maxDiffRatio,
		cfg.check.maxDiffTokens,
	);
	if (!guard.ok) {
		// Line-wise salvage: multiline messages keep the lines that validate
		// as edits and revert only the offending lines (never all-or-nothing).
		const inLines = masked.split("\n");
		const outLines = content.split("\n");
		if (inLines.length === outLines.length && inLines.length > 1) {
			const merged = inLines
				.map((ln, i) => {
					const ol = outLines[i] as string;
					return validateCorrection(
						ln,
						ol,
						cfg.check.maxDiffRatio,
						cfg.check.maxDiffTokens,
					).ok
						? ol
						: ln;
				})
				.join("\n");
			if (merged !== masked) content = merged;
			else return done(text, false, false, "guardrail");
		} else {
			return done(text, false, false, "guardrail");
		}
	}

	const corrected = restore(content, spans);

	return done(corrected, corrected !== text, false);
}

/**
 * Cached, coalescing single-slot checker: repeated texts hit an in-RAM cache;
 * identical in-flight requests share one LLM call; all others serialize behind
 * a single lock (calls are ~100–200 ms, single-user, so a fair chain is enough).
 */
export class Checker {
	private cache = new Map<string, { result: CheckResult; ts: number }>();
	private inflight = new Map<string, Promise<CheckResult>>();
	private lock: Promise<unknown> = Promise.resolve();

	constructor(
		private cfg: Config,
		private llm: { chat: LlmClient["chat"] },
		private log: (e: Record<string, unknown>) => void = () => {},
	) {}

	private hash(text: string): string {
		return createHash("sha256").update(text).digest("hex").slice(0, 16);
	}

	private cacheGet(text: string): CheckResult | null {
		const key = this.hash(text);
		const hit = this.cache.get(key);
		if (!hit) return null;
		if (Date.now() - hit.ts > this.cfg.gateway.cacheTtlMs) {
			this.cache.delete(key);
			return null;
		}
		this.cache.delete(key); // LRU touch
		this.cache.set(key, hit);
		return { ...hit.result, cached: true };
	}

	private cacheSet(text: string, result: CheckResult): void {
		const key = this.hash(text);
		this.cache.set(key, { result, ts: Date.now() });
		if (this.cache.size > this.cfg.gateway.cacheMax) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
	}

	check(text: string): Promise<CheckResult> {
		const cached = this.cacheGet(text);
		if (cached) return Promise.resolve(cached);

		const key = this.hash(text);
		const existing = this.inflight.get(key);
		if (existing) return existing;

		const promise = this.withSlot(text, key);
		this.inflight.set(key, promise);
		return promise;
	}

	private async withSlot(text: string, key: string): Promise<CheckResult> {
		const release = this.lock;
		let releaseLock: () => void = () => {};
		this.lock = new Promise<void>((r) => {
			releaseLock = r;
		});
		await release.catch(() => {});
		try {
			const result = await runCheck(text, this.cfg, this.llm);
			this.cacheSet(text, result);
			this.log({
				event: "check",
				hash: key,
				len: text.length,
				ms: result.ms,
				changed: result.changed,
				note: result.note ?? "ok",
			});
			return result;
		} finally {
			releaseLock();
			this.inflight.delete(key);
		}
	}
}

/** HTTP gateway. Binds loopback only. Logs never contain message text. */
export function startGateway(
	cfg: Config,
	checker: Checker,
): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		hostname: cfg.gateway.host,
		port: cfg.gateway.port,
		async fetch(req): Promise<Response> {
			const url = new URL(req.url);
			if (req.method === "GET" && url.pathname === "/health") {
				return Response.json({ ok: true });
			}
			if (req.method === "POST" && url.pathname === "/check") {
				let body: { text?: unknown };
				try {
					body = await req.json();
				} catch {
					return Response.json({ error: "bad-json" }, { status: 400 });
				}
				if (typeof body.text !== "string") {
					return Response.json(
						{ error: "text-must-be-string" },
						{ status: 400 },
					);
				}
				const result = await checker.check(body.text);
				return Response.json(result);
			}
			return Response.json({ error: "not-found" }, { status: 404 });
		},
	});
}
