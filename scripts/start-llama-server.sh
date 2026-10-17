#!/bin/sh
set -eu

MODEL_DIR="$HOME/Models/Aether"
LLAMA_SERVER="$HOME/.local/bin/llama-server"
if [ -n "${AETHER_CPU_THREADS:-}" ]; then
  CPU_THREADS="$AETHER_CPU_THREADS"
elif command -v lscpu >/dev/null 2>&1; then
  CPU_THREADS=$(lscpu --parse=CORE,SOCKET | awk -F, '$1 !~ /^#/ { cores[$1 "," $2] = 1 } END { print length(cores) }')
else
  CPU_THREADS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1')
fi
case "$CPU_THREADS" in
  ''|*[!0-9]*|0) echo "AETHER_CPU_THREADS must be a positive integer." >&2; exit 1 ;;
esac

if [ ! -x "$LLAMA_SERVER" ]; then
  echo "llama-server is not installed at $LLAMA_SERVER" >&2
  exit 1
fi

if [ ! -d "$MODEL_DIR" ] || ! find "$MODEL_DIR" -maxdepth 1 -type f -name '*.gguf' -print -quit | grep -q .; then
  echo "No GGUF models were found in $MODEL_DIR" >&2
  echo "Download it with: npm run download:model" >&2
  exit 1
fi

exec "$LLAMA_SERVER" \
  --models-dir "$MODEL_DIR" \
  --models-max 1 \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 8192 \
  --parallel 1 \
  --threads "$CPU_THREADS" \
  --n-gpu-layers 99 \
  --flash-attn on \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --batch-size 512 \
  --ubatch-size 128
