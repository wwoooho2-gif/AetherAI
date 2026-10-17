import { useEffect, useState } from "react";
import { Square, Volume2, X } from "lucide-react";
import { DEFAULT_BODY_TEMPLATE, HOPPOU_PRESET, isHoppou } from "./lib/tts.js";

// Read-aloud settings. Everything except the API key is saved in this browser; the key lives in memory only.
export default function VoicePanel({ settings, onSettings, apiKey, onApiKey, speech, onTest, onStop, onClose, isStatic }) {
  const [voices, setVoices] = useState([]);
  useEffect(() => {
    const engine = window.speechSynthesis;
    if (!engine) return undefined;
    const load = () => setVoices(engine.getVoices());
    load();
    engine.addEventListener?.("voiceschanged", load);
    return () => engine.removeEventListener?.("voiceschanged", load);
  }, []);

  const set = (patch) => onSettings({ ...settings, ...patch });
  const setHttp = (patch) => onSettings({ ...settings, http: { ...settings.http, ...patch } });
  const hoppou = isHoppou(settings);
  const busy = speech.state !== "idle";
  const hasBrowserVoice = typeof window !== "undefined" && "speechSynthesis" in window;

  return (
    <section className="voice-panel" role="dialog" aria-label="Voice settings">
      <header>
        <strong><Volume2 size={14} /> Voice</strong>
        <button type="button" aria-label="Close voice settings" onClick={onClose}><X size={14} /></button>
      </header>

      <label className="voice-check">
        <input type="checkbox" checked={settings.autoRead} onChange={(event) => set({ autoRead: event.target.checked })} />
        Read every reply aloud automatically
      </label>

      <div className="voice-row">
        <span>Voice engine</span>
        <select
          value={settings.engine === "browser" ? "browser" : hoppou ? "hoppou" : "http"}
          onChange={(event) => {
            const choice = event.target.value;
            if (choice === "browser") set({ engine: "browser" });
            else if (choice === "hoppou") onSettings({ ...settings, engine: "http", http: { ...HOPPOU_PRESET } });
            else set({ engine: "http", http: hoppou ? { ...settings.http, url: "" } : settings.http });
          }}
        >
          <option value="browser">Built-in (this device)</option>
          <option value="hoppou">hoppou.ai</option>
          <option value="http">Other service (any TTS API)</option>
        </select>
      </div>

      {settings.engine === "browser" ? (
        <>
          {!hasBrowserVoice && <p className="voice-warn">This browser has no built-in text-to-speech. Use a custom service instead.</p>}
          <div className="voice-row">
            <span>Voice</span>
            <select value={settings.voiceURI} onChange={(event) => set({ voiceURI: event.target.value })}>
              <option value="">Default</option>
              {voices.map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>
              ))}
            </select>
          </div>
          <div className="voice-row">
            <span>Pitch {settings.pitch.toFixed(1)}</span>
            <input type="range" min="0.5" max="1.5" step="0.1" value={settings.pitch} onChange={(event) => set({ pitch: Number(event.target.value) })} />
          </div>
        </>
      ) : hoppou ? (
        <>
          <div className="voice-row">
            <span>API key</span>
            <input type="password" autoComplete="off" placeholder="Your hoppou.ai key (kept in memory only)" value={apiKey} onChange={(event) => onApiKey(event.target.value)} />
          </div>
          <div className="voice-row">
            <span>Voice</span>
            <input type="text" placeholder="alba" value={settings.http.voice} onChange={(event) => setHttp({ voice: event.target.value })} />
          </div>
          <div className="voice-row">
            <span>Model</span>
            <input type="text" placeholder="tts-1" value={settings.http.model} onChange={(event) => setHttp({ model: event.target.value })} />
          </div>
          <p className="voice-hint">
            Sends your reply text to api.hoppou.ai to be turned into speech. Your key isn’t saved, so enter it again after a refresh.
            {!apiKey && " Add your key, then press Test voice."}
          </p>
        </>
      ) : (
        <>
          <div className="voice-row">
            <span>Service URL</span>
            <input type="url" placeholder="https://… (the text-to-speech endpoint)" value={settings.http.url} onChange={(event) => setHttp({ url: event.target.value })} />
          </div>
          <div className="voice-row">
            <span>API key</span>
            <input type="password" autoComplete="off" placeholder="Kept in memory only, never saved" value={apiKey} onChange={(event) => onApiKey(event.target.value)} />
          </div>
          <div className="voice-row">
            <span>Voice name</span>
            <input type="text" placeholder="voice id / name" value={settings.http.voice} onChange={(event) => setHttp({ voice: event.target.value })} />
          </div>
          <div className="voice-row">
            <span>Model</span>
            <input type="text" placeholder="optional" value={settings.http.model} onChange={(event) => setHttp({ model: event.target.value })} />
          </div>
          <div className="voice-row voice-row-column">
            <span>Request body (JSON; <code>{"{{text}}"}</code> <code>{"{{voice}}"}</code> <code>{"{{model}}"}</code> <code>{"{{speed}}"}</code> are filled in)</span>
            <textarea rows={3} spellCheck={false} value={settings.http.bodyTemplate} onChange={(event) => setHttp({ bodyTemplate: event.target.value })} />
            <button type="button" className="voice-link" onClick={() => setHttp({ bodyTemplate: DEFAULT_BODY_TEMPLATE })}>Reset to OpenAI-style body</button>
          </div>
          <p className="voice-hint">
            {isStatic
              ? "On this hosted site the browser calls the service directly, so it must allow cross-origin requests (CORS)."
              : "The local app calls public https services for you. A TTS server on this computer (http://localhost…) is called directly and must allow CORS."}
          </p>
        </>
      )}

      <div className="voice-row">
        <span>Speed {settings.rate.toFixed(1)}×</span>
        <input type="range" min="0.6" max="1.8" step="0.1" value={settings.rate} onChange={(event) => set({ rate: Number(event.target.value) })} />
      </div>

      {speech.error && <p className="voice-warn" role="alert">{speech.error}</p>}
      <div className="voice-actions">
        {busy ? (
          <button type="button" onClick={onStop}><Square size={13} /> Stop</button>
        ) : (
          <button type="button" onClick={onTest}><Volume2 size={13} /> Test voice</button>
        )}
      </div>
    </section>
  );
}
