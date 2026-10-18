# Manual e2e checklist

Run before releases and after touching the injector, bundle UX, or the
apply-path. Everything except the last section can be driven headlessly via
`spikes/cdp-probe.mjs` (see git history for examples).

## Setup

- [ ] `slack-grammar doctor` all green
- [ ] `slack-grammar launch` → Slack opens, `status` shows daemon/gateway/Slack all true, cdpOk true

## Bridge

- [ ] `window.__sg.version` present in the page; `connected: true`
- [ ] Ctrl+R in Slack → bridge reconnects (addScriptToEvaluateOnNewDocument re-runs)

## Checking UX

- [ ] Type a synthetic typo message ("we was definately going to ship it yesturday"), pause → diff card appears with red/green highlights
- [ ] **Apply fix** → composer text corrected, send button enabled, "✓ applied — Ctrl+Z to undo" flash, no re-check loop
- [ ] Ctrl+Z after Apply → original text restored
- [ ] **Ignore** → card hides; same text typed again does not re-check
- [ ] **Copy** → corrected text on the clipboard (paste elsewhere to verify); button shows "Copied", card stays open, composer untouched
- [ ] Esc → card hides
- [ ] Clean text ("the deployment finished successfully this morning") → no card
- [ ] `/remind …`, "heads up team:", open code fence → no check
- [ ] `@mention`, URL, `inline code`, :emoji: survive byte-for-byte after Apply
- [ ] Ctrl+Shift+G toggles checking; glyph reflects state
- [ ] Multi-line message → line breaks preserved after Apply

## Resilience

- [ ] `slack-grammar stop` → `launch` again → daemon **adopts** the running Slack (log: "adopted running slack"), bridge reconnects without Slack restart
- [ ] Quit Slack while daemon runs → relaunch via `launch` works; daemon did not respawn-loop
- [ ] Kill llama-server → checks return original text (no widget), error glyph shows; llama-server restarts on next daemon start

## GPU matrix (when hardware available)

- [ ] AMD dGPU (RADV) — desktop profile
- [ ] Intel Xe3 iGPU (ANV) — laptop profile, model size per install.sh logic
- [ ] CPU fallback — slow but functional

## Eval gate

- [ ] `bun run eval` ≥ 85% overall, 0–1 false positives on keep-cases (currently 60/60)

## Reinjection helper

- [ ] `bun run reinject --help` exits without touching Slack or the daemon.
- [ ] `bun run reinject`: decline confirmation; Slack and daemon stay untouched.
- [ ] After saving drafts and ending calls, accept confirmation: bundle rebuilds,
  Slack quits gracefully, daemon restarts, and the checker reports enabled.
- [ ] Repeat with an active systemd service and with a detached daemon.
- [ ] With a daemon running alongside external, uninjected Slack, reinjection
  pauses launch supervision: Slack does not respawn during the quit window.
- [ ] With the service in `activating (auto-restart)`, reinjection cancels the
  pending retry via service stop and restarts through systemd, not detached mode.
- [ ] An older daemon without pause acknowledgement causes a safe failure before
  Slack is asked to quit; no new daemon starts. Quit Slack manually and stop the
  daemon/service, then rerun to upgrade it.
- [ ] If Slack refuses to quit, helper times out without SIGKILL; quit it manually
  and rerun. If injection fails, helper exits nonzero rather than claiming success.
- [ ] No real draft text appears in script output; no draft is edited or sent.
