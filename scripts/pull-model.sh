#!/usr/bin/env bash
# pull-model.sh — download a pinned GGUF model with checksum verification.
# Usage: scripts/pull-model.sh [model-name]   (default: qwen3-4b)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS="$ROOT/models"
mkdir -p "$MODELS"

get_model() {
  local name="$1" url="$2" file="$3" sha="$4"
  local dest="$MODELS/$file"
  if [[ -f "$dest" ]]; then
    echo "$sha  $dest" | sha256sum -c - >/dev/null && { echo "$name already present: $dest"; return 0; }
    echo "checksum mismatch for existing $dest — re-downloading" >&2
    rm -f "$dest"
  fi
  echo "downloading $name (~2.4 GB)..."
  curl -fL --retry 3 -o "$dest.tmp" "$url"
  echo "$sha  $dest.tmp" | sha256sum -c -
  mv "$dest.tmp" "$dest"
  echo "OK: $dest"
}

case "${1:-qwen3.5-4b}" in
  qwen3.5-4b)
    get_model "Qwen3.5-4B Q4_K_M (default — best quality/size, ~3 GiB VRAM)" \
      "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/main/Qwen_Qwen3.5-4B-Q4_K_M.gguf" \
      "Qwen3.5-4B-Q4_K_M.gguf" \
      "13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983"
    ;;
  qwen3.5-9b)
    get_model "Qwen3.5-9B IQ4_XS (max quality within ~6 GiB VRAM)" \
      "https://huggingface.co/bartowski/Qwen_Qwen3.5-9B-GGUF/resolve/main/Qwen_Qwen3.5-9B-IQ4_XS.gguf" \
      "Qwen3.5-9B-IQ4_XS.gguf" \
      "7d977cc96c2e08616016d967f232083e354691a8a16f345b26f7d782ee5c9601"
    ;;
  qwen3-4b)
    get_model "Qwen3-4B-Instruct-2507 Q4_K_M (previous default, fastest)" \
      "https://huggingface.co/bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf" \
      "Qwen3-4B-Instruct-2507-Q4_K_M.gguf" \
      "2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e"
    ;;
  qwen3-1.7b)
    echo "placeholder: pin URL+sha256 here once benchmarked (Phase 4)" >&2
    exit 1
    ;;
  *)
    echo "unknown model '$1' (supported: qwen3.5-4b, qwen3.5-9b, qwen3-4b)" >&2
    exit 1
    ;;
esac
