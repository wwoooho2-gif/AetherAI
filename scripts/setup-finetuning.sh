#!/bin/sh
set -eu

VENV_DIR="$HOME/.local/share/aether-finetuning-venv"
BOOTSTRAP_DIR="$HOME/.local/share/aether-python-bootstrap"
PYTHON_BIN="${PYTHON_BIN:-}"

if [ -z "$PYTHON_BIN" ]; then
  for candidate in python3.13 python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$PYTHON_BIN" ]; then
  UV_BIN=$(command -v uv || true)
  if [ -z "$UV_BIN" ]; then
    SYSTEM_PYTHON=$(command -v python3 || true)
    if [ -z "$SYSTEM_PYTHON" ]; then
      echo "Python 3.10–3.13 or Python 3 with venv support is required to prepare training." >&2
      exit 1
    fi
    if ! "$SYSTEM_PYTHON" -m venv --help >/dev/null 2>&1; then
      echo "No supported Python is installed, and Python venv is unavailable to bootstrap Python 3.13." >&2
      exit 1
    fi
    echo "No supported Python is installed. Preparing a local Python 3.13 runtime..."
    "$SYSTEM_PYTHON" -m venv "$BOOTSTRAP_DIR"
    "$BOOTSTRAP_DIR/bin/python" -m pip install --upgrade uv
    UV_BIN="$BOOTSTRAP_DIR/bin/uv"
  else
    echo "No supported Python is installed. Preparing a local Python 3.13 runtime with uv..."
  fi
  "$UV_BIN" python install 3.13
  PYTHON_BIN=$("$UV_BIN" python find 3.13)
fi

if [ ! -x "$PYTHON_BIN" ] && ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "The selected Python executable was not found: $PYTHON_BIN" >&2
  exit 1
fi
PYTHON_VERSION=$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
case "$PYTHON_VERSION" in
  3.10|3.11|3.12|3.13) ;;
  *) echo "Python 3.10–3.13 is required; found $PYTHON_VERSION at $PYTHON_BIN." >&2; exit 1 ;;
esac

if ! "$PYTHON_BIN" -m venv --help >/dev/null 2>&1; then
  echo "The Python venv module is unavailable. Install the matching python3-venv package and retry." >&2
  exit 1
fi

mkdir -p "$(dirname "$VENV_DIR")"
echo "Creating the local training environment with Python $PYTHON_VERSION..."
"$PYTHON_BIN" -m venv "$VENV_DIR"
echo "Installing Unsloth and dataset support..."
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install unsloth datasets

echo
echo "Local fine-tuning tools installed at $VENV_DIR"
echo "A supported NVIDIA GPU with CUDA is required. Restart Aether and open Train a model."
