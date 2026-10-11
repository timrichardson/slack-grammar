# Phase 0 spike results — 2026-10-12

## 1. CDP injection into Slack — PASS

`slack --remote-debugging-port=9222` → endpoint answers; hello-world badge injected
via `Runtime.evaluate` + registered for future navigations. Selector/DOM details in
`docs/selectors.md`. Fallbacks (app.asar patch) not needed.

## 2. Composer recon — PASS

Quill-based composer with stable `data-qa="texty_input"` selector; send button
doubles as a draft-state oracle. See `docs/selectors.md`.

## 3. Text replacement — PASS

`selectAll` + `insertText` replaces composer text, Slack's internal draft state
syncs (send button enables after a frame), undo stack intact, cleanup works.
Clipboard-paste fallback not needed.

## 4. llama.cpp Vulkan latency on RX 9070 XT — PASS (10–20x better than target)

- Build: **llama.cpp nightly `b11559`** prebuilt `ubuntu-vulkan-x64` (29 MB tarball,
  no toolchain needed) — pinned as our reference build.
- Model: **Qwen3-4B-Instruct-2507 Q4_K_M** (2.4 GB)
  sha256 `2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e`
- Server flags: `-ngl 99 -fa 1 -c 4096 --host 127.0.0.1 --port 8080`
  (`GGML_VK_VISIBLE_DEVICES=0` picks the dGPU; RADV detected fine).
- Model load ~1.2 s; **correction latency 64–202 ms per message** (target was
  <1.5 s). VRAM ~2.5 GB.

### Quality observations (Qwen3-4B, temperature 0, plain system prompt)

- Fixes typos/grammar conservatively; leaves arguable style ("I seen", "me and
  him") — acceptable for a conservative default.
- Already-correct input returned **unchanged** — good.
- **Failure mode found**: imperative messages ("can you review the docs…") got
  *answered* ("Sure, I can review…") instead of corrected. Phase 1 must:
  reframe prompt (user-role instruction "correct the following text", not
  conversational), add few-shot examples incl. an imperative one, and add an
  output-validation guardrail server-side (discard correction if it diverges too
  much from the input, e.g. diff-ratio threshold → return original).

## Environment pins

| Component | Version |
|---|---|
| slack-desktop | 4.52.178 (Electron 44.4.5, Chrome 152) |
| llama.cpp | nightly b11559 (v0.6.0-dev), prebuilt vulkan x64 |
| model | Qwen3-4B-Instruct-2507 Q4_K_M (bartowski GGUF) |
| GPU | RX 9070 XT, Mesa 26.2.4 RADV |

## Open items deferred by design

- Multi-workspace/multi-window target mapping (single workspace on this machine;
  daemon's `Target.setAutoAttach` handles it — verify in Phase 2 with 2+ windows).
- `Runtime.addBinding` round-trip (Phase 2; CDP sessions here were short-lived).
- Panther Lake/Xe3 bring-up (Phase 4, when hardware available).
