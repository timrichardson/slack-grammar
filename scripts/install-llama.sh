#!/usr/bin/env bash
# install-llama.sh — fetch a pinned llama.cpp prebuilt Vulkan build.
# Usage: scripts/install-llama.sh [build-tag]   (default: pinned below)
set -euo pipefail

LLAMA_TAG="${1:-b11559}"
LLAMA_SHA256="3c864ef7eaac254b179a52cfc648ea5b31bcea67e3523710acc6828f44e12d9e"  # b11559 tarball
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
TARBALL="$VENDOR/llama-${LLAMA_TAG}-ubuntu-vulkan-x64.tar.gz"
DEST="$VENDOR/llama-${LLAMA_TAG}"

# Checksums are per-tag; only the pinned tag has a known hash.
if [[ "$LLAMA_TAG" != "b11559" ]]; then
  echo "note: no pinned checksum for tag $LLAMA_TAG (checksum verification skipped)" >&2
  LLAMA_SHA256=""
fi

mkdir -p "$VENDOR"

if [[ -x "$DEST/llama-server" ]]; then
  echo "llama.cpp $LLAMA_TAG already installed at $DEST"
  "$DEST/llama-server" --version
  exit 0
fi

echo "downloading llama.cpp $LLAMA_TAG (ubuntu-vulkan-x64)..."
curl -fL --retry 3 -o "$TARBALL" \
  "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-ubuntu-vulkan-x64.tar.gz"

if [[ -n "$LLAMA_SHA256" ]]; then
  echo "$LLAMA_SHA256  $TARBALL" | sha256sum -c -
fi

mkdir -p "$DEST"
tar -xzf "$TARBALL" -C "$DEST" --strip-components=1

# Smoke test: confirm the Vulkan backend loads on this machine.
export LD_LIBRARY_PATH="$DEST"
"$DEST/llama-server" --version

cat <<EOF

OK: llama.cpp $LLAMA_TAG installed at $DEST
Requires a Vulkan driver (RADV for AMD, ANV for Intel). If the smoke test
failed with a Vulkan error, check: vulkaninfo --summary
EOF
