// Small browser download helpers shared by the app and the message list.
import { createZip } from "./zip.js";

function saveBlob(blob, filename, revokeAfter = 1000) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), revokeAfter);
}

export function downloadArtifact(filename, content) {
  saveBlob(new Blob([content], { type: "text/plain;charset=utf-8" }), filename);
}

export async function downloadZip(files, filename = "aether-files.zip") {
  const blob = await createZip(files.filter((file) => !file.readOnly).map(({ name, content }) => ({ name, content })));
  saveBlob(blob, filename, 2000);
}

/** Save a picture held as a data: URL (used for attached images). */
export function downloadDataUrl(filename, dataUrl) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}
