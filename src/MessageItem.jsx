// One chat message. Wrapped in React.memo so typing in the composer (or a new reply) doesn't re-render
// every earlier message. Long replies are shown short first, with "Show more".
import { memo, useState } from "react";
import { Check, ChevronDown, Copy, Download, Ellipsis, ExternalLink, Eye, FileArchive, FileText, RotateCw, Sparkles, Square, ThumbsDown, ThumbsUp, Volume2 } from "lucide-react";
import { renderRich } from "./lib/markdown.jsx";
import { downloadArtifact, downloadZip } from "./lib/download.js";

const PROSE_LIMIT = 800; // longer than this starts collapsed
const PROSE_SHOWN = 560; // how much is visible while collapsed
const CODE_LIMIT = 16; // code blocks longer than this (lines) start collapsed
const CODE_SHOWN = 12;

/** Cut text at a paragraph or word boundary near `limit`. */
function clipText(text, limit) {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const breakAt = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("\n"), head.lastIndexOf(". "), head.lastIndexOf(" "));
  return `${(breakAt > limit * 0.5 ? head.slice(0, breakAt + 1) : head).trimEnd()}…`;
}

function ArtifactCard({ segment, segments, message, act }) {
  const [open, setOpen] = useState(false);
  const isEdit = segment.language.toLowerCase() === "edit";
  const lines = segment.content.split("\n");
  const long = lines.length > CODE_LIMIT;
  const shown = long && !open ? lines.slice(0, CODE_SHOWN).join("\n") : segment.content;
  const result = isEdit ? message.edits?.find((edit) => edit.name === segment.path || edit.name.endsWith(`/${segment.path}`)) : null;
  const edited = result ? message.editedFiles?.find((file) => file.name === result.name) : null;
  return (
    <section className="artifact-card">
      <header className="artifact-header">
        <div className="artifact-file">
          <FileText size={14} />
          <strong>{segment.filename}</strong>
          <span>{segment.language}</span>
        </div>
        <div className="artifact-actions">
          {isEdit ? (
            <>
              {result && (
                <span className={result.failed.length ? "edit-status edit-status-warn" : "edit-status"}>
                  {result.applied}/{result.total} applied
                </span>
              )}
              {edited && (
                <button aria-label={`Download edited ${edited.name}`} onClick={() => downloadArtifact(edited.name.split("/").pop(), edited.content)}>
                  <Download size={14} />
                  <span>Edited file</span>
                </button>
              )}
            </>
          ) : (
            <>
              <button aria-label={`Preview ${segment.filename}`} onClick={() => act.preview({ ...segment, artifacts: segments.filter((candidate) => candidate.type === "artifact") })}>
                <Eye size={14} />
                <span>Preview</span>
              </button>
              <button aria-label={`Download ${segment.filename}`} onClick={() => downloadArtifact(segment.filename, segment.content)}>
                <Download size={14} />
                <span>Download</span>
              </button>
            </>
          )}
        </div>
      </header>
      <pre className="artifact-code"><code>{shown}</code></pre>
      {long && (
        <button type="button" className="show-more show-more-code" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <ChevronDown size={13} className={open ? "flip" : ""} />
          <span>{open ? "Show less" : `Show all ${lines.length} lines`}</span>
        </button>
      )}
    </section>
  );
}

function MessageItem({ message, segments, index, isLast, busy, speechState, copied, feedback, menuOpen, act }) {
  const [expanded, setExpanded] = useState(false);
  const isAssistant = message.role === "assistant";

  const proseLength = isAssistant
    ? segments.reduce((sum, segment) => sum + (segment.type === "text" ? segment.content.trim().length : 0), 0)
    : message.content.length;
  const collapsible = proseLength > PROSE_LIMIT;
  const collapsed = collapsible && !expanded;

  // While collapsed, show prose up to PROSE_SHOWN characters; code cards stay available.
  let budget = collapsed ? PROSE_SHOWN : Infinity;
  const proseFor = (text) => {
    if (budget <= 0) return "";
    const clipped = collapsed ? clipText(text, budget) : text;
    budget -= text.length;
    return clipped;
  };

  const reading = speechState !== null;
  const hasFiles = isAssistant && (segments.some((segment) => segment.type === "artifact") || message.editedFiles?.length > 0);

  return (
    <article className={`message message-${message.role}`}>
      {isAssistant ? <div className="message-avatar"><Sparkles size={15} /></div> : <div className="avatar user-avatar">A</div>}
      <div className="message-body">
        <div className="message-meta">
          <strong>{isAssistant ? message.modelName || "Aether" : "You"}</strong>
          <span>{message.time}</span>
        </div>
        {isAssistant
          ? segments.map((segment, segmentIndex) => {
              if (segment.type === "text") {
                const text = segment.content.trim() ? proseFor(segment.content) : "";
                return text.trim() ? <p key={`text-${segmentIndex}`}>{renderRich(text)}</p> : null;
              }
              return <ArtifactCard key={`artifact-${segmentIndex}`} segment={segment} segments={segments} message={message} act={act} />;
            })
          : <p>{renderRich(proseFor(message.content))}</p>}
        {!isAssistant && message.images?.length > 0 && (
          <div className="message-images">
            {message.images.map((image) => (
              <button
                type="button"
                key={image.name}
                className="message-image"
                title={image.name}
                aria-label={`View ${image.name}`}
                onClick={() => act.preview({ type: "image", filename: image.name.split("/").pop(), path: image.name, image: image.dataUrl, content: "" })}
              >
                <img src={image.dataUrl} alt={image.name} />
                <span>{image.name}</span>
              </button>
            ))}
          </div>
        )}
        {collapsible && (
          <button type="button" className="show-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            <ChevronDown size={13} className={expanded ? "flip" : ""} />
            <span>{expanded ? "Show less" : "Show more"}</span>
          </button>
        )}
        {message.edits?.some((edit) => edit.failed.length > 0) && (
          <div className="edit-problems" role="note">
            {message.edits.filter((edit) => edit.failed.length > 0).map((edit) => (
              <p key={edit.name}><strong>{edit.name}:</strong> {edit.failed.join(" · ")} Ask me to retry that change.</p>
            ))}
          </div>
        )}
        {message.images?.length > 0 && (
          <div className="message-images">
            {message.images.map((image) => (
              <figure key={image.url}>
                <img src={image.url} alt={image.alt} loading="lazy" referrerPolicy="no-referrer" />
                <figcaption>
                  {image.alt}
                  {image.license ? ` · ${image.license}` : ""}
                  {/^https:/.test(image.credit || "") && <> · <a href={image.credit} target="_blank" rel="noopener noreferrer nofollow">source <ExternalLink size={10} /></a></>}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
        {message.sources?.length > 0 && (
          <div className="message-sources">
            <span>Sources</span>
            {message.sources.slice(0, 6).map((source, sourceIndex) => (
              <a key={`${source.url}-${sourceIndex}`} href={source.url} target="_blank" rel="noopener noreferrer nofollow" title={source.title}>
                {source.source}: {source.title}
              </a>
            ))}
          </div>
        )}
        {message.notes?.length > 0 && <p className="message-notes">{message.notes.join(" · ")}</p>}
        {isAssistant && (
          <div className="message-actions">
            <button
              type="button"
              aria-label={reading ? "Stop reading aloud" : "Read aloud"}
              title={reading ? "Stop reading" : "Read this reply out loud"}
              className={`listen-button${reading ? " is-selected" : ""}`}
              onClick={() => (reading ? act.stop() : act.speak(index, message.content))}
            >
              {reading ? <Square size={13} /> : <Volume2 size={14} />}
              <span>{reading ? (speechState === "loading" ? "Loading… stop" : "Stop") : "Listen"}</span>
            </button>
            <button type="button" aria-label={copied ? "Response copied" : "Copy response"} title={copied ? "Copied" : "Copy response"} onClick={() => act.copy(message.content, index)}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            <button type="button" aria-label="Good response" aria-pressed={feedback === "up"} title="Good response" className={feedback === "up" ? "is-selected" : ""} onClick={() => act.rate(index, "up")}>
              <ThumbsUp size={14} />
            </button>
            <button type="button" aria-label="Bad response" aria-pressed={feedback === "down"} title="Bad response" className={feedback === "down" ? "is-selected" : ""} onClick={() => act.rate(index, "down")}>
              <ThumbsDown size={14} />
            </button>
            {hasFiles && (
              <button
                type="button"
                aria-label="Download all files in this reply as a zip"
                title="Download all files in this reply as .zip"
                onClick={() => {
                  const files = new Map();
                  segments
                    .filter((segment) => segment.type === "artifact" && segment.language.toLowerCase() !== "edit")
                    .forEach((segment) => files.set(segment.path, { name: segment.path, content: segment.content }));
                  (message.editedFiles || []).forEach((file) => files.set(file.name, file));
                  downloadZip([...files.values()], "aether-reply.zip");
                }}
              >
                <FileArchive size={14} />
              </button>
            )}
            <div className="message-more" onKeyDown={(event) => { if (event.key === "Escape") act.closeMenu(); }}>
              <button type="button" aria-label="More response options" aria-expanded={menuOpen} aria-controls={`message-menu-${index}`} title="More options" onClick={() => act.toggleMenu(index)}>
                <Ellipsis size={15} />
              </button>
              {menuOpen && (
                <div className="message-menu" id={`message-menu-${index}`} role="group" aria-label="Response options">
                  <button type="button" onClick={() => act.copy(message.content, index)}>
                    <Copy size={13} />
                    <span>Copy response</span>
                  </button>
                  {isLast && (
                    <button type="button" disabled={busy} onClick={() => act.regenerate(index)}>
                      <RotateCw size={13} />
                      <span>Regenerate response</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

/** The marker left behind by /compact: one slim line, summary on demand. */
export const SummaryNote = memo(function SummaryNote({ message }) {
  return (
    <details className="compact-note">
      <summary>
        <span>Earlier conversation compacted</span>
        <em>{message.summarizes ? `${message.summarizes} messages → short summary` : "short summary"}</em>
      </summary>
      <p>{renderRich(message.content)}</p>
    </details>
  );
});

export default memo(MessageItem);
