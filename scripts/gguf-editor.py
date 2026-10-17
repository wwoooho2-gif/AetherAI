#!/usr/bin/env python3
"""Inspect GGUF tensors and write edited models without changing their sources."""

import argparse
import json
import math
import os
import shutil
import sys
import subprocess
from pathlib import Path

import numpy as np


MODEL_DIRECTORY = Path.home() / "Models" / "Aether"
MAX_OPERATIONS = 1000
MAX_TENSOR_ELEMENTS = 100_000_000
MAX_ABS_VALUE = 1_000_000
MAX_METADATA_ITEMS = 256
MAX_METADATA_TEXT = 1_000_000


def load_gguf():
    try:
        from gguf.constants import GGMLQuantizationType, GGUFValueType
        from gguf.gguf_reader import GGUFReader
        from gguf.gguf_writer import GGUFWriter
        from gguf.quants import dequantize, quantize
    except ImportError as error:
        raise RuntimeError(
            f"GGUF editor dependency is missing: {error}. Run `sh scripts/setup-gguf-editor.sh`."
        ) from error
    return GGMLQuantizationType, GGUFValueType, GGUFReader, GGUFWriter, dequantize, quantize


def model_path(name: str) -> Path:
    if not name or Path(name).name != name or not name.lower().endswith(".gguf"):
        raise ValueError("Choose a GGUF file from the Aether models folder.")
    path = MODEL_DIRECTORY / name
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"GGUF model not found: {name}")
    return path


def reader_for(name: str):
    _, _, reader_type, _, _, _ = load_gguf()
    return reader_type(str(model_path(name)))


def close_reader(reader):
    mmap = getattr(reader.data, "_mmap", None)
    if mmap is not None:
        mmap.close()


def inspect_model(name: str) -> dict:
    path = model_path(name)
    value_types = load_gguf()[1]
    reader = reader_for(name)
    try:
        metadata = {}
        for key in ("general.architecture", "general.name", "general.file_type", "tokenizer.ggml.model"):
            field = reader.get_field(key)
            if field is not None:
                value = field.contents()
                if isinstance(value, str) and len(value) > 500:
                    value = value[:500] + "…"
                metadata[key] = value
        tensors = [
            {
                "name": tensor.name,
                "shape": list(reversed([int(dimension) for dimension in tensor.shape])),
                "elements": tensor.n_elements,
                "bytes": tensor.n_bytes,
                "type": tensor.tensor_type.name,
                "editable": tensor.n_elements <= MAX_TENSOR_ELEMENTS,
            }
            for tensor in reader.tensors
        ]
        metadata_fields = []
        for key, field in reader.fields.items():
            if not field.types:
                continue
            value_type = field.types[0]
            item_count = len(field.data) if value_type == value_types.ARRAY else None
            metadata_fields.append({
                "key": key,
                "type": value_type.name,
                "subtype": field.types[-1].name if value_type == value_types.ARRAY else None,
                "items": item_count,
                "editable": (
                    not key.startswith("GGUF.")
                    and key != "general.architecture"
                    and (item_count is None or item_count <= MAX_METADATA_ITEMS)
                ),
            })
        return {
            "fileName": name,
            "size": path.stat().st_size,
            "metadata": metadata,
            "metadataFields": metadata_fields,
            "tensorCount": len(tensors),
            "tensors": tensors,
            "note": f"Tensors over {MAX_TENSOR_ELEMENTS:,} values are read-only in this editor.",
        }
    finally:
        close_reader(reader)


def list_models() -> list[dict]:
    if not MODEL_DIRECTORY.is_dir():
        return []
    models = []
    model_paths = (
        path for path in MODEL_DIRECTORY.iterdir()
        if path.is_file() and path.suffix.lower() == ".gguf"
    )
    for path in sorted(model_paths, key=lambda item: item.name.lower()):
        model = {
            "name": path.name,
            "displayName": path.stem,
            "size": path.stat().st_size,
        }
        reader = None
        try:
            reader = reader_for(path.name)
            field = reader.get_field("general.name")
            if field is not None:
                display_name = field.contents()
                if isinstance(display_name, str) and display_name.strip():
                    model["displayName"] = display_name.strip()
        except Exception as error:
            model["metadataError"] = str(error)
        finally:
            if reader is not None:
                close_reader(reader)
        models.append(model)
    return models


def json_value(value):
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return [json_value(item) for item in value.tolist()]
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    return value


def read_metadata(name: str, key: str) -> dict:
    if not key or len(key) > 128:
        raise ValueError("Choose a valid GGUF metadata key.")
    reader = reader_for(name)
    try:
        field = reader.get_field(key)
        if field is None:
            return {"key": key, "exists": False, "type": "STRING", "editable": True, "value": ""}
        value_type = field.types[0]
        items = len(field.data) if value_type.name == "ARRAY" else None
        editable = (
            not key.startswith("GGUF.")
            and key != "general.architecture"
            and (items is None or items <= MAX_METADATA_ITEMS)
        )
        value = json_value(field.contents()) if editable else None
        if value is not None and len(json.dumps(value, ensure_ascii=False)) > MAX_METADATA_TEXT:
            editable = False
            value = None
        return {
            "key": key,
            "exists": True,
            "type": value_type.name,
            "subtype": field.types[-1].name if value_type.name == "ARRAY" else None,
            "editable": editable,
            "value": value,
        }
    finally:
        close_reader(reader)


def sample_tensor(name: str, tensor_name: str, index: int, count: int) -> dict:
    _, _, _, _, dequantize, _ = load_gguf()
    reader = reader_for(name)
    try:
        tensor = next((item for item in reader.tensors if item.name == tensor_name), None)
        if tensor is None:
            raise ValueError("The selected tensor does not exist in this GGUF.")
        if tensor.n_elements > MAX_TENSOR_ELEMENTS:
            raise ValueError(f"This tensor has more than {MAX_TENSOR_ELEMENTS:,} values and cannot be previewed here.")
        if index < 0 or index >= tensor.n_elements or count < 1 or count > 32:
            raise ValueError("Choose an in-range index and preview between 1 and 32 values.")
        first = tensor.data.reshape(-1, tensor.data.shape[-1])
        logical_shape = list(reversed([int(dimension) for dimension in tensor.shape]))
        logical_row_length = logical_shape[-1]
        row_index, row_offset = divmod(index, logical_row_length)
        values = dequantize(first[row_index], tensor.tensor_type).reshape(-1)
        sample = [
            float(value) if math.isfinite(float(value)) else None
            for value in values[row_offset : min(row_offset + count, len(values))]
        ]
        return {"tensor": tensor_name, "index": index, "values": sample}
    finally:
        close_reader(reader)


def validate_metadata_value(key: object, value: object, reader, value_types):
    if not isinstance(key, str) or not key or len(key) > 128:
        raise ValueError("Metadata keys must be non-empty strings of at most 128 characters.")
    if key.startswith("GGUF.") or key == "general.architecture":
        raise ValueError(f"Metadata key {key!r} is reserved and cannot be edited.")
    field = reader.get_field(key)
    if field is None:
        if not isinstance(value, str) or len(value) > MAX_METADATA_TEXT:
            raise ValueError("New metadata fields must be strings up to 1 MB.")
        return value_types.STRING, None, value

    value_type = field.types[0]
    subtype = field.types[-1] if value_type == value_types.ARRAY else None
    if value_type == value_types.ARRAY:
        if not isinstance(value, list) or len(value) > MAX_METADATA_ITEMS:
            raise ValueError(f"Array metadata must contain at most {MAX_METADATA_ITEMS:,} items.")
        item_type = subtype.name
        if any(not metadata_scalar_matches(item_type, item) for item in value):
            raise ValueError(f"Metadata array values must match the GGUF {item_type} type.")
        if item_type == "STRING" and any(len(item) > MAX_METADATA_TEXT for item in value):
            raise ValueError("Metadata strings cannot exceed 1 MB each.")
        if len(json.dumps(value, ensure_ascii=False)) > MAX_METADATA_TEXT:
            raise ValueError("Metadata arrays cannot exceed 1 MB when encoded as JSON.")
        return value_type, subtype, value

    type_name = value_type.name
    if not metadata_scalar_matches(type_name, value):
        raise ValueError(f"Metadata value for {key!r} must match its existing GGUF {type_name} type.")
    if type_name == "STRING" and len(value) > MAX_METADATA_TEXT:
        raise ValueError("Metadata strings cannot exceed 1 MB.")
    if key == "general.alignment" and (value < 1 or value > 4096 or value & (value - 1)):
        raise ValueError("GGUF alignment must be a power of two between 1 and 4096.")
    return value_type, None, value


def metadata_scalar_matches(type_name: str, value: object) -> bool:
    if type_name == "STRING":
        return isinstance(value, str)
    if type_name == "BOOL":
        return isinstance(value, bool)
    if type_name.startswith(("UINT", "INT")):
        if not isinstance(value, int) or isinstance(value, bool):
            return False
        bits = int(type_name[4:] if type_name.startswith("UINT") else type_name[3:])
        minimum = 0 if type_name.startswith("UINT") else -(2 ** (bits - 1))
        maximum = 2**bits - 1 if type_name.startswith("UINT") else 2 ** (bits - 1) - 1
        return minimum <= value <= maximum
    if type_name.startswith("FLOAT"):
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            return False
        bits = int(type_name.removeprefix("FLOAT"))
        return abs(value) <= (3.4028235e38 if bits == 32 else 1.7976931348623157e308)
    return False


def validate_operations(operations: object, reader, quantization_types, value_types):
    if not isinstance(operations, list) or not 1 <= len(operations) <= MAX_OPERATIONS:
        raise ValueError(f"Provide between 1 and {MAX_OPERATIONS} scripted operations.")
    tensors = {tensor.name: tensor for tensor in reader.tensors}
    grouped: dict[str, list[dict]] = {}
    metadata_updates = {}
    for operation in operations:
        if not isinstance(operation, dict):
            raise ValueError("Each scripted operation must be a JSON object.")
        if operation.get("op") == "metadata_set":
            key = operation.get("key")
            value_type, subtype, value = validate_metadata_value(
                key, operation.get("value"), reader, value_types
            )
            metadata_updates[key] = {
                "type": value_type,
                "subtype": subtype,
                "value": value,
            }
            continue
        tensor_name = operation.get("tensor")
        tensor = tensors.get(tensor_name)
        if tensor is None:
            raise ValueError(f"Tensor not found: {tensor_name!r}")
        if tensor.n_elements > MAX_TENSOR_ELEMENTS:
            raise ValueError(f"Tensor {tensor_name!r} is too large to edit in this version.")
        if tensor.tensor_type not in {
            quantization_types.F16,
            quantization_types.F32,
        } and not tensor.tensor_type.name.startswith(("Q", "IQ", "TQ")):
            raise ValueError(f"Tensor {tensor_name!r} uses an unsupported type ({tensor.tensor_type.name}).")

        op = operation.get("op")
        if op == "set":
            index = operation.get("index")
            value = operation.get("value")
            if not isinstance(index, int) or not 0 <= index < tensor.n_elements:
                raise ValueError(f"Set operation index for {tensor_name!r} is out of range.")
            if not is_valid_number(value):
                raise ValueError("Set values must be finite numbers within ±1,000,000.")
            normalized = {"op": op, "index": index, "value": value}
        elif op in {"scale", "add"}:
            key = "factor" if op == "scale" else "value"
            value = operation.get(key)
            if not is_valid_number(value) or (op == "scale" and abs(value) > 100):
                raise ValueError(f"{key} must be finite; scale factors must be between -100 and 100.")
            normalized = {"op": op, key: value}
        elif op == "clamp":
            minimum = operation.get("min")
            maximum = operation.get("max")
            if (
                not is_valid_number(minimum)
                or not is_valid_number(maximum)
                or minimum > maximum
            ):
                raise ValueError("Clamp operations require finite min and max values, with min ≤ max.")
            normalized = {"op": op, "min": minimum, "max": maximum}
        else:
            raise ValueError("Script operations support only set, scale, add, and clamp.")
        grouped.setdefault(tensor_name, []).append(normalized)
    return grouped, metadata_updates


def is_valid_number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and abs(value) <= MAX_ABS_VALUE
        and math.isfinite(value)
    )


def transform_rows(tensor, operations: list[dict], scratch_path: Path, dequantize, quantize):
    if tensor.n_elements > MAX_TENSOR_ELEMENTS:
        raise ValueError(f"Tensor {tensor.name!r} exceeds the safe editing size limit.")
    values_shape = list(reversed([int(dimension) for dimension in tensor.shape]))
    row_length = values_shape[-1]
    raw_rows = tensor.data.reshape(-1, tensor.data.shape[-1])
    try:
        quantize(np.zeros((1, row_length), dtype=np.float32), tensor.tensor_type)
        requantize_with_llama = False
    except NotImplementedError:
        requantize_with_llama = True
    output_shape = values_shape if requantize_with_llama else tensor.data.shape
    output_dtype = np.float32 if requantize_with_llama else tensor.data.dtype
    output = np.memmap(scratch_path, mode="w+", dtype=output_dtype, shape=output_shape)
    output_rows = output.reshape((-1, row_length)) if requantize_with_llama else output.reshape(raw_rows.shape)

    try:
        for row_index in range(raw_rows.shape[0]):
            values = dequantize(raw_rows[row_index], tensor.tensor_type).reshape(-1).copy()
            start_index = row_index * row_length
            end_index = start_index + len(values)
            for operation in operations:
                op = operation["op"]
                if op == "set":
                    if start_index <= operation["index"] < end_index:
                        values[operation["index"] - start_index] = operation["value"]
                elif op == "scale":
                    np.multiply(values, operation["factor"], out=values)
                elif op == "add":
                    np.add(values, operation["value"], out=values)
                elif op == "clamp":
                    np.clip(values, operation["min"], operation["max"], out=values)
            if not np.isfinite(values).all():
                raise ValueError(f"Operations produced non-finite values in {tensor.name!r}.")
            if requantize_with_llama:
                output_rows[row_index] = values
            else:
                encoded = quantize(values.reshape((1, row_length)), tensor.tensor_type).reshape(-1)
                if encoded.size != output_rows[row_index].size:
                    raise RuntimeError(f"Unexpected encoded tensor size for {tensor.name!r}.")
                output_rows[row_index] = encoded
        output.flush()
        output_type = None if requantize_with_llama else tensor.tensor_type
        return output, output_type, requantize_with_llama
    except Exception:
        output.flush()
        output._mmap.close()
        scratch_path.unlink(missing_ok=True)
        raise


def llama_quantizer() -> str | None:
    configured = os.environ.get("AETHER_LLAMA_QUANTIZE")
    if configured:
        return configured if Path(configured).is_file() and os.access(configured, os.X_OK) else None
    discovered = shutil.which("llama-quantize")
    if discovered:
        return discovered
    for candidate in (
        Path.home() / ".local" / "lib" / "ollama" / "llama-quantize",
        Path.home() / "llama.cpp" / "build" / "bin" / "llama-quantize",
    ):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def run_llama_requantization(
    executable: str,
    source_path: Path,
    output_path: Path,
    tensor_types: dict[str, str],
) -> None:
    command = [executable]
    for name, tensor_type in tensor_types.items():
        command.extend(["--tensor-type", f"{name}={tensor_type}"])
    command.extend([str(source_path), str(output_path), "Q4_K_M"])
    print("Re-quantizing edited tensors with llama.cpp.", flush=True)
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    output = "\n".join(part for part in (result.stdout, result.stderr) if part.strip())
    if output:
        print(output, flush=True)
    if result.returncode:
        raise RuntimeError(
            f"llama-quantize failed with exit code {result.returncode}; "
            "the intermediate file was not saved as a model."
        )


def copy_metadata(reader, writer, value_types, metadata_updates):
    for name, field in reader.fields.items():
        if name.startswith("GGUF.") or name == "general.architecture" or not field.types:
            continue
        value_type = field.types[0]
        sub_type = field.types[-1] if value_type == value_types.ARRAY else None
        update = metadata_updates.get(name)
        if update:
            value_type, sub_type, value = update["type"], update["subtype"], update["value"]
        else:
            value = field.contents()
        if name == "general.alignment":
            writer.data_alignment = int(value)
        writer.add_key_value(name, value, value_type, sub_type)
    for name, update in metadata_updates.items():
        if name not in reader.fields:
            writer.add_key_value(name, update["value"], update["type"], update["subtype"])


def edit_model(name: str, output_name: str, operations_path: Path) -> dict:
    source_path = model_path(name)
    if not output_name or Path(output_name).name != output_name or not output_name.lower().endswith(".gguf"):
        raise ValueError("The edited model must use a new GGUF filename.")
    output_path = MODEL_DIRECTORY / output_name
    if source_path == output_path:
        raise ValueError("The edited model must use a new filename; the source will never be overwritten.")
    if output_path.exists():
        raise ValueError("A model with the requested output name already exists.")

    quantization_types, value_types, reader_type, writer_type, dequantize, quantize = load_gguf()
    reader = reader_type(str(source_path))
    writer = None
    partial_path = output_path.with_name(output_path.name + ".part")
    requantized_path = output_path.with_name(output_path.name + ".requantized.part")
    open_memmaps = []
    try:
        architecture_field = reader.get_field("general.architecture")
        if architecture_field is None:
            raise ValueError("GGUF is missing its model architecture metadata.")
        architecture = architecture_field.contents()
        with operations_path.open(encoding="utf8") as handle:
            operations = json.load(handle)
        grouped, metadata_updates = validate_operations(
            operations, reader, quantization_types, value_types
        )
        target_types = {
            tensor.name: tensor.tensor_type.name
            for tensor in reader.tensors
            if tensor.name in grouped and tensor.tensor_type not in {
                quantization_types.F16,
                quantization_types.F32,
            }
        }
        quantizer = None
        if target_types:
            for tensor in reader.tensors:
                if tensor.name not in target_types:
                    continue
                try:
                    quantize(
                        np.zeros((1, int(tensor.shape[0])), dtype=np.float32),
                        tensor.tensor_type,
                    )
                except NotImplementedError:
                    if quantizer is None:
                        quantizer = llama_quantizer()
                    if quantizer is None:
                        raise RuntimeError(
                            f"Editing {tensor.tensor_type.name} tensors requires llama-quantize. "
                            "Add it to PATH or set AETHER_LLAMA_QUANTIZE to its executable."
                        )

        work_directory = operations_path.parent
        writer = writer_type(str(partial_path), architecture, use_temp_file=True, endianess=reader.endianess)
        copy_metadata(reader, writer, value_types, metadata_updates)
        llama_tensor_types = {}

        for tensor_index, tensor in enumerate(reader.tensors):
            tensor_operations = grouped.get(tensor.name)
            if tensor_operations:
                print(f"Editing tensor {tensor_index + 1}/{len(reader.tensors)}: {tensor.name}", flush=True)
                scratch_path = work_directory / f"tensor-{tensor_index}.bin"
                data, output_type, needs_llama = transform_rows(
                    tensor, tensor_operations, scratch_path, dequantize, quantize
                )
                open_memmaps.append((data, scratch_path))
                writer.add_tensor(tensor.name, data, raw_dtype=output_type)
                if needs_llama:
                    llama_tensor_types[tensor.name] = tensor.tensor_type.name
                data.flush()
                data._mmap.close()
                open_memmaps.pop()
                scratch_path.unlink(missing_ok=True)
            else:
                writer.add_tensor(tensor.name, tensor.data, raw_dtype=tensor.tensor_type)

        writer.write_header_to_file()
        writer.write_kv_data_to_file()
        writer.write_tensors_to_file()
        writer.close()
        writer = None

        verify_path = partial_path
        if llama_tensor_types:
            for tensor in reader.tensors:
                if tensor.name not in llama_tensor_types and tensor.tensor_type.name in {"F16", "F32", "BF16"}:
                    llama_tensor_types[tensor.name] = tensor.tensor_type.name
            run_llama_requantization(
                quantizer, partial_path, requantized_path, llama_tensor_types
            )
            verify_path = requantized_path

        print("Verifying the edited GGUF before saving it.", flush=True)
        verified = reader_type(str(verify_path))
        try:
            if len(verified.tensors) != len(reader.tensors):
                raise RuntimeError("Verification failed: tensor count changed.")
            if verified.get_field("general.architecture").contents() != architecture:
                raise RuntimeError("Verification failed: model architecture changed.")
            for tensor in verified.tensors:
                expected_type = llama_tensor_types.get(tensor.name)
                if expected_type and tensor.tensor_type.name != expected_type:
                    raise RuntimeError(
                        f"Verification failed: {tensor.name!r} was saved as "
                        f"{tensor.tensor_type.name}, expected {expected_type}."
                    )
            for key, update in metadata_updates.items():
                field = verified.get_field(key)
                if field is None or json_value(field.contents()) != update["value"]:
                    raise RuntimeError(f"Verification failed: metadata {key!r} did not round-trip.")
        finally:
            close_reader(verified)

        os.replace(verify_path, output_path)
        print(f"Edited copy saved: {output_path}", flush=True)
        return {"output": output_name, "path": str(output_path)}
    finally:
        for memmap, scratch_path in open_memmaps:
            memmap._mmap.close()
            scratch_path.unlink(missing_ok=True)
        if writer is not None:
            writer.close()
            if writer.temp_file is not None:
                writer.temp_file.close()
        close_reader(reader)
        partial_path.unlink(missing_ok=True)
        requantized_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("check", "models", "inspect", "metadata", "sample", "edit"))
    parser.add_argument("--model")
    parser.add_argument("--tensor")
    parser.add_argument("--key")
    parser.add_argument("--index", type=int, default=0)
    parser.add_argument("--count", type=int, default=8)
    parser.add_argument("--output")
    parser.add_argument("--operations")
    args = parser.parse_args()
    try:
        if args.action == "check":
            load_gguf()
            import gguf
            quantizer = llama_quantizer()
            quantizer_status = (
                f"llama-quantize {quantizer}"
                if quantizer
                else "Q4_K re-quantization unavailable (install llama-quantize or set AETHER_LLAMA_QUANTIZE)"
            )
            print(
                f"GGUF editor ready (gguf {getattr(gguf, '__version__', 'installed')}, "
                f"NumPy {np.__version__}; {quantizer_status})."
            )
            return 0
        if args.action == "models":
            result = list_models()
            print(json.dumps({"models": result}, ensure_ascii=False, allow_nan=False))
            return 0
        if not args.model:
            raise ValueError("--model is required for this operation.")
        if args.action == "inspect":
            result = inspect_model(args.model)
        elif args.action == "metadata":
            if not args.key:
                raise ValueError("--key is required to read metadata.")
            result = read_metadata(args.model, args.key)
        elif args.action == "sample":
            if not args.tensor:
                raise ValueError("--tensor is required for sampling.")
            result = sample_tensor(args.model, args.tensor, args.index, args.count)
        else:
            if not args.output or not args.operations:
                raise ValueError("--output and --operations are required for editing.")
            result = edit_model(args.model, args.output, Path(args.operations))
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except Exception as error:
        print(f"GGUF operation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
