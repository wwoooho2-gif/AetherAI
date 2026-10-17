// Chats saved in this browser (IndexedDB). Nothing leaves the device.
// Two stores: "meta" (id, title, time: small, used for the sidebar list) and "chats" (the full conversation
// including messages, edited project files, photos and feedback). API keys are never part of a chat.
const DB_NAME = "aether-chats";
const MAX_CHATS = 100;

let dbPromise;
export const storageAvailable = () => typeof indexedDB !== "undefined";

function openDb() {
  if (!storageAvailable()) return Promise.reject(new Error("This browser doesn’t allow saving chats (private mode?)."));
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("meta", { keyPath: "id" });
      request.result.createObjectStore("chats", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = undefined;
      reject(request.error || new Error("Could not open browser storage."));
    };
  });
  return dbPromise;
}

const done = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error || new Error("Browser storage failed."));
  transaction.onabort = () => reject(transaction.error || new Error("Browser storage is full or blocked."));
});
const asPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export function chatTitle(messages) {
  const first = messages.find((message) => message.role === "user");
  const text = String(first?.requestContent || first?.content || "").replace(/\s+/g, " ").trim();
  return (text || "New chat").slice(0, 48);
}

/** Only the newest reply needs its "files before this reply" snapshot (for Regenerate); drop the rest to save space. */
export function slimMessages(messages) {
  const last = messages.length - 1;
  return messages.map((message, index) => {
    if (index === last || !message.attachmentsBefore) return message;
    const { attachmentsBefore: _dropped, ...rest } = message;
    return rest;
  });
}

/** @returns {Promise<{id:string,title:string,updatedAt:number}[]>} newest first */
export async function listChats() {
  const db = await openDb();
  const rows = await asPromise(db.transaction("meta").objectStore("meta").getAll());
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadChat(id) {
  const db = await openDb();
  return (await asPromise(db.transaction("chats").objectStore("chats").get(id))) || null;
}

export async function saveChat({ id, messages, attachments, feedback }) {
  const db = await openDb();
  const updatedAt = Date.now();
  const title = chatTitle(messages);
  const transaction = db.transaction(["meta", "chats"], "readwrite");
  transaction.objectStore("meta").put({ id, title, updatedAt, count: messages.length });
  transaction.objectStore("chats").put({ id, title, updatedAt, messages: slimMessages(messages), attachments, feedback });
  await done(transaction);
  await pruneChats(db);
  return { id, title, updatedAt, count: messages.length };
}

async function pruneChats(db) {
  const rows = (await asPromise(db.transaction("meta").objectStore("meta").getAll())).sort((a, b) => b.updatedAt - a.updatedAt);
  if (rows.length <= MAX_CHATS) return;
  const transaction = db.transaction(["meta", "chats"], "readwrite");
  rows.slice(MAX_CHATS).forEach(({ id }) => {
    transaction.objectStore("meta").delete(id);
    transaction.objectStore("chats").delete(id);
  });
  await done(transaction);
}

export async function deleteChat(id) {
  const db = await openDb();
  const transaction = db.transaction(["meta", "chats"], "readwrite");
  transaction.objectStore("meta").delete(id);
  transaction.objectStore("chats").delete(id);
  await done(transaction);
}

export async function clearChats() {
  const db = await openDb();
  const transaction = db.transaction(["meta", "chats"], "readwrite");
  transaction.objectStore("meta").clear();
  transaction.objectStore("chats").clear();
  await done(transaction);
}

/** Ask the browser not to evict our data when disk space is low. Harmless if refused. */
export function requestDurableStorage() {
  return navigator.storage?.persist?.().catch(() => false);
}
