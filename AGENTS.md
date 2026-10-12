# AGENTS.md

Guidance for AI coding agents (and humans in a hurry) working in this repository.
Keep this file current — if you add a command, convention, or subsystem, update it here.

## What this repo is

`slack-grammar` is a local-only grammar and spelling checker for the Linux Slack
desktop app. A daemon launches Slack with `--remote-debugging-port` and injects a
JS bundle via the Chrome DevTools Protocol; the bundle watches the message
composer, sends paused-typing text to a local `llama-server` (llama.cpp, Vulkan
backend), and shows a one-click diff fix. Runs on AMD (RADV) and Intel Xe3 (ANV)
GPUs. **Status: Phases 0–2 complete (spikes, LLM service, CDP injector — live in
Slack); the in-Slack UI is next.** `PLAN.md` is the source of truth for architecture,
phases, and decisions — read it before making design choices.

## Hard rules (non-negotiable)

- **Privacy**: message text never leaves localhost. No telemetry, no analytics,
  no external network calls from the daemon or bundle (the only outbound
  connection is to `127.0.0.1` llama-server). Never log, cache to disk, or
  commit real message contents. Test fixtures must use synthetic text.
- **Never eat the user's text**: any error path in checking/applying returns the
  original text or applies nothing. No destructive writes to the composer.
- **Never break Slack**: injection must fail soft (feature-detect selectors,
  silent disable + surface in `doctor`), never crash or blank the Slack renderer.
- **No secrets, models, or binaries in git**: GGUFs and llama.cpp builds are
  fetched by `scripts/` with pinned versions + checksums.
- License is PSF-2.0. New third-party dependencies must be permissive
  (MIT/BSD/Apache-2.0/PSF) — no GPL or copilot-style ambiguity.

## Commands

- Install deps: `bun install` (workspace root)
- Dev daemon: `bun run dev` — Lint: `bun run lint` — Typecheck: `bun run typecheck`
- Tests: `bun test` — Eval suite (needs llama-server on :8080): `bun run eval`
- Doctor: `bun run doctor`
- Install llama.cpp / model: `scripts/install-llama.sh`, `scripts/pull-model.sh`

## Layout

- `PLAN.md` — architecture, locked decisions, phased roadmap, risks
- `daemon/` — Bun/TypeScript: Slack launcher, CDP injector, gateway, llama-server
  supervision
- `bundle/` — TS compiled by esbuild to one IIFE injected into Slack's renderer
  (no frameworks, no imports at runtime)
- `eval/` — grammar corpus + model accuracy/latency runner
- `scripts/` — pinned installs of llama.cpp + model GGUFs
- `systemd/` — user units; `docs/` — spike notes incl. Slack selector reference

## Conventions

- TypeScript strict mode everywhere. Daemon: Bun runtime, ESM. Bundle: vanilla
  DOM APIs, defensive coding, everything feature-detected.
- Selector/DOM knowledge lives only in `bundle/src/selectors.ts` (single point
  of breakage when Slack updates).
- LLM calls go through the daemon gateway (prompt templates, caching, timeouts)
  — the bundle never talks to llama-server directly.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:` …).
- Tests accompany logic changes (diff, sentinel protect/restore, prompt
  builder, gateway queue). Pure logic gets unit tests; CDP/UI work gets manual
  checklist entries in `docs/`.

## Security gotchas

- The CDP debug port exposes full control of Slack: bind 127.0.0.1 only, use
  an ephemeral port, close on daemon exit. Never commit a fixed port to docs.
- Model output is untrusted input: never `eval` it or inject as HTML; treat as
  plain text (XSS via "corrected" text is a real path into Slack's renderer).
- `llama-server` binds 127.0.0.1 only; assume other local processes could talk
  to it — it holds no message history beyond a TTL cache.

## When stuck

Read `PLAN.md` (decisions + risks), then `docs/` spike notes. If a Slack DOM
assumption fails, verify against the live app via CDP before inventing
selectors.
