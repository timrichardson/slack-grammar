# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Changed
- **Default model: Qwen3.5-4B Q4_K_M** (~3 GiB VRAM), replacing
  Qwen3-4B-Instruct-2507. Selected by benchmarking four models on a seeded
  400-sentence JFLEG sample plus the 60-case suite: improved-toward-reference
  49.0% (vs 46.0%), harmed 13.3% (vs 15.0%), keep-precision 100%. Measured
  footprints: 3.0 GiB (4B), 4.7 GiB (9B IQ4_XS) — both within a 6 GiB budget;
  `scripts/pull-model.sh` gained `qwen3.5-9b` (max-quality option) and keeps
  `qwen3-4b` (fastest). Gemma-4-E4B was evaluated and rejected: it rewrites
  correct text (keep-precision 71%).
- `LlmClient` now sends `chat_template_kwargs: {enable_thinking: false}` —
  Qwen3.5-class models emit `<think>` blocks by default, which previously
  drained the token budget and returned empty corrections.

### Added
- **JFLEG benchmark harness** (`eval/jfleg.ts`, `docs/jfleg.md`): full-pipeline
  evaluation on the public JFLEG GEC corpus (1,501 sentences, 4 references
  each; CC BY-NC-SA — downloaded at eval time, never committed). Results on
  the shipped default: improved 45.1%, GLEU (detokenized) 0.524 dev / 0.583
  test vs source-baseline 38.2/40.5 and human-reference 55.3/62.4.
- Model-agnostic eval metrics (fix-recall, keep-precision) alongside the
  strict accept-lists, for fair cross-model comparison.
- `scripts/bench-models.sh`: per-model VRAM footprint (sysfs), both suites,
  with a fail-loud guard against port collisions.

## [0.1.0] — 2026-10-12

First public release. Local-only grammar & spelling checking for the Linux
Slack desktop app via CDP injection and a Vulkan-accelerated local LLM.

### Added
- Daemon: llama-server supervision, loopback gateway (`/check`) with LRU
  cache + in-flight dedup, CLI (`launch|start|stop|status|doctor|install-desktop-entry`)
- CDP injector: auto-attach to every workspace window, re-inject on page
  loads, reconnect with backoff, adoption of an already-running Slack
- Injected bundle: composer watcher (1 s pause debounce, skip rules),
  Shadow-DOM diff card with Apply/Ignore, Ctrl+Shift+G toggle,
  status glyph, Esc dismiss, version-aware re-injection
- Check pipeline: sentinel protection (mentions/URLs/code/emoji),
  chat-style-preserving prompt with few-shots, guardrails (absolute+ratio
  thresholds, line-wise salvage, sentinel integrity), "never eat the text"
  invariant on every failure path
- Eval harness: 60-case corpus, 12 categories, gating runner (60/60 at
  release, p50 ≈ 77 ms on RX 9070 XT)
- Installers: pinned llama.cpp nightly + Qwen3-4B GGUF (SHA-256 verified),
  systemd user unit, desktop entry, end-to-end `install.sh`
- Docs: threat model, e2e checklist, selector reference, spike notes
