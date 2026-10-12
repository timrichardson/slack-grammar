# slack-grammar

Local-only grammar and spelling checking for the Linux **Slack desktop app**, powered by a local LLM on your GPU (AMD via RADV, Intel via ANV — anything with Vulkan). No cloud, no accounts, no telemetry: your drafts never leave localhost.

![status](https://img.shields.io/badge/status-beta-orange) ![license](https://img.shields.io/badge/license-Apache--2.0-blue)

When you pause typing, slack-grammar checks your draft and shows a small diff card above the composer — one click applies the fix. `Ctrl+Z` still undoes it, because fixes are applied through the editor's own editing pipeline.

```
 you type:   we was definately going to ship it yesturday
             ─────────────────────────────────────────────
 suggestion: we  was  definately  going to ship it  yesturday
                    were  definitely                 yesterday
             [Apply fix] [Ignore]                     ✕
```

## How it works

```
┌──────────────────────────── Slack (Electron) ────────────────────────────┐
│  injected bundle: composer watcher → 1s typing pause → diff card UI     │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ Chrome DevTools Protocol binding (no network from the page)
┌───────────────┴──────────────────────────────────────────────────────────┐
│ slack-grammar daemon (this repo, Bun)                                    │
│  • guardrails: never eat your text — bad corrections are discarded       │
│  • chat-style aware: no added periods, no re-capitalized sentences       │
│  • protects @mentions, URLs, code, emoji from the model                  │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ 127.0.0.1 only
        llama-server (llama.cpp, Vulkan backend) — Qwen3.5-4B, ~0.1–0.3s/check
```

Slack has no plugin API, so the daemon launches Slack with
`--remote-debugging-port` (ephemeral, loopback-only) and injects a bundle via
CDP that re-registers on every page load and survives Slack restarts.

## Requirements

- Linux with Slack desktop (`slack-desktop` .deb, v4.5x) — Electron/Chromium
- A Vulkan-capable GPU + driver (tested: AMD RX 9070 XT / RADV; Intel iGPUs use ANV)
  — a CPU fallback works but is slower
- [Bun](https://bun.sh) ≥ 1.1
- ~3 GB free disk (llama.cpp + 4B model)
- Slack must not be running when you first `launch` (the daemon takes over launching it)

## Quickstart

```sh
git clone https://github.com/timrichardson/slack-grammar.git
cd slack-grammar
./scripts/install.sh          # llama.cpp + model + bundle + systemd + launcher entry
slack-grammar launch          # starts daemon if needed, launches Slack through it
```

Then type a sloppy message in any Slack composer and pause for a second.

### Daily use

| Action | Result |
|---|---|
| Pause typing (~1 s) | Check runs; diff card appears if something's wrong |
| **Apply fix** / **Ignore** / **Esc** | Apply rewrites the draft (`Ctrl+Z` undoes); Ignore silences that text for the session |
| `Ctrl+Shift+G` | Toggle checking on/off for the window |
| `slack-grammar status` / `doctor` | Health of daemon, gateway, Slack injection |
| `slack-grammar stop` | Stop the daemon (Slack keeps running, injection pauses) |

Use the "Slack (slack-grammar)" desktop entry instead of the normal Slack icon.

## Configuration

Defaults live in `config/config.example.toml` — copy to
`~/.config/slack-grammar/config.toml` to override: model path/size, ports,
timeouts, guardrail thresholds, check rules (min words, debounce).

## Privacy & security

- Draft text goes exactly two places over loopback: the daemon and llama-server, both bound to `127.0.0.1`. Nothing is sent to the internet.
- No message text is written to disk; logs contain lengths and hashes only.
- Fixes apply through the editor's native commands — drafts are never destructively replaced.
- The debug port exposes control of Slack to *local processes only* while the daemon runs; it closes with the daemon. See [docs/threat-model.md](docs/threat-model.md).
- Reporting a vulnerability: see [SECURITY.md](SECURITY.md).

## Limitations

- English only for now (the checker conservatively avoids style edits)
- The suggestion card, not inline underlines (see roadmap in [PLAN.md](PLAN.md))
- One machine, one user, one Slack at a time

## Development

```sh
bun install
bun run lint && bun run typecheck && bun test
bun run build:bundle         # rebuild the injected bundle
bun run eval                 # 60-case correction suite (needs llama-server up)
bun run eval:jfleg           # public JFLEG benchmark (see docs/jfleg.md)
```

`llms.txt` provides a curated project map for AI tools; this repo is also served
as an MCP server at `https://gitmcp.io/timrichardson/slack-grammar`.

Architecture and decisions: [PLAN.md](PLAN.md) · agent/contributor guide: [AGENTS.md](AGENTS.md)

## Support

This project currently does not accept external code contributions: **pull
requests are disabled at the repository level** (a native GitHub setting).
Issue reports from anyone are welcome — for security issues use private
vulnerability reporting (see [SECURITY.md](SECURITY.md)) rather than public
issues.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
