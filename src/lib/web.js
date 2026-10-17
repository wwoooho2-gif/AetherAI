// Web access: search, read pages, find photos, generate images.
//
// Local app (npm run dev): searching and page reading go through the dev server
//   (/__aether/web/*), which has no CORS limits and blocks private/internal addresses.
// Hosted site (GitHub Pages, no server): only CORS-friendly sources work from the browser —
//   Wikipedia, Stack Overflow, GitHub, Wikimedia Commons — plus an optional reader proxy
//   for opening arbitrary pages (see READER_PROXY below).
const SEARCH_BASE = (typeof window !== "undefined" && window.AETHER_SEARCH_BASE) || "/search";
// Third-party "reader" used ONLY on the hosted site, only when the page can't be fetched directly.
// The proxy sees the URL you open. Set window.AETHER_READER_PROXY = "" to disable it.
const READER_PROXY = (typeof window !== "undefined" && window.AETHER_READER_PROXY !== undefined)
  ? window.AETHER_READER_PROXY
  : "https://r.jina.ai/";

const withTimeout = (ms = 12000) => AbortSignal.timeout(ms);

export function extractUrls(text) {
  return [...new Set(String(text).match(/https?:\/\/[^\s<>"')\]]+/g) || [])]
    .map((url) => url.replace(/[.,;:!?]+$/, ""))
    .slice(0, 3);
}

export const isSafeImageUrl = (url) => /^(https:\/\/|data:image\/|blob:)/i.test(String(url));

// ---- search --------------------------------------------------------------------------------------
async function searchViaServer(query) {
  const response = await fetch(`/__aether/web/search?q=${encodeURIComponent(query)}`, { signal: withTimeout() });
  if (!response.ok) throw new Error(`Web search returned HTTP ${response.status}.`);
  return (await response.json()).results || [];
}

async function searchWikipedia(query) {
  const params = new URLSearchParams({
    action: "query", list: "search", srsearch: query, srlimit: "3", format: "json", origin: "*",
  });
  const data = await (await fetch(`https://en.wikipedia.org/w/api.php?${params}`, { signal: withTimeout() })).json();
  return (data.query?.search || []).map((item) => ({
    source: "Wikipedia",
    title: item.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
    snippet: item.snippet.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
  }));
}

async function searchStackOverflow(query) {
  const params = new URLSearchParams({ order: "desc", sort: "relevance", site: "stackoverflow", pagesize: "3", q: query });
  const data = await (await fetch(`${SEARCH_BASE}/stackoverflow?${params}`, { signal: withTimeout() })).json();
  const parser = new DOMParser();
  return (data.items || []).map((item) => ({
    source: "Stack Overflow",
    title: item.title,
    url: item.link,
    snippet: parser.parseFromString(item.excerpt || "", "text/html").body.textContent.trim(),
  }));
}

async function searchGithub(query) {
  const params = new URLSearchParams({ per_page: "3", q: query });
  const data = await (await fetch(`${SEARCH_BASE}/github?${params}`, {
    headers: { Accept: "application/vnd.github+json" }, signal: withTimeout(),
  })).json();
  return (data.items || []).map((item) => ({
    source: "GitHub", title: item.full_name, url: item.html_url, snippet: item.description || "GitHub repository",
  }));
}

/** @returns {Promise<{source:string,title:string,url:string,snippet:string}[]>} */
export async function webSearch(query, { isStatic = false } = {}) {
  const q = String(query).trim().slice(0, 300);
  if (!q) throw new Error("Nothing to search for.");
  const results = [];
  const failures = [];
  if (!isStatic) {
    try { results.push(...(await searchViaServer(q))); } catch (error) { failures.push(error.message); }
  }
  if (results.length < 3) {
    const settled = await Promise.allSettled([searchWikipedia(q), searchStackOverflow(q), searchGithub(q)]);
    for (const item of settled) {
      if (item.status === "fulfilled") results.push(...item.value);
      else failures.push(item.reason?.message || "A search source failed.");
    }
  }
  const usable = results.filter((r) => r.title && r.url && r.snippet).slice(0, 6);
  if (!usable.length) throw new Error(failures.join(" ") || "No readable results were found.");
  return usable;
}

// ---- reading a page ---------------------------------------------------------------------------------
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,svg,iframe,nav,footer,header,form,aside").forEach((node) => node.remove());
  const main = doc.querySelector("main, article") || doc.body;
  return (main?.textContent || "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

/** @returns {Promise<{url:string,title:string,text:string,html?:string}>} */
export async function fetchPage(rawUrl, { isStatic = false, maxChars = 6000, keepHtml = false } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error("That isn't a valid link."); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https links can be opened.");

  if (!isStatic) {
    const response = await fetch(`/__aether/web/fetch?url=${encodeURIComponent(url.href)}`, { signal: withTimeout(20000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not open the page (HTTP ${response.status}).`);
    return { url: data.url, title: data.title, text: String(data.text).slice(0, maxChars), html: keepHtml ? data.html : undefined };
  }
  // Hosted site: try the page directly (only works for sites that allow cross-origin reads) …
  try {
    const response = await fetch(url.href, { signal: withTimeout(15000) });
    if (response.ok) {
      const html = await response.text();
      const title = new DOMParser().parseFromString(html, "text/html").title || url.hostname;
      return { url: url.href, title, text: htmlToText(html).slice(0, maxChars), html: keepHtml ? html : undefined };
    }
  } catch { /* blocked by CORS — fall through */ }
  // … then through the reader proxy, if enabled.
  if (!READER_PROXY) throw new Error("This site doesn't allow the browser to read it. Run Aether locally (npm run dev) to open any page.");
  const response = await fetch(`${READER_PROXY}${url.href}`, { signal: withTimeout(25000) });
  if (!response.ok) throw new Error(`The reader service returned HTTP ${response.status}.`);
  const text = (await response.text()).slice(0, maxChars);
  return { url: url.href, title: url.hostname, text };
}

// ---- photos ------------------------------------------------------------------------------------------
/** Real photos from Wikimedia Commons (CORS-friendly, licences vary — credit links are returned). */
export async function searchImages(query, limit = 4) {
  const params = new URLSearchParams({
    action: "query", generator: "search", gsrsearch: `${query} filetype:bitmap`, gsrnamespace: "6",
    gsrlimit: String(limit), prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "640", format: "json", origin: "*",
  });
  const data = await (await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { signal: withTimeout() })).json();
  const pages = Object.values(data.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  const images = pages.map((page) => {
    const info = page.imageinfo?.[0];
    if (!info?.thumburl) return null;
    const meta = info.extmetadata || {};
    return {
      url: info.thumburl,
      alt: page.title.replace(/^File:/, "").replace(/\.[a-z]+$/i, ""),
      credit: info.descriptionurl,
      license: meta.LicenseShortName?.value || "",
    };
  }).filter(Boolean);
  if (!images.length) throw new Error(`No photos found for "${query}".`);
  return images;
}

/**
 * Create an image from a prompt.
 * - Local app with an OpenAI key: gpt-image-1 through the local server.
 * - Otherwise: Pollinations (free, no key). The prompt is sent to that service.
 */
export async function generateImage(prompt, { openaiKey = "", isStatic = false, size = 768 } = {}) {
  const text = String(prompt).trim().slice(0, 1000);
  if (!text) throw new Error("Describe the image you want.");
  if (openaiKey && !isStatic) {
    const response = await fetch("/__aether/providers/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: openaiKey, prompt: text }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `OpenAI returned HTTP ${response.status}.`);
    return { url: data.image, alt: text, credit: "", license: "Generated with OpenAI" };
  }
  const seed = Math.floor(Math.random() * 1e6);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(text)}?width=${size}&height=${size}&nologo=true&seed=${seed}`;
  // Verify it actually loads so a failure shows up as an error instead of a broken image icon.
  await new Promise((resolve, reject) => {
    const probe = new Image();
    const timer = setTimeout(() => reject(new Error("The image service took too long. Try again.")), 60000);
    probe.onload = () => { clearTimeout(timer); resolve(); };
    probe.onerror = () => { clearTimeout(timer); reject(new Error("The image service couldn't make that image right now.")); };
    probe.src = url;
  });
  return { url, alt: text, credit: "https://pollinations.ai", license: "Generated with Pollinations" };
}

/** Compact search results for the prompt: one line each, capped. */
export function formatResultsForPrompt(results, maxSnippet = 220) {
  return results.map((r, i) => `${i + 1}. [${r.source}] ${r.title} — ${r.url}\n${String(r.snippet).slice(0, maxSnippet)}`).join("\n");
}
