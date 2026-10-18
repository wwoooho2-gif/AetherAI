// Downloads the small models that ship inside the app into public/models/ and writes manifest.json.
// Runs in the GitHub Pages workflow before `vite build`. Safe to re-run: existing files are kept.
// Edit BUNDLED to change what is included (keep the total well under GitHub Pages' 1 GB site limit).
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const HF = "https://huggingface.co";
const BUNDLED = [
  { label: "SmolLM2 135M (fastest)", file: "SmolLM2-135M-Instruct-Q4_K_M.gguf", url: `${HF}/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q4_K_M.gguf` },
  { label: "Qwen2.5 0.5B (better answers)", file: "qwen2.5-0.5b-instruct-q4_k_m.gguf", url: `${HF}/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf` },
];

const dir = new URL("../public/models/", import.meta.url);
mkdirSync(dir, { recursive: true });
const manifest = [];
for (const m of BUNDLED) {
  const path = new URL(m.file, dir);
  if (!existsSync(path)) {
    console.log(`Downloading ${m.file}…`);
    const res = await fetch(m.url, { redirect: "follow" });
    if (!res.ok || !res.body) { console.warn(`Skipping ${m.file}: HTTP ${res.status}`); continue; }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
  }
  manifest.push({ label: m.label, file: m.file, bytes: statSync(path).size });
}
writeFileSync(new URL("manifest.json", dir), JSON.stringify(manifest, null, 2));
console.log(`Bundled ${manifest.length} model(s).`);
