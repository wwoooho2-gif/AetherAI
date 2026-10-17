#!/bin/sh
set -eu

APP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LLAMA_PID=""

cleanup() {
  if [ -n "$LLAMA_PID" ]; then
    kill "$LLAMA_PID" 2>/dev/null || true
    wait "$LLAMA_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$APP_ROOT"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to check whether the local llama.cpp server is ready." >&2
  exit 1
fi

if curl --silent --fail --max-time 2 http://127.0.0.1:8080/v1/models >/dev/null 2>&1; then
  echo "Using the existing llama.cpp server at http://127.0.0.1:8080"
else
  echo "Starting the local llama.cpp server..."
  sh "$APP_ROOT/scripts/start-llama-server.sh" &
  LLAMA_PID=$!

  attempt=0
  until curl --silent --fail --max-time 2 http://127.0.0.1:8080/v1/models >/dev/null 2>&1; do
    if ! kill -0 "$LLAMA_PID" 2>/dev/null; then
      wait "$LLAMA_PID" || true
      echo "llama.cpp exited before its API became ready." >&2
      exit 1
    fi

    attempt=$((attempt + 1))
    if [ "$attempt" -ge 120 ]; then
      echo "llama.cpp did not become ready within 120 seconds." >&2
      exit 1
    fi
    sleep 1
  done
fi

echo "Starting the Aether web app..."
"$APP_ROOT/node_modules/.bin/vite" --host 0.0.0.0
