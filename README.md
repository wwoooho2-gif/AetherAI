<p align="center">
  <img src="public/icon-192.png" alt="AetherAI icon" width="96" height="96" />
</p>

<h1 align="center">AetherAI</h1>

<p align="center">
  A local-first AI chat and model lab. Run GGUF models in your browser, edit their metadata, and tune their behavior.<br />
  <a href="https://wwoooho2-gif.github.io/AetherAI/"><strong>Open the hosted site</strong></a>
</p>

## What it does

- **Chat** with a model that runs on your own device. Nothing is uploaded anywhere.
- **Run any GGUF in the browser** (hosted site) or against a local llama.cpp server (local app).
- **Edit GGUF files** to inspect tensors and metadata, then save the result as a new copy.
- **Train a model** with a local workshop for prompts and behavior rules (local app).
- **Use the web** when you want it: search, photos, image generation, HTML previews, and file or zip editing.
- **Read replies aloud** with built-in voices or [hoppou.ai](https://hoppou.ai).

> **Hosted site limits:** it runs models inside your browser, so only small models work, and online or custom text-to-speech services (like hoppou.ai) are usually blocked by the browser. For bigger models and custom voices, download the project and run it on your own computer (below).

## Quick start (local app)

```sh
npm install
npm run dev
```

Then open <http://127.0.0.1:5175>.

For a local model server and downloads:

```sh
npm run download:model   # fetch a starter model into ~/Models/Aether
npm start                # start llama.cpp and the app together
```

Other scripts: `npm run build`, `npm run preview`, `npm run train:setup`, `npm run ai`.

## Install on iPhone (home-screen app)

AetherAI is a Progressive Web App, so it installs like a native app with no App Store or Mac needed.

1. Deploy it (push to `main`; the Pages workflow publishes it) and open <https://wwoooho2-gif.github.io/AetherAI/> in **Safari** on the iPhone.
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Open it from the new AetherAI icon. It runs full screen, and the app shell works offline after the first visit.

Notes: iOS limits browser memory, so stick to small models (about 1B or smaller at Q4 on most iPhones). Saved chats and models live in that installed app's own storage, separate from Safari tabs.

## Run any GGUF in the browser (hosted site)

The hosted version has an integrated loader, so no llama.cpp server is needed.

- Drop a `.gguf` file onto the loader, or click it to choose one. For split models, select every part at once.
- Or paste a direct link to a `.gguf` (Hugging Face `blob` and `resolve` links both work), or pick a starter model.
- Models run in WebAssembly (llama.cpp via [wllama](https://github.com/ngxson/wllama)). Nothing is uploaded.
- The loaded model is saved in the browser's private storage and restored on your next visit. Remove it from the loader's **Saved on this device** list.
- The runtime (`wllama.wasm`) is bundled into the build, so no CDN is needed.
- Limits: CPU only, so use small models (about 1B to 3B parameters at Q4, under 2 GB). Larger files can run out of browser memory.

## Web, photos, images, files and zips

Turn on the **Web** pill under the chat box to let Aether use the internet for that chat.

| You want | How |
| --- | --- |
| Current info | Web on: Aether searches before answering and lists its sources. Pasted links are always opened and read. |
| Photos | `/photo red panda`, or the model asks for them while Web is on. Real photos from Wikimedia Commons, with licence and source link. |
| New images | `/image a fox in the snow` (or the image button). Uses OpenAI if you added a key in the local app, otherwise Pollinations (free; your prompt is sent to that service). |
| HTML pages | Ask for a page and press **Preview**, or attach an `.html` file and press the eye icon. It runs in a sandboxed frame. |
| Zip files | `.zip` button on the file chips, on any reply with files, or type `/zip`. |
| Shrink the chat | `/compact [focus]` or the Context chip summarizes older messages to free up memory. |
| Read / edit files | Drop files, a folder, or a `.zip` anywhere on the chat. Aether edits with small SEARCH/REPLACE patches, applies them, and lets you download the edited file or the whole project. |

**Hosted site note:** browsers only allow CORS-friendly sites, so web search there covers Wikipedia, Stack Overflow and GitHub. Opening arbitrary links goes through the reader service in `src/lib/web.js` (`window.AETHER_READER_PROXY`; set it to `""` to turn it off). The local app searches and reads any public page itself, blocks private and internal addresses, and sends nothing to a third-party reader.

## Saved in your browser

Chats save automatically and reopen after a refresh, including attached and edited project files, photos, sources and thumbs feedback. They live in this browser's IndexedDB (`src/lib/chatStore.js`) and are never uploaded.

- The sidebar lists your saved chats (newest first, up to 100). Click one to reopen it, hover for the delete button, or press **Clear** to remove them all.
- API keys are never saved. Voice, style and coding preferences are saved separately in the browser.
- Browser data is per site and per browser. Clearing site data or using a private window removes it, and `localhost` and the GitHub Pages site keep separate chats.
- On a shared computer, delete your chats when you're done.

## Read aloud (text-to-speech)

Press **Listen** under any reply to hear it (it becomes **Stop** while reading), or open **Voice** under the chat box to read every reply automatically.

- **Built-in (default):** your device's own voices. Free, no setup, works offline. Code, links and markdown are skipped so it sounds natural.
- **hoppou.ai:** pick it in Voice settings and paste your API key. The endpoint (`https://api.hoppou.ai/tts/v1/audio/speech`), model (`tts-1`) and voice (`alba`) are filled in for you. Your key is kept in memory only, so enter it again after a refresh.
- **Other service (any TTS API):** enter the URL, key, voice name and a JSON request body. `{{text}}`, `{{voice}}`, `{{model}}` and `{{speed}}` are filled in. The default body is OpenAI-compatible. The service must answer with audio, or JSON containing `audio_url` or `audio_base64`.
- On the hosted site, or for a TTS server on your own computer, the browser calls the service directly, so it must allow CORS.
- Long replies are read sentence by sentence, and the next sentence is fetched while the current one plays.

## Why it is fast

Local models are slow mostly because of how much text they read and write. Each turn is packed into a budget based on the model's context size (`src/lib/context.js`):

- Older turns lose their code blocks and file bodies. The newest two stay verbatim.
- Attached files are re-packed every turn. Big files or projects keep only the parts that match your question.
- The system prompt is short and identical between requests, with changing material placed last, so llama.cpp can reuse its prompt cache.
- File edits are patches, so the model writes a few lines instead of the whole file.
- Replies are short by default (a brevity rule in the system prompt plus an output cap). The **Long** pill lifts both. If a reply hits the cap it says so and you can type "continue".
- Long chats compact themselves: once the history fills about 60% of its share of the prompt, Aether runs `/compact` for you before the next reply (the model writes the summary, or a quick recap if it is busy). Type `/compact` (optionally `/compact what to remember`) or click the **Context** chip to do it on demand. Your messages are kept: the summary note sits above the recent turns and older messages hide behind **Show earlier messages**.
- The message list is memoized, long replies and code blocks start collapsed with **Show more**, and only the newest 40 messages are drawn, so typing stays smooth in long chats.
- The in-browser model is warmed up right after it loads.
- The app loads lazily: the GGUF editor, voice settings and credits are fetched only when opened, fonts load without blocking the first paint, and saved models restore once the page is idle.

## Credits

Voices by [hoppou.ai](https://hoppou.ai). Built with [llama.cpp](https://github.com/ggml-org/llama.cpp), [wllama](https://github.com/ngxson/wllama), [React](https://react.dev), [Vite](https://vite.dev) and [Lucide](https://lucide.dev). The same list is in the app's **Credits** tab.

## Project structure

- `src/` React app (`App.jsx`, `staticBackend.js` for the in-browser runtime, `lib/` helpers)
- `public/` favicon, app icons and web manifest
- `scripts/` local model, training and GGUF tooling
- `vite.config.js` build config plus the local API hooks for model browsing and GGUF editing
- `.github/workflows/pages.yml` builds and deploys the hosted site

## Notes

- GGUF editing is non-destructive: edited copies are written as new files, never over the source.
- The local app expects model files in `~/Models/Aether`.

## Optional Hugging Face authentication

Fine-tuning downloads its base model from Hugging Face. Downloads work without signing in, but Hugging Face may apply lower rate limits. Enter a read token in the **Hugging Face token** field on the Train a model screen. Aether stores it outside the project at `~/.config/aether/hf-token` with owner-only permissions, and provides a Remove button.

You can also set `HF_TOKEN` in the environment before starting Aether. Never commit or share your token. The trainer also migrates the deprecated `HF_HUB_ENABLE_HF_TRANSFER` setting to `HF_XET_HIGH_PERFORMANCE` when it starts.
