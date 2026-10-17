#!/bin/sh
set -eu

VENV_DIR="$HOME/.local/share/aether-gguf-editor-venv"
PYTHON_BIN="${PYTHON_BIN:-python3}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python 3 is required to prepare the GGUF editor." >&2
  exit 1
fi

if ! "$PYTHON_BIN" -m venv --help >/dev/null 2>&1; then
  echo "The Python venv module is unavailable. Install the python3-venv package and retry." >&2
  exit 1
fi

mkdir -p "$(dirname "$VENV_DIR")"
"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install numpy gguf

echo
echo "GGUF editing tools installed at $VENV_DIR"
echo "Restart Aether; it will detect this environment automatically."
