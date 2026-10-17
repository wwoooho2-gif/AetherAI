// Browser-only replacement for the Vite dev-server API, used when built with VITE_STATIC=1
// (GitHub Pages). Cloud chat calls providers directly; local-only features report a clear error.
export const IS_STATIC = import.meta.env.VITE_STATIC === "1";

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

export function installStaticBackend() {
  if (!IS_STATIC) return;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input.url;
    if (raw.startsWith("/__aether/providers/chat")) {
      let payload = {};
      try { payload = JSON.parse(init?.body ?? "{}"); } catch { /* ignore */ }
      return cloudChat(payload);
    }
    if (raw.startsWith("/__aether/gguf/models") || raw.startsWith("/__aether/model-manager")) return json(503, { error: LOCAL_ONLY, models: [] });
    if (raw.startsWith("/__aether/")) return json(503, { error: LOCAL_ONLY });
    if (raw.startsWith("/v1/")) return json(503, { error: "No local llama.cpp server on the hosted site." });
    if (raw.startsWith("/search/stackoverflow")) return realFetch(raw.replace("/search/stackoverflow", "https://api.stackexchange.com/2.3/search/excerpts"), init);
    if (raw.startsWith("/search/github")) return realFetch(raw.replace("/search/github", "https://api.github.com/search/repositories"), init);
    return realFetch(input, init);
  };
}
