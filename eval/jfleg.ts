#!/usr/bin/env bun
// eval/jfleg.ts — evaluate the correction pipeline against JFLEG.
//
// JFLEG (Napoles, Sakaguchi & Tetreault, EACL 2017) — CC BY-NC-SA 4.0.
// Downloaded at runtime to vendor/jfleg/ (gitignored); never redistributed.
// Citation: http://aclweb.org/anthology/E17-2037
//
// Usage: bun run eval/jfleg.ts [--n 300] [--all] [--fp 100] [llama-base]
// Metrics:
//   improvement — share of sentences where our output's best token-F1 toward
//     any human reference beats the input's (style-aware; our chat-style
//     preservation isn't punished by formal-reference capitalization)
//   GLEU — official gleu.py, raw and style-normalized outputs (leaderboard-
//     comparable; normalization only adds sentence-capital/terminal period)
//   fp-rate — share of *correct* reference sentences we changed (want ~0)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, repoRoot } from "../daemon/src/config.ts";
import { runCheck } from "../daemon/src/gateway.ts";
import { LlmClient } from "../daemon/src/llm.ts";

const args = process.argv.slice(2);
const flag = (name: string, def: string): string => {
	const i = args.indexOf(name);
	return i >= 0 ? (args[i + 1] ?? def) : def;
};
const N = args.includes("--all") ? 100000 : Number(flag("--n", "300"));
const FP_N = Number(flag("--fp", "100"));
const base =
	args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) ??
	"http://127.0.0.1:8080";

// ---------- data ----------
const VENDOR = join(repoRoot, "vendor", "jfleg");
const BASE_URL = "https://raw.githubusercontent.com/keisks/jfleg/master";
const FILES = [
	"dev/dev.src",
	"dev/dev.ref0",
	"dev/dev.ref1",
	"dev/dev.ref2",
	"dev/dev.ref3",
	"test/test.src",
	"test/test.ref0",
	"test/test.ref1",
	"test/test.ref2",
	"test/test.ref3",
	"eval/gleu.py",
];

function ensureData(): void {
	if (
		existsSync(join(VENDOR, "dev", "dev.src")) &&
		existsSync(join(VENDOR, "eval", "gleu.py"))
	)
		return;
	console.log("downloading JFLEG (CC BY-NC-SA 4.0, eval use only)…");
	mkdirSync(VENDOR, { recursive: true });
	for (const f of FILES) {
		const dest = join(VENDOR, f);
		mkdirSync(dirname(dest), { recursive: true });
		const url = `${BASE_URL}/${f}`;
		const res = spawnSync("curl", ["-sfL", "--retry", "3", "-o", dest, url]);
		if (res.status !== 0) throw new Error(`download failed: ${url}`);
	}
	console.log(`JFLEG ready in ${VENDOR}`);
}

function loadSet(name: "dev" | "test"): { src: string[]; refs: string[][] } {
	const lines = (p: string) =>
		readFileSync(p, "utf8")
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
	const src = lines(join(VENDOR, name, `${name}.src`)).map(detok);
	const refs = [0, 1, 2, 3].map((i) =>
		lines(join(VENDOR, name, `${name}.ref${i}`)).map(detok),
	);
	const first = refs[0] as string[];
	return { src, refs: first.map((_, idx) => refs.map((r) => r[idx] ?? "")) };
}

/** JFLEG ships tokenized ("do n't", "However ,") — detokenize for natural-text scoring. */
export function detok(s: string): string {
	return s
		.replace(/``/g, '"')
		.replace(/''/g, '"')
		.replace(/\s+([)\]},.;:!?%])/g, "$1")
		.replace(/([([])\s+/g, "$1")
		.replace(/\s+(n't|'s|'re|'ve|'ll|'d|'m)\b/gi, "$1")
		.replace(/\s{2,}/g, " ")
		.trim();
}

// ---------- seeded sampling ----------
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------- metrics ----------
const tok = (s: string) => s.toLowerCase().match(/\w+|[^\s\w]/g) ?? [];

/** bag-of-words token F1 */
function f1(a: string, b: string): number {
	const ta = tok(a);
	const tb = tok(b);
	if (ta.length === 0 && tb.length === 0) return 1;
	const bag = new Map<string, number>();
	for (const t of ta) bag.set(t, (bag.get(t) ?? 0) + 1);
	let hit = 0;
	for (const t of tb) {
		const c = bag.get(t) ?? 0;
		if (c > 0) {
			hit++;
			bag.set(t, c - 1);
		}
	}
	const p = hit / Math.max(tb.length, 1);
	const r = hit / Math.max(ta.length, 1);
	return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

const bestF1 = (x: string, refs: string[]) =>
	Math.max(...refs.map((r) => f1(x, r)));

/** formal-style transform for the leaderboard-comparable GLEU variant */
function formalize(s: string): string {
	let t = s.trim();
	if (t.length > 0) t = (t[0] as string).toUpperCase() + t.slice(1);
	if (t.length > 0 && !/[.!?]["')\]]?$/.test(t)) t += ".";
	return t;
}

function gleu(
	setName: string,
	hypPath: string,
	srcPath: string,
	refDir: string,
): string | null {
	// gleu.py needs scipy; prefer the eval venv (create with:
	//   python3 -m venv vendor/jfleg/venv && vendor/jfleg/venv/bin/pip install scipy)
	const py = existsSync(join(VENDOR, "venv", "bin", "python"))
		? join(VENDOR, "venv", "bin", "python")
		: "python3";
	const r = spawnSync(py, [
		join(VENDOR, "eval", "gleu.py"),
		"-r",
		...[0, 1, 2, 3].map((i) => join(refDir, `${setName}.ref${i}`)),
		"-s",
		srcPath,
		"--hyp",
		hypPath,
	]);
	if (r.status !== 0) return null;
	// gleu.py prints [['<mean>', '<std>', '(lo,hi)']]
	return (r.stdout.toString().match(/\[\['([\d.]+)'/) ?? [])[1] ?? null;
}

// ---------- run ----------
ensureData();
const cfg = defaultConfig();
const llm = new LlmClient(base, cfg.gateway.timeoutMs);
if (!(await llm.health())) {
	console.error(`llama-server not healthy at ${base}`);
	process.exit(1);
}

interface Row {
	set: string;
	idx: number;
	src: string;
	out: string;
	refs: string[];
	ms: number;
	skipped: boolean;
	guardrailed: boolean;
}
const rows: Row[] = [];
const latencies: number[] = [];
let skippedShort = 0;
let guardrailCount = 0;

const all: Array<{ set: string; idx: number; src: string; refs: string[] }> =
	[];
for (const name of ["dev", "test"] as const) {
	const { src, refs } = loadSet(name);
	for (let i = 0; i < src.length; i++)
		all.push({
			set: name,
			idx: i,
			src: src[i] as string,
			refs: refs[i] as string[],
		});
}
const rng = mulberry32(42);
const sample = [...all].sort(() => rng() - 0.5).slice(0, N);
console.log(`evaluating ${sample.length}/${all.length} JFLEG sentences…`);

for (const c of sample) {
	const res = await runCheck(c.src, cfg, llm);
	latencies.push(res.ms);
	if (res.note === "too-short" || res.note === "too-long") skippedShort++;
	if (res.note === "guardrail") guardrailCount++;
	rows.push({
		set: c.set,
		idx: c.idx,
		src: c.src,
		out: res.corrected,
		refs: c.refs,
		ms: res.ms,
		skipped: res.note === "too-short" || res.note === "too-long",
		guardrailed: res.note === "guardrail",
	});
}

// improvement classification
let improved = 0;
let unchanged = 0;
let harmed = 0;
const worst: Array<{ src: string; out: string; ref: string; delta: number }> =
	[];
for (const r of rows) {
	if (r.skipped) {
		unchanged++;
		continue;
	}
	const before = bestF1(r.src, r.refs);
	const after = bestF1(r.out, r.refs);
	const delta = after - before;
	if (delta > 0.02) improved++;
	else if (delta < -0.02) {
		harmed++;
		worst.push({ src: r.src, out: r.out, ref: r.refs[0] ?? "", delta });
	} else unchanged++;
}

// false-positive probe: reference sentences are correct English — we should not touch them
let fpChanged = 0;
const fpRows: string[] = [];
const fpSample = [...all].sort(() => rng() - 0.5).slice(0, FP_N);
console.log(`false-positive probe on ${FP_N} correct reference sentences…`);
for (const c of fpSample) {
	const ref = c.refs[0];
	if (!ref) continue;
	const res = await runCheck(ref, cfg, llm);
	if (res.changed) {
		fpChanged++;
		if (fpRows.length < 5)
			fpRows.push(`${JSON.stringify(ref)} -> ${JSON.stringify(res.corrected)}`);
	}
}

latencies.sort((a, b) => a - b);
const p = (q: number) =>
	latencies[
		Math.min(latencies.length - 1, Math.floor((q / 100) * latencies.length))
	];
const pct = (n: number, d: number) =>
	`${((100 * n) / Math.max(d, 1)).toFixed(1)}%`;

console.log(
	`\n=== JFLEG (n=${rows.length}, CC BY-NC-SA 4.0; style-aware metrics) ===`,
);
console.log(
	`improved toward reference : ${improved} (${pct(improved, rows.length)})`,
);
console.log(
	`unchanged                 : ${unchanged} (${pct(unchanged, rows.length)}) [skipped-short: ${skippedShort}, guardrail-held: ${guardrailCount}]`,
);
console.log(
	`harmed                    : ${harmed} (${pct(harmed, rows.length)})`,
);
console.log(
	`false positives on refs   : ${fpChanged}/${FP_N} (${pct(fpChanged, FP_N)})`,
);
console.log(
	`latency ms                : p50=${p(50)} p95=${p(95)} max=${latencies.at(-1)}`,
);

// GLEU on detokenized data (internally consistent; not leaderboard-comparable —
// the leaderboard scores tokenized text). Hypotheses are our natural output.
const writeHyp = (transform: (s: string) => string) => {
	const bySet = new Map<string, string[]>();
	// keep original corpus order so hyp lines align with the src file
	for (const r of [...rows].sort((a, b) =>
		a.set === b.set ? a.idx - b.idx : 0,
	)) {
		const list = bySet.get(r.set) ?? [];
		list.push(transform(r.out));
		bySet.set(r.set, list);
	}
	return bySet;
};

{
	// materialize detok refs + sampled/full detok src once per set
	const detokDir = join(VENDOR, "detok");
	mkdirSync(detokDir, { recursive: true });
	const srcPaths = new Map<string, string>();
	for (const name of ["dev", "test"] as const) {
		const { src, refs } = loadSet(name);
		for (let i = 0; i < 4; i++) {
			writeFileSync(
				join(detokDir, `${name}.ref${i}`),
				`${refs.map((r) => (r[i] as string) ?? "").join("\n")}\n`,
			);
		}
		const chosen = [...rows.filter((r) => r.set === name)].sort(
			(a, b) => a.idx - b.idx,
		);
		const srcFile =
			chosen.length === src.length
				? join(detokDir, `${name}.src`)
				: join(detokDir, `${name}.sample.src`);
		writeFileSync(srcFile, `${chosen.map((r) => r.src).join("\n")}\n`);
		srcPaths.set(name, srcFile);
	}
	for (const [label, transform] of [
		["GLEU detok, raw", (s: string) => s],
		["GLEU detok, style-normalized", formalize],
	] as const) {
		for (const [set, outs] of writeHyp(transform)) {
			const hypPath = join(
				detokDir,
				`${set}.hyp.${transform === formalize ? "formal" : "raw"}`,
			);
			writeFileSync(hypPath, `${outs.join("\n")}\n`);
			const score = gleu(set, hypPath, srcPaths.get(set) as string, detokDir);
			console.log(`${label} (${set}): ${score ?? "n/a (gleu.py failed)"}`);
		}
	}
}

if (worst.length > 0) {
	console.log("\nworst regressions (style-aware metric):");
	for (const w of worst.slice(0, 5)) {
		console.log(
			`  [${w.delta.toFixed(2)}] src=${JSON.stringify(w.src)}\n        out=${JSON.stringify(w.out)}\n        ref=${JSON.stringify(w.ref)}`,
		);
	}
}
if (fpRows.length > 0) {
	console.log("\nfalse-positive examples:");
	for (const f of fpRows) console.log(`  ${f}`);
}
