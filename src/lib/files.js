// Reading and editing dropped files in any language.
import { readZipEntries } from "./zip.js";
import { describeBinary } from "./binary.js";

export const MAX_FILE_BYTES = 2_000_000; // per text file
export const MAX_BINARY_BYTES = 60_000_000; // per binary file (only a short summary is kept)
export const MAX_TOTAL_FILES = 200; // per drop / per zip
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|__pycache__|\.venv|venv|target|\.next|\.idea|\.vscode)(\/|$)/;
// Media/archives we can't describe usefully. Every other binary (dll, exe, so, class, wasm, pdf, docx…) is summarised.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|heic|mp[34]|m4a|mov|avi|mkv|webm|wav|ogg|flac|woff2?|ttf|otf|eot|gz|tgz|tar|7z|rar|xz|bz2|gguf|pack|idx|rev|lock)$/i;

/** Guess the language from a filename (used for code fences). */
const LANGS = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
  py: "python", rb: "ruby", php: "php", java: "java", kt: "kotlin", swift: "swift", go: "go", rs: "rust",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", lua: "lua", r: "r", dart: "dart",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", bat: "batch", sql: "sql", html: "html", htm: "html",
  css: "css", scss: "scss", json: "json", yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml", md: "markdown",
  vue: "vue", svelte: "svelte", gd: "gdscript", scala: "scala", hs: "haskell", ex: "elixir", exs: "elixir", zig: "zig",
  luau: "lua", jl: "julia", pl: "perl", pm: "perl", clj: "clojure", erl: "erlang", ml: "ocaml", fs: "fsharp", vb: "vbnet",
  asm: "nasm", s: "asm", nim: "nim", cr: "crystal", v: "v", groovy: "groovy", gradle: "groovy", m: "objectivec", mm: "objectivec",
  sol: "solidity", tf: "hcl", proto: "protobuf", graphql: "graphql", ini: "ini", cfg: "ini", txt: "", cmake: "cmake", mk: "makefile",
};
export const languageOf = (name) => LANGS[String(name).split(".").pop().toLowerCase()] || "";

/** Text if the first 8 KB has no NUL byte and decodes cleanly. Works for any language or config file. */
export function looksLikeText(bytes) {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  let bad = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) bad += 1;
  return bad / (sample.length || 1) < 0.02;
}

const decodeText = (bytes) => new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
const displayPath = (file) => file.webkitRelativePath || file.relativePath || file.name;

/**
 * Turn dropped/picked File objects into attachments: { name, content, size }.
 * Expands .zip archives, skips junk folders and binaries, never throws for a single bad file.
 * @returns {{ accepted: {name:string, content:string, size:number}[], rejected: string[] }}
 */
export async function readAttachments(fileList) {
  const accepted = [];
  const rejected = [];
  const add = async (name, bytes) => {
    if (accepted.length >= MAX_TOTAL_FILES) return rejected.push(`${name} (more than ${MAX_TOTAL_FILES} files)`);
    if (SKIP_DIRS.test(name)) return undefined;
    if (BINARY_EXT.test(name)) return rejected.push(`${name} (media/archive)`);
    if (!looksLikeText(bytes) || /\.(dll|exe|sys|ocx|so|dylib|class|wasm|bin|o|obj|a|lib|pdf|docx|xlsx|pptx|odt|ods|odp)$/i.test(name)) {
      if (bytes.length > MAX_BINARY_BYTES) return rejected.push(`${name} (over ${Math.round(MAX_BINARY_BYTES / 1e6)} MB)`);
      const summary = await describeBinary(name, bytes);
      accepted.push({ name, content: summary, size: bytes.length, readOnly: true });
      return undefined;
    }
    if (bytes.length > MAX_FILE_BYTES) return rejected.push(`${name} (over ${Math.round(MAX_FILE_BYTES / 1e6)} MB)`);
    accepted.push({ name, content: decodeText(bytes), size: bytes.length });
    return undefined;
  };

  for (const file of Array.from(fileList || [])) {
    const name = displayPath(file);
    try {
      if (/\.zip$/i.test(file.name)) {
        for (const entry of await readZipEntries(file)) {
          if (entry.encrypted) {
            rejected.push(`${entry.name} (password-protected)`);
          } else if (SKIP_DIRS.test(entry.name) || BINARY_EXT.test(entry.name)) {
            continue;
          } else if (entry.size > MAX_BINARY_BYTES) {
            rejected.push(`${entry.name} (over ${Math.round(MAX_BINARY_BYTES / 1e6)} MB)`);
          } else {
            // Keep the archive's own folder layout; only add a prefix when it isn't already there.
            const stem = file.name.replace(/\.zip$/i, "");
            await add(entry.name.startsWith(`${stem}/`) ? entry.name : `${stem}/${entry.name}`, await entry.bytes());
          }
        }
      } else {
        if (SKIP_DIRS.test(name)) continue;
        await add(name, new Uint8Array(await file.arrayBuffer()));
      }
    } catch (error) {
      rejected.push(`${name} (${error.message || "could not read"})`);
    }
  }
  return { accepted, rejected };
}

/** Collect every File from a drop event, including whole folders (webkitGetAsEntry). */
export async function filesFromDrop(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return Array.from(dataTransfer?.files || []);
  const out = [];
  async function walk(entry, prefix) {
    if (out.length >= MAX_TOTAL_FILES * 2) return;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      Object.defineProperty(file, "relativePath", { value: `${prefix}${file.name}` });
      out.push(file);
    } else if (entry.isDirectory) {
      if (SKIP_DIRS.test(`${prefix}${entry.name}`)) return;
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  }
  for (const entry of entries) await walk(entry, "");
  return out;
}

// ---- Edit patches ---------------------------------------------------------------------------
// To save output tokens (the slow part of local generation) the model edits files with
// SEARCH/REPLACE blocks instead of rewriting them:
//
//   ```edit filename="app.py"
//   <<<<<<< SEARCH
//   old lines
//   =======
//   new lines
//   >>>>>>> REPLACE
//   ```
const BLOCK = /<<<<<<< ?SEARCH\r?\n([\s\S]*?)\r?\n?=======\r?\n([\s\S]*?)\r?\n?>>>>>>> ?REPLACE/g;

const normaliseWs = (text) => text.replace(/[ \t]+$/gm, "").replace(/\r\n/g, "\n");

export function parsePatchBlocks(body) {
  const blocks = [];
  for (const match of String(body).matchAll(BLOCK)) blocks.push({ search: match[1], replace: match[2] });
  return blocks;
}

/**
 * Apply SEARCH/REPLACE blocks to a file's text.
 * Exact match first, then a whitespace-tolerant match. An ambiguous or missing block is reported, never guessed.
 * @returns {{ content: string, applied: number, failed: string[] }}
 */
export function applyPatchBlocks(original, blocks) {
  let content = original;
  let applied = 0;
  const failed = [];
  for (const { search, replace } of blocks) {
    if (!search.trim()) {
      failed.push("A block had an empty SEARCH section.");
      continue;
    }
    const first = content.indexOf(search);
    if (first >= 0) {
      if (content.indexOf(search, first + 1) >= 0) {
        failed.push(`Ambiguous: "${search.trim().split("\n")[0].slice(0, 60)}" appears more than once.`);
        continue;
      }
      content = content.slice(0, first) + replace + content.slice(first + search.length);
      applied += 1;
      continue;
    }
    // Whitespace-tolerant fallback (models often drop trailing spaces or change indentation endings).
    const lines = content.split("\n");
    const wanted = normaliseWs(search).split("\n").map((line) => line.trim());
    let hit = -1;
    let hits = 0;
    for (let i = 0; i + wanted.length <= lines.length; i += 1) {
      if (wanted.every((line, offset) => lines[i + offset].trim() === line)) {
        hit = i;
        hits += 1;
      }
    }
    if (hits === 1) {
      lines.splice(hit, wanted.length, ...replace.split("\n"));
      content = lines.join("\n");
      applied += 1;
    } else {
      failed.push(`${hits > 1 ? "Ambiguous" : "Not found"}: "${search.trim().split("\n")[0].slice(0, 60)}"`);
    }
  }
  return { content, applied, failed };
}

export const EDIT_PROMPT =
  "Attached files appear as FILE blocks. To change a file do NOT rewrite it; output one block per file: " +
  "```edit filename=\"path/name.ext\"\n<<<<<<< SEARCH\nexact existing lines\n=======\nnew lines\n>>>>>>> REPLACE\n``` " +
  "(several SEARCH/REPLACE pairs are fine; SEARCH must match the file exactly and be unique). " +
  "Give a whole file only when creating a new one or when most of it changes. Works for any language. " +
  "Files marked as binary analysis (dll, exe, pdf…) are read-only summaries: explain or reimplement them in text, but never edit them with a block.";
