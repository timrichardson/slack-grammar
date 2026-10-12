#!/usr/bin/env bash
# install.sh — end-to-end setup for slack-grammar.
# Installs: llama.cpp (pinned Vulkan build), model (pinned GGUF), bundle,
# ~/.local/bin/slack-grammar wrapper, systemd user unit, desktop entry.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
UNIT_DIR="$HOME/.config/systemd/user"
BUN="${BUN:-$HOME/.bun/bin/bun}"

echo "== slack-grammar install =="

# 1. bun
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$BUN" ]; then
  echo "error: bun is required (https://bun.sh): curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi
[ -x "$BUN" ] || BUN="$(command -v bun)"
echo "using bun: $BUN"

# 2. engine + model (skip with SKIP_DOWNLOAD=1)
if [ "${SKIP_DOWNLOAD:-0}" != "1" ]; then
  "$ROOT/scripts/install-llama.sh"
  "$ROOT/scripts/pull-model.sh" qwen3-4b
fi

# 3. deps + bundle
(cd "$ROOT" && "$BUN" install)
(cd "$ROOT" && "$BUN" run build:bundle)

# 4. wrapper on PATH
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/slack-grammar" <<EOF
#!/bin/sh
exec "$BUN" run "$ROOT/daemon/src/main.ts" "\$@"
EOF
chmod +x "$BIN_DIR/slack-grammar"
echo "wrote $BIN_DIR/slack-grammar"

# 5. systemd user unit
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/slack-grammar.service" <<EOF
[Unit]
Description=slack-grammar — local LLM grammar checker for Slack
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=$BIN_DIR/slack-grammar start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
echo "wrote $UNIT_DIR/slack-grammar.service (not enabled — run 'slack-grammar launch' on demand, or:)"
echo "  systemctl --user enable --now slack-grammar"

# 6. desktop entry (routes Slack through the daemon)
"$BIN_DIR/slack-grammar" install-desktop-entry

echo
echo "== install complete =="
echo "quit Slack if it's running, then: slack-grammar launch"
echo "verify with: slack-grammar doctor && slack-grammar status"
