import { ExternalLink, Heart, Mic, Sparkles } from "lucide-react";

const HOPPOU_URL = "https://hoppou.ai";

const OPEN_SOURCE = [
  { name: "llama.cpp", note: "The engine that runs GGUF models", url: "https://github.com/ggml-org/llama.cpp" },
  { name: "wllama", note: "llama.cpp compiled to WebAssembly", url: "https://github.com/ngxson/wllama" },
  { name: "Hugging Face", note: "Where the starter models live", url: "https://huggingface.co" },
  { name: "React", note: "The interface", url: "https://react.dev" },
  { name: "Vite", note: "Build tooling", url: "https://vite.dev" },
  { name: "Lucide", note: "Icons", url: "https://lucide.dev" },
  { name: "Wikimedia Commons", note: "Photo search", url: "https://commons.wikimedia.org" },
  { name: "Pollinations", note: "Free image generation", url: "https://pollinations.ai" },
];

export default function CreditsPanel() {
  return (
    <div className="fine-tune-scroll credits-scroll">
      <div className="fine-tune-content credits-content">
        <header className="fine-tune-heading">
          <div className="fine-tune-eyebrow"><Heart size={11} /> CREDITS</div>
          <h1>Made with <em>great tools</em></h1>
          <p>Aether is a small project that stands on the shoulders of some excellent people and services.</p>
        </header>

        <a className="credits-hero" href={HOPPOU_URL} target="_blank" rel="noopener noreferrer">
          <span className="credits-hero-icon"><Mic size={22} /></span>
          <span className="credits-hero-copy">
            <span className="credits-hero-tag"><Sparkles size={11} /> Featured partner</span>
            <strong>hoppou.ai</strong>
            <span>Natural text-to-speech voices. Aether can read every reply aloud through the hoppou.ai API. Choose it in Voice settings.</span>
          </span>
          <span className="credits-hero-cta">Visit hoppou.ai <ExternalLink size={13} /></span>
        </a>

        <h2 className="credits-subhead">Built with</h2>
        <ul className="credits-grid">
          {OPEN_SOURCE.map((item) => (
            <li key={item.name}>
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                <strong>{item.name}</strong>
                <span>{item.note}</span>
              </a>
            </li>
          ))}
        </ul>

        <p className="credits-foot">AetherAI runs models on your own device. Chats and models stay in your browser.</p>
      </div>
    </div>
  );
}
