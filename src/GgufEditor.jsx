import { useEffect, useState } from "react";
import CustomSelect from "./CustomSelect.jsx";
import {
  BrainCircuit,
  Check,
  CircleAlert,
  Download,
  FileUp,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

const API = "/__aether/gguf";
const starterScript = "[]";

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit > 1 ? 2 : 0)} ${units[unit]}`;
}

function operationLabel(operation) {
  if (operation.op === "metadata_set") return `Set metadata ${operation.key}`;
  const target = operation.tensor;
  if (operation.op === "set") return `Set ${target}[${operation.index}] = ${operation.value}`;
  if (operation.op === "scale") return `Scale ${target} × ${operation.factor}`;
  if (operation.op === "add") return `Add ${operation.value} to ${target}`;
  return `Clamp ${target} to [${operation.min}, ${operation.max}]`;
}

export default function GgufEditor({ onModelSaved }) {
  const [models, setModels] = useState([]);
  const [model, setModel] = useState("");
  const [modelInfo, setModelInfo] = useState(null);
  const [modelName, setModelName] = useState("");
  const [modelRules, setModelRules] = useState("");
  const [chatTemplate, setChatTemplate] = useState("");
  const [metadataKey, setMetadataKey] = useState("general.name");
  const [metadataJson, setMetadataJson] = useState('""');
  const [metadataDetail, setMetadataDetail] = useState(null);
  const [metadataError, setMetadataError] = useState("");
  const [selectedTensor, setSelectedTensor] = useState("");
  const [tensorFilter, setTensorFilter] = useState("");
  const [sampleIndex, setSampleIndex] = useState("0");
  const [sample, setSample] = useState(null);
  const [sampleError, setSampleError] = useState("");
  const [editType, setEditType] = useState("set");
  const [editIndex, setEditIndex] = useState("0");
  const [editValue, setEditValue] = useState("0");
  const [editFactor, setEditFactor] = useState("1");
  const [clampMin, setClampMin] = useState("-1");
  const [clampMax, setClampMax] = useState("1");
  const [script, setScript] = useState(starterScript);
  const [operations, setOperations] = useState([]);
  const [status, setStatus] = useState({
    status: "checking",
    ready: false,
    logs: [],
    message: "Checking the local GGUF editor...",
  });
  const [error, setError] = useState("");
  const [loadingModels, setLoadingModels] = useState(true);
  const [loadingModelInfo, setLoadingModelInfo] = useState(false);
  const [scriptImported, setScriptImported] = useState(false);

  async function loadModels(preferredName = "") {
    try {
      const response = await fetch(`${API}/models`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `GGUF service returned HTTP ${response.status}.`);
      setModels(data.models || []);
      setModel((current) => {
        if (preferredName && data.models.some((item) => item.name === preferredName)) return preferredName;
        if (current && data.models.some((item) => item.name === current)) return current;
        return data.models[0]?.name || "";
      });
    } catch (loadError) {
      console.error("Could not load local GGUF models:", loadError);
      setError(loadError.message);
    } finally {
      setLoadingModels(false);
    }
  }

  async function refreshStatus(force = false) {
    try {
      const response = await fetch(`${API}/status${force ? "?refresh=1" : ""}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `GGUF service returned HTTP ${response.status}.`);
      setStatus(data);
    } catch (statusError) {
      console.error("Could not check the local GGUF editor:", statusError);
      setStatus((current) => ({ ...current, ready: false, message: statusError.message }));
    }
  }

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const [modelResponse, statusResponse] = await Promise.all([
          fetch(`${API}/models`),
          fetch(`${API}/status`),
        ]);
        const [modelData, statusData] = await Promise.all([modelResponse.json(), statusResponse.json()]);
        if (!modelResponse.ok) throw new Error(modelData.error || `GGUF model list returned HTTP ${modelResponse.status}.`);
        if (!statusResponse.ok) throw new Error(statusData.error || `GGUF service returned HTTP ${statusResponse.status}.`);
        if (!mounted) return;
        setModels(modelData.models || []);
        setModel((current) => current && modelData.models.some((item) => item.name === current)
          ? current
          : modelData.models[0]?.name || "");
        setStatus(statusData);
      } catch (refreshError) {
        if (!mounted) return;
        console.error("Could not initialize the GGUF editor:", refreshError);
        setError(refreshError.message);
        setStatus((current) => ({ ...current, ready: false, message: refreshError.message }));
      } finally {
        if (mounted) setLoadingModels(false);
      }
    };
    refresh();
    const intervalId = window.setInterval(() => {
      fetch(`${API}/status`)
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || `GGUF service returned HTTP ${response.status}.`);
          if (mounted) setStatus(data);
        })
        .catch((statusError) => {
          console.error("Could not refresh GGUF editor status:", statusError);
          if (mounted) setStatus((current) => ({ ...current, ready: false, message: statusError.message }));
        });
    }, 2000);
    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!model) {
      setModelInfo(null);
      setSelectedTensor("");
      return undefined;
    }
    let mounted = true;
    setLoadingModelInfo(true);
    setModelInfo(null);
    setModelName("");
    setSelectedTensor("");
    setSample(null);
    fetch(`${API}/inspect?${new URLSearchParams({ model })}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Could not inspect model (HTTP ${response.status}).`);
        if (!mounted) return;
        setModelInfo(data);
        setModelName(data.metadata["general.name"] || "");
        setSelectedTensor(data.tensors.find((tensor) => tensor.editable)?.name || data.tensors[0]?.name || "");
        setMetadataKey(data.metadataFields.find((field) => field.key === "general.name" && field.editable)?.key
          || data.metadataFields.find((field) => field.editable)?.key
          || "aether.system_prompt");
      })
      .catch((inspectError) => {
        if (!mounted) return;
        console.error("Could not inspect GGUF model:", inspectError);
        setError(inspectError.message);
      })
      .finally(() => {
        if (mounted) setLoadingModelInfo(false);
      });
    return () => { mounted = false; };
  }, [model]);

  useEffect(() => {
    if (!model) {
      setModelRules("");
      setChatTemplate("");
      return undefined;
    }
    let mounted = true;
    async function loadBehaviorMetadata() {
      try {
        const read = async (key) => {
          const params = new URLSearchParams({ model, key });
          const response = await fetch(`${API}/metadata?${params}`);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || `Could not read ${key} (HTTP ${response.status}).`);
          return data.value ?? "";
        };
        const [rules, template] = await Promise.all([
          read("aether.system_prompt"),
          read("tokenizer.chat_template"),
        ]);
        if (!mounted) return;
        setModelRules(typeof rules === "string" ? rules : "");
        setChatTemplate(typeof template === "string" ? template : "");
        setMetadataError("");
      } catch (loadError) {
        if (!mounted) return;
        console.error("Could not load GGUF behavior metadata:", loadError);
        setMetadataError(loadError.message);
      }
    }
    loadBehaviorMetadata();
    return () => { mounted = false; };
  }, [model]);

  useEffect(() => {
    if (!model || !metadataKey || !modelInfo) {
      setMetadataDetail(null);
      return undefined;
    }
    let mounted = true;
    const params = new URLSearchParams({ model, key: metadataKey });
    fetch(`${API}/metadata?${params}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Could not read metadata (HTTP ${response.status}).`);
        if (!mounted) return;
        setMetadataDetail(data);
        setMetadataJson(JSON.stringify(data.value, null, 2));
      })
      .catch((loadError) => {
        if (!mounted) return;
        console.error("Could not load selected GGUF metadata:", loadError);
        setMetadataDetail(null);
        setMetadataError(loadError.message);
      });
    return () => { mounted = false; };
  }, [model, metadataKey, modelInfo]);

  useEffect(() => {
    if (!model || !selectedTensor || !modelInfo) {
      setSample(null);
      setSampleError("");
      return undefined;
    }
    let mounted = true;
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams({
        model,
        tensor: selectedTensor,
        index: sampleIndex || "0",
        count: "8",
      });
      fetch(`${API}/sample?${params}`)
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || `Could not sample tensor (HTTP ${response.status}).`);
          if (!mounted) return;
          setSample(data);
          setSampleError("");
        })
        .catch((sampleFailure) => {
          if (!mounted) return;
          setSample(null);
          setSampleError(sampleFailure.message);
        });
    }, 180);
    return () => {
      mounted = false;
      window.clearTimeout(timeout);
    };
  }, [model, selectedTensor, sampleIndex, modelInfo]);

  useEffect(() => {
    if (status.status !== "completed" || !status.output) return;
    const outputName = status.output.split(/[\\/]/).pop();
    loadModels(outputName);
    onModelSaved?.();
  }, [status.status]);

  const currentTensor = modelInfo?.tensors.find((tensor) => tensor.name === selectedTensor);
  const filteredTensors = (modelInfo?.tensors || []).filter((tensor) =>
    tensor.name.toLowerCase().includes(tensorFilter.trim().toLowerCase()),
  );
  const isRunning = status.status === "running" || status.status === "stopping";

  function queueDirectEdit() {
    setError("");
    if (!model || !currentTensor || !currentTensor.editable) {
      setError("Select an editable tensor first.");
      return;
    }
    let operation;
    if (editType === "set") {
      const index = Number(editIndex);
      const value = Number(editValue);
      if (!Number.isSafeInteger(index) || index < 0 || index >= currentTensor.elements || !Number.isFinite(value)) {
        setError("Enter an in-range tensor index and a finite numeric value.");
        return;
      }
      operation = { tensor: selectedTensor, op: "set", index, value };
    } else if (editType === "scale") {
      const factor = Number(editFactor);
      if (!Number.isFinite(factor) || Math.abs(factor) > 100) {
        setError("Enter a finite scale factor between -100 and 100.");
        return;
      }
      operation = { tensor: selectedTensor, op: "scale", factor };
    } else if (editType === "add") {
      const value = Number(editValue);
      if (!Number.isFinite(value)) {
        setError("Enter a finite number to add.");
        return;
      }
      operation = { tensor: selectedTensor, op: "add", value };
    } else {
      const min = Number(clampMin);
      const max = Number(clampMax);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        setError("Enter finite clamp bounds where minimum is no greater than maximum.");
        return;
      }
      operation = { tensor: selectedTensor, op: "clamp", min, max };
    }
    setOperations((current) => [...current, operation]);
  }

  function queueMetadataEdit(key, value) {
    setError("");
    if (operations.length >= 1000) {
      setError("A maximum of 1,000 operations can be queued at once.");
      return;
    }
    setOperations((current) => [...current, { op: "metadata_set", key, value }]);
  }

  function queueGenericMetadataEdit() {
    setError("");
    try {
      const value = JSON.parse(metadataJson);
      queueMetadataEdit(metadataKey, value);
    } catch (parseError) {
      setError(`Metadata value must be valid JSON: ${parseError.message}`);
    }
  }

  function queueScriptOperations() {
    setError("");
    try {
      const parsed = JSON.parse(script);
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(
        (operation) => !operation || typeof operation !== "object" || Array.isArray(operation),
      )) {
        throw new Error("A script must be a JSON array of operation objects.");
      }
      if (operations.length + parsed.length > 1000) {
        throw new Error("A maximum of 1,000 operations can be queued at once.");
      }
      setOperations((current) => [...current, ...parsed]);
    } catch (parseError) {
      setError(parseError.message || "The script must be valid JSON.");
    }
  }

  async function importScript(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 1_000_000) {
      setError("Choose a JSON script smaller than 1 MB.");
      return;
    }
    try {
      setScript(await file.text());
      setScriptImported(true);
      setError("");
    } catch (readError) {
      console.error("Could not read tensor script:", readError);
      setError(`Could not read the script: ${readError.message}`);
    }
  }

  async function runEdits() {
    setError("");
    if (!model || operations.length === 0) {
      setError("Choose a model and queue at least one operation.");
      return;
    }
    try {
      const response = await fetch(`${API}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, operations }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Could not start edit (HTTP ${response.status}).`);
      setStatus((current) => ({ ...current, ...data, ready: true }));
    } catch (editError) {
      console.error("Could not start GGUF edit:", editError);
      setError(editError.message);
    }
  }

  async function stopEdits() {
    try {
      const response = await fetch(`${API}/stop`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Could not stop edit (HTTP ${response.status}).`);
      setStatus((current) => ({ ...current, ...data }));
    } catch (stopError) {
      console.error("Could not stop GGUF edit:", stopError);
      setError(stopError.message);
    }
  }

  async function refreshAll() {
    setError("");
    await Promise.all([loadModels(), refreshStatus(true)]);
  }

  return (
    <div className="gguf-editor-scroll">
      <div className="gguf-editor-content">
        <header className="gguf-editor-heading">
          <span className="gguf-editor-eyebrow"><BrainCircuit size={15} /> GGUF WEIGHT WORKBENCH</span>
          <h1>Edit the weights<br /><em>inside your model files.</em></h1>
          <p>Inspect tensors, change selected values, scale or clamp a whole tensor, or queue a JSON edit script.</p>
        </header>

        <div className={`gguf-editor-status ${status.ready ? "gguf-editor-status-ready" : "gguf-editor-status-setup"}`} role="status">
          {status.ready ? <Check size={17} /> : <CircleAlert size={17} />}
          <div>
            <strong>
              {isRunning
                ? status.status === "stopping" ? "Stopping GGUF edit…" : "Writing edited model copy"
                : status.status === "completed"
                  ? "GGUF edit complete"
                  : status.ready ? "Local GGUF editor ready" : "Set up the local GGUF editor"}
            </strong>
            <span>{status.message || (status.ready ? "GGUF files stay on this device." : "Install the lightweight local editor dependencies to continue.")}</span>
          </div>
          {!status.ready && (
            <button type="button" className="gguf-refresh-button" onClick={() => refreshStatus(true)}>
              <RefreshCw size={14} /><span>Check again</span>
            </button>
          )}
        </div>

        {!status.ready && (
          <section className="gguf-setup-card">
            <h2>Install the local GGUF tools</h2>
            <p>This installs NumPy and llama.cpp’s GGUF Python library in a separate environment. It does not modify either model.</p>
            <code>sh scripts/setup-gguf-editor.sh</code>
            <p>Run this from the Aether project folder, then return here and select <strong>Check again</strong>.</p>
          </section>
        )}

        <section className="gguf-file-card">
          <div className="gguf-card-title">
            <div>
              <span className="gguf-step">01 / MODEL FILE</span>
              <h2>Select a GGUF to inspect</h2>
            </div>
            <button type="button" className="gguf-secondary-button" onClick={refreshAll} aria-label="Refresh models and editor status">
              <RefreshCw size={14} /><span>Refresh</span>
            </button>
          </div>
          <label htmlFor="gguf-model-select">GGUF in ~/Models/Aether</label>
          <CustomSelect
            id="gguf-model-select"
            value={model}
            options={models.length === 0
              ? [{ value: "", label: loadingModels ? "Loading local files…" : "No GGUF models found" }]
              : models.map((item) => ({
                value: item.name,
                label: `${item.displayName || item.name} · ${formatBytes(item.size)}`,
              }))}
            onChange={(value) => {
              setModel(value);
              setError("");
            }}
            disabled={loadingModels || models.length === 0}
          />
          {models.length === 0 && !loadingModels && (
            <p className="gguf-muted-note">Place GGUF files in <code>~/Models/Aether</code>, then refresh this page.</p>
          )}
          {modelInfo && (
            <div className="gguf-metadata-summary">
              <span>{formatBytes(modelInfo.size)}</span>
              <span>{modelInfo.tensorCount.toLocaleString()} tensors</span>
              {modelInfo.metadata["general.architecture"] && <span>{modelInfo.metadata["general.architecture"]}</span>}
              {modelInfo.metadata["general.name"] && <span>{modelInfo.metadata["general.name"]}</span>}
            </div>
          )}
          {loadingModelInfo && <p className="gguf-muted-note">Reading GGUF metadata…</p>}
        </section>

        <section className="gguf-panel gguf-model-name-panel">
          <span className="gguf-step">MODEL IDENTITY</span>
          <h2>Model name</h2>
          <label htmlFor="gguf-model-name">Name shown by Aether and compatible loaders</label>
          <input
            id="gguf-model-name"
            value={modelName}
            onChange={(event) => setModelName(event.target.value)}
            maxLength={500}
            placeholder="Enter a display name for this model"
            disabled={!modelInfo}
          />
          <button
            type="button"
            className="gguf-add-operation"
            disabled={!modelInfo || !modelName.trim()}
            onClick={() => queueMetadataEdit("general.name", modelName.trim())}
          >
            <Plus size={15} /> Queue name change
          </button>
          <p className="gguf-muted-note">This edits the saved copy’s <code>general.name</code>; the original stays untouched. Aether’s model picker shows the new name immediately, but llama.cpp must load the copy before you can chat with it.</p>
        </section>

        <div className="gguf-editor-columns gguf-behavior-columns">
          <section className="gguf-panel">
            <span className="gguf-step">MODEL BEHAVIOR</span>
            <h2>Aether rules and personality</h2>
            <p className="gguf-muted-note">Saved as <code>aether.system_prompt</code> in this GGUF and applied by Aether when this model chats. Other inference apps may ignore this custom field.</p>
            <textarea
              className="gguf-script-input gguf-behavior-input"
              value={modelRules}
              onChange={(event) => setModelRules(event.target.value)}
              placeholder="Write the rules or personality you want Aether to use with this model."
              aria-label="Model behavior rules"
            />
            <button type="button" className="gguf-add-operation" disabled={!model} onClick={() => queueMetadataEdit("aether.system_prompt", modelRules)}>
              <Plus size={15} /> Queue model rules
            </button>
          </section>
          <section className="gguf-panel">
            <span className="gguf-step">INFERENCE FORMAT</span>
            <h2>Chat template</h2>
            <p className="gguf-muted-note">This Jinja template is used by compatible inference servers. Invalid templates can prevent the model from loading.</p>
            <textarea
              className="gguf-script-input gguf-chat-template-input"
              value={chatTemplate}
              onChange={(event) => setChatTemplate(event.target.value)}
              placeholder="The model's tokenizer.chat_template appears here."
              spellCheck="false"
              aria-label="GGUF chat template"
            />
            <button type="button" className="gguf-add-operation" disabled={!model || !chatTemplate.trim()} onClick={() => queueMetadataEdit("tokenizer.chat_template", chatTemplate)}>
              <Plus size={15} /> Queue chat template
            </button>
          </section>
        </div>
        {metadataError && <p className="gguf-inline-error" role="alert">{metadataError}</p>}

        <div className="gguf-editor-columns">
          <section className="gguf-panel">
            <div className="gguf-card-title">
              <div>
                <span className="gguf-step">02 / TENSOR BROWSER</span>
                <h2>Inspect tensor weights</h2>
              </div>
            </div>
            <label htmlFor="gguf-tensor-filter">Find a tensor</label>
            <div className="gguf-search-field">
              <Search size={14} />
              <input
                id="gguf-tensor-filter"
                value={tensorFilter}
                onChange={(event) => setTensorFilter(event.target.value)}
                placeholder="Filter by tensor name"
              />
            </div>
            <CustomSelect
              id="gguf-tensor-list"
              className="gguf-tensor-select"
              listbox
              value={selectedTensor}
              options={filteredTensors.map((tensor) => ({
                value: tensor.name,
                label: `${tensor.name} · ${tensor.type} · ${tensor.elements.toLocaleString()}`,
              }))}
              onChange={(value) => {
                setSelectedTensor(value);
                setSampleIndex("0");
              }}
              disabled={!modelInfo}
              aria-label="Tensor list"
            />
            {currentTensor && (
              <div className="gguf-tensor-detail">
                <div><span>Type</span><strong>{currentTensor.type}</strong></div>
                <div><span>Shape</span><strong>[{currentTensor.shape.join(" × ")}]</strong></div>
                <div><span>Elements</span><strong>{currentTensor.elements.toLocaleString()}</strong></div>
              </div>
            )}
            {currentTensor?.editable ? (
              <div className="gguf-sample">
                <div className="gguf-sample-heading">
                  <label htmlFor="gguf-sample-index">Values from flat index</label>
                  <input
                    id="gguf-sample-index"
                    type="number"
                    min="0"
                    max={Math.max(0, (currentTensor?.elements || 1) - 1)}
                    value={sampleIndex}
                    onChange={(event) => setSampleIndex(event.target.value)}
                  />
                </div>
                {sampleError && <p className="gguf-inline-error" role="alert">{sampleError}</p>}
                {sample?.values && (
                  <div className="gguf-sample-values">
                    {sample.values.map((value, index) => (
                      <span key={index}><small>{Number(sampleIndex) + index}</small>{value === null ? "non-finite" : value.toPrecision(6)}</span>
                    ))}
                  </div>
                )}
              </div>
            ) : currentTensor ? (
              <p className="gguf-muted-note">{modelInfo?.note}</p>
            ) : null}
          </section>

          <section className="gguf-panel">
            <span className="gguf-step">03 / EDIT</span>
            <h2>Queue a weight operation</h2>
            <label htmlFor="gguf-edit-type">Operation</label>
            <CustomSelect
              id="gguf-edit-type"
              value={editType}
              options={[
                { value: "set", label: "Set one value" },
                { value: "scale", label: "Scale the whole tensor" },
                { value: "add", label: "Add to every value" },
                { value: "clamp", label: "Clamp all values" },
              ]}
              onChange={setEditType}
            />
            {editType === "set" && (
              <>
                <label htmlFor="gguf-edit-index">Flat index</label>
                <input id="gguf-edit-index" type="number" min="0" max={Math.max(0, (currentTensor?.elements || 1) - 1)} value={editIndex} onChange={(event) => setEditIndex(event.target.value)} />
                <label htmlFor="gguf-edit-value">New value</label>
                <input id="gguf-edit-value" type="number" step="any" value={editValue} onChange={(event) => setEditValue(event.target.value)} />
              </>
            )}
            {editType === "scale" && (
              <>
                <label htmlFor="gguf-edit-factor">Scale factor</label>
                <input id="gguf-edit-factor" type="number" step="any" value={editFactor} onChange={(event) => setEditFactor(event.target.value)} />
              </>
            )}
            {editType === "add" && (
              <>
                <label htmlFor="gguf-add-value">Value to add</label>
                <input id="gguf-add-value" type="number" step="any" value={editValue} onChange={(event) => setEditValue(event.target.value)} />
              </>
            )}
            {editType === "clamp" && (
              <div className="gguf-clamp-fields">
                <div><label htmlFor="gguf-clamp-min">Minimum</label><input id="gguf-clamp-min" type="number" step="any" value={clampMin} onChange={(event) => setClampMin(event.target.value)} /></div>
                <div><label htmlFor="gguf-clamp-max">Maximum</label><input id="gguf-clamp-max" type="number" step="any" value={clampMax} onChange={(event) => setClampMax(event.target.value)} /></div>
              </div>
            )}
            <button type="button" className="gguf-add-operation" disabled={!currentTensor?.editable} onClick={queueDirectEdit}>
              <Plus size={15} /> Add to edit queue
            </button>
            <p className="gguf-muted-note">Weight index uses row-major order. Quantized tensors are decoded and re-quantized when changed.</p>
          </section>
        </div>

        <section className="gguf-panel gguf-script-panel">
          <div className="gguf-card-title">
            <div>
              <span className="gguf-step">04 / SCRIPT</span>
              <h2>Queue your own edit script</h2>
            </div>
            <label className="gguf-secondary-button gguf-import-button">
              <FileUp size={14} /><span>{scriptImported ? "Replace JSON" : "Import JSON"}</span>
              <input type="file" accept=".json,.txt" onChange={importScript} />
            </label>
          </div>
          <p className="gguf-muted-note">Scripts are JSON operation lists—not executable Python. Supported operations: <code>set</code>, <code>scale</code>, <code>add</code>, <code>clamp</code>, and <code>metadata_set</code>. Examples: <code>{'{"tensor":"TENSOR_NAME","op":"scale","factor":0.99}'}</code> and <code>{'{"op":"metadata_set","key":"general.name","value":"My Model"}'}</code>.</p>
          <textarea
            className="gguf-script-input"
            value={script}
            onChange={(event) => {
              setScript(event.target.value);
              setScriptImported(false);
            }}
            spellCheck="false"
            aria-label="JSON tensor edit script"
          />
          <button type="button" className="gguf-add-operation" onClick={queueScriptOperations}>
            <Plus size={15} /> Queue script operations
          </button>
        </section>

        <section className="gguf-panel gguf-metadata-panel">
          <span className="gguf-step">GGUF METADATA</span>
          <h2>Edit another metadata field</h2>
          <label htmlFor="gguf-metadata-key">Metadata key</label>
          <CustomSelect
            id="gguf-metadata-key"
            value={metadataKey}
            options={[
              ...(modelInfo?.metadataFields || [])
                .filter((field) => field.editable)
                .map((field) => ({ value: field.key, label: `${field.key} · ${field.type}` })),
              ...(!modelInfo?.metadataFields?.some((field) => field.key === "aether.system_prompt")
                ? [{ value: "aether.system_prompt", label: "aether.system_prompt · STRING (Aether custom)" }]
                : []),
            ]}
            onChange={setMetadataKey}
          />
          <label htmlFor="gguf-metadata-value">Value as JSON</label>
          <textarea
            id="gguf-metadata-value"
            className="gguf-script-input"
            value={metadataJson}
            onChange={(event) => setMetadataJson(event.target.value)}
            spellCheck="false"
            aria-label="GGUF metadata value in JSON"
          />
          <p className="gguf-muted-note">
            {metadataDetail?.exists
              ? `Current type: ${metadataDetail.type}${metadataDetail.subtype ? ` / ${metadataDetail.subtype}` : ""}. Keep the JSON value compatible with this type.`
              : "This field does not exist yet; new metadata fields are stored as strings."}
          </p>
          <button type="button" className="gguf-add-operation" disabled={!metadataDetail?.editable} onClick={queueGenericMetadataEdit}>
            <Plus size={15} /> Queue metadata change
          </button>
        </section>

        <section className="gguf-panel gguf-queue-panel">
          <div className="gguf-card-title">
            <div>
              <span className="gguf-step">05 / SAVE COPY</span>
              <h2>{operations.length} queued {operations.length === 1 ? "operation" : "operations"}</h2>
            </div>
            <button type="button" className="gguf-clear-button" disabled={operations.length === 0 || isRunning} onClick={() => setOperations([])}>
              Clear queue
            </button>
          </div>
          {operations.length > 0 ? (
            <ol className="gguf-operation-list">
              {operations.map((operation, index) => (
                <li key={`${index}-${operation.tensor}-${operation.op}`}>
                  <code>{operationLabel(operation)}</code>
                  <button type="button" aria-label={`Remove operation ${index + 1}`} onClick={() => setOperations((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ol>
          ) : <p className="gguf-muted-note">No edits queued yet. Select a tensor or add JSON operations above.</p>}
          <button type="button" className="gguf-run-button" disabled={!status.ready || isRunning || !model || operations.length === 0} onClick={runEdits}>
            {isRunning ? <><LoaderCircle className="gguf-spinner" size={16} /> Writing copy…</> : <><Download size={16} /> Save edited copy</>}
          </button>
          {status.status === "running" && <button type="button" className="gguf-stop-button" onClick={stopEdits}>Stop edit</button>}
          <p className="gguf-warning">The original file is never overwritten. Saving rewrites a full model-sized copy, may take several minutes, and needs extra disk space. Q4_K-family tensors use a local llama.cpp <code>llama-quantize</code> executable for re-quantization.</p>
        </section>

        {error && <p className="gguf-error" role="alert">{error}</p>}
        {status.output && status.status === "completed" && (
          <p className="gguf-complete" role="status">Saved edited model: <code>{status.output}</code>. Restart llama.cpp and refresh Aether’s model list before chatting with it.</p>
        )}
        {status.logs?.length > 0 && (
          <details className="gguf-log" open={isRunning || status.status === "failed"}>
            <summary>Editor log</summary>
            <pre>{status.logs.slice(-18).join("\n")}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
