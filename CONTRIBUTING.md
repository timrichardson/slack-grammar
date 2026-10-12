# Contributing to slack-grammar

Thanks for your interest! This project is small and focused; keeping it that
way is a goal.

## Getting set up

1. Follow the [README quickstart](README.md) (you need a working local setup
   before you can test changes).
2. Read [AGENTS.md](AGENTS.md) — it is the working guide for humans too:
   hard rules (privacy, never eat the user's text, never break Slack),
   conventions, and layout.
3. Read [PLAN.md](PLAN.md) for architecture and the decision log.

## Ground rules

- **Privacy is non-negotiable**: no telemetry, no external network calls, no
  message text in logs, no real message content in tests or fixtures. Test
  fixtures must use synthetic text.
- **Permissive deps only** (MIT/BSD/Apache-2.0/PSF), so the project stays
  single-license Apache-2.0.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:` …).

## Before you open a PR

```sh
bun run lint && bun run typecheck && bun test
bun run eval        # if you touched the prompt, guardrails, or protection layers
```

- The eval suite (`eval/corpus.jsonl`) gates at ≥85% and ≤1 false positive;
  prompt or guardrail changes must run it and must not regress the
  "already correct stays unchanged" cases.
- New pure logic (diff, rules, protection, protocol) needs unit tests.
- Changes touching the Slack DOM belong in `bundle/src/selectors.ts` only —
  it is the single point of breakage when Slack updates.

## Reporting bugs

Include: Slack version, GPU/driver (`vulkaninfo --summary`), `slack-grammar
doctor` output, daemon log lines (`~/.local/state/slack-grammar/daemon.log` —
they never contain your message text), and a synthetic example sentence that
misbehaves. **Do not paste real messages from your workspace.**

## Security issues

Do not open public issues for security problems — see [SECURITY.md](SECURITY.md).
