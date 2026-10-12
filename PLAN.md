# slack-grammar — Local LLM grammar & spelling checker for the Linux Slack desktop app

## Goal

Check every message I write in the Linux Slack desktop app for grammar and spelling,
using a local LLM only. Suggestions appear as I type (after a pause); one click applies
the fix. Runs on:

- **Desktop**: AMD Radeon RX 9070 XT (`gfx1201`, RADV Vulkan) — Ubuntu 26.04, 59 GB RAM
- **Laptop**: Panther Lake (Intel Xe3 iGPU, ANV Vulkan)

Hard constraints: no cloud APIs, no message text leaves the machine, nothing is logged
to disk, and it must survive Slack auto-updates without manual repair.

**Project invariants** (apply to every phase):

1. *Never eat the user's text* — any failure returns/applies the original, never a
   mangled or empty composer.
2. *Never break Slack* — the injected bundle fails soft; selector breakage means
   silent disable + a `doctor` warning, never a broken renderer.
3. *Local-only* — the only network connections are loopback (llama-server, CDP).

**License**: PSF-2.0 (per maintainer choice). Third-party deps must stay
permissive (MIT/BSD/Apache-2.0/PSF) so the project stays single-license.

## Decisions (locked in)

| Decision | Choice | Rationale |
|---|---|---|
| Integration | **CDP injection** — launch Slack with `--remote-debugging-port`, inject JS via Chrome DevTools Protocol | Non-invasive, no sudo, no file patching, survives Slack updates, easy to disable |
| Interaction | **Live check on typing pause + one-click fix** | Grammarly-like feel without intercepting sends |
| Model class | **~4B instruct GGUF (Q4_K_M)**, default Qwen3-4B-Instruct | Great at "fix grammar, output corrected text only"; fast on 9070 XT, adequate on Xe3 iGPU; per-machine override to ~1.7B if laptop is too slow |
| Engine | **llama.cpp `llama-server`, Vulkan backend** | One build runs on both AMD (RADV) and Intel (ANV). No ROCm/SYCL split, no Ollama (Intel iGPU support too shaky). Bonus: Phoronix benchmarks show Vulkan/RADV **outperforming ROCm 6.4.3** on the RX 9070 XT in llama.cpp — Vulkan is not a compromise even on the AMD desktop |

## Architecture

```
┌─────────────────────────── Slack (Electron) ────────────────────────────┐
│  renderer per workspace window                                           │
│  ┌───────────────────── injected bundle (plain JS IIFE) ──────────────┐  │
│  │  composer watcher  →  debounce  →  check request (via CDP binding) │  │
│  │  floating diff UI  ←  corrected text  ←  …                          │  │
│  └──────────────────────────────┬──────────────────────────────────────┘  │
└─────────────────────────────────┼──────────────────────────────────────────┘
                                  │ CDP WebSocket (Runtime.addBinding / evaluate)
┌─────────────────────────────────┼──────────────────────────────────────────┐
│ slack-grammar daemon (Bun, systemd --user)                                │
│  ├── launcher: spawns slack with --remote-debugging-port=<ephemeral>      │
│  ├── cdp: auto-attach to all targets, inject bundle on every page load    │
│  ├── gateway: /check → prompt build → cache → queue → parse → response    │
│  └── subprocess mgmt: llama-server (Vulkan) on 127.0.0.1:8080             │
└────────────────────────────────────────────────────────────────────────────┘
```

Key design points:

- **CDP bindings, not fetch.** Slack's renderer CSP likely blocks `fetch` to
  `127.0.0.1`. The bundle talks to the daemon through `Runtime.addBinding`
  (page → daemon) and `Runtime.evaluate` (daemon → page). Zero network from the page.
- **Gateway layer between bundle and llama-server.** Centralizes the prompt template,
  result caching (by text hash), request coalescing/cancellation, and JSON contract.
  Lets us swap engines or models without touching the bundle.
- **Client-side diff.** The model returns only the corrected text; we compute a
  word-level diff in the bundle. Small models are unreliable at emitting structured
  diffs, but very reliable at "rewrite this text corrected".
- **Replacement via native editing commands.** Apply fixes with
  `document.execCommand('insertText')` / InputEvents so Slack's own editor state,
  send-button enablement, and Ctrl+Z undo stack all stay consistent.

## Repository layout

```
slack_grammar/
├── PLAN.md
├── AGENTS.md             # agent/contributor working rules (CLAUDE.md symlinks here)
├── LICENSE               # PSF-2.0
├── README.md
├── daemon/               # Bun/TypeScript: launcher + CDP injector + gateway
├── bundle/               # TypeScript → single IIFE via esbuild (no framework)
│   └── src/              #   composer.ts, ui.ts, diff.ts, bridge.ts, protect.ts
├── eval/                 # grammar corpus + accuracy/latency runner
├── scripts/              # install-llama.sh, pull-model.sh, install.sh, doctor
├── systemd/              # slack-grammar.service (user unit)
├── config/               # config.example.toml
└── docs/                 # spike notes, selector reference, laptop setup
```

## Prior art & research findings (2026-10)

**Approach validation — CDP injection into Slack works:**

- **`electron-inject`** (tintinweb, PyPI) — injects JS into closed-source Electron
  apps (Slack explicitly demoed) via the remote debug console. Proves the
  mechanism; we build it in TypeScript with auto-attach + reconnect instead of
  one-shot injection.
- **`shlack`** (~johnhamelink, sourcehut) — declarative JS injection into Slack
  desktop via remote debugger on a localhost port (Nix-based). Same architecture
  as our daemon, single-user scope.
- Electron docs confirm `--remote-debugging-port` is a supported switch; Vercel's
  `agent-browser` documents `slack --remote-debugging-port=9222` on Linux as a
  standard automation entry point.

**Grammar-checker landscape — the idea is proven, our niche is open:**

- **Harper** (Automattic, ~15k stars, Apache-2.0) — Rust, offline, <10 ms lint,
  ships a WASM build (`harper.js`). Deterministic rule-based checker, no LLM.
  Strong candidate for an instant first-pass tier later (see Backlog).
- **OpenGrammar** (122★, Apache-2.0) — self-hosted Grammarly alternative,
  dual-engine: local dictionary/regex first pass + LLM router for deep checks,
  with dedup so the LLM never re-checks what the local engine already caught.
  Validates the two-tier design pattern.
- **GhostEdit** (MIT) — system-wide hotkey checker; offline T5 grammar model
  (`t5-base-grammar-correction` via ONNX) plus Harper.js/nspell; correction
  cache. Validates offline-model path; we prefer a local LLM for quality.
- **grammarfix** (macOS, MIT) — Ollama-based cleanup CLI with the invariant
  *"never eats your text"* (errors always return the original input). Adopted
  as project invariant #1.
- **Gramma / LanguageTool** — LanguageTool-local pattern; Harper's authors
  document its downsides (~16 GB n-gram data, multi-second latency) — confirms
  avoidance.
- **Gap**: no existing project combines *Linux Slack desktop* + *live composer
  integration* + *local LLM*. Closest projects are browser extensions or
  system-wide hotkey tools. Our differentiation is the native, update-resilient
  Slack integration.

**Engine findings:**

- Phoronix (RX 9070 XT, Linux 6.17 + Mesa 25.3+): llama.cpp **Vulkan/RADV beats
  ROCm 6.4.3** across text-gen and prompt-processing benchmarks — Vulkan is the
  right call on the desktop too, not just the laptop.
- llama.cpp Vulkan runs on Intel Arc iGPUs incl. Arc 140T-class (UMA) hardware;
  known edge-case bugs (f16 accumulation on embeddings) don't affect standard
  text generation. SYCL remains a documented fallback if Xe3/ANV hits issues.
- Prebuilt `llama-bXXXX-bin-ubuntu-vulkan-x64.zip` releases exist — no compiler
  toolchain needed on either machine.

## Phases

### Phase 0 — Spikes (validate riskiest assumptions)  ~half day — **DONE 2026-10-12, all passed** (details: `docs/spike-notes.md`)

1. **CDP into Slack**: ✅ flag honored, badge injected, one page target per window.
2. **Composer recon**: ✅ Quill editor, `data-qa="texty_input"`, send button as
   draft-state oracle (`docs/selectors.md`).
3. **Text replacement**: ✅ selectAll+insertText syncs Slack state, undo works.
4. **llama.cpp Vulkan on 9070 XT**: ✅ prebuilt b11559, Qwen3-4B Q4_K_M:
   **64–202 ms per correction** (target <1.5 s), ~2.5 GB VRAM. One prompt failure
   mode found (imperative messages get answered, not corrected) → Phase 1 work.

### Phase 1 — LLM service  ~1 day — **DONE 2026-10-12** (60/60 eval, p50 75 ms)

- ✅ `scripts/install-llama.sh` (pinned b11559 + sha256), `scripts/pull-model.sh`
  (Qwen3-4B Q4_K_M + sha256, alternate model slots).
- ✅ Chat-style-preserving prompt (4 few-shot pairs incl. imperative + emoji
  cases), temperature 0, prompt caching on llama-server.
- ✅ Sentinel protection with URL trailing-punctuation handling; guardrail with
  absolute-token + ratio thresholds and **line-wise salvage** for multiline.
- ✅ Gateway `POST /check` on 127.0.0.1:8765: LRU cache, in-flight dedup,
  single-slot serialization, timeout → original text. Structured logs without
  message content.
- ✅ `eval/`: 60-case corpus (12 categories), runner with per-tag scoring +
  latency percentiles; gates at ≥85% and ≤1 false positive.
- ✅ systemd user unit (`systemd/slack-grammar.service`; install.sh templates
  paths in Phase 5).
- Findings baked in: model wanted to normalize chat style (added periods,
  capitalized/lowercased) — prompt rules now prioritize real fixes over style;
  `,;` artifact around URLs was a protect-layer bug (URL regex ate commas).

### Phase 2 — Injector daemon  ~1–2 days — **DONE 2026-10-12** (e2e verified in live Slack)

- ✅ Launcher: `slack-grammar launch` (daemon auto-start + Slack launch through it),
  `start|stop|status|doctor|install-desktop-entry` CLI; ephemeral CDP port bound to
  127.0.0.1; state files under `~/.local/state/slack-grammar/`.
- ✅ CDP client: browser-level `Target.setAutoAttach` (flatten, page filter) — every
  workspace window gets the bundle on every new document + `Runtime.addBinding`
  bridge; reconnect with backoff; **adoption** of an already-running Slack that
  still has our CDP port (daemon restart resilience).
- ✅ Protocol v1 (`hello|ping|check`) verified end-to-end inside the live renderer:
  `window.__sg.call("check", …)` → binding → gateway → llama-server → back, 95–99 ms.
- ✅ Relaunch policy: crashed Slack re-launched up to 3×, then parks (no respawn
  loops); user-quit Slack is left alone.
- Found along the way: Electron's self re-exec can leave `/proc/*/cmdline` with
  spaces instead of NUL separators — process detection splits on both; pid-file
  removal is pid-conditional to survive daemon restart races.

### Phase 3 — In-Slack UX (the bundle)  ~2–3 days — **DONE 2026-10-12** (core, verified live)

- ✅ Composer watcher: delegated input events (survives channel switches — the
  composer element is recreated constantly), ~1 s typing-pause debounce, stale
  result discard, single-flight. Skip rules: too short, slash-commands,
  trailing `:`, open code fences, caret in code, session-ignored texts.
- ✅ Floating widget: Shadow-DOM isolated card above the composer; word-level
  diff (del strike-through / ins highlight); Apply / Ignore / Dismiss; Esc
  dismisses; mousedown-guard keeps composer focus so Ctrl+Z works after Apply.
- ✅ Apply path: Phase-0-validated `selectAll`+`insertText`; empty-correction
  guard (never eat the text); applied text auto-ignored (no check loops);
  "✓ applied — Ctrl+Z to undo" flash.
- ✅ Status glyph (checking pulse / error) + **Ctrl+Shift+G** enable toggle.
- ✅ Live e2e in real Slack: typo text → widget with diff → Apply → composer
  corrected + send button enabled + no re-check; clean text → no widget.
- ✅ Bundle version guard: a newer bundle takes over a loaded page in place
  (daemon restart deploys without a Slack reload).
- Deferred to Phase 5 polish: config plumbing (debounce/minWords come from the
  daemon), thread/huddle composer filtering by aria-label, i18n hook.

### Phase 4 — Panther Lake laptop bring-up  ~half day (when hardware available)

- Same install; `install.sh` detects GPU via `vulkaninfo`, picks model
  (4B if ≥ 24 GB RAM, else 1.7B) and context size accordingly.
- Verify ANV Vulkan + llama.cpp on Xe3; record required Mesa/kernel floor in docs;
  benchmark latency — swap to 1.7B model via per-machine config if 4B feels slow.
- Battery: document power-profile interaction; keep llama-server slot warm but idle
  (`--idle`), option to stop service on battery.

### Phase 5 — Hardening, packaging & open-source hygiene  ~1 day

- Security pass: ephemeral 127.0.0.1 debug port, no external binds, no message text
  in logs or on disk, kill daemon → port closes.
- Tests: unit (diff, sentinel protect/restore, prompt builder), integration
  (gateway with a mock llama-server), manual e2e checklist (threads, DMs, huddles,
  emoji picker, mentions, paste, multi-window, two workspaces).
- `install.sh` end-to-end on a clean user; README with architecture + troubleshooting.
- **Open-source hygiene** (per OpenSSF OSPS baseline & GitHub repo best practices):
  - Community files before publicizing: `README.md` (quickstart + demo GIF +
    "why this exists"), `CONTRIBUTING.md`, `SECURITY.md` (privacy promise +
    CDP-port disclosure + private vulnerability reporting), `CODE_OF_CONDUCT.md`,
    `SUPPORT`/support statement in README, issue/PR templates.
  - CI from day one (GitHub Actions): lint, typecheck, unit tests, esbuild bundle
    check on PR; Dependabot + secret scanning + push protection enabled.
  - Reproducibility: pinned llama.cpp release + model GGUF SHA256 checksums in
    `scripts/`; `CHANGELOG.md` + semver tags from first release.
  - Threat-model doc (OSPS-SA-01): what the CDP port exposes, what's local-only,
    what the model can/can't do (model output treated as untrusted input).

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Slack update changes DOM/selectors | High, eventually | Selector map isolated in one module, feature-detection + silent disable, `doctor` reports breakage, optional `apt-mark hold slack-desktop` |
| Renderer CSP or Electron blocks injection/injection paths | Low–med | Phase 0 spike; fallback = patch `app.asar` preload (documented, more maintenance) |
| Composer replacement desyncs editor state | Med | execCommand/insertText path validated in Phase 0; fallback: CDP clipboard paste; keep rich content out of scope for v1 |
| 4B too slow on Xe3 iGPU | Med | Benchmark in Phase 1/4; config-driven downgrade to 1.7B; corrections are short outputs |
| Model rewrites style / false positives | Med | Conservative prompt, "already correct" eval cases must return unchanged, per-diff magnitude threshold, easy Ignore |
| Model *answers* imperative messages instead of correcting them (observed in spike) | High if unfixed | Reframed non-conversational prompt + few-shot incl. imperative example; server-side guardrail discards corrections whose diff-ratio vs input exceeds a threshold (return original) |
| Vulkan quirks on RADV/ANV (fp16, coopmat) | Low | Pin known-good llama.cpp release; CPU fallback config |
| Latency spikes while typing | Med | Debounce + cache + cancel stale; serial queue; warm slot; timeout → silent pass |

## Out of scope for v1

- Sentence-level inline underlines inside the composer (DOM overlay in Slack's editor
  is brittle; the popup diff gets 90% of the value)
- Languages other than English (config hook exists)
- Editing already-sent messages
- macOS / Slack in browser

## Backlog (post-v1 ideas from research)

- **Hybrid two-tier checking with `harper.js`** (WASM, Apache-2.0): instant
  deterministic first-pass underlines inside the composer (<10 ms, no GPU), LLM
  pass only when Harper flags something ambiguous or on pause. Cuts LLM calls
  sharply (OpenGrammar's dedup pattern) and gives sub-second feedback on obvious
  typos. The upgrade path to inline underlines.
- Inline underlines in the composer (enabled by the above)
- Multiple languages via config (Harper is English-only; LLM tier would carry it)
- Other Electron apps (Discord, Teams) — the daemon/injector is app-agnostic in
  principle
