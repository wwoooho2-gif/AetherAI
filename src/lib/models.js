// Starter models for the in-browser loader (all GGUF, 4-bit unless noted). "phone" = small enough for most phones.
// Any other .gguf can still be dropped in or pasted as a link.
const HF = "https://huggingface.co";
export const MODEL_CATALOG = [
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
];
