# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

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
