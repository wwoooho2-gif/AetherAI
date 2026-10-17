#!/usr/bin/env python3
"""Locally fine-tune a supported small model and export a quantized GGUF."""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path


legacy_transfer_setting = os.environ.pop("HF_HUB_ENABLE_HF_TRANSFER", None)
if legacy_transfer_setting and legacy_transfer_setting.lower() not in {"0", "false", "no", "off"}:
    os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")


SUPPORTED_MODELS = {
    "unsloth/Qwen3.5-0.8B",
    "unsloth/Qwen3.5-2B",
    "unsloth/Qwen3.5-4B",
    "unsloth/Qwen3.5-9B",
    "unsloth/Qwen2.5-Coder-7B-Instruct",
}
MODEL_DIRECTORY = Path.home() / "Models" / "Aether"


def check_environment() -> None:
    try:
        import torch
        import unsloth  # noqa: F401
        import datasets  # noqa: F401
        import transformers  # noqa: F401
    except ImportError as error:
        raise RuntimeError(
            f"Fine-tuning dependencies are missing: {error}. "
            "Run `sh scripts/setup-finetuning.sh`."
        ) from error

    if not torch.cuda.is_available():
        raise RuntimeError("A supported NVIDIA GPU and CUDA-enabled PyTorch are required.")
    print(f"Fine-tuning ready on {torch.cuda.get_device_name(0)}.")


def read_request(request_path: Path) -> dict:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    if request.get("model") not in SUPPORTED_MODELS:
        raise ValueError("Choose a supported base model.")
    examples = request.get("examples")
    if not isinstance(examples, list) or not 2 <= len(examples) <= 500:
        raise ValueError("Provide between 2 and 500 training examples.")
    system_prompt = request.get("systemPrompt", "")
    if not isinstance(system_prompt, str) or len(system_prompt) > 5000:
        raise ValueError("Behavior rules must be a string of 5,000 characters or fewer.")
    request["systemPrompt"] = system_prompt.strip()
    for example in examples:
        messages = example.get("messages") if isinstance(example, dict) else None
        if (
            not isinstance(messages, list)
            or len(messages) != 2
            or not all(isinstance(message, dict) for message in messages)
            or messages[0].get("role") != "user"
            or messages[1].get("role") != "assistant"
            or not isinstance(messages[0].get("content"), str)
            or not isinstance(messages[1].get("content"), str)
            or not messages[0]["content"].strip()
            or not messages[1]["content"].strip()
        ):
            raise ValueError("Every example must contain a user prompt and assistant response.")
    epochs = request.get("epochs")
    if not isinstance(epochs, int) or isinstance(epochs, bool) or epochs not in range(1, 6):
        raise ValueError("Epochs must be an integer from 1 to 5.")
    if request.get("sequenceLength") not in (512, 1024, 2048, 4096):
        raise ValueError("Choose a supported sequence length.")
    learning_rate = request.get("learningRate")
    if not isinstance(learning_rate, (float, int)) or not 0.00001 <= learning_rate <= 0.001:
        raise ValueError("Learning rate must be between 0.00001 and 0.001.")
    return request


def train(request_path: Path, output_dir: Path, output_name: str) -> None:
    if output_dir.resolve() != MODEL_DIRECTORY.resolve():
        raise ValueError(f"Model output must be saved in {MODEL_DIRECTORY}.")
    if not re.fullmatch(r"aether-[a-z0-9-]+\.gguf", output_name):
        raise ValueError("The output filename is invalid.")
    output_dir.mkdir(parents=True, exist_ok=True)
    if (output_dir / output_name).exists():
        raise FileExistsError(f"Refusing to overwrite an existing model: {output_name}")

    request = read_request(request_path)
    check_environment()

    import torch
    from datasets import Dataset
    from transformers import DataCollatorForSeq2Seq, Trainer, TrainingArguments
    from unsloth import FastLanguageModel

    max_sequence_length = request["sequenceLength"]
    print(f"Loading {request['model']} in 4-bit mode...")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=request["model"],
        max_seq_length=max_sequence_length,
        dtype=None,
        load_in_4bit=True,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        lora_alpha=16,
        lora_dropout=0,
        target_modules=[
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
        ],
        use_gradient_checkpointing="unsloth",
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model.config.use_cache = False

    encoded_examples = []
    for example in request["examples"]:
        messages = example["messages"]
        if request["systemPrompt"]:
            messages = [
                {"role": "system", "content": request["systemPrompt"]},
                *messages,
            ]
        prompt_ids = tokenizer.apply_chat_template(
            messages[:-1],
            tokenize=True,
            add_generation_prompt=True,
        )
        full_ids = tokenizer.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=False,
        )
        prompt_ids = list(prompt_ids)
        full_ids = list(full_ids)
        assistant_start = 0
        for prompt_token, full_token in zip(prompt_ids, full_ids):
            if prompt_token != full_token:
                break
            assistant_start += 1
        if assistant_start == 0 or assistant_start == len(full_ids):
            raise ValueError(
                "Could not find the assistant response boundary in the tokenized example "
                f"(prompt: {len(prompt_ids)} tokens, full conversation: {len(full_ids)} tokens). "
                "The base model's chat template may not support this example format."
            )
        answer_tokens = len(full_ids) - assistant_start
        if answer_tokens > max_sequence_length:
            raise ValueError(
                f"An example's ideal answer uses {answer_tokens} tokens, exceeding the "
                f"selected {max_sequence_length}-token sequence length. Shorten the answer "
                "or select a longer sequence length."
            )

        truncated_from = max(0, len(full_ids) - max_sequence_length)
        input_ids = full_ids[truncated_from:]
        target_start = max(0, assistant_start - truncated_from)
        if target_start >= len(input_ids):
            raise ValueError(
                "The prompt and system rules leave no room for the ideal answer in the "
                f"selected {max_sequence_length}-token sequence length. Shorten the prompt "
                "or system rules, or select a longer sequence length."
            )
        labels = [-100] * target_start + input_ids[target_start:]
        encoded_examples.append({
            "input_ids": input_ids,
            "attention_mask": [1] * len(input_ids),
            "labels": labels,
        })

    dataset = Dataset.from_list(encoded_examples)
    with tempfile.TemporaryDirectory(prefix="aether-train-") as temporary_directory:
        training_args = TrainingArguments(
            output_dir=temporary_directory,
            num_train_epochs=request["epochs"],
            per_device_train_batch_size=1,
            gradient_accumulation_steps=4,
            learning_rate=float(request["learningRate"]),
            logging_steps=1,
            save_strategy="no",
            report_to="none",
            optim="adamw_8bit",
            fp16=not FastLanguageModel.is_bfloat16_supported(),
            bf16=FastLanguageModel.is_bfloat16_supported(),
            gradient_checkpointing=True,
            remove_unused_columns=False,
        )
        trainer = Trainer(
            model=model,
            args=training_args,
            train_dataset=dataset,
            data_collator=DataCollatorForSeq2Seq(
                tokenizer=tokenizer,
                model=model,
                padding=True,
            ),
        )
        trainer.train()
        print("Training finished. Exporting a Q4_K_M GGUF...")
        gguf_directory = Path(temporary_directory) / "gguf"
        gguf_directory.mkdir()
        model.save_pretrained_gguf(
            str(gguf_directory),
            tokenizer,
            quantization_method="q4_k_m",
        )

        gguf_files = sorted(gguf_directory.rglob("*.gguf"))
        if len(gguf_files) != 1:
            raise RuntimeError(
                f"Expected one exported GGUF model, found {len(gguf_files)}."
            )
        partial_path = output_dir / f".{output_name}.part"
        try:
            shutil.copy2(gguf_files[0], partial_path)
            partial_path.replace(output_dir / output_name)
        finally:
            partial_path.unlink(missing_ok=True)

    print(f"Saved trained model: {output_dir / output_name}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "train"))
    parser.add_argument("--request", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--output-name")
    arguments = parser.parse_args()

    try:
        if arguments.command == "check":
            check_environment()
            return 0
        if not arguments.request or not arguments.output_dir or not arguments.output_name:
            raise ValueError("Training requires a request file, output directory, and output filename.")
        train(arguments.request, arguments.output_dir, arguments.output_name)
        return 0
    except Exception as error:
        print(f"Training failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
