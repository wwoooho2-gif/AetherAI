// Browser-only replacement for the Vite dev-server API, used when built with VITE_STATIC=1
// (GitHub Pages). Cloud chat calls providers directly; local-only features report a clear error.
import wasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url";
// Static (hosted) mode: set at build time, or detected at runtime on *.github.io so a build made
// without VITE_STATIC still behaves correctly on GitHub Pages.
export const IS_MOBILE =
  typeof navigator !== "undefined" &&
  (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || "")));
// Context window used in the browser. Smaller on phones: less memory, quicker start, faster replies.
export const BROWSER_CONTEXT = IS_MOBILE ? 2048 : 4096;
// Biggest model we try on a phone (bytes). Bigger ones crash the tab, so we say so up front instead.
const MOBILE_MAX_MODEL = (typeof navigator !== "undefined" && navigator.deviceMemory && navigator.deviceMemory <= 3 ? 1.0 : 1.8) * 1e9;
export const IS_STATIC =
  import.meta.env.VITE_STATIC === "1" ||
  (typeof window !== "undefined" && /(^|\.)github\.io$/.test(window.location.hostname));

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const LOCAL_ONLY = "This feature needs the local version of Aether (npm run dev). It isn't available on the hosted site.";

async function cloudChat(payload) {
  const { provider, apiKey, model, messages, baseUrl } = payload;
  const key = String(apiKey || "").trim();
  if (!key) return json(400, { error: "Enter a valid API key for the selected provider." });
  if (!model || !String(model).trim()) return json(400, { error: "Enter a model name." });
  let url, headers = { "content-type": "application/json" }, body;
  if (provider === "openai" || provider === "custom") {
    let base = provider === "openai" ? "https://api.openai.com/v1" : String(baseUrl || "").replace(/\/+$/, "");
    if (!/^https:\/\//.test(base)) return json(400, { error: "Custom providers must use an https:// URL." });
    url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    headers.authorization = `Bearer ${key}`;
    body = { model: model.trim(), messages, stream: false };
  } else if (provider === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    body = {
      model: model.trim(),
      max_tokens: 4096,
      system: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"),
      messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    };
  } else if (provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.trim())}:generateContent`;
    headers["x-goog-api-key"] = key;
    body = {
      systemInstruction: { parts: messages.filter((m) => m.role === "system").map((m) => ({ text: m.content })) },
      contents: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 4096 },
    };
  } else {
    return json(400, { error: "Choose a supported AI provider." });
  }
  let upstream;
  try {
    upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    return json(502, { error: "The request was blocked. Check the key and URL, and that this provider allows browser requests (CORS)." });
  }
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) return json(upstream.status, { error: String(data.error?.message || data.message || `Provider returned HTTP ${upstream.status}.`).slice(0, 2000) });
  const content = provider === "anthropic"
    ? data.content?.filter((p) => p.type === "text").map((p) => p.text).join("")
    : provider === "gemini"
      ? data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("")
      : data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) return json(502, { error: "The provider returned no text response." });
  return json(200, { content });
}


// ---- Integrated GGUF loader (wllama / WebAssembly) --------------------------------------
// Runs any .gguf the visitor provides entirely inside the browser:
//   * from a file on their disk (pick or drag-and-drop, split shards supported),
//   * or from a direct link (Hugging Face "resolve" URLs work).
// Models are kept in the browser's private storage (OPFS) so they survive a page reload and
// are restored automatically. Nothing is ever uploaded to a server. The WebAssembly runtime is
// bundled with the site, so no CDN is needed once the page has loaded.

let wllama = null;
let browserModel = null; // { name, displayName, size, modifiedAt }
let inferenceQueue = Promise.resolve();
let activeDownload = null; // AbortController for a running URL download

const STORE_DIR = "aether-models";
const LAST_MODEL_KEY = "aether-last-browser-model";
const RESTORING_KEY = "aether-restoring-model";

// -- loader state (observed by the UI through subscribeLoader / getLoaderState) ------------
// phase: idle | downloading | loading | ready | error
let loaderState = { phase: "idle", percent: null, message: "", error: "", model: null, saving: false };
const listeners = new Set();
function setLoaderState(patch) {
  loaderState = { ...loaderState, ...patch };
  listeners.forEach((listener) => listener());
}
export function subscribeLoader(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getLoaderState() {
  return loaderState;
}

export function getBrowserModel() {
  return browserModel;
}

export function browserLoaderSupported() {
  return typeof WebAssembly === "object" && typeof Worker === "function";
}

// -- small helpers ---------------------------------------------------------------------------
const baseName = (name) => String(name).split(/[\\/]/).pop();
const displayNameOf = (name) => baseName(name).replace(/\.gguf$/i, "");
const formatBytes = (bytes) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

function rememberLastModel(name) {
  try { name ? localStorage.setItem(LAST_MODEL_KEY, name) : localStorage.removeItem(LAST_MODEL_KEY); } catch { /* storage blocked */ }
}
function readLastModel() {
  try { return localStorage.getItem(LAST_MODEL_KEY) || ""; } catch { return ""; }
}

async function assertGguf(file) {
  const magic = new TextDecoder().decode(await file.slice(0, 4).arrayBuffer());
  if (magic !== "GGUF") {
    throw new Error(`${file.name} is not a GGUF model file (it doesn't start with the GGUF header).`);
  }
}

// -- on-device storage (Origin Private File System) -----------------------------------------
async function storeRoot() {
  // iOS Safari can read OPFS but has no createWritable(); skip on-device saving there instead of failing the load.
  if (!navigator.storage?.getDirectory || typeof FileSystemFileHandle === "undefined" || !("createWritable" in FileSystemFileHandle.prototype)) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(STORE_DIR, { create: true });
  } catch {
    return null;
  }
}

// Each saved model is a folder named after its first file and holds every shard in order.
const modelFolderName = (name) => encodeURIComponent(baseName(name));
const shardFileName = (index, name) => `${String(index).padStart(4, "0")}-${encodeURIComponent(baseName(name))}`;

async function pipeToFile(dir, fileName, source, onChunk) {
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  const counter = new TransformStream({
    transform(chunk, controller) {
      onChunk?.(chunk.byteLength);
      controller.enqueue(chunk);
    },
  });
  try {
    await source.pipeThrough(counter).pipeTo(writable);
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function hasRoomFor(bytes) {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return !quota || quota - (usage || 0) > bytes * 1.05;
  } catch {
    return true;
  }
}

async function saveFilesToStore(files) {
  const root = await storeRoot();
  if (!root) return false;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (!(await hasRoomFor(total))) return false;
  const folder = modelFolderName(files[0].name);
  await root.removeEntry(folder, { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle(folder, { create: true });
  try {
    for (let index = 0; index < files.length; index += 1) {
      await pipeToFile(dir, shardFileName(index, files[index].name), files[index].stream());
    }
  } catch (error) {
    await root.removeEntry(folder, { recursive: true }).catch(() => {});
    throw error;
  }
  return true;
}

async function readSavedFiles(name) {
  const root = await storeRoot();
  if (!root) return null;
  let dir;
  try { dir = await root.getDirectoryHandle(modelFolderName(name)); } catch { return null; }
  const entries = [];
  for await (const [entryName, handle] of dir.entries()) {
    if (handle.kind === "file") entries.push([entryName, handle]);
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  const files = [];
  for (const [entryName, handle] of entries) {
    const file = await handle.getFile();
    // the stored name is "0000-<encoded name>"; give the File its real name back
    const realName = decodeURIComponent(entryName.replace(/^\d+-/, ""));
    files.push(new File([file], realName, { type: file.type }));
  }
  return files.length ? files : null;
}

export async function listSavedModels() {
  const root = await storeRoot();
  if (!root) return [];
  const saved = [];
  for await (const [folderName, handle] of root.entries()) {
    if (handle.kind !== "directory") continue;
    let size = 0;
    let shards = 0;
    for await (const [, fileHandle] of handle.entries()) {
      if (fileHandle.kind !== "file") continue;
      size += (await fileHandle.getFile()).size;
      shards += 1;
    }
    if (shards) saved.push({ name: decodeURIComponent(folderName), size, shards });
  }
  return saved.sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteSavedModel(name) {
  const root = await storeRoot();
  await root?.removeEntry(modelFolderName(name), { recursive: true }).catch(() => {});
  if (readLastModel() === name) rememberLastModel("");
}

// -- loading ---------------------------------------------------------------------------------
async function startRuntime(blobs, name, size, onProgress) {
  const { Wllama } = await import("@wllama/wllama");
  await unloadBrowserModel();
  const instance = new Wllama({ default: wasmUrl }, { suppressNativeLog: true });
  try {
    await instance.loadModel(blobs, {
      n_ctx: BROWSER_CONTEXT, // a smaller context keeps memory use down (the model default can be 32k+)
      n_batch: IS_MOBILE ? 256 : 512,
      n_gpu_layers: 0, // CPU only: WebGPU is faster but crashes on many machines/models
      progressCallback: ({ loaded, total }) => {
        if (total) onProgress?.(Math.round((loaded / total) * 100));
      },
    });
  } catch (error) {
    await instance.exit().catch(() => {});
    throw error;
  }
  wllama = instance;
  browserModel = { name, displayName: displayNameOf(name), size, modifiedAt: Date.now() };
  return browserModel;
}

function friendlyLoadError(error, fileName) {
  const text = String(error?.message || error);
  if (/memory|alloc|abort|crash|RuntimeError/i.test(text)) {
    return `${fileName} didn't fit in this browser's memory. Try a smaller or more compressed model (about 1B to 3B parameters at Q4, under 2 GB).`;
  }
  if (/unsupported|unknown model architecture|invalid|magic/i.test(text)) {
    return `${fileName} could not be read: ${text}. It may use a model architecture this runtime doesn't support yet.`;
  }
  return `Could not load ${fileName}: ${text}`;
}

/**
 * Load one .gguf (or all shards of a split model) that the visitor picked.
 * @param {File|File[]|FileList} input
 * @param {{ remember?: boolean, fromStore?: boolean }} options
 */
export async function loadBrowserModel(input, options = {}) {
  const { remember = true, fromStore = false } = options;
  const files = (input instanceof File ? [input] : Array.from(input || []))
    .filter((file) => /\.gguf$/i.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!files.length) {
    const error = new Error("Choose a .gguf model file.");
    setLoaderState({ phase: "error", error: error.message, percent: null });
    throw error;
  }
  const primary = files[0].name;
  const size = files.reduce((sum, file) => sum + file.size, 0);
  if (IS_MOBILE && size > MOBILE_MAX_MODEL) {
    const message = `${primary} is ${formatBytes(size)}, too big for a phone browser and it would crash the tab. Pick a model under ${formatBytes(MOBILE_MAX_MODEL)} (the ones marked "phone" in the list).`;
    setLoaderState({ phase: "error", percent: null, error: message, message: "" });
    throw new Error(message);
  }
  try {
    setLoaderState({ phase: "loading", percent: 0, error: "", message: `Loading ${primary} into the browser…` });
    await assertGguf(files[0]);
    await startRuntime(files, primary, size, (percent) =>
      setLoaderState({ phase: "loading", percent, message: `Loading ${primary} into the browser…` }),
    );
  } catch (error) {
    const message = friendlyLoadError(error, primary);
    setLoaderState({ phase: "error", percent: null, error: message, message: "", model: null, saving: false });
    throw new Error(message);
  }
  rememberLastModel(primary);
  setLoaderState({ phase: "ready", percent: null, error: "", message: `${primary} is ready.`, model: browserModel });
  warmUpModel();

  // Keep a copy in on-device storage so the next visit doesn't need the file again.
  if (remember && !fromStore) {
    setLoaderState({ saving: true });
    saveFilesToStore(files)
      .then((saved) => {
        if (!saved) rememberLastModel(""); // nothing to restore from next time
        setLoaderState({ saving: false, message: saved ? `${primary} is ready and saved on this device.` : `${primary} is ready (this browser has no room to save it for next time).` });
      })
      .catch(() => {
        rememberLastModel("");
        setLoaderState({ saving: false });
      });
  }
  return browserModel;
}

/** Turn a Hugging Face "blob" page link into the direct download link. */
export function normalizeModelUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw new Error("Paste a full link that starts with https://"); }
  if (url.protocol !== "https:") throw new Error("The link must start with https://");
  if (/(^|\.)huggingface\.co$/.test(url.hostname)) url.pathname = url.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, "$1/resolve/");
  if (!/\.gguf$/i.test(url.pathname)) throw new Error("The link must point directly to a .gguf file.");
  return url;
}

export function cancelModelDownload() {
  activeDownload?.abort();
}

/** Download a .gguf from a direct link, keep it on this device, and load it. */
export async function loadBrowserModelFromUrl(rawUrl) {
  const url = normalizeModelUrl(rawUrl);
  const fileName = decodeURIComponent(url.pathname.split("/").pop());
  const controller = new AbortController();
  activeDownload = controller;
  try {
    setLoaderState({ phase: "downloading", percent: null, error: "", message: `Connecting to ${url.hostname}…` });
    let response;
    try {
      response = await fetch(url.href, { signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new Error(`Couldn't reach ${url.hostname}. The site may be blocking browser downloads (CORS), or you may be offline. Download the file and drop it here instead.`);
    }
    if (!response.ok || !response.body) {
      const hint = response.status === 401 || response.status === 403
        ? " This model may need a login or license acceptance. Download it from the website, then drop the file here."
        : response.status === 404 ? " Check the link." : "";
      throw new Error(`The server answered HTTP ${response.status}.${hint}`);
    }
    const total = Number(response.headers.get("content-length")) || 0;
    let received = 0;
    const report = (bytes) => {
      received += bytes;
      setLoaderState({
        phase: "downloading",
        percent: total ? Math.min(99, Math.round((received / total) * 100)) : null,
        message: `Downloading ${fileName}… ${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : ""}`,
      });
    };

    const root = await storeRoot();
    let files;
    if (root && (!total || (await hasRoomFor(total)))) {
      const folder = modelFolderName(fileName);
      await root.removeEntry(folder, { recursive: true }).catch(() => {});
      const dir = await root.getDirectoryHandle(folder, { create: true });
      try {
        await pipeToFile(dir, shardFileName(0, fileName), response.body, report);
      } catch (error) {
        await root.removeEntry(folder, { recursive: true }).catch(() => {});
        throw error;
      }
      files = await readSavedFiles(fileName);
    }
    if (!files) {
      // No usable on-device storage: hold the download in memory for this session only.
      const chunks = [];
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        report(value.byteLength);
      }
      files = [new File(chunks, fileName)];
    }
    return await loadBrowserModel(files, { fromStore: Boolean(root), remember: true });
  } catch (error) {
    if (error?.name === "AbortError") {
      setLoaderState({ phase: "idle", percent: null, message: "", error: "" });
      throw new Error("Download cancelled.");
    }
    if (loaderState.phase !== "error") setLoaderState({ phase: "error", percent: null, error: error.message, message: "" });
    throw error;
  } finally {
    activeDownload = null;
  }
}

/** Load a model that was saved on this device earlier. */
export async function loadSavedModel(name) {
  const files = await readSavedFiles(name);
  if (!files) {
    const error = new Error(`${name} is no longer saved on this device.`);
    setLoaderState({ phase: "error", error: error.message, percent: null });
    throw error;
  }
  return loadBrowserModel(files, { fromStore: true });
}

/** On page load: bring back the model the visitor used last time, if it was saved. */
export async function restoreLastModel() {
  const last = readLastModel();
  if (!last || browserModel || loaderState.phase === "loading" || loaderState.phase === "downloading") return null;
  // If the tab died while restoring last time (out of memory), don't loop: skip the auto-restore once.
  try {
    if (localStorage.getItem(RESTORING_KEY)) {
      localStorage.removeItem(RESTORING_KEY);
      setLoaderState({ phase: "error", error: "The last model crashed this browser tab while reopening, so it wasn't restored. Pick a smaller one from the list." });
      return null;
    }
    localStorage.setItem(RESTORING_KEY, "1");
  } catch { /* storage blocked */ }
  const files = await readSavedFiles(last).catch(() => null);
  if (!files) { rememberLastModel(""); try { localStorage.removeItem(RESTORING_KEY); } catch { /* */ } return null; }
  try {
    return await loadBrowserModel(files, { fromStore: true });
  } catch {
    return null; // the loader state already carries the error for the UI
  } finally {
    try { localStorage.removeItem(RESTORING_KEY); } catch { /* storage blocked */ }
  }
}

// One throw-away token right after loading pages the weights in and warms up the WebAssembly code,
// so the visitor's first real reply starts sooner. Best effort: failures are ignored.
function warmUpModel() {
  const instance = wllama;
  if (!instance) return;
  const run = async () => {
    if (instance !== wllama) return;
    try {
      await instance.createChatCompletion({ messages: [{ role: "user", content: "Hi" }], max_tokens: 1, temperature: 0 });
    } catch { /* warm-up only */ }
  };
  inferenceQueue = inferenceQueue.then(run, run);
}

export async function unloadBrowserModel() {
  const old = wllama;
  wllama = null;
  browserModel = null;
  if (loaderState.model) setLoaderState({ model: null, phase: loaderState.phase === "ready" ? "idle" : loaderState.phase });
  if (old) await old.exit().catch(() => {});
}

function browserChat(payload) {
  if (!wllama || !browserModel) return Promise.resolve(json(503, { error: "No model is loaded in the browser. Load a GGUF model first (drop a .gguf file onto the loader, or paste a link to one)." }));
  const run = async () => {
    try {
      const messages = (payload.messages || []).map((m) => ({ role: m.role, content: String(m.content ?? "") }));
      const result = await wllama.createChatCompletion({
        messages,
        max_tokens: payload.max_tokens || 1024,
        temperature: payload.temperature ?? 0.7,
        useCache: true, // reuse the already-processed start of the prompt (system prompt + older turns)
      });
      const content = result?.choices?.[0]?.message?.content ?? "";
      return json(200, { choices: [{ message: { role: "assistant", content } }] });
    } catch (error) {
      const text = String(error?.message || error);
      if (/crash|abort|out of memory|memory access/i.test(text)) {
        // The WebAssembly module is dead; drop it so the user knows to load the file again.
        await unloadBrowserModel();
        setLoaderState({ phase: "error", error: "The in-browser model crashed (usually out of memory). Load it again or pick a smaller model." });
        return json(500, { error: "The in-browser model crashed (usually out of memory). Load the .gguf again, or use a smaller model (about 1B to 3B parameters at Q4, under 2 GB)." });
      }
      return json(500, { error: `The in-browser model failed: ${text}` });
    }
  };
  // one request at a time: the WebAssembly runtime has a single sequence
  const next = inferenceQueue.then(run, run);
  inferenceQueue = next.catch(() => {});
  return next;
}

// -- multi-model support: every saved model stays listed, one is loaded into memory at a time --
const sameModel = (a, b) => Boolean(a && b) && baseName(a).toLowerCase() === baseName(b).toLowerCase();

function bodyModelName(init) {
  try { return String(JSON.parse(init?.body ?? "{}").model || ""); } catch { return ""; }
}

async function allKnownModels() {
  const saved = await listSavedModels().catch(() => []);
  const models = saved.map((item) => ({
    name: item.name,
    displayName: displayNameOf(item.name),
    size: item.size,
    modifiedAt: 0,
  }));
  if (browserModel && !models.some((item) => sameModel(item.name, browserModel.name))) models.unshift(browserModel);
  return models;
}

let staticBackendInstalled = false;

export function installStaticBackend(force = false) {
  if (!IS_STATIC && !force) return;
  if (staticBackendInstalled) return;
  staticBackendInstalled = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (raw.startsWith("/__aether/providers/chat")) {
      let payload = {};
      try { payload = JSON.parse(init?.body ?? "{}"); } catch { /* ignore */ }
      return cloudChat(payload);
    }
    if (raw.startsWith("/__aether/gguf/models")) return json(200, { models: await allKnownModels() });
    if (raw.startsWith("/__aether/model-manager/reload")) {
      const wanted = bodyModelName(init);
      if (wanted && !sameModel(browserModel?.name, wanted)) {
        // Switch to another model that was saved on this device earlier.
        const saved = (await listSavedModels().catch(() => [])).find((item) => sameModel(item.name, wanted));
        if (!saved) return json(404, { error: "That model is no longer saved on this device. Load the GGUF file again." });
        try {
          await loadSavedModel(saved.name);
        } catch (error) {
          return json(500, { error: error?.message || "Could not load that model." });
        }
      }
      return browserModel
        ? json(200, { status: "loaded", model: browserModel.name, modelId: browserModel.name })
        : json(404, { error: "That model is no longer loaded. Upload the GGUF file again." });
    }
    if (raw.startsWith("/__aether/model-manager/remove")) {
      // Only the model the visitor explicitly removes is deleted; other saved models stay.
      const wanted = bodyModelName(init);
      if (!wanted || sameModel(browserModel?.name, wanted)) await unloadBrowserModel();
      if (wanted) {
        const saved = (await listSavedModels().catch(() => [])).find((item) => sameModel(item.name, wanted));
        await deleteSavedModel(saved?.name || wanted);
      }
      return json(200, { status: "removed", warning: "" });
    }
    if (raw.startsWith("/__aether/model-manager")) return json(503, { error: LOCAL_ONLY, models: [] });
    if (raw.startsWith("/__aether/")) return json(503, { error: LOCAL_ONLY });
    if (raw.startsWith("/v1/models")) return json(200, { data: browserModel ? [{ id: browserModel.name }] : [] });
    if (raw.startsWith("/v1/chat/completions")) {
      let payload = {};
      try { payload = JSON.parse(init?.body ?? "{}"); } catch { /* ignore */ }
      return browserChat(payload);
    }
    if (raw.startsWith("/v1/")) return json(503, { error: "No local llama.cpp server on the hosted site." });
    if (raw.startsWith("/search/stackoverflow")) return realFetch(raw.replace("/search/stackoverflow", "https://api.stackexchange.com/2.3/search/excerpts"), init);
    if (raw.startsWith("/search/github")) return realFetch(raw.replace("/search/github", "https://api.github.com/search/repositories"), init);
    return realFetch(input, init);
  };
}
