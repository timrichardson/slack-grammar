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

### Phase 0 — Spikes (de-risk before building anything)  ~half day

1. **CDP into Slack**: run `slack --remote-debugging-port=9222`, connect, list
   targets, `Page.addScriptToEvaluateOnNewDocument` a hello-world that adds a DOM
   badge. Confirm Slack doesn't strip the flag and the renderer accepts injection.
2. **Composer recon**: identify stable selectors/hooks for the message composer
   (`div[contenteditable]`, `data-qa` attributes), how mentions/emoji render in the
   DOM, and how multi-window/multi-workspace maps to CDP targets. Write findings to
   `docs/selectors.md`.
3. **Text replacement**: focus composer, select-all, `execCommand('insertText')`.
   Verify: send button enables, draft persists across channel switch, Ctrl+Z undoes.
4. **llama.cpp Vulkan on 9070 XT**: download prebuilt Vulkan release, run
   Qwen3-4B-Instruct Q4_K_M, measure prompt+generation latency for a typical
   correction (~30 words in, ~30 words out). Target: < 1.5 s on desktop.

**Exit criteria:** all four spikes pass, or fallbacks are chosen (app.asar patch if
CDP is blocked; clipboard-paste via CDP Input events if execCommand desyncs).

### Phase 1 — LLM service  ~1 day

- `scripts/install-llama.sh`: pinned prebuilt llama.cpp Vulkan build (fallback:
  source build with `-DGGML_VULKAN=1`).
- `scripts/pull-model.sh`: fetch GGUF from Hugging Face. Default
  `Qwen3-4B-Instruct-2507-Q4_K_M`; alternates pinned in config.
- Prompt design (temperature 0, JSON mode off — plain text out):
  system prompt = "fix grammar/spelling only; preserve formatting, mentions, emoji,
  URLs, code blocks; change as little as possible; return the text only".
  Token protection: replace @mentions/URLs/code spans with sentinel tokens before
  the LLM call, restore after.
- Gateway `/check`: hash cache, single-slot queue, stale-request cancellation,
  timeout (3 s) → respond "no correction" (never block or annoy).
- `eval/`: ~60-sentence corpus (real typos, its/it's, code blocks, URLs, names,
  emoji, multi-line, "already correct" texts that must come back unchanged).
  Runner scores accuracy + latency for 2–3 candidate models; pick the default from data.
- systemd user unit: starts daemon (which starts llama-server) on login.

### Phase 2 — Injector daemon  ~1–2 days

- Launcher: copies Slack's `.desktop` entry to `~/.local/share/applications` with
  `Exec=slack-grammar` so normal launching works; picks an ephemeral debug port,
  binds 127.0.0.1 only.
- CDP client: `Target.setAutoAttach` for all windows/workspaces; inject bundle on
  every new document; re-inject after Slack self-update relaunch; reconnect on crash.
- Binding protocol: versioned JSON messages (check request/response, config,
  enable/disable, status).
- CLI: `slack-grammar start|stop|status|logs|doctor` (doctor verifies GPU, Vulkan,
  llama-server, Slack version, injection health).

### Phase 3 — In-Slack UX (the bundle)  ~2–3 days

- Composer watcher: input events + MutationObserver; debounce ~1 s idle; skip if
  < 3 words, empty, or caret inside a code block; skip text ending in `:` (commands).
- Floating widget near composer, only when the diff is non-empty:
  original → corrected with word-level highlights; `[Apply] [Ignore] [Dismiss]`.
  Ignore suppresses re-checks of the same text for the session.
- Apply = Phase-0-validated replacement path; keep a pre-apply snapshot for a
  one-step restore.
- Status glyph (idle/checking/ready/error/offline) + global on/off toggle hotkey;
  config: language, debounce, aggressiveness (conservative default: only clear errors).
- Graceful degradation: if selectors feature-detect fails after a Slack update,
  disable silently and surface it in `doctor` + logs — never break Slack itself.

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
