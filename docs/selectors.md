# Slack desktop DOM & CDP — spike findings (2026-10-12)

Environment: slack-desktop 4.52.178 (Electron 44.4.5 / Chrome 152), Ubuntu 26.04,
launched as `slack --remote-debugging-port=9222`. Probe: `spikes/cdp-probe.mjs`
(zero-dependency Node 24, global WebSocket).

## CDP connection

- `--remote-debugging-port` is **not stripped** by Slack's main process; endpoint
  answers immediately on 127.0.0.1 after launch.
- `/json/list` shows one `page` target per workspace window
  (`https://app.slack.com/client/<T..>/...`) plus a `service_worker` (ignore).
  The daemon should attach to `page` targets only — multi-workspace = multi-target,
  handled by `Target.setAutoAttach` as planned.
- `Runtime.evaluate` + `Page.addScriptToEvaluateOnNewDocument` both work.
  Note: script registration is **per CDP session** — it disappears when our
  websocket disconnects. Daemon must re-register on every (re)connect.
- A previously-running Slack must be fully exited first (single-instance app).

## Composer (it's Quill)

- Editor: `div[role="textbox"][data-qa="texty_input"]` with class `ql-editor`
  (Slack uses **Quill**). Present even on the activity-inbox view (thread reply
  panel composer, per its `aria-label="Reply to thread with tom"`).
- Sibling `div.ql-clipboard` exists (Quill internals) — excluded automatically
  by requiring `role="textbox"`.
- `ql-blank` class = empty state; toggles **asynchronously** after input
  (mutation-observer driven). Don't trust it synchronously.
- Empty composer `innerText === "\n"` (Quill keeps a trailing newline).
- Context available via `aria-label` (e.g. "Reply to thread with X") — usable to
  skip checks in huddle/threads if desired.

## Send button = Slack's internal draft-state oracle

- `[data-qa="texty_send_button"]` with `aria-disabled` true/false.
- Reads are **stale immediately after `execCommand`** (React renders async);
  settle within ~1 frame (verified at 800 ms, clearly synced).
- Useful as a health check: after applying a fix, `aria-disabled="false"`
  proves Slack's app state — not just the DOM — received the text.

## Text replacement (the apply-fix path) — VERIFIED

All through `document.execCommand` on the focused editor (caret set to end first):

| Operation | Result |
|---|---|
| `insertText` (typing simulation) | lands in editor + Slack draft state syncs |
| `selectAll` + `insertText` (fix apply) | full replacement, draft state syncs, send enables |
| `undo` | reverts to previous text (editor undo stack intact) |
| `selectAll` + `delete` (cleanup) | empties composer, send disables, `ql-blank` returns |

Caveats:

- Always `focus()` the editor and place the caret before `execCommand`.
- Never read back DOM state synchronously after `execCommand`; wait a frame.

## Injection side effects

- Injected badge div appeared fine; no CSP interference for DOM manipulation.
- No `fetch`-to-localhost test done (design already avoids it via CDP bindings).
