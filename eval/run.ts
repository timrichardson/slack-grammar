#!/usr/bin/env bun
// eval/run.ts — score the correction pipeline against eval/corpus.jsonl.
// Usage: bun run eval [llama-base-url]   (default http://127.0.0.1:8080)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../daemon/src/config.ts";
import { runCheck } from "../daemon/src/gateway.ts";
import { LlmClient } from "../daemon/src/llm.ts";

const base = process.argv[2] ?? "http://127.0.0.1:8080";
const cfg = defaultConfig();
const llm = new LlmClient(base, cfg.gateway.timeoutMs);
if (!(await llm.health())) {
	console.error(
		`llama-server not healthy at ${base} (start it or pass a base URL)`,
	);
	process.exit(1);
}

const corpusPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"corpus.jsonl",
);
const cases = readFileSync(corpusPath, "utf8")
	.trim()
	.split("\n")
	.map(
		(l) =>
			JSON.parse(l) as {
				id: string;
				tag: string;
				want: "fix" | "keep";
				input: string;
				accept: string[];
			},
	);

// Keep-cases compare strictly (added periods/capitals = style violations).
// Fix-cases tolerate sentence-start capitalization and one trailing period.
function policyNorm(s: string, want: "fix" | "keep"): string {
	let t = s.trim();
	if (want === "fix") {
		if (t.endsWith(".") && !t.endsWith("..")) t = t.slice(0, -1);
		t = t.slice(0, 1).toLowerCase() + t.slice(1);
	}
	return t;
}
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

interface Row {
	id: string;
	tag: string;
	ok: boolean;
	kind: "pass" | "missed" | "false-positive" | "bad-output" | "guardrail";
	ms: number;
	output: string;
}
const rows: Row[] = [];
const latencies: number[] = [];

for (const c of cases) {
	const res = await runCheck(c.input, cfg, llm);
	latencies.push(res.ms);
	const out = policyNorm(res.corrected, c.want);
	const accept = c.accept.map((a) => policyNorm(a, c.want));

	let ok: boolean;
	let kind: Row["kind"];
	if (c.want === "keep") {
		ok = out === policyNorm(c.input, c.want);
		kind = ok ? "pass" : "false-positive";
	} else {
		ok = accept.includes(out);
		if (ok) kind = "pass";
		else if (res.note === "guardrail") kind = "guardrail";
		else if (out === policyNorm(c.input, c.want)) kind = "missed";
		else kind = "bad-output";
	}
	rows.push({ id: c.id, tag: c.tag, ok, kind, ms: res.ms, output: out });
}

const pass = rows.filter((r) => r.ok).length;
const byTag = new Map<string, { total: number; pass: number }>();
for (const r of rows) {
	const t = byTag.get(r.tag) ?? { total: 0, pass: 0 };
	t.total++;
	if (r.ok) t.pass++;
	byTag.set(r.tag, t);
}

latencies.sort((a, b) => a - b);
const p = (q: number) =>
	latencies[
		Math.min(latencies.length - 1, Math.floor((q / 100) * latencies.length))
	];

console.log(
	`\n=== results: ${pass}/${rows.length} pass (${pct(pass / rows.length)}) ===\n`,
);
for (const [tag, s] of [...byTag.entries()].sort()) {
	console.log(
		`  ${tag.padEnd(14)} ${String(s.pass).padStart(2)}/${String(s.total).padEnd(2)} ${pct(s.pass / s.total)}`,
	);
}
console.log(`\nlatency ms: p50=${p(50)} p95=${p(95)} max=${latencies.at(-1)}`);

const failures = rows.filter((r) => !r.ok);
if (failures.length > 0) {
	console.log("\nfailures:");
	for (const f of failures) {
		const c = cases.find((c) => c.id === f.id);
		console.log(
			`  [${f.kind}] ${f.id} (${f.tag}): in=${JSON.stringify(c?.input)} out=${JSON.stringify(f.output)}`,
		);
	}
}

const keepFails = rows.filter((r) => r.kind === "false-positive").length;
process.exit(pass / rows.length >= 0.85 && keepFails <= 1 ? 0 : 1);
