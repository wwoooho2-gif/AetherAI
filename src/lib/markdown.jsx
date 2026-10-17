// Minimal, safe inline rendering: **bold**, `code`, [links](https://…) and ![images](https://…).
// Nothing is injected as HTML; URLs are limited to https/data:image/blob.
import { isSafeImageUrl } from "./web.js";

const TOKEN = /(!\[[^\]]*\]\([^)\s]+\)|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*\*[^*]+?\*\*|__[^_]+?__|`[^`\n]+`|https?:\/\/[^\s<>"')\]]+)/g;

export function renderRich(content) {
  return String(content).split(TOKEN).map((part, index) => {
    if (!part) return null;
    let match = part.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (match) {
      return isSafeImageUrl(match[2])
        ? <img key={index} className="chat-image" src={match[2]} alt={match[1]} loading="lazy" referrerPolicy="no-referrer" />
        : match[1];
    }
    match = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (match) return <a key={index} href={match[2]} target="_blank" rel="noopener noreferrer nofollow">{match[1]}</a>;
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    if (/^https?:\/\//.test(part)) return <a key={index} href={part} target="_blank" rel="noopener noreferrer nofollow">{part}</a>;
    return part;
  });
}
