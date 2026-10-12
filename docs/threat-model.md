# Threat model

OSPS-SA-01 style summary of actors, assets, and boundaries.

## Assets

1. **Draft message text** (user's unpublished Slack messages) — the sensitive asset.
2. **Slack session** (cookies, tokens, full account access via the renderer).
3. **Local machine integrity** (llama-server, daemon, injected JS run as the user).

## Actors

- **User** (trusted owner of the machine)
- **Local processes** running as the same user (partially trusted by default on
  single-user desktop Linux; see boundary B1)
- **Other machines on the network / internet** (untrusted)
- **The LLM** (Qwen3-4B running locally; produces untrusted *output*, processes
  text locally — no third party involved)
- **Slack's own code** (trusted; we must never break it)

## Trust boundaries

| # | Boundary | Exposure | Mitigation |
|---|---|---|---|
| B1 | CDP debug port (ephemeral, `127.0.0.1`) | Any local process as the user can connect and control Slack (read/write messages, session) | Port exists only while the daemon runs; chosen fresh per launch; closed on daemon exit. Same-trust-level exposure as other local automation. Documented loudly in README/SECURITY. |
| B2 | llama-server `127.0.0.1:8080` | Any local process can send prompts / read completions of *its own* requests; llama-server retains no history; our gateway cache is RAM-only with TTL | Acceptable on single-user machines; configurable port. |
| B3 | Gateway `127.0.0.1:8765` (`POST /check`) | Local processes could submit text and receive corrections; no message store exists | Acceptable; adds cache-poisoning nuisance at worst (deterministic temperature 0). |
| B4 | Network egress | None required for any component | No telemetry, no update pings; installer downloads are explicit one-time `curl` with pinned SHA-256. |

## Attack paths & mitigations

- **Malicious "correction" (prompt injection via checked text)** → model output
  is rendered as plain text only (never `innerHTML`/`eval`); sentinels must
  survive byte-for-byte; diff-ratio/length guardrails reject rewrites; every
  failure path returns the original text ("never eat the text").
- **Injected bundle exploited as an XSS sink** → widget builds DOM via
  `document.createElement` + `textContent` exclusively; no URL/HTML sinks.
- **Compromised llama.cpp build or model file** → pinned versions + SHA-256
  verification in `scripts/`; no binaries in git.
- **Daemon crash / Slack update** → fail-soft injection (feature-detect +
  silent disable surfaced via `doctor`); Slack never left broken; daemon
  restart adopts a running Slack instead of killing it.
- **Log leakage** → logs carry hashes/lengths/latencies only; no message text
  is ever logged, cached to disk, or committed.

## Residual risks (accepted)

- A malicious local process at the same trust level can already keylog or read
  Slack storage directly; B1 adds no new *class* of exposure for such an actor.
- Guardrails can still pass a subtly wrong (but plausible) correction — the
  user remains the final reviewer before sending.
