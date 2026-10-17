// Prompt/context compaction. Local models are slow mostly because of prompt size
// (prefill) and output length, so we keep both small without losing what matters.
import { languageOf } from "./files.js";

/** Cheap token estimate: ~4 characters per token for code/English. */
export const estimateTokens = (text) => Math.ceil(String(text || "").length / 4);

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;

/** Replace code blocks in an old turn with a one-line stub, e.g. [code: app.py, 120 lines]. */
export function stubCode(text) {
  return String(text).replace(FENCE, (_m, info, body) => {
    const name = String(info).match(/filename=["']?([^"'\s]+)/)?.[1] || String(info).trim().split(/\s+/)[0] || "code";
    return `[code omitted: ${name}, ${body.split("\n").length} lines]`;
  });
}

/** Keep the start and end of long text; the middle is rarely what the next question needs. */
export function headTail(text, max) {
  const value = String(text);
  if (value.length <= max) return value;
  const keep = Math.floor(max / 2);
  return `${value.slice(0, keep)}\n…[${value.length - max} characters omitted]…\n${value.slice(-keep)}`;
}

// ---- file chunk selection ----------------------------------------------------------------------
const STOP = new Set("the a an and or of to in on for with is are was be it this that from by as at how what why can you please file code make change fix add use using into then".split(" "));
const words = (text) => (String(text).toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || []).filter((w) => !STOP.has(w));

function splitChunks(content, targetLines = 60) {
  const lines = content.split("\n");
  const chunks = [];
  for (let start = 0; start < lines.length; start += targetLines) {
    chunks.push({ start: start + 1, text: lines.slice(start, start + targetLines).join("\n") });
  }
  return chunks;
}

/**
 * Fit attached files into a character budget.
 * Small sets go in whole. Otherwise files are ranked by relevance to the question; the best ones get a
 * share of the budget (big files are cut down to the sections that match), the rest are listed by name only.
 */
export function packFiles(files, question, budgetChars = 12_000) {
  if (!files.length) return "";
  const total = files.reduce((sum, file) => sum + file.content.length, 0);
  const queryWords = new Set(words(question));
  const fileScore = (file) => {
    const base = file.name.split("/").pop().toLowerCase();
    let score = queryWords.has(base.replace(/\.[a-z0-9]+$/, "")) || String(question).toLowerCase().includes(base) ? 1000 : 0;
    const lowered = file.content.toLowerCase();
    for (const word of queryWords) if (lowered.includes(word)) score += 1;
    return score;
  };
  const ranked = files.map((file) => ({ file, score: fileScore(file) })).sort((a, b) => b.score - a.score);
  const whole = total <= budgetChars;
  const maxFiles = whole ? files.length : Math.max(1, Math.floor(budgetChars / 1800));
  const chosen = ranked.slice(0, maxFiles);
  const left = ranked.slice(maxFiles).map((item) => item.file.name);
  const out = [];
  if (files.length > 1) {
    const listed = files.slice(0, 60).map((file) => file.name).join("\n");
    out.push(`Files (${files.length}):\n${listed}${files.length > 60 ? "\n…" : ""}`);
  }
  let remaining = budgetChars;
  chosen.forEach(({ file, score }, position) => {
    const header = `FILE ${file.name}${languageOf(file.name) ? ` (${languageOf(file.name)})` : ""}`;
    const share = whole ? Infinity : Math.floor(remaining / (chosen.length - position)) * (score >= 1000 ? 2 : 1);
    const limit = whole ? Infinity : Math.min(remaining, Math.max(1200, share));
    if (file.content.length <= limit) {
      remaining -= file.content.length;
      out.push(`${header}\n\`\`\`\n${file.content}\n\`\`\``);
      return;
    }
    const chunks = splitChunks(file.content).map((chunk) => {
      const lowered = chunk.text.toLowerCase();
      let hits = 0;
      for (const word of queryWords) if (lowered.includes(word)) hits += 1;
      return { ...chunk, hits };
    });
    const keep = new Set([0]); // the top of a file (imports, setup) is almost always useful
    let used = chunks[0].text.length;
    [...chunks].sort((a, b) => b.hits - a.hits).forEach((chunk) => {
      if (chunk.hits > 0 && used + chunk.text.length <= limit && !keep.has(chunks.indexOf(chunk))) {
        keep.add(chunks.indexOf(chunk));
        used += chunk.text.length;
      }
    });
    remaining -= used;
    const pieces = [...keep].sort((a, b) => a - b).map((i) => `# lines ${chunks[i].start}+\n${chunks[i].text}`);
    out.push(`${header} — large file; showing ${keep.size} of ${chunks.length} sections that match the request. Ask for other parts by line range.\n\`\`\`\n${pieces.join("\n…\n")}\n\`\`\``);
  });
  if (left.length) out.push(`Not shown (ask if needed): ${left.slice(0, 40).join(", ")}${left.length > 40 ? ", …" : ""}`);
  return out.join("\n\n");
}

/**
 * Build the compact message history.
 *  - the newest turn is kept verbatim
 *  - older assistant turns lose their code blocks and are trimmed
 *  - older user turns lose pasted/attached file bodies (the files stay in the workspace)
 *  - oldest turns drop first when over budget
 */
export function compactHistory(messages, { budgetTokens = 2200, recentVerbatim = 2 } = {}) {
  const usable = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const out = [];
  let used = 0;
  for (let i = usable.length - 1; i >= 0; i -= 1) {
    const message = usable[i];
    const fromEnd = usable.length - 1 - i;
    let content = message.compactContent ?? message.requestContent ?? message.content;
    if (fromEnd >= recentVerbatim) {
      content = message.role === "assistant" ? headTail(stubCode(content), 900) : headTail(content, 900);
    }
    const cost = estimateTokens(content) + 4;
    if (out.length > 0 && used + cost > budgetTokens) break;
    out.push({ role: message.role, content });
    used += cost;
  }
  return out.reverse();
}
