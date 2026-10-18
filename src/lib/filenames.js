// Pick a sensible filename for a code block the model didn't label.
// Order: a name mentioned right before the block, a name in the block's first comment line,
// then a name that fits what the code is (index.html, main.py, Foo.java, package.json…).

const EXT = {
  javascript: "js", js: "js", jsx: "jsx", typescript: "ts", ts: "ts", tsx: "tsx", html: "html", css: "css", scss: "scss",
  python: "py", py: "py", java: "java", c: "c", cpp: "cpp", "c++": "cpp", csharp: "cs", cs: "cs", go: "go", golang: "go",
  rust: "rs", rs: "rs", ruby: "rb", rb: "rb", php: "php", swift: "swift", kotlin: "kt", lua: "lua", r: "r", dart: "dart",
  bash: "sh", sh: "sh", shell: "sh", zsh: "sh", powershell: "ps1", sql: "sql", json: "json", yaml: "yml", yml: "yml",
  toml: "toml", xml: "xml", svg: "svg", markdown: "md", md: "md", text: "txt", txt: "txt", diff: "diff", edit: "diff",
  vue: "vue", svelte: "svelte", gdscript: "gd", glsl: "glsl", ini: "ini", csv: "csv",
};
const KNOWN_EXT = new Set([...Object.values(EXT), "yaml", "htm", "mjs", "cjs", "env", "cfg", "conf", "lock", "gradle", "bat", "kts", "h", "hpp", "tf", "proto"]);

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const snake = (text) => String(text).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
const pascalName = (text) => /^[A-Z][A-Za-z0-9_]*$/.test(text || "");

const FAMILY = [["js", "mjs", "cjs", "jsx"], ["ts", "tsx"], ["yml", "yaml"], ["html", "htm"], ["c", "h"], ["cpp", "hpp", "h"]];
/** A name found in nearby text only counts if its extension fits the block's language. */
function fits(name, language) {
  const want = EXT[String(language).toLowerCase()];
  if (!want || want === "txt") return true; // unknown language: trust the name
  const got = name.split(".").pop().toLowerCase();
  return got === want || FAMILY.some((group) => group.includes(got) && group.includes(want));
}

function mentionedName(before) {
  const tail = String(before || "").replace(/(?:https?:\/\/|www\.)\S+/gi, " ").slice(-240);
  const found = [...tail.matchAll(/([A-Za-z0-9_][A-Za-z0-9_./-]*\.([A-Za-z0-9]{1,6}))(?![A-Za-z0-9])/g)]
    .filter((match) => KNOWN_EXT.has(match[2].toLowerCase()) && !/^\d/.test(match[1]) && !/^https?/i.test(match[1]));
  return found.length ? found[found.length - 1][1] : "";
}

function commentName(content) {
  const first = String(content).split("\n", 3).find((line) => line.trim()) || "";
  const match = first.match(/^\s*(?:\/\/|#|--|\/\*|<!--)\s*(?:file(?:name)?\s*[:=]\s*)?([A-Za-z0-9_][A-Za-z0-9_./-]*\.([A-Za-z0-9]{1,6}))\s*(?:\*\/|-->)?\s*$/i);
  return match && KNOWN_EXT.has(match[2].toLowerCase()) ? match[1] : "";
}

function nameFromCode(language, content, ext) {
  const lang = String(language || "").toLowerCase();
  const code = String(content);
  const firstLine = code.trimStart().split("\n", 1)[0] || "";
  switch (lang) {
    case "html": {
      const title = code.match(/<title>\s*([^<]{2,60}?)\s*<\/title>/i)?.[1];
      return { base: "index", alt: title ? slug(title) : "page", ext: "html" };
    }
    case "css": case "scss": return { base: "styles", alt: "extra-styles", ext };
    case "javascript": case "js": case "typescript": case "ts": {
      const hasModuleHint = /\bexpress\(|require\(["']http|createServer|app\.listen/.test(code);
      return { base: hasModuleHint ? "server" : lang.startsWith("t") ? "index" : "script", alt: "module", ext };
    }
    case "jsx": case "tsx": case "vue": case "svelte": {
      const component = code.match(/export\s+default\s+function\s+([A-Z]\w*)/)?.[1] || code.match(/(?:function|const|class)\s+([A-Z]\w*)\s*(?:=|\(|extends)/)?.[1];
      return { base: component || "App", alt: "Component", ext };
    }
    case "python": case "py": {
      if (/if\s+__name__\s*==/.test(code)) return { base: "main", alt: "script", ext };
      const cls = code.match(/^class\s+([A-Za-z_]\w*)/m)?.[1];
      return { base: cls ? snake(cls) : "main", alt: "script", ext };
    }
    case "java": case "kotlin": case "csharp": case "cs": case "swift": case "dart": {
      const cls = code.match(/(?:public\s+)?(?:final\s+|abstract\s+|static\s+)*(?:class|interface|enum|record|struct|object)\s+([A-Za-z_]\w*)/)?.[1];
      return { base: pascalName(cls) ? cls : "Main", alt: "Helper", ext };
    }
    case "go": case "golang": return { base: "main", alt: "util", ext };
    case "rust": case "rs": return { base: "main", alt: "lib", ext };
    case "c": case "cpp": case "c++": return { base: /\bint\s+main\s*\(/.test(code) ? "main" : "util", alt: "util", ext };
    case "bash": case "sh": case "shell": case "zsh":
      return { base: firstLine.startsWith("#!") ? "script" : "commands", alt: "script", ext };
    case "sql": return { base: /\bcreate\s+table\b/i.test(code) ? "schema" : "query", alt: "query", ext };
    case "json": {
      if (/"(?:dependencies|devDependencies|scripts)"\s*:/.test(code) && /"name"\s*:/.test(code)) return { base: "package", alt: "data", ext };
      if (/"compilerOptions"/.test(code)) return { base: "tsconfig", alt: "data", ext };
      return { base: "data", alt: "config", ext };
    }
    case "yaml": case "yml": return { base: /\bservices\s*:/.test(code) ? "docker-compose" : /\bon\s*:[\s\S]*\bjobs\s*:/.test(code) ? "workflow" : "config", alt: "settings", ext };
    case "toml": return { base: /\[package\]/.test(code) ? "Cargo" : /\[project\]|\[tool\./.test(code) ? "pyproject" : "config", alt: "settings", ext };
    case "markdown": case "md": return { base: "README", alt: "notes", ext };
    case "svg": return { base: "image", alt: "icon", ext };
    case "xml": return { base: "data", alt: "config", ext };
    case "diff": case "edit": return { base: "changes", alt: "changes-2", ext };
    case "dockerfile": return { base: "Dockerfile", alt: "Dockerfile.dev", ext: "" };
    case "makefile": return { base: "Makefile", alt: "Makefile.extra", ext: "" };
    case "powershell": return { base: "script", alt: "tools", ext };
    default: return { base: lang && /^[a-z0-9+#-]{1,12}$/.test(lang) && lang !== "text" ? slug(lang) || "snippet" : "notes", alt: "snippet", ext };
  }
}

/** Make `name` unique within `used` (case-insensitive) by adding -2, -3… before the extension. */
function unique(name, used) {
  if (!used.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const [stem, tail] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${tail}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * @param {{ language?: string, content: string, before?: string, used?: Set<string> }} input
 * @returns {string} a filename; the caller adds it to `used`
 */
export function inferFilename({ language = "", content, before = "", used = new Set() }) {
  const ext = EXT[String(language).toLowerCase()] || (/^[a-z0-9]{1,5}$/i.test(language) ? String(language).toLowerCase() : "txt");
  const candidates = [mentionedName(before), commentName(content)];
  const named = candidates.find((name) => name && fits(name, language)) || "";
  if (named) return unique(named.replace(/^\.?\//, ""), used);
  const { base, alt, ext: finalExt = ext } = nameFromCode(language, content, ext);
  const dotExt = finalExt ? `.${finalExt}` : "";
  let name = `${base}${dotExt}`;
  // a second page/module in the same reply gets its own descriptive name instead of "index-2.html"
  if (used.has(name.toLowerCase()) && alt && alt !== base) name = `${alt}${dotExt}`;
  return unique(name, used);
}
