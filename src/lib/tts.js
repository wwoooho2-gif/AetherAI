// Read-aloud for Aether.
//  - "browser": the device's built-in voices (speechSynthesis). Free, offline-capable, no setup.
//  - "http":    any text-to-speech web service you configure (hoppou.ai, a local Piper/Kokoro server,
//               OpenAI-compatible /v1/audio/speech, ...). You give the URL and a JSON body template.
// Long replies are split into sentences: the browser engine queues them, the HTTP engine fetches the
// next sentence while the current one plays, so speech starts quickly and never cuts off.

export const TTS_KEY = "aether.tts.settings.v1";
export const DEFAULT_BODY_TEMPLATE = '{"model":"{{model}}","input":"{{text}}","voice":"{{voice}}","response_format":"mp3"}';
// hoppou.ai: OpenAI-compatible speech endpoint, Bearer auth, MP3 back. Body matches their curl example exactly.
export const HOPPOU_PRESET = {
  url: "https://api.hoppou.ai/tts/v1/audio/speech",
  model: "tts-1",
  voice: "alba",
  bodyTemplate: '{"model":"{{model}}","input":"{{text}}","voice":"{{voice}}"}',
};
export const isHoppou = (settings) => settings.engine === "http" && settings.http.url === HOPPOU_PRESET.url;

export const DEFAULT_TTS_SETTINGS = {
  engine: "browser", // "browser" | "http"
  autoRead: false,
  voiceURI: "",
  rate: 1,
  pitch: 1,
  http: { url: "", model: "", voice: "", bodyTemplate: DEFAULT_BODY_TEMPLATE },
};

export function loadTtsSettings(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(TTS_KEY) || "null");
    if (!saved || typeof saved !== "object") return structuredClone(DEFAULT_TTS_SETTINGS);
    return {
      ...DEFAULT_TTS_SETTINGS,
      ...saved,
      http: { ...DEFAULT_TTS_SETTINGS.http, ...(saved.http || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_TTS_SETTINGS);
  }
}

// The API key is deliberately NOT part of the saved settings (same rule as the cloud AI providers).
export function saveTtsSettings(settings, storage = globalThis.localStorage) {
  try {
    storage.setItem(TTS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("Could not save voice settings:", error);
  }
}

/** Markdown -> what a person would actually say out loud. */
export function speakableText(markdown) {
  let omittedCode = false;
  const text = String(markdown)
    .replace(/```[\s\S]*?(```|$)/g, () => {
      if (omittedCode) return " ";
      omittedCode = true;
      return " (code omitted) ";
    })
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/^\s*📎.*$/gm, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/[*_~`]/g, "")
    .replace(/[|]/g, " ")
    .replace(/\s*\n\s*/g, ". ")
    .replace(/([.!?:;,])(\s*\.)+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text;
}

/** Split into speakable pieces of at most `max` characters, preferring sentence ends. */
export function chunkText(text, max = 220) {
  const sentences = String(text).match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [];
  const chunks = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (sentence.length > max) {
      flush();
      let rest = sentence;
      while (rest.length > max) {
        let cut = Math.max(rest.lastIndexOf(", ", max), rest.lastIndexOf("; ", max), rest.lastIndexOf(" ", max));
        if (cut < max * 0.4) cut = max;
        chunks.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1);
      }
      current = rest;
    } else if ((current + sentence).length > max) {
      flush();
      current = sentence;
    } else {
      current += sentence;
    }
  }
  flush();
  return chunks.filter((chunk) => /[\p{L}\p{N}]/u.test(chunk));
}

/** Fill {{text}} {{voice}} {{model}} {{speed}} in a JSON template, safely (values are never pasted as raw JSON). */
export function buildTtsBody(template, values) {
  let parsed;
  try {
    parsed = JSON.parse(template);
  } catch {
    throw new Error("The voice request template isn’t valid JSON.");
  }
  const fill = (node) => {
    if (typeof node === "string") {
      const whole = node.match(/^\{\{(\w+)\}\}$/);
      if (whole && typeof values[whole[1]] === "number") return values[whole[1]]; // "{{speed}}" -> number
      return node.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(values[key] ?? ""));
    }
    if (Array.isArray(node)) return node.map(fill);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, fill(value)]));
    return node;
  };
  return fill(parsed);
}

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

function base64ToBlob(base64, type = "audio/mpeg") {
  const binary = atob(base64.replace(/^data:[^,]*,/, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Ask the configured service for audio. Returns { blob } or { url }. */
export async function requestSpeechAudio(http, apiKey, text, { rate = 1, isStatic = false, signal } = {}) {
  if (!/^https?:\/\//i.test(http.url || "")) throw new Error("Enter the voice service URL in Voice settings.");
  const body = buildTtsBody(http.bodyTemplate || DEFAULT_BODY_TEMPLATE, {
    text, voice: http.voice || "", model: http.model || "", speed: rate,
  });
  let response;
  if (!isStatic && !LOCAL_URL.test(http.url)) {
    // Local app: the dev server makes the call (no CORS limits, public https hosts only).
    response = await fetch("/__aether/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: http.url, apiKey: apiKey || "", body }),
      signal,
    });
  } else {
    // Hosted site, or a TTS server on your own machine: straight from the browser (needs CORS enabled there).
    try {
      response = await fetch(http.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // A bare "NetworkError"/"Failed to fetch" here means the browser blocked the call, almost always CORS.
      throw new Error(
        `The browser blocked the request to ${new URL(http.url).hostname} (it doesn't allow calls from web pages, or an ad-blocker/offline is in the way). ` +
        "Use the local app (npm run dev), which makes the call for you, or switch Voice engine to Browser voices.",
      );
    }
  }
  const type = response.headers.get("content-type") || "";
  if (!response.ok) {
    const detail = type.includes("json") ? (await response.json().catch(() => ({}))).error : "";
    throw new Error(detail || `The voice service answered HTTP ${response.status}.`);
  }
  if (/^audio\//i.test(type) || type.includes("octet-stream")) return { blob: await response.blob() };
  if (type.includes("json")) {
    const data = await response.json();
    const link = data.audio_url || data.url;
    if (typeof link === "string" && /^https:\/\//.test(link)) return { url: link };
    const encoded = data.audio_base64 || data.audio;
    if (typeof encoded === "string" && encoded.length > 100) return { blob: base64ToBlob(encoded) };
  }
  throw new Error("The voice service didn’t return audio. Check the request template in Voice settings.");
}

/**
 * One speaker for the whole app. State is reported through onChange({ state, id, error }):
 * state is "idle" | "loading" | "speaking" | "paused"; id says which message is being read.
 */
export function createSpeaker({ getSettings, getApiKey, isStatic, onChange }) {
  let run = 0; // bumped on every speak/stop so late callbacks from old runs are ignored
  let abort = null;
  let audio = null;
  let audioUrl = "";
  let lastId = null; // message being read, so pause/resume can report it
  const report = (state, id = null, error = "") => {
    if (id != null) lastId = id;
    onChange?.({ state, id: state === "idle" ? null : id ?? lastId, error });
  };

  const synth = () => (typeof window !== "undefined" ? window.speechSynthesis : undefined);
  const releaseAudio = () => {
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio = null;
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = "";
  };

  function stop() {
    run += 1;
    abort?.abort();
    abort = null;
    releaseAudio();
    synth()?.cancel();
    report("idle");
  }

  function playSource(source, rate, token) {
    return new Promise((resolve, reject) => {
      if (token !== run) return resolve();
      releaseAudio();
      audioUrl = source.blob ? URL.createObjectURL(source.blob) : "";
      audio = new Audio(source.blob ? audioUrl : source.url);
      audio.playbackRate = rate;
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("The audio from the voice service couldn’t be played."));
      return audio.play().catch(reject);
    });
  }

  async function speakHttp(chunks, id, token, settings) {
    const rate = settings.rate;
    abort = new AbortController();
    const { signal } = abort;
    const fetchChunk = (chunk) => {
      const promise = requestSpeechAudio(settings.http, getApiKey?.() || "", chunk, { rate, isStatic, signal });
      promise.catch(() => {}); // avoid unhandled-rejection noise for prefetches that get cancelled
      return promise;
    };
    report("loading", id);
    let next = fetchChunk(chunks[0]);
    for (let i = 0; i < chunks.length; i += 1) {
      const source = await next;
      if (token !== run) return;
      if (i + 1 < chunks.length) next = fetchChunk(chunks[i + 1]);
      report("speaking", id);
      await playSource(source, rate, token);
      if (token !== run) return;
      if (i + 1 < chunks.length) report("loading", id);
    }
    releaseAudio();
    report("idle");
  }

  function speakBrowser(chunks, id, token, settings) {
    const engine = synth();
    if (!engine || typeof SpeechSynthesisUtterance === "undefined") {
      throw new Error("This browser has no built-in text-to-speech.");
    }
    engine.cancel();
    const voice = engine.getVoices().find((item) => item.voiceURI === settings.voiceURI);
    report("speaking", id);
    chunks.forEach((chunk, index) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = settings.rate;
      utterance.pitch = settings.pitch;
      utterance.onend = () => {
        if (token === run && index === chunks.length - 1) report("idle");
      };
      utterance.onerror = (event) => {
        if (token !== run || event.error === "interrupted" || event.error === "canceled") return;
        run += 1;
        engine.cancel();
        report("idle", null, `The browser voice failed (${event.error || "unknown error"}).`);
      };
      engine.speak(utterance);
    });
  }

  async function speak(id, markdown) {
    stop();
    const settings = getSettings();
    const chunks = chunkText(speakableText(markdown), settings.engine === "http" ? 300 : 220);
    if (!chunks.length) return;
    const token = run;
    try {
      if (settings.engine === "http") await speakHttp(chunks, id, token, settings);
      else speakBrowser(chunks, id, token, settings);
    } catch (error) {
      if (error?.name === "AbortError" || token !== run) return;
      run += 1;
      releaseAudio();
      report("idle", null, error.message || "Could not read this aloud.");
    }
  }

  function togglePause() {
    if (audio) {
      if (audio.paused) {
        audio.play();
        report("speaking");
      } else {
        audio.pause();
        report("paused");
      }
      return;
    }
    const engine = synth();
    if (!engine) return;
    if (engine.paused) engine.resume();
    else engine.pause();
  }
  return { speak, stop, togglePause };
}
