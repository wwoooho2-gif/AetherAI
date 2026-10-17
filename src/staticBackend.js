// Browser-only replacement for the Vite dev-server API, used when built with VITE_STATIC=1
// (GitHub Pages). Cloud chat calls providers directly; local-only features report a clear error.
// Static (hosted) mode: set at build time, or detected at runtime on *.github.io so a build made
// without VITE_STATIC still behaves correctly on GitHub Pages.
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


// ---- In-browser GGUF runtime (wllama) for the hosted site -------------------------------
// The visitor picks a .gguf from their own disk; it is read into browser memory and run with
// WebAssembly. Nothing is uploaded anywhere. The model is forgotten when the tab is closed.
let wllama = null;
let browserModel = null; // { name, displayName, size, modifiedAt }
let inferenceQueue = Promise.resolve();

export function getBrowserModel() {
  return browserModel;
}

export async function loadBrowserModel(file, onProgress) {
  const { Wllama } = await import("@wllama/wllama");
  // The .wasm files are loaded from the CDN at runtime (pinned to the installed version), so the
  // build never has to resolve a file path inside the package.
  const CDN = "https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/esm";
  let wasmPaths;
  try {
    ({ default: wasmPaths } = await import(/* @vite-ignore */ `${CDN}/wasm-from-cdn.js`));
  } catch {
    wasmPaths = { default: `${CDN}/wasm/wllama.wasm` };
  }
  await unloadBrowserModel();
  const instance = new Wllama(wasmPaths);
  try {
    await instance.loadModel([file], {
      progressCallback: ({ loaded, total }) => {
        if (onProgress && total) onProgress(Math.round((loaded / total) * 100));
      },
    });
  } catch (error) {
    await instance.exit().catch(() => {});
    throw error;
  }
  wllama = instance;
  browserModel = {
    name: file.name,
    displayName: file.name.replace(/\.gguf$/i, ""),
    size: file.size,
    modifiedAt: Date.now(),
  };
  return browserModel;
}

export async function unloadBrowserModel() {
  const old = wllama;
  wllama = null;
  browserModel = null;
  if (old) await old.exit().catch(() => {});
}

function browserChat(payload) {
  if (!wllama || !browserModel) return Promise.resolve(json(503, { error: "No model is loaded in the browser. Use Upload GGUF model first." }));
  const run = async () => {
    try {
      const messages = (payload.messages || []).map((m) => ({ role: m.role, content: String(m.content ?? "") }));
      const result = await wllama.createChatCompletion({
        messages,
        max_tokens: payload.max_tokens || 1024,
        temperature: payload.temperature ?? 0.7,
      });
      const content = result?.choices?.[0]?.message?.content ?? "";
      return json(200, { choices: [{ message: { role: "assistant", content } }] });
    } catch (error) {
      return json(500, { error: `The in-browser model failed: ${error?.message || error}` });
    }
  };
  // one request at a time: the WebAssembly runtime has a single sequence
  const next = inferenceQueue.then(run, run);
  inferenceQueue = next.catch(() => {});
  return next;
}

let staticBackendInstalled = false;

export function installStaticBackend(force = false) {
  if (!IS_STATIC && !force) return;
  if (staticBackendInstalled) return;
  staticBackendInstalled = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input.url;
    if (raw.startsWith("/__aether/providers/chat")) {
      let payload = {};
      try { payload = JSON.parse(init?.body ?? "{}"); } catch { /* ignore */ }
      return cloudChat(payload);
    }
    if (raw.startsWith("/__aether/gguf/models")) return json(200, { models: browserModel ? [browserModel] : [] });
    if (raw.startsWith("/__aether/model-manager/reload")) {
      return browserModel
        ? json(200, { status: "loaded", model: browserModel.name, modelId: browserModel.name })
        : json(404, { error: "That model is no longer loaded. Upload the GGUF file again." });
    }
    if (raw.startsWith("/__aether/model-manager/remove")) {
      await unloadBrowserModel();
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
