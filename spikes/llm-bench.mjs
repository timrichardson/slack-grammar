#!/usr/bin/env node
// Phase 0 spike: llama-server grammar-correction latency benchmark.
// Usage: node spikes/llm-bench.mjs [baseUrl]
const BASE = process.argv[2] || "http://127.0.0.1:8080";

const SYSTEM = `You are a grammar and spelling checker. Fix only clear grammar and spelling mistakes. Return ONLY the corrected text, no commentary. Change as little as possible. Preserve formatting, names, mentions, URLs and code blocks exactly.`;

const CASES = [
  "i definately think we shoud of went with the second option",
  "their going to send the report tommorow, i seen it already",
  "can you review the docs when you get a chance, its not urgent",
  "we was thinking about moving the meeting to thursday instead",
  "that meeting could of been an email honestly",
  "me and him are pairing on the migration next week", // already-correct-ish (style)
  "The report is ready for review.", // already correct: must return unchanged
];

const t0 = performance.now();
let first = true;
for (const text of CASES) {
  const start = performance.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
      temperature: 0,
      max_tokens: 200,
    }),
  });
  const j = await res.json();
  const ms = performance.now() - start;
  const out = j.choices?.[0]?.message?.content?.trim();
  const u = j.usage;
  console.log(
    `${first ? "" : ""}${ms.toFixed(0).padStart(5)}ms | pp:${u?.prompt_tokens} tg:${u?.completion_tokens} | ${JSON.stringify(text)}\n         -> ${JSON.stringify(out)}`
  );
  first = false;
}
console.log(`\ntotal: ${((performance.now() - t0) / 1000).toFixed(1)}s for ${CASES.length} requests (incl. first-token warmup on req 1)`);
