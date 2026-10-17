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


## Web, photos, images, files and zips

Turn on the **Web** pill under the chat box to let Aether use the internet for that chat.

| You want | How |
| --- | --- |
| Current info | Web on: Aether searches before answering and lists its sources. Pasted links are always opened and read. |
| Photos | `/photo red panda`, or the model asks for them while Web is on. Real photos from Wikimedia Commons, with licence + source link. |
| New images | `/image a fox in the snow` (or the image button). Uses OpenAI if you added a key in the local app, otherwise Pollinations (free; your prompt is sent to that service). |
| HTML pages | Ask for a page and press **Preview**, or attach an `.html` file and press the eye icon. It runs in a sandboxed frame. |
| Zip files | `.zip` button on the file chips, on any reply with files, or type `/zip`. |
| Read / edit files | Drop files, a whole folder, or a `.zip` anywhere on the chat. Any text or code language works. Aether edits with small SEARCH/REPLACE patches (much less to generate than rewriting a file), applies them, and lets you download the edited file or the whole project. |

Hosted site note: browsers only allow CORS-friendly sites, so web search there covers Wikipedia, Stack Overflow and GitHub, and opening arbitrary links goes through the reader service in `src/lib/web.js` (`window.AETHER_READER_PROXY`, set to `""` to turn it off). The local app (`npm run dev`) searches and reads any public page itself, blocks private/internal addresses, and sends nothing to a third-party reader.

### Why it is faster

Local models are slow mostly because of how much text they must read and write. Each turn is packed into a budget based on the model's context size (`src/lib/context.js`):

- older turns lose their code blocks and file bodies; the newest two stay verbatim
- attached files are re-packed fresh every turn; big files or big projects keep only the parts that match your question
- the system prompt is shorter and identical between requests, with changing material placed last, so llama.cpp can reuse its prompt cache
- file edits are patches, so the model writes a few lines instead of the whole file
- the GGUF editor loads only when you open it

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
