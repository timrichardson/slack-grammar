# JFLEG evaluation

[`eval/jfleg.ts`](../eval/jfleg.ts) evaluates the full correction pipeline
against **JFLEG** — the JHU FLuency-Extended GUG corpus for Grammatical Error
Correction (Napoles, Sakaguchi & Tetreault, EACL 2017; 754 dev + 747 test
sentences, 4 human corrections each).

**License**: JFLEG is CC BY-NC-SA 4.0 — downloaded at eval time to
`vendor/jfleg/` (gitignored), never redistributed. Citation:
http://aclweb.org/anthology/E17-2037

```sh
bun run eval:jfleg:setup        # once: scipy venv for the official GLEU script
bun run eval:jfleg              # 300-sentence sample + 100 FP probes
bun run eval:jfleg -- --all     # full 1,501 sentences
```

## Metrics and why they're not the leaderboard's

- **Improvement (primary)**: share of sentences where our output's best
  token-F1 toward any of the 4 references beats the input's. JFLEG references
  are formal essay style; slack-grammar deliberately preserves the author's
  style (lowercase sentence starts, no added final periods), which standard
  GEC metrics punish. Improvement measures what we actually care about:
  *did we move toward correct English without flattening the writer's voice?*
- **GLEU (secondary)**: the official `gleu.py`, run on detokenized text
  (JFLEG ships tokenized: `"do n't"`, `"However ,"`). Internally consistent,
  **not** comparable to the JFLEG leaderboard (which scores tokenized text).
  Reported for raw output and a style-normalized variant (sentence capital +
  terminal period) to show the cost of style preservation.
- **Reference-change rate**: how often we modify reference sentences. JFLEG
  references are one acceptable variant of learner English, not infallible
  gold — most "changes" are legitimate improvements ("more safe" → "safer").
  The signal to watch is whether any change *breaks* a correct sentence
  (manual review; see printed examples).

## Results (2026-10-12, Qwen3-4B Q4_K_M, RX 9070 XT, pipeline v0.1.0)

Full set, 1,501 sentences + 100 reference probes:

| metric | value |
|---|---|
| improved toward reference | 45.1% |
| unchanged | 38.3% (incl. 10 guardrail-held, 4 skipped-short) |
| harmed | 16.6% |
| reference sentences changed | 36% (reviewed: overwhelmingly legitimate fixes of learner-style refs, no breakage) |
| latency | p50 130 ms, p95 262 ms |

Notes:

- Most "harmed" cases are punctuation/quote normalization that the F1 metric
  counts against us, or debatable word choices ("espessial" → "essential" vs
  ref "special") rather than introduced errors.
- The guardrail held back 10 full-fluency rewrites — by design: this tool
  makes minimal edits, not essay rewrites.
- Interpreting: on deliberately errorful learner prose, roughly half the
  sentences measurably improve, a third are left alone (conservative default),
  and a sixth diverge from the reference style without breaking the text.
