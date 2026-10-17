// Starter models for the in-browser loader (all GGUF, 4-bit unless noted). "phone" = small enough for most phones.
// Any other .gguf can still be dropped in or pasted as a link.
const HF = "https://huggingface.co";
// The hosted website runs models inside the browser, so it only offers models up to this size (MB).
export const HOSTED_MAX_MB = 1000;
export const MODEL_CATALOG = [
  { group: "Tiny", label: "SmolLM2 135M (instant, basic)", mb: 105, phone: true, url: `${HF}/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q4_K_M.gguf` },
  { group: "Tiny", label: "Gemma 3 270M", mb: 253, phone: true, url: `${HF}/unsloth/gemma-3-270m-it-GGUF/resolve/main/gemma-3-270m-it-Q4_K_M.gguf` },
  { group: "Tiny", label: "LFM2 350M", mb: 230, phone: true, url: `${HF}/LiquidAI/LFM2-350M-GGUF/resolve/main/LFM2-350M-Q4_K_M.gguf` },
  { group: "Tiny", label: "Qwen3 0.6B", mb: 639, phone: true, url: `${HF}/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf` },
  { group: "Tiny", label: "TinyLlama 1.1B", mb: 669, phone: true, url: `${HF}/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf` },
  { group: "Tiny", label: "Gemma 3 1B", mb: 806, phone: true, url: `${HF}/unsloth/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf` },
  { group: "Coding", label: "Qwen2.5 Coder 0.5B", mb: 400, phone: true, url: `${HF}/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf` },
  { group: "Coding", label: "Qwen2.5 Coder 1.5B", mb: 1100, phone: true, url: `${HF}/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf` },
  { group: "Coding", label: "Qwen2.5 Coder 3B", mb: 2100, url: `${HF}/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf` },
  { group: "Coding", label: "DeepSeek R1 Distill 1.5B (reasoning)", mb: 1100, phone: true, url: `${HF}/bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf` },
  { group: "General", label: "SmolLM2 360M", mb: 270, phone: true, url: `${HF}/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf` },
  { group: "General", label: "Qwen2.5 0.5B", mb: 491, phone: true, url: `${HF}/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf` },
  { group: "General", label: "Llama 3.2 1B", mb: 808, phone: true, url: `${HF}/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf` },
  { group: "General", label: "Qwen2.5 1.5B", mb: 1100, phone: true, url: `${HF}/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf` },
  { group: "General", label: "SmolLM2 1.7B", mb: 1060, phone: true, url: `${HF}/bartowski/SmolLM2-1.7B-Instruct-GGUF/resolve/main/SmolLM2-1.7B-Instruct-Q4_K_M.gguf` },
  { group: "General", label: "Gemma 2 2B", mb: 1700, phone: true, url: `${HF}/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf` },
  { group: "General", label: "Qwen2.5 3B", mb: 2000, url: `${HF}/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf` },
  { group: "General", label: "Llama 3.2 3B", mb: 2000, url: `${HF}/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf` },
  // Bigger models: only offered when the project runs on your own computer (the hosted website stays small).
  { group: "Coding", label: "Qwen2.5 Coder 7B", mb: 4680, url: `${HF}/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf` },
  { group: "Coding", label: "Qwen2.5 Coder 14B", mb: 8990, url: `${HF}/bartowski/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf` },
  { group: "Coding", label: "DeepSeek R1 Distill 7B (reasoning)", mb: 4680, url: `${HF}/bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf` },
  { group: "General", label: "Qwen3.5 4B", mb: 2740, url: `${HF}/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf` },
  { group: "General", label: "Mistral 7B v0.3", mb: 4370, url: `${HF}/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf` },
  { group: "General", label: "Llama 3.1 8B", mb: 4920, url: `${HF}/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf` },
  { group: "General", label: "Gemma 2 9B", mb: 5760, url: `${HF}/bartowski/gemma-2-9b-it-GGUF/resolve/main/gemma-2-9b-it-Q4_K_M.gguf` },
];

/** Models to offer: everything on your own computer, only the small ones on the hosted website. */
export const modelsFor = (isStatic) => (isStatic ? MODEL_CATALOG.filter((m) => m.mb <= HOSTED_MAX_MB) : MODEL_CATALOG);

const norm = (text) => String(text).toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();

/**
 * Understand "/model qwen coder 1.5b", "download smollm2", "list models", or "/model <link to .gguf>".
 * Plain sentences only count when a catalog model is actually named, so normal chat isn't hijacked.
 * @returns {null | {list: true} | {entry?: object, url?: string, term: string, explicit: boolean}}
 */
export function matchModelRequest(text) {
  const value = String(text).trim();
  if (/^(\/models?|list (the )?models|show (the )?models|what models.*)\s*\??$/i.test(value)) return { list: true };
  const slash = value.match(/^\/models?\s+(.+)$/i);
  const natural = value.match(/^(?:please\s+)?(?:download|get|install|load|switch to|use)\s+(?:me\s+)?(?:the\s+)?(?:model\s+)?(.+)$/i);
  const term = (slash || natural)?.[1]?.trim();
  if (!term) return null;
  if (/^https:\/\/\S+\.gguf(\?\S*)?$/i.test(term)) return { url: term, term, explicit: true };
  const words = norm(term).split(" ").filter(Boolean);
  const entry = MODEL_CATALOG
    .filter((item) => words.every((word) => norm(item.label).includes(word)))
    .sort((a, b) => a.label.length - b.label.length)[0];
  if (entry) return { entry, url: entry.url, term, explicit: Boolean(slash) };
  return slash ? { list: true, term, explicit: true } : null;
}

export const modelListText = (isStatic) => {
  const line = (m) => `- ${m.label} (${m.group}, ${m.mb >= 1000 ? (m.mb / 1000).toFixed(1) + " GB" : m.mb + " MB"}${m.phone ? ", phone ok" : ""})`;
  return [
    "Models I can download. Say \"download <name>\" or \"/model <name>\":",
    ...modelsFor(isStatic).map(line),
    isStatic
      ? `Bigger models (up to 14B) are only offered when you download the project and run it on your own computer. You can also give me a direct link to any small .gguf: /model https://…`
      : "You can also give me a direct link to any .gguf: /model https://…",
  ].join("\n");
};
