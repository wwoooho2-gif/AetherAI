// Image understanding that runs on the device. A small vision-language model (SmolVLM 256M, via
// transformers.js) looks at each attached picture and writes a description, which is handed to the
// chat model as text. The library and weights load only the first time a picture is sent, then are cached
// by the browser. Nothing is uploaded: the weights are downloaded, the picture never leaves the device.
const MODEL_ID = "onnx-community/SmolVLM-256M-Instruct";
const PROMPT = "Describe this image in detail. Mention the main subjects, setting, colors, and any text you can read.";

let loading = null;
const described = new Map();

async function load(onStatus) {
  const lib = await import("@huggingface/transformers");
  const { AutoProcessor, AutoModelForVision2Seq } = lib;
  const webgpu = typeof navigator !== "undefined" && Boolean(navigator.gpu);
  onStatus?.("Loading the vision model (first time only)…");
  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  const progress_callback = (p) => {
    if (p?.status === "progress" && p.total) onStatus?.(`Downloading vision model… ${Math.round((p.loaded / p.total) * 100)}%`);
  };
  const attempts = webgpu
    ? [{ device: "webgpu", dtype: { embed_tokens: "fp16", vision_encoder: "q4", decoder_model_merged: "q4" } }]
    : [];
  attempts.push({ device: "wasm", dtype: { embed_tokens: "q8", vision_encoder: "q8", decoder_model_merged: "q8" } });
  let lastError;
  for (const options of attempts) {
    try {
      const model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, { ...options, progress_callback });
      return { lib, processor, model };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** @returns {Promise<string>} a text description of the picture (data URL in, text out). */
export async function describeImage(dataUrl, { onStatus } = {}) {
  const key = `${dataUrl.length}:${dataUrl.slice(-64)}`;
  if (described.has(key)) return described.get(key);
  loading ||= load(onStatus).catch((error) => { loading = null; throw error; });
  const { lib, processor, model } = await loading;
  onStatus?.("Looking at the image…");
  const image = await lib.load_image(dataUrl);
  const messages = [{ role: "user", content: [{ type: "image" }, { type: "text", text: PROMPT }] }];
  const prompt = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(prompt, [image], { do_image_splitting: false });
  const ids = await model.generate({ ...inputs, max_new_tokens: 256, do_sample: false });
  const [text] = processor.batch_decode(ids.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: true });
  const result = String(text || "").trim();
  if (result) described.set(key, result);
  return result;
}
