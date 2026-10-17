#!/bin/sh
set -eu

MODEL_DIR="$HOME/Models/Aether"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to download the model." >&2
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required to verify the downloaded model." >&2
  exit 1
fi

download_model() {
  MODEL_FILE="$MODEL_DIR/$1"
  PART_FILE="$MODEL_FILE.part"
  MODEL_URL="https://huggingface.co/$2/resolve/main/$1"
  EXPECTED_SIZE="$3"
  EXPECTED_SHA256="$4"

  if [ -f "$MODEL_FILE" ]; then
    ACTUAL_SHA256=$(sha256sum "$MODEL_FILE" | cut -d ' ' -f 1)
    if [ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ]; then
      echo "Model is already installed and verified: $MODEL_FILE"
      return
    fi
    echo "A model file already exists but does not match the expected SHA-256:" >&2
    echo "$MODEL_FILE" >&2
    return 1
  fi

  SIZE_GB=$(awk -v size="$EXPECTED_SIZE" 'BEGIN { printf "%.2f", size / 1000000000 }')
  echo "Downloading $1 ($SIZE_GB GB) from Hugging Face..."
  curl --fail --location --retry 3 --retry-delay 2 --continue-at - \
    --output "$PART_FILE" "$MODEL_URL"

  ACTUAL_SIZE=$(wc -c < "$PART_FILE" | tr -d ' ')
  if [ "$ACTUAL_SIZE" -ne "$EXPECTED_SIZE" ]; then
    echo "Downloaded model has an unexpected size: $ACTUAL_SIZE bytes (expected $EXPECTED_SIZE)." >&2
    echo "The partial download is preserved at $PART_FILE; rerun to resume." >&2
    return 1
  fi

  ACTUAL_SHA256=$(sha256sum "$PART_FILE" | cut -d ' ' -f 1)
  if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
    echo "Downloaded model failed SHA-256 verification." >&2
    echo "The file is preserved at $PART_FILE; investigate before retrying." >&2
    return 1
  fi

  mv "$PART_FILE" "$MODEL_FILE"
  echo "Model downloaded and verified: $MODEL_FILE"
}

mkdir -p "$MODEL_DIR"
case "${1:-all}" in
  all)
    download_model \
      "Qwen3.5-4B-Q4_K_M.gguf" \
      "unsloth/Qwen3.5-4B-GGUF" \
      2740937888 \
      "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4"
    download_model \
      "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf" \
      "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF" \
      4683074336 \
      "1664fccab734674a50763490a8c6931b70e3f2f8ec10031b54806d30e5f956b6"
    ;;
  fast)
    download_model \
      "Qwen3.5-4B-Q4_K_M.gguf" \
      "unsloth/Qwen3.5-4B-GGUF" \
      2740937888 \
      "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4"
    ;;
  coder)
    download_model \
      "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf" \
      "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF" \
      4683074336 \
      "1664fccab734674a50763490a8c6931b70e3f2f8ec10031b54806d30e5f956b6"
    ;;
  */*)
    # Any Hugging Face GGUF: sh scripts/download-model.sh <owner/repo> <file.gguf>   (no checksum known, so size is not verified)
    [ -n "${2:-}" ] || { echo "Usage: $0 <owner/repo> <file.gguf>" >&2; exit 2; }
    mkdir -p "$MODEL_DIR"
    curl --fail --location --retry 3 --continue-at - --output "$MODEL_DIR/$2" "https://huggingface.co/$1/resolve/main/$2"
    echo "Saved: $MODEL_DIR/$2"
    ;;
  *)
    echo "Usage: $0 [all|fast|coder|<owner/repo> <file.gguf>]" >&2
    exit 2
    ;;
esac
