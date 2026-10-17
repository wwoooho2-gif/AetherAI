// Dependency-free ZIP reader/writer for the browser (and Node 18+, used by the tests).
// Writing: deflate-raw via CompressionStream when available, otherwise stored (no compression).
// Reading: stored + deflate entries via DecompressionStream.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function pipeBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const canDeflate = () => typeof CompressionStream === "function";
const canInflate = () => typeof DecompressionStream === "function";

export function safeZipPath(name) {
  // No absolute paths, drive letters or ".." segments: they are the classic zip-slip tricks.
  return String(name)
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .replace(/^[a-zA-Z]:/, "");
}

/**
 * @param {{ name: string, content: string | Uint8Array }[]} files
 * @returns {Promise<Blob>}
 */
export async function createZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const seen = new Set();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const file of files) {
    let name = safeZipPath(file.name) || "file.txt";
    if (seen.has(name)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let counter = 2;
      while (seen.has(`${stem}-${counter}${ext}`)) counter += 1;
      name = `${stem}-${counter}${ext}`;
    }
    seen.add(name);
    const raw = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
    const nameBytes = encoder.encode(name);
    const crc = crc32(raw);
    let data = raw;
    let method = 0;
    if (raw.length > 64 && canDeflate()) {
      const packed = await pipeBytes(raw, new CompressionStream("deflate-raw"));
      if (packed.length < raw.length) {
        data = packed;
        method = 8;
      }
    }
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local.buffer, nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, method, true);
    entry.setUint16(12, dosTime, true);
    entry.setUint16(14, dosDate, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry.buffer, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, seen.size, true);
  end.setUint16(10, seen.size, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

/**
 * Read a zip. Returns entries with a lazy `bytes()` so big archives are not inflated up front.
 * @param {Blob|ArrayBuffer|Uint8Array} input
 */
export async function readZipEntries(input) {
  const buffer = input instanceof Uint8Array
    ? input
    : new Uint8Array(input instanceof ArrayBuffer ? input : await input.arrayBuffer());
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This doesn't look like a valid .zip file.");
  const count = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(pointer, true) !== 0x02014b50) throw new Error("The zip directory is damaged.");
    const flags = view.getUint16(pointer + 8, true);
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const size = view.getUint32(pointer + 24, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const rawName = decoder.decode(buffer.subarray(pointer + 46, pointer + 46 + nameLength));
    pointer += 46 + nameLength + extraLength + commentLength;
    const name = safeZipPath(rawName);
    if (!name || rawName.endsWith("/")) continue;
    entries.push({
      name,
      size,
      encrypted: Boolean(flags & 1),
      async bytes() {
        if (flags & 1) throw new Error(`${name} is password-protected.`);
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const slice = buffer.subarray(start, start + compressedSize);
        if (method === 0) return slice;
        if (method === 8) {
          if (!canInflate()) throw new Error("This browser can't unzip compressed files.");
          return pipeBytes(slice, new DecompressionStream("deflate-raw"));
        }
        throw new Error(`${name} uses an unsupported zip compression method (${method}).`);
      },
    });
  }
  return entries;
}
