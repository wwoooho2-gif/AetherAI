import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Download, FileUp, HardDrive, LoaderCircle, Trash2, X } from "lucide-react";
import {
  browserLoaderSupported,
  cancelModelDownload,
  deleteSavedModel,
  getLoaderState,
  listSavedModels,
  loadBrowserModel,
  loadBrowserModelFromUrl,
  loadSavedModel,
  subscribeLoader,
  IS_MOBILE,
} from "./staticBackend.js";
import { modelsFor } from "./lib/models.js";

const formatSize = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/**
 * The integrated GGUF loader: drop a file, paste a link, or reopen a model saved on this device.
 * `compact` hides the starter list and shortens the copy (used above the message box).
 */
export default function ModelLoader({ compact = false, onLoaded }) {
  const state = useSyncExternalStore(subscribeLoader, getLoaderState);
  const [dragging, setDragging] = useState(false);
  const [link, setLink] = useState("");
  const [saved, setSaved] = useState([]);
  const [localError, setLocalError] = useState("");
  const inputRef = useRef(null);
  const busy = state.phase === "loading" || state.phase === "downloading";

  async function refreshSaved() {
    try { setSaved(await listSavedModels()); } catch { setSaved([]); }
  }
  useEffect(() => { refreshSaved(); }, [state.phase, state.saving, state.model?.name]);

  async function run(task) {
    setLocalError("");
    try {
      const model = await task();
      onLoaded?.(model);
    } catch (error) {
      setLocalError(error?.message || String(error));
    }
  }

  function takeFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!files.some((file) => /\.gguf$/i.test(file.name))) {
      setLocalError("That isn't a .gguf file. Choose a model file ending in .gguf.");
      return;
    }
    run(() => loadBrowserModel(files));
  }

  function submitLink(event, explicitUrl) {
    event?.preventDefault();
    const url = explicitUrl || link;
    if (!url.trim() || busy) return;
    run(() => loadBrowserModelFromUrl(url));
  }

  if (!browserLoaderSupported()) {
    return (
      <section className="model-loader model-loader-unsupported" role="alert">
        This browser can't run models locally (WebAssembly or Web Workers are missing). Try a recent Chrome, Edge, Firefox or Safari.
      </section>
    );
  }

  const error = localError || (state.phase === "error" ? state.error : "");

  return (
    <section className={`model-loader ${compact ? "model-loader-compact" : ""}`} aria-label="Load a GGUF model">
      <header className="model-loader-head">
        <strong>{state.model ? "Switch model" : "Load a model to start chatting"}</strong>
        <span>Runs in your browser. Your files are never uploaded.</span>
      </header>

      <div
        className={`model-drop ${dragging ? "model-drop-active" : ""} ${busy ? "model-drop-busy" : ""}`}
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-disabled={busy}
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && !busy) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!busy) takeFiles(event.dataTransfer.files);
        }}
      >
        <FileUp size={20} />
        <span>
          <b>Drop a .gguf file here</b> or click to choose one
        </span>
        <small>Split models: select every part at once</small>
        <input
          ref={inputRef}
          type="file"
          accept=".gguf"
          multiple
          hidden
          onChange={(event) => {
            takeFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      <form className="model-link-row" onSubmit={submitLink}>
        <input
          type="url"
          inputMode="url"
          value={link}
          disabled={busy}
          placeholder="…or paste a link to a .gguf (Hugging Face works)"
          aria-label="Link to a GGUF file"
          onChange={(event) => setLink(event.target.value)}
        />
        <button type="submit" disabled={busy || !link.trim()}>
          <Download size={13} /> Download
        </button>
      </form>

      {busy && (
        <div className="model-progress" role="status">
          <div className="model-progress-line">
            <LoaderCircle className="fine-tune-spinner" size={13} />
            <span>{state.message}</span>
            {state.phase === "downloading" && (
              <button type="button" className="model-progress-cancel" onClick={cancelModelDownload} aria-label="Cancel download">
                <X size={12} />
              </button>
            )}
          </div>
          <div className={`model-progress-bar ${state.percent == null ? "model-progress-indeterminate" : ""}`}>
            <i style={state.percent == null ? undefined : { width: `${state.percent}%` }} />
          </div>
        </div>
      )}

      {!busy && state.phase === "ready" && state.message && !error && (
        <div className="model-loader-note" role="status">{state.message}{state.saving ? " Saving a copy on this device…" : ""}</div>
      )}
      {error && <div className="model-loader-error" role="alert">{error}</div>}

      {saved.length > 0 && (
        <div className="model-saved">
          <span className="model-saved-title"><HardDrive size={12} /> Saved on this device</span>
          {saved.map((item) => (
            <div className="model-saved-row" key={item.name}>
              <button type="button" disabled={busy} onClick={() => run(() => loadSavedModel(item.name))}>
                <span>{item.name.replace(/\.gguf$/i, "")}</span>
                <em>{formatSize(item.size)}{state.model?.name === item.name ? " · loaded" : ""}</em>
              </button>
              <button
                type="button"
                className="model-saved-delete"
                disabled={busy}
                aria-label={`Delete ${item.name} from this device`}
                title="Delete from this device"
                onClick={async () => { await deleteSavedModel(item.name); refreshSaved(); }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="model-big-note">
        Bigger models (several GB) and faster speeds are only offered and only work if you download the project and run it on your own computer. This website runs models inside your browser, so it is limited to small ones{IS_MOBILE ? ", especially on a phone" : ""}.
      </p>

      {!compact && (
        <div className="model-starters">
          <span className="model-saved-title">No model yet? Tap one to download it</span>
          <div className="model-starter-row">
            {modelsFor(true).filter((model) => !IS_MOBILE || model.phone).map((model) => (
              <button
                key={model.url}
                type="button"
                disabled={busy}
                onClick={(event) => { setLink(model.url); submitLink(event, model.url); }}
              >
                <b>{model.label}</b>
                <small>{model.group} · {formatSize(model.mb * 1e6)}{model.phone ? " · phone" : ""}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
