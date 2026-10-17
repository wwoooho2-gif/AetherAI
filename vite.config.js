import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, lstatSync, statSync, unlinkSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const homeDir = os.homedir();
const modelDirectory = path.join(homeDir, "Models", "Aether");
const ggufEditorScript = path.join(projectRoot, "scripts", "gguf-editor.py");
const ggufEditEnvironment = path.join(homeDir, ".local", "share", "aether-gguf-editor-venv", "bin", "python");
const trainingScript = path.join(projectRoot, "scripts", "train-model.py");
const trainingSetupScript = path.join(projectRoot, "scripts", "setup-finetuning.sh");
const trainingEnvironment = path.join(homeDir, ".local", "share", "aether-finetuning-venv", "bin", "python");
const huggingFaceTokenPath = path.join(homeDir, ".config", "aether", "hf-token");
const modelStabilityMs = 60_000;
let ggufJob;
let ggufReadiness;
let trainingJob;
let trainingReadiness;
let trainingSetupJob;

function ggufPython() {
  if (process.env.AETHER_GGUF_PYTHON) return process.env.AETHER_GGUF_PYTHON;
  return existsSync(ggufEditEnvironment) ? ggufEditEnvironment : "python3";
}

function trainingPython() {
  if (process.env.AETHER_TRAINING_PYTHON) return process.env.AETHER_TRAINING_PYTHON;
  return existsSync(trainingEnvironment) ? trainingEnvironment : "python3";
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function isLocalSameOrigin(request) {
  const remoteAddress = request.socket.remoteAddress || "";
  const isLoopback =
    remoteAddress === "::1" ||
    remoteAddress === "127.0.0.1" ||
    remoteAddress.startsWith("::ffff:127.");
  if (!request.headers.origin) return isLoopback && request.method === "GET";
  let origin;
  try {
    origin = new URL(request.headers.origin || "");
  } catch {
    return false;
  }
  return isLoopback &&
    origin.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) &&
    origin.host === request.headers.host;
}

function readJsonBody(request, response, callback) {
  let body = "";
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > 5_000_000) {
      sendJson(response, 413, { error: "The edit request must be smaller than 5 MB." });
      request.destroy();
      return;
    }
    body += chunk;
  });
  request.on("end", () => {
    if (response.writableEnded) return;
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      sendJson(response, 400, { error: "The request must contain valid JSON." });
      return;
    }
    Promise.resolve(callback(payload)).catch((error) => {
      console.error("Could not process the GGUF request:", error);
      if (!response.writableEnded) {
        sendJson(response, 500, { error: error.message || "Could not process the GGUF request." });
      }
    });
  });
  request.on("error", (error) => {
    console.error("Could not read the GGUF edit request:", error);
    if (!response.writableEnded) sendJson(response, 400, { error: "Could not read the request body." });
  });
}

function appendGgufOutput(stream, chunk) {
  stream.pending += chunk.toString();
  const lines = stream.pending.split(/\r?\n/);
  stream.pending = lines.pop() || "";
  ggufJob.logs.push(...lines.filter(Boolean));
  if (ggufJob.logs.length > 300) ggufJob.logs.splice(0, ggufJob.logs.length - 300);
}

function checkGgufEnvironment(force = false) {
  if (ggufReadiness && !force) return ggufReadiness;
  ggufReadiness = new Promise((resolve) => {
    execFile(
      ggufPython(),
      [ggufEditorScript, "check"],
      { timeout: 30_000, maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        resolve({
          ready: !error,
          python: ggufPython(),
          message: error
            ? (stderr.trim() || stdout.trim() || error.message || "GGUF editing dependencies are not installed.")
            : stdout.trim(),
        });
      },
    );
  });
  return ggufReadiness;
}

function appendTrainingOutput(stream, chunk) {
  stream.pending += chunk.toString();
  const lines = stream.pending.split(/\r?\n/);
  stream.pending = lines.pop() || "";
  trainingJob.logs.push(...lines.filter(Boolean));
  if (trainingJob.logs.length > 300) trainingJob.logs.splice(0, trainingJob.logs.length - 300);
}

function appendTrainingSetupOutput(stream, chunk) {
  stream.pending += chunk.toString();
  const lines = stream.pending.split(/\r?\n/);
  stream.pending = lines.pop() || "";
  trainingSetupJob.logs.push(...lines.filter(Boolean));
  if (trainingSetupJob.logs.length > 100) {
    trainingSetupJob.logs.splice(0, trainingSetupJob.logs.length - 100);
  }
}

function checkTrainingEnvironment(force = false) {
  if (trainingReadiness && !force) return trainingReadiness;
  trainingReadiness = new Promise((resolve) => {
    execFile(
      trainingPython(),
      [trainingScript, "check"],
      { cwd: projectRoot, timeout: 30_000, maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        resolve({
          ready: !error,
          python: trainingPython(),
          message: error
            ? (stderr.trim() || stdout.trim() || error.message || "The local training environment is not ready.")
            : stdout.trim(),
        });
      },
    );
  });
  return trainingReadiness;
}

function readTrainingBody(request, response, callback) {
  let body = "";
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > 5_000_000) {
      sendJson(response, 413, { error: "The training request must be smaller than 5 MB." });
      request.destroy();
      return;
    }
    body += chunk;
  });
  request.on("end", () => {
    if (response.writableEnded) return;
    try {
      Promise.resolve(callback(JSON.parse(body))).catch((error) => {
        console.error("Could not process the fine-tuning request:", error);
        if (!response.writableEnded) {
          sendJson(response, 500, { error: error.message || "Could not process the training request." });
        }
      });
    } catch (error) {
      if (error instanceof SyntaxError) {
        sendJson(response, 400, { error: "The training request must contain valid JSON." });
      } else {
        console.error("Could not process the fine-tuning request:", error);
        sendJson(response, 400, { error: error.message || "Could not process the training request." });
      }
    }
  });
  request.on("error", (error) => {
    console.error("Could not read the fine-tuning request:", error);
    if (!response.writableEnded) sendJson(response, 400, { error: "Could not read the training request body." });
  });
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  return normalized === "::" || normalized === "::1" ||
    normalized.startsWith("fc") || normalized.startsWith("fd") ||
    normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized);
}

async function validateCustomProviderUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid custom provider URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Custom cloud providers must use HTTPS and must not include credentials, query parameters, or fragments in the URL.");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || isPrivateAddress(url.hostname)) {
    throw new Error("Custom cloud provider URLs must use a public HTTPS hostname.");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("The custom provider hostname resolves to a non-public address.");
  }
  return url;
}

function providerPlugin() {
  return {
    name: "aether-session-provider-proxy",
    configureServer(server) {
      server.middlewares.use("/__aether/providers/chat", (request, response) => {
        if (!isLocalSameOrigin(request)) {
          sendJson(response, 403, { error: "A same-origin loopback request is required." });
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST" }).end();
          return;
        }



        let body = "";
        let size = 0;
        request.on("data", (chunk) => {
          size += chunk.length;
          if (size > 2_000_000) {
            sendJson(response, 413, { error: "The provider request is too large." });
            request.destroy();
            return;
          }
          body += chunk;
        });
        request.on("end", async () => {
          if (response.writableEnded) return;
          try {
            const payload = JSON.parse(body);
            const { provider, apiKey, model, messages } = payload;
            if (!["openai", "anthropic", "gemini", "custom"].includes(provider)) {
              throw new Error("Choose a supported AI provider.");
            }
            if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 2000) {
              throw new Error("Enter a valid API key for the selected provider.");
            }
            if (typeof model !== "string" || !model.trim() || model.length > 200) {
              throw new Error("Enter a model name.");
            }
            if (!Array.isArray(messages) || messages.length < 1 || messages.length > 100 ||
              messages.some((message) =>
                !["system", "user", "assistant"].includes(message?.role) ||
                typeof message.content !== "string" ||
                message.content.length > 200_000,
              )) {
              throw new Error("The chat messages are invalid or too large.");
            }

            let url;
            let headers = { "content-type": "application/json" };
            let upstreamBody;
            if (provider === "openai") {
              url = new URL("https://api.openai.com/v1/chat/completions");
              headers.authorization = `Bearer ${apiKey.trim()}`;
              upstreamBody = { model: model.trim(), messages, stream: false };
            } else if (provider === "anthropic") {
              url = new URL("https://api.anthropic.com/v1/messages");
              headers["x-api-key"] = apiKey.trim();
              headers["anthropic-version"] = "2023-06-01";
              upstreamBody = {
                model: model.trim(),
                max_tokens: 4096,
                system: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n"),
                messages: messages.filter((message) => message.role !== "system").map((message) => ({
                  role: message.role === "assistant" ? "assistant" : "user",
                  content: message.content,
                })),
              };
            } else if (provider === "gemini") {
              url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.trim())}:generateContent`);
              headers["x-goog-api-key"] = apiKey.trim();
              upstreamBody = {
                systemInstruction: {
                  parts: messages.filter((message) => message.role === "system").map((message) => ({ text: message.content })),
                },
                contents: messages.filter((message) => message.role !== "system").map((message) => ({
                  role: message.role === "assistant" ? "model" : "user",
                  parts: [{ text: message.content }],
                })),
                generationConfig: { maxOutputTokens: 4096 },
              };
            } else {
              const baseUrl = await validateCustomProviderUrl(payload.baseUrl);
              const basePath = baseUrl.pathname.replace(/\/+$/, "");
              url = new URL(`${basePath.endsWith("/chat/completions") ? basePath : `${basePath}/chat/completions`}`, baseUrl.origin);
              headers.authorization = `Bearer ${apiKey.trim()}`;
              upstreamBody = { model: model.trim(), messages, stream: false };
            }

            const upstream = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify(upstreamBody),
              signal: AbortSignal.timeout(90_000),
              redirect: "manual",
            });
            const upstreamData = await upstream.json().catch(() => ({}));
            if (!upstream.ok) {
              const providerError = upstreamData.error?.message || upstreamData.message ||
                `Provider returned HTTP ${upstream.status}.`;
              sendJson(response, upstream.status, { error: String(providerError).slice(0, 2000) });
              return;
            }

            const content = provider === "anthropic"
              ? upstreamData.content?.filter((part) => part.type === "text").map((part) => part.text).join("")
              : provider === "gemini"
                ? upstreamData.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("")
                : upstreamData.choices?.[0]?.message?.content;
            if (typeof content !== "string" || !content.trim()) {
              throw new Error("The provider returned no text response.");
            }
            sendJson(response, 200, { content });
          } catch (error) {
            console.error("External AI provider request failed:", error);
            if (!response.writableEnded) {
              const isInvalidInput = error instanceof SyntaxError ||
                /^(Choose|Enter|The chat messages|Custom cloud|The custom provider)/.test(error.message || "");
              sendJson(response, isInvalidInput ? 400 : 502, {
                error: error.message || "The external AI provider request failed.",
              });
            }
          }
        });
        request.on("error", (error) => {
          console.error("Could not read external AI provider request:", error);
          if (!response.writableEnded) sendJson(response, 400, { error: "Could not read the provider request." });
        });
      });
    },
  };
}


function mediaPlugin() {
  return {
    name: "aether-media-generation",
    configureServer(server) {
      server.middlewares.use("/__aether/providers/image", (request, response) => {
        if (!isLocalSameOrigin(request)) {
          sendJson(response, 403, { error: "A same-origin loopback request is required." });
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST" }).end();
          return;
        }
        readJsonBody(request, response, async (payload) => {
          if (typeof payload.apiKey !== "string" || !payload.apiKey.trim() ||
            typeof payload.prompt !== "string" || !payload.prompt.trim() || payload.prompt.length > 4000) {
            sendJson(response, 400, { error: "Enter an OpenAI API key and an image prompt under 4,000 characters." });
            return;
          }
          const upstream = await fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${payload.apiKey.trim()}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-image-1",
              prompt: payload.prompt.trim(),
              size: "1024x1024",
              n: 1,
            }),
            signal: AbortSignal.timeout(120_000),
            redirect: "manual",
          });
          const data = await upstream.json().catch(() => ({}));
          if (!upstream.ok) {
            sendJson(response, upstream.status, { error: data.error?.message || `OpenAI returned HTTP ${upstream.status}.` });
            return;
          }
          const image = data.data?.[0]?.b64_json;
          if (typeof image !== "string" || !image) {
            throw new Error("OpenAI returned no image data.");
          }
          sendJson(response, 200, { image: `data:image/png;base64,${image}` });
        });
      });

      server.middlewares.use("/__aether/comfy", (request, response) => {
        if (!isLocalSameOrigin(request)) {
          sendJson(response, 403, { error: "A same-origin loopback request is required." });
          return;
        }
        const route = (request.url || "/").split("?", 1)[0];
        if (route === "/queue" && request.method === "POST") {
          readJsonBody(request, response, async (payload) => {
            if (typeof payload.prompt !== "string" || !payload.prompt.trim() ||
              !payload.workflow || typeof payload.workflow !== "object" || Array.isArray(payload.workflow)) {
              sendJson(response, 400, { error: "Choose a ComfyUI API workflow and enter a prompt." });
              return;
            }
            let replacements = 0;
            const replacePrompt = (value) => {
              if (typeof value === "string") {
                const replaced = value.replaceAll("{{prompt}}", payload.prompt.trim());
                if (replaced !== value) replacements += 1;
                return replaced;
              }
              if (Array.isArray(value)) return value.map(replacePrompt);
              if (value && typeof value === "object") {
                return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePrompt(item)]));
              }
              return value;
            };
            const workflow = replacePrompt(payload.workflow);
            if (!replacements) {
              sendJson(response, 400, { error: "Add {{prompt}} to a text input in the ComfyUI API workflow before uploading it." });
              return;
            }
            const upstream = await fetch("http://127.0.0.1:8188/prompt", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
              signal: AbortSignal.timeout(15_000),
            });
            const data = await upstream.json().catch(() => ({}));
            if (!upstream.ok || !data.prompt_id) {
              sendJson(response, upstream.status || 502, {
                error: data.error?.message || data.error || "ComfyUI could not queue this workflow. Check that it is running on 127.0.0.1:8188.",
              });
              return;
            }
            sendJson(response, 200, { promptId: data.prompt_id });
          });
          return;
        }
        if (route.startsWith("/history/") && request.method === "GET") {
          const promptId = route.slice("/history/".length);
          if (!/^[a-f0-9-]{16,64}$/i.test(promptId)) {
            sendJson(response, 400, { error: "Invalid ComfyUI job ID." });
            return;
          }
          fetch(`http://127.0.0.1:8188/history/${encodeURIComponent(promptId)}`, {
            signal: AbortSignal.timeout(15_000),
          }).then(async (upstream) => {
            const data = await upstream.json().catch(() => ({}));
            if (!upstream.ok) throw new Error(`ComfyUI returned HTTP ${upstream.status}.`);
            sendJson(response, 200, { job: data[promptId] || null });
          }).catch((error) => {
            sendJson(response, 502, { error: error.message || "Could not read ComfyUI job status." });
          });
          return;
        }
        if (route === "/view" && request.method === "GET") {
          const params = new URL(request.url, "http://localhost").searchParams;
          const filename = params.get("filename") || "";
          const subfolder = params.get("subfolder") || "";
          const type = params.get("type") || "output";
          if (
            !filename || filename === "." || filename === ".." ||
            path.basename(filename) !== filename || filename.includes("\0") ||
            subfolder.split("/").some((part) => part === "." || part === "..") ||
            !["output", "temp", "input"].includes(type)
          ) {
            sendJson(response, 400, { error: "Invalid ComfyUI output file path." });
            return;
          }
          const viewUrl = new URL("http://127.0.0.1:8188/view");
          viewUrl.searchParams.set("filename", filename);
          viewUrl.searchParams.set("subfolder", subfolder);
          viewUrl.searchParams.set("type", type);
          fetch(viewUrl, { signal: AbortSignal.timeout(120_000) }).then(async (upstream) => {
            if (!upstream.ok || !upstream.body) {
              sendJson(response, upstream.status || 502, { error: `ComfyUI could not load this output (HTTP ${upstream.status}).` });
              return;
            }
            response.writeHead(200, {
              "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
              "Cache-Control": "no-store",
            });
            Readable.fromWeb(upstream.body).pipe(response);
          }).catch((error) => {
            sendJson(response, 502, { error: error.message || "Could not load the ComfyUI output." });
          });
          return;
        }
        if (request.method !== "GET" && request.method !== "POST") {
          response.writeHead(405, { Allow: "GET, POST" }).end();
          return;
        }
        sendJson(response, 404, { error: "Unknown ComfyUI route." });
      });
    },
  };
}

function listGgufModels() {
  if (!existsSync(modelDirectory)) return [];
  const models = readdirSync(modelDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".gguf"))
    .map((entry) => {
      const filePath = path.join(modelDirectory, entry.name);
      const details = statSync(filePath);
      return {
        name: entry.name,
        displayName: entry.name.replace(/\.gguf$/i, ""),
        size: details.size,
        modifiedAt: details.mtimeMs,
      };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name));

  const newestModel = models[0];
  if (newestModel && Date.now() - newestModel.modifiedAt >= modelStabilityMs) {
    for (const oldModel of models.slice(1)) {
      const oldPath = path.join(modelDirectory, oldModel.name);
      try {
        const newestStatus = lstatSync(path.join(modelDirectory, newestModel.name));
        const fileStatus = lstatSync(oldPath);
        if (
          !newestStatus.isFile() ||
          newestStatus.isSymbolicLink() ||
          Date.now() - newestStatus.mtimeMs < modelStabilityMs ||
          !fileStatus.isFile() ||
          fileStatus.isSymbolicLink() ||
          fileStatus.mtimeMs > newestStatus.mtimeMs
        ) {
          continue;
        }
        unlinkSync(oldPath);
        console.info(`Removed older local model ${oldPath}; keeping ${newestModel.name}.`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  return listGgufModelFiles();
}

function listGgufModelFiles() {
  if (!existsSync(modelDirectory)) return [];
  return readdirSync(modelDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".gguf"))
    .map((entry) => {
      const details = statSync(path.join(modelDirectory, entry.name));
      return {
        name: entry.name,
        displayName: entry.name.replace(/\.gguf$/i, ""),
        size: details.size,
        modifiedAt: details.mtimeMs,
      };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name));
}

function modelFileKey(value) {
  return String(value || "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.gguf$/i, "")
    .toLowerCase();
}

async function requestLlamaManagement(route, method = "GET", payload) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:8080${route}`, {
      method,
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`Could not reach the local llama.cpp model manager: ${error.message}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`The local llama.cpp model manager returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(data.error?.message || data.error || `llama.cpp returned HTTP ${response.status}.`);
  }
  return data;
}

async function getLlamaModel(fileName) {
  const data = await requestLlamaManagement("/models?reload=1");
  if (!Array.isArray(data.data)) {
    throw new Error("The local llama.cpp model manager returned an invalid model list.");
  }
  const targetKey = modelFileKey(fileName);
  const model = data.data.find((candidate) => {
    const identifiers = [candidate.id, candidate.name, ...(candidate.aliases || [])];
    return identifiers.some((identifier) => modelFileKey(identifier) === targetKey);
  });
  return { data: data.data, model };
}

async function waitForLlamaModel(fileName, expectedStatuses, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const data = await requestLlamaManagement("/models");
    const targetKey = modelFileKey(fileName);
    const model = data.data?.find((candidate) =>
      [candidate.id, candidate.name, ...(candidate.aliases || [])]
        .some((identifier) => modelFileKey(identifier) === targetKey),
    );
    if (!model) throw new Error(`Model ${fileName} disappeared from the llama.cpp model list.`);
    lastStatus = model.status?.value || "unknown";
    if (expectedStatuses.includes(lastStatus)) return model;
    if (lastStatus === "error") {
      throw new Error(`llama.cpp could not load ${fileName}. Check the llama.cpp server log.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${fileName}; current model status: ${lastStatus}.`);
}

function validModelName(name) {
  return typeof name === "string" &&
    path.basename(name) === name &&
    name.toLowerCase().endsWith(".gguf") &&
    existsSync(path.join(modelDirectory, name)) &&
    !lstatSync(path.join(modelDirectory, name)).isSymbolicLink();
}

function runGgufQuery(args, response) {
  execFile(
    ggufPython(),
    [ggufEditorScript, ...args],
    { cwd: projectRoot, timeout: 180_000, maxBuffer: 30_000_000 },
    (error, stdout, stderr) => {
      if (error) {
        const message = stderr.trim() || stdout.trim() || error.message;
        sendJson(response, 400, { error: message });
        return;
      }
      try {
        sendJson(response, 200, JSON.parse(stdout));
      } catch (parseError) {
        console.error("GGUF inspector returned invalid JSON:", parseError, stdout.slice(0, 1000));
        sendJson(response, 500, { error: "The GGUF inspector returned an invalid response." });
      }
    },
  );
}

function ggufEditorPlugin() {
  return {
    name: "aether-local-gguf-editor",
    configureServer(server) {
      server.middlewares.use("/__aether/gguf", (request, response, next) => {
        if (!isLocalSameOrigin(request)) {
          sendJson(response, 403, { error: "A same-origin loopback request is required." });
          return;
        }

        const route = (request.url || "/").split("?", 1)[0];
        if (route === "/models" && request.method === "GET") {
          try {
            const models = listGgufModels();
            checkGgufEnvironment().then((environment) => {
              if (environment.ready) {
                runGgufQuery(["models"], response);
              } else {
                sendJson(response, 200, { models });
              }
            });
          } catch (error) {
            console.error("Could not synchronize local GGUF models:", error);
            sendJson(response, 500, { error: `Could not synchronize local GGUF models: ${error.message}` });
          }
          return;
        }

        if (route === "/status" && request.method === "GET") {
          if (["running", "stopping"].includes(ggufJob?.status)) {
            sendJson(response, 200, {
              status: ggufJob.status,
              logs: ggufJob.logs,
              output: ggufJob.output || "",
              startedAt: ggufJob.startedAt,
              ready: true,
            });
            return;
          }
          const refresh = new URL(request.url, "http://localhost").searchParams.get("refresh") === "1";
          checkGgufEnvironment(refresh).then((environment) => {
            sendJson(response, 200, {
              status: ggufJob?.status || "idle",
              logs: ggufJob?.logs || [],
              output: ggufJob?.output || "",
              ready: environment.ready,
              python: environment.python,
              message: environment.message,
            });
          });
          return;
        }

        if (route === "/inspect" && request.method === "GET") {
          const name = new URL(request.url, "http://localhost").searchParams.get("model");
          if (!validModelName(name)) {
            sendJson(response, 400, { error: "Choose a GGUF file from the Aether models folder." });
            return;
          }
          runGgufQuery(["inspect", "--model", name], response);
          return;
        }

        if (route === "/metadata" && request.method === "GET") {
          const params = new URL(request.url, "http://localhost").searchParams;
          const name = params.get("model");
          const key = params.get("key");
          if (!validModelName(name) || !key) {
            sendJson(response, 400, { error: "Choose a GGUF file and metadata key." });
            return;
          }
          runGgufQuery(["metadata", "--model", name, "--key", key], response);
          return;
        }

        if (route === "/sample" && request.method === "GET") {
          const params = new URL(request.url, "http://localhost").searchParams;
          const name = params.get("model");
          const tensor = params.get("tensor");
          const index = Number(params.get("index") || 0);
          const count = Number(params.get("count") || 8);
          if (!validModelName(name) || !tensor || !Number.isInteger(index) || !Number.isInteger(count)) {
            sendJson(response, 400, { error: "Choose a model, tensor, and valid sample index." });
            return;
          }
          runGgufQuery(["sample", "--model", name, "--tensor", tensor, "--index", String(index), "--count", String(count)], response);
          return;
        }

        if (route === "/edit" && request.method === "POST") {
          readJsonBody(request, response, async (payload) => {
            if (["running", "stopping"].includes(ggufJob?.status)) {
              sendJson(response, 409, { error: "A GGUF edit is already running." });
              return;
            }
            const { model, operations } = payload || {};
            if (!validModelName(model)) {
              sendJson(response, 400, { error: "Choose a GGUF file from the Aether models folder." });
              return;
            }
            if (!Array.isArray(operations) || operations.length < 1 || operations.length > 1000) {
              sendJson(response, 400, { error: "Provide between 1 and 1,000 tensor operations." });
              return;
            }

            const environment = await checkGgufEnvironment();
            if (!environment.ready) {
              sendJson(response, 503, {
                error: `The GGUF editor is not ready. ${environment.message}`,
                python: environment.python,
              });
              return;
            }

            const editId = randomUUID().slice(0, 8);
            const output = `${model.slice(0, -5)}-edited-${editId}.gguf`;
            const runDirectory = path.join(homeDir, ".local", "share", "aether-gguf-editor", "jobs", editId);
            const operationsPath = path.join(runDirectory, "operations.json");
            try {
              await mkdir(runDirectory, { recursive: true });
              await writeFile(operationsPath, JSON.stringify(operations), { encoding: "utf8", flag: "wx" });
            } catch (error) {
              console.error("Could not prepare the GGUF edit:", error);
              sendJson(response, 500, { error: `Could not save the edit operations: ${error.message}` });
              return;
            }

            ggufJob = {
              status: "running",
              logs: [`Copying ${model} and applying ${operations.length} operation(s).`],
              output,
              startedAt: new Date().toISOString(),
            };
            const child = spawn(ggufPython(), [
              ggufEditorScript,
              "edit",
              "--model", model,
              "--output", output,
              "--operations", operationsPath,
            ], {
              cwd: projectRoot,
              env: { ...process.env, TMPDIR: runDirectory },
              stdio: ["ignore", "pipe", "pipe"],
            });
            ggufJob.child = child;
            const stdout = { pending: "" };
            const stderr = { pending: "" };
            child.stdout.on("data", (chunk) => appendGgufOutput(stdout, chunk));
            child.stderr.on("data", (chunk) => appendGgufOutput(stderr, chunk));
            child.on("error", (error) => {
              ggufJob.status = "failed";
              ggufJob.logs.push(`Could not start the GGUF editor: ${error.message}`);
            });
            child.on("close", (code, signal) => {
              if (stdout.pending) ggufJob.logs.push(stdout.pending);
              if (stderr.pending) ggufJob.logs.push(stderr.pending);
              if (!["running", "stopping"].includes(ggufJob.status)) return;
              ggufJob.status = code === 0 ? "completed" : signal ? "stopped" : "failed";
              if (code === 0) ggufJob.output = path.join(modelDirectory, output);
              rm(runDirectory, { recursive: true, force: true }).catch((error) => {
                console.error("Could not remove temporary GGUF edit data:", error);
              });
              if (code === 0) {
                ggufReadiness = undefined;
                ggufJob.logs.push(`Edited copy saved as ${output}. The original model remains unchanged.`);
              } else if (signal) {
                ggufJob.logs.push(`GGUF edit stopped (${signal}).`);
              } else {
                ggufJob.logs.push(`GGUF editor exited with code ${code}.`);
              }
            });
            sendJson(response, 202, { status: "running", logs: ggufJob.logs, output });
          });
          return;
        }

        if (route === "/stop" && request.method === "POST") {
          if (!ggufJob?.child || ggufJob.status !== "running") {
            sendJson(response, 409, { error: "There is no running GGUF edit to stop." });
            return;
          }
          ggufJob.status = "stopping";
          ggufJob.child.kill("SIGTERM");
          sendJson(response, 202, { status: "stopping" });
          return;
        }

        if (request.method !== "GET" && request.method !== "POST") {
          response.writeHead(405, { Allow: "GET, POST" }).end();
          return;
        }
        next();
      });

      server.httpServer?.on("close", () => {
        if (["running", "stopping"].includes(ggufJob?.status)) ggufJob.child?.kill("SIGTERM");
      });
    },
  };
}

function modelManagementPlugin() {
  return {
    name: "aether-local-model-management",
    configureServer(server) {
      server.middlewares.use("/__aether/model-manager", (request, response) => {
        if (!isLocalSameOrigin(request)) {
          sendJson(response, 403, { error: "A same-origin loopback request is required." });
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST" }).end();
          return;
        }

        const route = (request.url || "/").split("?", 1)[0];
        if (route !== "/reload" && route !== "/remove") {
          sendJson(response, 404, { error: "Unknown model-management action." });
          return;
        }

        readJsonBody(request, response, async (payload) => {
          const fileName = payload?.model;
          if (!validModelName(fileName)) {
            sendJson(response, 404, { error: "That GGUF file is no longer in the local model folder." });
            return;
          }

          const initialStats = lstatSync(path.join(modelDirectory, fileName));
          let serverModel;
          try {
            ({ model: serverModel } = await getLlamaModel(fileName));
          } catch (error) {
            sendJson(response, 503, { error: error.message });
            return;
          }

          if (route === "/reload") {
            if (!serverModel) {
              sendJson(response, 404, {
                error: "llama.cpp does not know this model yet. Restart llama.cpp and try again.",
              });
              return;
            }

            let status = serverModel.status?.value;
            if (status === "loaded" || status === "loading") {
              await requestLlamaManagement("/models/unload", "POST", { model: serverModel.id });
              await waitForLlamaModel(fileName, ["unloaded"]);
              status = "unloaded";
            } else if (status === "unloading") {
              await waitForLlamaModel(fileName, ["unloaded"]);
              status = "unloaded";
            }
            if (status !== "unloaded") {
              sendJson(response, 409, {
                error: `Cannot reload this model while llama.cpp reports "${status || "unknown"}".`,
              });
              return;
            }

            await requestLlamaManagement("/models/load", "POST", { model: serverModel.id });
            const loadedModel = await waitForLlamaModel(fileName, ["loaded"]);
            sendJson(response, 200, {
              status: "loaded",
              model: fileName,
              modelId: loadedModel.id,
            });
            return;
          }

          if (serverModel) {
            const status = serverModel.status?.value;
            if (status === "loaded" || status === "loading") {
              await requestLlamaManagement("/models/unload", "POST", { model: serverModel.id });
              await waitForLlamaModel(fileName, ["unloaded"]);
            } else if (status === "unloading") {
              await waitForLlamaModel(fileName, ["unloaded"]);
            } else if (status && status !== "unloaded" && status !== "error") {
              sendJson(response, 409, {
                error: `Cannot remove this model while llama.cpp reports "${status}".`,
              });
              return;
            }
          }

          const modelPath = path.join(modelDirectory, fileName);
          const currentStats = lstatSync(modelPath);
          if (
            !currentStats.isFile() ||
            currentStats.isSymbolicLink() ||
            currentStats.dev !== initialStats.dev ||
            currentStats.ino !== initialStats.ino
          ) {
            sendJson(response, 409, { error: "The model file changed while it was being removed. Refresh and try again." });
            return;
          }
          unlinkSync(modelPath);

          let warning = "";
          try {
            await requestLlamaManagement("/models?reload=1");
          } catch (error) {
            warning = `The model file was removed, but llama.cpp did not refresh its model list: ${error.message}`;
            console.error(warning);
          }
          sendJson(response, 200, { status: "removed", model: fileName, warning });
        });
      });
    },
  };
}

function trainingPlugin(hfToken) {
  async function getHuggingFaceToken() {
    try {
      return (await readFile(huggingFaceTokenPath, "utf8")).trim();
    } catch (error) {
      if (error.code === "ENOENT") return hfToken || process.env.HF_TOKEN || "";
      throw error;
    }
  }

  return {
    name: "aether-local-fine-tuning",
    configureServer(server) {
      server.middlewares.use("/__aether/training", (request, response) => {
        if (!isLocalSameOrigin(request)) {
          sendJson(response, 403, { error: "A same-origin loopback request is required." });
          return;
        }

        const route = (request.url || "/").split("?", 1)[0];
        if (route === "/token" && request.method === "GET") {
          getHuggingFaceToken().then((token) => {
            sendJson(response, 200, { configured: Boolean(token) });
          }).catch((error) => {
            console.error("Could not check local Hugging Face token:", error);
            sendJson(response, 500, { error: "Could not check the locally saved Hugging Face token." });
          });
          return;
        }

        if (route === "/token" && request.method === "POST") {
          readJsonBody(request, response, async (payload) => {
            if (typeof payload.token !== "string" || !/^hf_[A-Za-z0-9_-]{8,500}$/.test(payload.token.trim())) {
              sendJson(response, 400, { error: "Enter a valid Hugging Face token beginning with hf_." });
              return;
            }
            const token = payload.token.trim();
            const tokenDirectory = path.dirname(huggingFaceTokenPath);
            const temporaryPath = `${huggingFaceTokenPath}.${randomUUID()}.tmp`;
            try {
              await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
              await chmod(tokenDirectory, 0o700);
              await writeFile(temporaryPath, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
              await chmod(temporaryPath, 0o600);
              await rename(temporaryPath, huggingFaceTokenPath);
              await chmod(huggingFaceTokenPath, 0o600);
            } catch (error) {
              await unlink(temporaryPath).catch(() => {});
              throw error;
            }
            sendJson(response, 200, { configured: true });
          });
          return;
        }

        if (route === "/token" && request.method === "DELETE") {
          unlink(huggingFaceTokenPath).then(async () => {
            sendJson(response, 200, { configured: Boolean(await getHuggingFaceToken()) });
          }).catch((error) => {
            if (error.code === "ENOENT") {
              getHuggingFaceToken().then((token) => {
                sendJson(response, 200, { configured: Boolean(token) });
              }).catch((readError) => {
                console.error("Could not check local Hugging Face token:", readError);
                sendJson(response, 500, { error: "Could not check the locally saved Hugging Face token." });
              });
              return;
            }
            console.error("Could not remove local Hugging Face token:", error);
            sendJson(response, 500, { error: "Could not remove the locally saved Hugging Face token." });
          });
          return;
        }

        if (route === "/status" && request.method === "GET") {
          if (trainingSetupJob?.status === "setup-running") {
            sendJson(response, 200, {
              status: "setup-running",
              logs: trainingSetupJob.logs,
              output: "",
              ready: false,
              message: "Installing local training dependencies. This may take several minutes and download multiple gigabytes.",
            });
            return;
          }
          if (["running", "stopping"].includes(trainingJob?.status)) {
            sendJson(response, 200, {
              status: trainingJob.status,
              logs: trainingJob.logs,
              output: trainingJob.output || "",
              startedAt: trainingJob.startedAt,
              ready: true,
              message: "Training runs locally. Your examples and model files stay on this device.",
            });
            return;
          }
          const refresh = new URL(request.url, "http://localhost").searchParams.get("refresh") === "1";
          checkTrainingEnvironment(refresh).then((environment) => {
            sendJson(response, 200, {
              status: trainingJob?.status || trainingSetupJob?.status || "idle",
              logs: trainingJob?.logs?.length ? trainingJob.logs : trainingSetupJob?.logs || [],
              output: trainingJob?.output || "",
              ready: environment.ready,
              python: environment.python,
              message: environment.ready
                ? environment.message
                : trainingSetupJob?.status === "setup-failed"
                  ? trainingSetupJob.message
                  : environment.message,
            });
          });
          return;
        }

        if (route === "/setup" && request.method === "POST") {
          if (trainingSetupJob?.status === "setup-running") {
            sendJson(response, 202, {
              status: "setup-running",
              logs: trainingSetupJob.logs,
              ready: false,
              message: "Local training setup is already running.",
            });
            return;
          }
          if (["running", "stopping"].includes(trainingJob?.status)) {
            sendJson(response, 409, { error: "Stop the current training job before setting up the training environment." });
            return;
          }

          trainingSetupJob = {
            status: "setup-running",
            logs: ["Creating the isolated Aether training environment..."],
            message: "",
            startedAt: new Date().toISOString(),
          };
          trainingReadiness = undefined;
          const child = spawn("sh", [trainingSetupScript], {
            cwd: projectRoot,
            env: { ...process.env, PYTHONUNBUFFERED: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          trainingSetupJob.child = child;
          const stdout = { pending: "" };
          const stderr = { pending: "" };
          child.stdout.on("data", (chunk) => appendTrainingSetupOutput(stdout, chunk));
          child.stderr.on("data", (chunk) => appendTrainingSetupOutput(stderr, chunk));
          child.on("error", (error) => {
            trainingSetupJob.status = "setup-failed";
            trainingSetupJob.message = `Could not start local training setup: ${error.message}`;
            trainingSetupJob.logs.push(trainingSetupJob.message);
            console.error(trainingSetupJob.message);
          });
          child.on("close", (code, signal) => {
            if (stdout.pending) appendTrainingSetupOutput(stdout, `${stdout.pending}\n`);
            if (stderr.pending) appendTrainingSetupOutput(stderr, `${stderr.pending}\n`);
            if (trainingSetupJob.status !== "setup-running") return;
            trainingSetupJob.status = code === 0 ? "setup-completed" : "setup-failed";
            trainingSetupJob.message = code === 0
              ? "Training dependencies installed. Verifying CUDA and the local trainer..."
              : signal
                ? `Training setup stopped (${signal}).`
                : [...trainingSetupJob.logs].reverse().find((line) =>
                    /error|failed|required|found|unavailable/i.test(line),
                  ) || `Training setup exited with code ${code}.`;
            if (code !== 0) {
              trainingSetupJob.logs.push(trainingSetupJob.message);
              return;
            }
            trainingReadiness = undefined;
            checkTrainingEnvironment(true).then((environment) => {
              trainingSetupJob.status = environment.ready ? "setup-completed" : "setup-failed";
              trainingSetupJob.message = environment.message;
              trainingSetupJob.logs.push(environment.message);
            }).catch((error) => {
              trainingSetupJob.status = "setup-failed";
              trainingSetupJob.message = `Could not verify the training environment: ${error.message}`;
              trainingSetupJob.logs.push(trainingSetupJob.message);
              console.error(trainingSetupJob.message);
            });
          });
          sendJson(response, 202, {
            status: "setup-running",
            logs: trainingSetupJob.logs,
            ready: false,
            message: "Installing local training dependencies.",
          });
          return;
        }

        if (route === "/start" && request.method === "POST") {
          if (["running", "stopping"].includes(trainingJob?.status)) {
            sendJson(response, 409, { error: "A fine-tuning job is already running." });
            return;
          }
          readTrainingBody(request, response, async (payload) => {
            const modelIds = {
              "Qwen3.5-0.8B": "unsloth/Qwen3.5-0.8B",
              "Qwen3.5-2B": "unsloth/Qwen3.5-2B",
              "Qwen3.5-4B": "unsloth/Qwen3.5-4B",
              "Qwen3.5-9B": "unsloth/Qwen3.5-9B",
              "Qwen2.5-Coder-7B": "unsloth/Qwen2.5-Coder-7B-Instruct",
            };
            const {
              model,
              examples,
              systemPrompt = "",
              epochs,
              sequenceLength,
              learningRate,
            } = payload || {};
            if (!Object.hasOwn(modelIds, model)) {
              sendJson(response, 400, { error: "Choose a supported base model." });
              return;
            }
            if (typeof systemPrompt !== "string" || systemPrompt.length > 5000) {
              sendJson(response, 400, { error: "Behavior rules must be 5,000 characters or fewer." });
              return;
            }
            if (!Array.isArray(examples) || examples.length < 2 || examples.length > 500 ||
              examples.some((example) =>
                !Array.isArray(example?.messages) ||
                example.messages.length !== 2 ||
                example.messages[0]?.role !== "user" ||
                example.messages[1]?.role !== "assistant" ||
                typeof example.messages[0]?.content !== "string" ||
                typeof example.messages[1]?.content !== "string" ||
                !example.messages[0].content.trim() ||
                !example.messages[1].content.trim() ||
                example.messages[0].content.length > 10_000 ||
                example.messages[1].content.length > 10_000,
              )) {
              sendJson(response, 400, { error: "Provide 2–500 complete prompt/response examples, each no longer than 10,000 characters." });
              return;
            }
            if (!Number.isInteger(epochs) || epochs < 1 || epochs > 5) {
              sendJson(response, 400, { error: "Epochs must be an integer from 1 to 5." });
              return;
            }
            if (![512, 1024, 2048, 4096].includes(sequenceLength)) {
              sendJson(response, 400, { error: "Choose a supported sequence length." });
              return;
            }
            if (!Number.isFinite(learningRate) || learningRate < 0.00001 || learningRate > 0.001) {
              sendJson(response, 400, { error: "Learning rate must be between 0.00001 and 0.001." });
              return;
            }

            const environment = await checkTrainingEnvironment();
            if (!environment.ready) {
              sendJson(response, 503, {
                error: `Local training is not ready. ${environment.message}`,
                python: environment.python,
              });
              return;
            }

            const configuredToken = await getHuggingFaceToken();
            const jobId = randomUUID().slice(0, 8);
            const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
            const outputName = `aether-${model.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-trained-${timestamp}-${jobId}.gguf`;
            const runDirectory = path.join(homeDir, ".local", "share", "aether-finetuning", "jobs", jobId);
            const requestPath = path.join(runDirectory, "training.json");
            try {
              await mkdir(runDirectory, { recursive: true });
              await mkdir(modelDirectory, { recursive: true });
              await writeFile(requestPath, JSON.stringify({
                model: modelIds[model],
                examples,
                systemPrompt,
                epochs,
                sequenceLength,
                learningRate,
              }), { encoding: "utf8", flag: "wx" });
            } catch (error) {
              console.error("Could not prepare the fine-tuning job:", error);
              sendJson(response, 500, { error: `Could not save the training job: ${error.message}` });
              return;
            }

            trainingJob = {
              status: "running",
              logs: [`Starting ${model} QLoRA fine-tuning with ${examples.length} examples.`],
              output: "",
              outputName,
              startedAt: new Date().toISOString(),
            };
            const child = spawn(trainingPython(), [
              trainingScript,
              "train",
              "--request", requestPath,
              "--output-dir", modelDirectory,
              "--output-name", outputName,
            ], {
              cwd: projectRoot,
              env: {
                ...process.env,
                ...(configuredToken ? { HF_TOKEN: configuredToken } : {}),
                PYTHONUNBUFFERED: "1",
              },
              stdio: ["ignore", "pipe", "pipe"],
            });
            trainingJob.child = child;
            const stdout = { pending: "" };
            const stderr = { pending: "" };
            child.stdout.on("data", (chunk) => appendTrainingOutput(stdout, chunk));
            child.stderr.on("data", (chunk) => appendTrainingOutput(stderr, chunk));
            child.on("error", (error) => {
              trainingJob.status = "failed";
              trainingJob.logs.push(`Could not start the trainer: ${error.message}`);
            });
            child.on("close", (code, signal) => {
              if (stdout.pending) trainingJob.logs.push(stdout.pending);
              if (stderr.pending) trainingJob.logs.push(stderr.pending);
              rm(runDirectory, { recursive: true, force: true }).catch((error) => {
                console.error("Could not remove temporary fine-tuning data:", error);
              });
              if (!["running", "stopping"].includes(trainingJob.status)) return;
              if (code === 0 && existsSync(path.join(modelDirectory, outputName))) {
                trainingJob.status = "completed";
                trainingJob.output = path.join(modelDirectory, outputName);
                trainingJob.logs.push(`Fine-tuned GGUF saved as ${outputName}.`);
              } else {
                trainingJob.status = signal ? "stopped" : "failed";
                trainingJob.logs.push(
                  signal ? `Training stopped (${signal}).` : `Trainer exited with code ${code} without producing a GGUF.`,
                );
              }
            });
            sendJson(response, 202, { status: "running", logs: trainingJob.logs, output: "" });
          });
          return;
        }

        if (route === "/stop" && request.method === "POST") {
          if (!trainingJob?.child || trainingJob.status !== "running") {
            sendJson(response, 409, { error: "There is no running fine-tuning job to stop." });
            return;
          }
          trainingJob.status = "stopping";
          trainingJob.child.kill("SIGTERM");
          sendJson(response, 202, { status: "stopping" });
          return;
        }

        if (request.method !== "GET" && request.method !== "POST") {
          response.writeHead(405, { Allow: "GET, POST" }).end();
          return;
        }
        sendJson(response, 404, { error: "Unknown fine-tuning route." });
      });

      server.httpServer?.on("close", () => {
        if (["running", "stopping"].includes(trainingJob?.status)) trainingJob.child?.kill("SIGTERM");
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "");
  const hfToken = process.env.HF_TOKEN || env.HF_TOKEN;

  return {
    base: "./",
    plugins: [
      react(),
      ggufEditorPlugin(),
      modelManagementPlugin(),
      providerPlugin(),
      mediaPlugin(),
      trainingPlugin(hfToken),
    ],
    server: {
      proxy: {
        "/search/stackoverflow": {
          target: "https://api.stackexchange.com",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/search\/stackoverflow/, "/2.3/search/excerpts"),
        },
        "/search/github": {
          target: "https://api.github.com",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/search\/github/, "/search/repositories"),
        },
        "/v1": {
          target: "http://127.0.0.1:8080",
          changeOrigin: true,
          rewrite: (path) => path,
        },
      },
    },
  };
});
