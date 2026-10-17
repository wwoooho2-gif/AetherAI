# Aether

Aether is a local-first AI chat and model lab built for running and editing GGUF models directly on your machine.

It includes:
- a chat interface powered by a selected local model
- a GGUF browser/editor for inspecting tensors and metadata
- a local model workshop for training prompts and behavior rules
- a clean, single-project layout suitable for GitHub hosting

## Run any GGUF in the browser (hosted site)

The hosted version includes an integrated loader, so no llama.cpp server is needed:

- Drop a `.gguf` file onto the loader, or click it to choose one (for split models, select every part at once).
- Or paste a direct link to a `.gguf` (Hugging Face `blob` and `resolve` links both work), or use one of the starter models.
- Models run in WebAssembly (llama.cpp via [wllama](https://github.com/ngxson/wllama)); nothing is uploaded anywhere.
- The loaded model is saved in the browser's private storage and restored on the next visit. Delete it from the loader's "Saved on this device" list.
- The runtime (`wllama.wasm`) is bundled into the build, so it works without a CDN.
- Practical limits: CPU-only, so use small models (about 1B to 3B parameters at Q4, under 2 GB). Larger single files can run out of browser memory.

## Features

- Browse local GGUF models in `~/Models/Aether`
- View model metadata including `general.name`, system prompt fields, and tokenizer chat templates
- Edit model identity and behavior metadata without replacing the original file
- Save edited GGUF copies as new files
- Keep the app running locally with Vite

## Quick start

1. Install dependencies:
   npm install
2. Start the app in local dev mode:
   npm run dev
3. Open the app in your browser:
   http://127.0.0.1:5175

## Project structure

- `src/` — React app UI
- `scripts/` — local model, training, and GGUF tooling
- `vite.config.js` — local API hooks for model browsing and GGUF editing
- `public/` — static assets

## Notes

- This project is designed for local-only use.
- GGUF editing is intentionally kept non-destructive by writing edited copies instead of overwriting source files.
- The app expects local model files in `~/Models/Aether`.

## Optional Hugging Face authentication

Fine-tuning downloads its base model from Hugging Face. Those downloads can work without signing in, but Hugging Face may apply lower rate limits. Enter a read token in the **Hugging Face token** field on the Train a model screen. Aether stores it outside the project at `~/.config/aether/hf-token` with owner-only permissions, and provides a Remove button.

Alternatively, set `HF_TOKEN` in the environment before starting Aether. Never commit or share your token. The trainer also migrates the deprecated `HF_HUB_ENABLE_HF_TRANSFER` setting to `HF_XET_HIGH_PERFORMANCE` when it starts.
# AetherAI
# AetherAI
