// Read-only "text view" of binary files (.dll, .exe, .so, .class, .wasm, .pdf, .docx …) so the model can
// reason about them. Small on purpose: header facts + exported/imported names + readable strings.
import { readZipEntries } from "./zip.js";

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);
const hex = (n, w = 0) => `0x${n.toString(16).toUpperCase().padStart(w, "0")}`;

const MACHINES = { 0x14c: "x86", 0x8664: "x64", 0x1c0: "ARM", 0xaa64: "ARM64", 0x1c4: "ARM (Thumb-2)", 0x200: "IA64" };
const SUBSYSTEMS = { 1: "native/driver", 2: "Windows GUI", 3: "Windows console", 9: "Windows CE", 10: "EFI app" };

/** Printable ASCII + UTF-16LE strings, de-duplicated, capped. */
export function extractStrings(bytes, { min = 8, max = 80 } = {}) {
  const seen = new Set();
  const out = [];
  const push = (s) => {
    if (out.length >= max || seen.has(s) || !/[A-Za-z]{4}/.test(s)) return;
    seen.add(s);
    out.push(s.length > 160 ? `${s.slice(0, 160)}…` : s);
  };
  let run = "";
  const limit = Math.min(bytes.length, 4_000_000);
  for (let i = 0; i < limit && out.length < max; i += 1) {
    const b = bytes[i];
    if (b >= 32 && b < 127) run += String.fromCharCode(b);
    else {
      if (run.length >= min) push(run);
      run = "";
    }
  }
  if (run.length >= min) push(run);
  // UTF-16LE (Windows resources, .NET)
  run = "";
  for (let i = 0; i + 1 < limit && out.length < max; i += 2) {
    const b = bytes[i];
    if (b >= 32 && b < 127 && bytes[i + 1] === 0) run += String.fromCharCode(b);
    else {
      if (run.length >= min) push(run);
      run = "";
    }
  }
  return out;
}

const cstr = (bytes, at, cap = 120) => {
  let s = "";
  for (let i = at; i < bytes.length && s.length < cap && bytes[i]; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
};

/** Windows PE (.dll/.exe/.sys): machine, sections, exports, imports, .NET flag. */
export function describePE(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = u32(v, 0x3c);
  if (u32(v, pe) !== 0x4550) return null;
  const machine = u16(v, pe + 4);
  const nSections = u16(v, pe + 6);
  const stamp = u32(v, pe + 8);
  const optSize = u16(v, pe + 20);
  const characteristics = u16(v, pe + 22);
  const opt = pe + 24;
  const plus = u16(v, opt) === 0x20b;
  const dirBase = opt + (plus ? 112 : 96);
  const dir = (i) => ({ rva: u32(v, dirBase + i * 8), size: u32(v, dirBase + i * 8 + 4) });
  const sections = [];
  let table = opt + optSize;
  for (let i = 0; i < nSections; i += 1, table += 40) {
    sections.push({
      name: cstr(bytes, table, 8),
      vaddr: u32(v, table + 12),
      vsize: u32(v, table + 8),
      rawPtr: u32(v, table + 20),
      rawSize: u32(v, table + 16),
    });
  }
  const rva2off = (rva) => {
    const s = sections.find((x) => rva >= x.vaddr && rva < x.vaddr + Math.max(x.vsize, x.rawSize));
    return s ? rva - s.vaddr + s.rawPtr : -1;
  };
  const lines = [
    `Windows PE ${plus ? "PE32+" : "PE32"} ${characteristics & 0x2000 ? "DLL" : "executable"} · ${MACHINES[machine] || hex(machine)} · ${SUBSYSTEMS[u16(v, opt + 68)] || "subsystem " + u16(v, opt + 68)}`,
    `Built: ${stamp ? new Date(stamp * 1000).toISOString().slice(0, 10) : "unknown"} · entry point ${hex(u32(v, opt + 16))} · image base ${plus ? "64-bit" : hex(u32(v, opt + 28))}`,
    `Sections: ${sections.map((s) => `${s.name}(${s.rawSize}B)`).join(" ")}`,
  ];
  if (dir(14).rva) lines.push(".NET assembly (managed code): strings below include type and method names.");

  const exp = dir(0);
  const expOff = exp.rva ? rva2off(exp.rva) : -1;
  if (expOff > 0) {
    const nameCount = u32(v, expOff + 24);
    const namesOff = rva2off(u32(v, expOff + 32));
    const names = [];
    for (let i = 0; i < Math.min(nameCount, 300) && namesOff > 0; i += 1) {
      const at = rva2off(u32(v, namesOff + i * 4));
      if (at > 0) names.push(cstr(bytes, at));
    }
    lines.push(`Exports (${nameCount}): ${names.join(", ")}${nameCount > 300 ? ", …" : ""}`);
  }

  const imp = dir(1);
  let impOff = imp.rva ? rva2off(imp.rva) : -1;
  if (impOff > 0) {
    const imports = [];
    for (let n = 0; n < 80; n += 1, impOff += 20) {
      const nameRva = u32(v, impOff + 12);
      if (!nameRva) break;
      const lib = cstr(bytes, rva2off(nameRva));
      let thunk = rva2off(u32(v, impOff) || u32(v, impOff + 16));
      const funcs = [];
      const step = plus ? 8 : 4;
      for (let k = 0; k < 40 && thunk > 0 && thunk + step <= bytes.length; k += 1, thunk += step) {
        const entry = u32(v, thunk);
        if (!entry || (!plus && entry & 0x80000000)) { if (!entry) break; continue; }
        const at = rva2off(entry);
        if (at > 0) funcs.push(cstr(bytes, at + 2, 60));
      }
      imports.push(`${lib}: ${funcs.join(", ")}`);
    }
    if (imports.length) lines.push(`Imports:\n${imports.join("\n")}`);
  }
  return lines.join("\n");
}

function describeELF(bytes) {
  const types = { 1: "relocatable", 2: "executable", 3: "shared object" };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const machines = { 3: "x86", 62: "x86-64", 40: "ARM", 183: "ARM64", 243: "RISC-V" };
  return `ELF ${bytes[4] === 2 ? "64" : "32"}-bit ${types[u16(v, 16)] || ""} · ${machines[u16(v, 18)] || "machine " + u16(v, 18)}`;
}

function xmlText(xml) {
  return xml
    .replace(/<\/(w:p|a:p|text:p|row|si)>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

const OFFICE = /\.(docx|xlsx|pptx|odt|ods|odp)$/i;
const WANTED = /^(word\/document\.xml|xl\/sharedStrings\.xml|ppt\/slides\/slide\d+\.xml|content\.xml)$/;

async function readOffice(bytes) {
  const parts = [];
  for (const entry of await readZipEntries(bytes)) {
    if (!WANTED.test(entry.name)) continue;
    parts.push(xmlText(new TextDecoder().decode(await entry.bytes())));
  }
  return parts.join("\n\n");
}

/**
 * Describe any non-text file as text. Never throws; falls back to strings.
 * @returns {Promise<string>}
 */
export async function describeBinary(name, bytes) {
  const head = Array.from(bytes.subarray(0, 4));
  const kind = [];
  try {
    if (OFFICE.test(name) && head[0] === 0x50) {
      const text = await readOffice(bytes);
      if (text) return `Document text extracted from ${name}:\n${text}`;
    }
    if (head[0] === 0x4d && head[1] === 0x5a) {
      const info = describePE(bytes);
      if (info) kind.push(info);
    } else if (head[0] === 0x7f && head[1] === 0x45) kind.push(describeELF(bytes));
    else if (head[0] === 0xca && head[1] === 0xfe && head[2] === 0xba && head[3] === 0xbe) kind.push("Java .class file or Mach-O universal binary");
    else if (head[0] === 0 && head[1] === 0x61 && head[2] === 0x73) kind.push("WebAssembly module");
    else if (head[0] === 0x25 && head[1] === 0x50) kind.push("PDF (only uncompressed text is readable here)");
  } catch (error) {
    kind.push(`Header could not be fully parsed (${error.message || "damaged file"}).`);
  }
  const strings = extractStrings(bytes);
  const first = Array.from(bytes.subarray(0, 32)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return [
    `Binary file, ${bytes.length} bytes. Read-only analysis (cannot be edited). First bytes: ${first}`,
    ...kind,
    strings.length ? `Readable strings:\n${strings.join("\n")}` : "No readable strings found.",
  ].join("\n");
}
