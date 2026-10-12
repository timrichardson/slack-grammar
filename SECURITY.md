# Security Policy

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository
(Report a vulnerability → Security tab). Do not open public issues for
security problems. Please include reproduction steps and impact; a response
is aimed for within a week (this is a personal project — no SLA).

## Security & privacy model (summary)

Full details in [docs/threat-model.md](docs/threat-model.md).

- **No network egress.** The daemon, gateway, and llama-server bind to
  `127.0.0.1` only. Message text never leaves the machine.
- **No message text at rest.** Logs contain lengths and hashes. The
  correction cache is RAM-only with a TTL.
- **Slack is exposed via a CDP debug port** while the daemon runs: an
  ephemeral, loopback-only `--remote-debugging-port`. Any local process
  running as your user could connect to it. This is the same trust boundary
  as other local automation tools; if that is unacceptable, don't run
  slack-grammar. The port is closed when the daemon stops.
- **Model output is untrusted.** Corrections are treated as plain text,
  never evaluated or injected as HTML. Guardrails discard corrections that
  diverge too far from the input, and fixes apply through the editor's
  native commands.
- **Supply chain**: llama.cpp builds and model GGUFs are pinned by SHA-256
  in `scripts/`; no binaries are committed to the repo.
