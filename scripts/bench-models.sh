#!/usr/bin/env bash
# bench-models.sh — compare candidate models on both eval suites + VRAM footprint.
# Usage: scripts/bench-models.sh <model.gguf> [...]   (each served on :8090, ctx 2048)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LLAMA="$ROOT/vendor/llama-b11559"
PORT=8090
VRAM=/sys/class/drm/card1/device/mem_info_vram_used   # RX 9070 XT (dGPU)

vram_gib() { awk '{printf "%.2f", $1/1073741824}' "$VRAM" 2>/dev/null || echo "n/a"; }

for model in "$@"; do
	name="$(basename "$model" .gguf)"
	echo "=================================================================="
	echo "MODEL: $name"
	before=$(vram_gib)
	LD_LIBRARY_PATH="$LLAMA" GGML_VK_VISIBLE_DEVICES=0 "$LLAMA/llama-server" \
		-m "$model" -ngl 99 -fa 1 -c 2048 --host 127.0.0.1 --port $PORT >/dev/null 2>&1 &
	srv=$!
	for i in $(seq 1 120); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
	if ! kill -0 $srv 2>/dev/null; then
		echo "FATAL: server process died (port $PORT already in use?)" >&2
		exit 1
	fi
	curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || { echo "FATAL: server did not become healthy"; exit 1; }
	after=$(vram_gib)
	echo "VRAM: before=${before}GiB after=${after}GiB"

	echo "--- 60-case suite (strict + model-agnostic) ---"
	bun run "$ROOT/eval/run.ts" "http://127.0.0.1:$PORT" 2>/dev/null | grep -E 'results:|model-agnostic|latency' || echo "(suite failed)"

	echo "--- JFLEG n=400 (seeded sample) ---"
	bun run "$ROOT/eval/jfleg.ts" --n 400 --fp 0 "http://127.0.0.1:$PORT" 2>/dev/null | grep -E 'improved|unchanged|harmed|latency' || echo "(jfleg failed)"

	kill $srv 2>/dev/null || true
	wait $srv 2>/dev/null || true
	sleep 3
	echo "VRAM after unload: $(vram_gib)GiB"
done
echo "=================================================================="
echo "done."
