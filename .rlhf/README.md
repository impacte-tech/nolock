# Fine-Tuning with nolock's RLHF Data

This guide walks you through fine-tuning language models using the preference data
collected by nolock's built-in RLHF system. The JSONL files under `.rlhf/kto/` and
`.rlhf/dpo/` are pre-formatted for [Hugging Face TRL](https://huggingface.co/docs/trl/v1.8.0)
(v1.8.0) — no conversion needed.

---

## Prerequisites

- Python 3.10+
- A CUDA-capable GPU (recommended) or Apple Silicon Mac
- 4–16 GB VRAM depending on model size

## Setup

From the cloned nolock repository, create a Python virtual environment and install
the training dependencies:

```bash
# Create and activate a virtual environment (from the nolock repo root)
python3 -m venv .venv-rlhf
source .venv-rlhf/bin/activate   # Linux / macOS
# .venv-rlhf\Scripts\activate    # Windows (PowerShell)

# Install TRL and its dependencies (pinned in .rlhf/requirements.txt)
pip install -r .rlhf/requirements.txt
```

> **Note:** The virtual environment is intentionally isolated from nolock's
> Node.js/Tauri toolchain. It only contains the Python packages needed for
> fine-tuning.

Verify the installation:

```bash
python -c "import trl; print(f'TRL {trl.__version__}')"
# → TRL 1.8.0
```

---

## Data Layout

**KTO and DPO data live in separate top-level directories** under `.rlhf/`, each with its own structure:

```
.rlhf/
  kto/                          ← Thumbs-up/down (KTO) data
    good/<provider>_<model>/data.jsonl  # KTO desirable (label: true)
    bad/<provider>_<model>/data.jsonl   # KTO undesirable (label: false)
  dpo/                          ← Pairwise preference (DPO) data
    <provider>_<model>/data.jsonl       # DPO chosen/rejected pairs
```

Each model configuration gets its own subdirectory (e.g. `ollama_qwen3_8b`),
so you can train on feedback from specific models or merge them all. KTO and DPO
are independent — you can use either method on its own, or combine them
sequentially (KTO first, then DPO for refined alignment).

### Field Reference

The JSONL schemas match the dataset formats expected by
[TRL v1.8.0](https://huggingface.co/docs/trl/v1.8.0) directly.

**KTO entries** — [KTOTrainer expected format](https://huggingface.co/docs/trl/v1.8.0/en/kto_trainer#expected-dataset-type-and-format):

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | string | The user's message |
| `completion` | string | The AI's response |
| `label` | boolean | `true` = desirable, `false` = undesirable |
| `model_provider` | string | e.g. `"ollama"`, `"openrouter"` |
| `model_name` | string | e.g. `"qwen3.5:0.8b-mlx"` |
| `model_configurations` | object | `{ temperature, max_tokens, system_prompt }` |
| `timestamp` | string | ISO 8601 |
| `user_correction` | string? | Optional correction from the user (thumbs-down only) |

**DPO entries** — [DPOTrainer expected format](https://huggingface.co/docs/trl/v1.8.0/en/dpo_trainer#expected-dataset-type-and-format):

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | string | The user's message |
| `chosen` | string | The response the user preferred |
| `rejected` | string | The response the user rejected |
| `model_provider` | string | e.g. `"ollama"` |
| `model_name` | string | e.g. `"qwen3.5:0.8b-mlx"` |
| `model_configurations` | object | `{ temperature, max_tokens, system_prompt }` |
| `timestamp` | string | ISO 8601 |

---

## DPO Training

DPO (Direct Preference Optimization) trains on pairwise preference data — each
example has a `chosen` and `rejected` response for the same prompt.

### Loading the Data

```python
from datasets import load_dataset, concatenate_datasets
from pathlib import Path

def load_dpo_data(data_dir: str = ".rlhf/dpo"):
    """Load all DPO pairwise JSONL files and concatenate them."""
    dataset_dir = Path(data_dir)
    jsonl_files = list(dataset_dir.glob("*/data.jsonl"))

    if not jsonl_files:
        raise FileNotFoundError(f"No JSONL files found in {data_dir}")

    datasets_list = []
    for path in jsonl_files:
        ds = load_dataset("json", data_files=str(path), split="train")
        datasets_list.append(ds)
        print(f"  Loaded {len(ds)} examples from {path.parent.name}")

    combined = concatenate_datasets(datasets_list)
    print(f"\nTotal DPO examples: {len(combined)}")
    return combined
```

### Training Script

```python
from trl import DPOTrainer, DPOConfig
from transformers import AutoModelForCausalLM, AutoTokenizer

# ---- Configuration ----
BASE_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"   # adjust to your target
OUTPUT_DIR = "output/dpo-nolock"

# ---- Load model and tokenizer ----
model = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL,
    torch_dtype="auto",
    device_map="auto",
)
tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
tokenizer.pad_token = tokenizer.eos_token

# ---- Load data ----
dataset = load_dpo_data()

# ---- Train ----
training_args = DPOConfig(
    output_dir=OUTPUT_DIR,
    num_train_epochs=3,
    per_device_train_batch_size=4,
    gradient_accumulation_steps=4,
    learning_rate=5e-7,
    beta=0.1,
    loss_type="sigmoid",
    logging_steps=10,
    save_strategy="epoch",
    bf16=True,
    remove_unused_columns=True,
)

trainer = DPOTrainer(
    model=model,
    args=training_args,
    processing_class=tokenizer,
    train_dataset=dataset,
)

trainer.train()
trainer.save_model(OUTPUT_DIR)
```

### Key DPO Hyperparameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| `beta` | `0.1` | Controls deviation from reference model. Higher = less deviation. |
| `loss_type` | `"sigmoid"` | Standard DPO. Try `"ipo"` or `"hinge"` for alternatives. |
| `learning_rate` | `1e-6` | Start low (`5e-7` to `5e-6`). |
| `num_train_epochs` | `3` | 1–5 epochs typical for small personal datasets. |

> **Tip:** If you have fewer than 50 DPO examples, consider using KTO instead —
> it works better with small, unpaired datasets.

---

## KTO Training

KTO (Kahneman-Tversky Optimization) trains on individual responses with a binary
label (good/bad). It does **not** require paired data, making it ideal for
thumbs-up/thumbs-down feedback.

### Loading the Data

```python
from datasets import load_dataset, concatenate_datasets
from pathlib import Path

def load_kto_data(data_dir: str = ".rlhf/kto"):
    """Load all KTO JSONL files (good + bad) and concatenate them."""
    dataset_dir = Path(data_dir)
    jsonl_files = (
        list((dataset_dir / "good").glob("*/data.jsonl"))
        + list((dataset_dir / "bad").glob("*/data.jsonl"))
    )

    if not jsonl_files:
        raise FileNotFoundError(f"No JSONL files found in {data_dir}")

    datasets_list = []
    for path in jsonl_files:
        ds = load_dataset("json", data_files=str(path), split="train")
        datasets_list.append(ds)
        print(f"  Loaded {len(ds)} examples from {path.parent.parent.name}/{path.parent.name}")

    combined = concatenate_datasets(datasets_list)

    # Count labels
    chosen = sum(1 for ex in combined if ex["label"])
    rejected = len(combined) - chosen
    print(f"\nTotal KTO examples: {len(combined)} ({chosen} desirable, {rejected} undesirable)")

    return combined
```

### Training Script

```python
from trl import KTOTrainer, KTOConfig
from transformers import AutoModelForCausalLM, AutoTokenizer

# ---- Configuration ----
BASE_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"   # adjust to your target
OUTPUT_DIR = "output/kto-nolock"

# ---- Load model and tokenizer ----
model = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL,
    torch_dtype="auto",
    device_map="auto",
)
tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
tokenizer.pad_token = tokenizer.eos_token

# ---- Load data ----
dataset = load_kto_data()

# ---- Train ----
training_args = KTOConfig(
    output_dir=OUTPUT_DIR,
    num_train_epochs=3,
    per_device_train_batch_size=4,
    gradient_accumulation_steps=4,
    learning_rate=5e-7,
    beta=0.1,
    desirable_weight=1.0,
    undesirable_weight=1.0,
    logging_steps=10,
    save_strategy="epoch",
    bf16=True,
    remove_unused_columns=True,
)

trainer = KTOTrainer(
    model=model,
    args=training_args,
    processing_class=tokenizer,
    train_dataset=dataset,
)

trainer.train()
trainer.save_model(OUTPUT_DIR)
```

### Key KTO Hyperparameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| `beta` | `0.1` | Higher = less deviation from reference model. |
| `desirable_weight` | `1.0` | Increase if you have few positive examples. |
| `undesirable_weight` | `1.0` | Increase if you have few negative examples. |
| `learning_rate` | `1e-6` | Keep between `5e-7` and `5e-6`. Never above `1e-6` with default `beta`. |

> **Tip:** If your data is heavily imbalanced (e.g. 90% thumbs-up), increase
> `undesirable_weight` so the ratio of `desirable_weight * positives` to
> `undesirable_weight * negatives` stays between 1:1 and 4:3.

---

## Merging Data from Multiple Models

Since nolock partitions data by provider and model, you can merge data from
different backends to create a richer training set. KTO and DPO data are stored
independently, so you can merge within each method:

```python
# Merge all DPO data across all models
dataset = load_dpo_data(".rlhf/dpo")

# Or train on data from a specific model only
from datasets import load_dataset
dataset = load_dataset("json", data_files=".rlhf/dpo/ollama_qwen3_8b/data.jsonl", split="train")

# KTO data is loaded separately from .rlhf/kto/{good,bad}/
kto_dataset = load_kto_data(".rlhf/kto")
```

---

## Exporting to Hugging Face Hub

After training, push your model to the Hub for easy sharing and deployment:

```python
# For DPO
trainer.push_to_hub("your-username/model-name")

# Or save locally and upload later
trainer.save_model("./my-finetuned-model")
```

---

## Dataset Volume Guide

How much feedback you need depends on the base model size and the training method.
nolock's recommended models are all under 1B parameters, which is the sweet spot
for personal fine-tuning — they learn from fewer examples and overfit less than
larger models.

### KTO (Thumbs-Up / Down)

KTO trains on individual responses, so every rating counts. These are
**minimum** recommendations for visible improvement.

| Base Model Size | Min Examples | Comfortable | Notes |
|-----------------|:------------:|:-----------:|-------|
| **~0.5B** (e.g. `qwen2.5-coder:0.5b`) | 20 | 50–100 | Tiny model — converges fast, but overfits above ~200 epochs on small data. |
| **~0.8B** (e.g. `qwen3.5:0.8b-mlx`) | 30 | 80–150 | Good balance of capacity and data efficiency. Recommended for most users. |
| **1.5B** (e.g. `qwen2.5-1.5b`) | 50 | 100–200 | Only use LoRA/PEFT — full fine-tuning needs significantly more data. |
| **3B+** | 150 | 300+ | Consider public alignment datasets to supplement your own. |

> **Key constraint:** KTO's KL divergence estimate requires a per-device batch
> size > 1 with sequential sampling. With very few examples, use
> `per_device_train_batch_size=2` and `gradient_accumulation_steps` to reach an
> effective batch size of 8–16.

### DPO (Pairwise Preference)

DPO requires *paired* comparisons (chosen + rejected for the same prompt), which
is a stronger signal per example. Fewer pairs are needed, but each pair must be
genuinely informative — both responses should be plausible, with one clearly
better.

| Base Model Size | Min Pairs | Comfortable | Notes |
|-----------------|:---------:|:-----------:|-------|
| **~0.5B** | 15 | 40–80 | Very small model — even 20 high-quality pairs can shift behavior. |
| **~0.8B** | 25 | 60–120 | Can handle more nuanced preferences (e.g. style, verbosity). Recommended base size. |
| **1.5B** | 40 | 80–200 | Pair quality matters more than quantity at this scale. |
| **3B+** | 100 | 200–500 | Use LoRA/PEFT; full fine-tuning is impractical with personal data. |

> **Quality > Quantity:** 30 thoughtful DPO pairs where both responses are
> genuinely close in quality are worth more than 200 pairs where one response is
> obviously garbage. The model learns *your taste* from the marginal cases.

### How to Know You Have Enough

- **KTO:** Watch the `rewards/margins` metric during training. If it plateaus
  after a few epochs, adding more data (not more epochs) will help.
- **DPO:** Check `rewards/accuracies`. Once it consistently stays above 0.6–0.7,
  the model is learning the preference signal. Below that, collect more pairs.
- **Both:** If validation loss starts *increasing* while training loss keeps
  dropping, you're overfitting — stop early or collect more data.

### Start with KTO, Graduate to DPO

Most users collect thumbs-up/down naturally while coding (KTO). Pairwise
comparisons (DPO) require the DPO prompt to fire every N messages, which is more
deliberate. Since KTO and DPO data live in separate directories, you can use
either method independently or combine them:

1. **Start with KTO** — collect 30–50 thumbs-up/down responses during normal usage.
2. **Enable DPO** — once you have enough KTO data, toggle DPO on (`Ctrl+A, R`)
   and collect 20–40 pairwise comparisons.
3. **Train KTO first** — it uses all your data. Then train DPO on the subset of
   paired examples for a more refined alignment.

---

## Tips

1. **Keep `learning_rate` low.** Personal datasets are small — aggressive learning
   rates cause overfitting quickly. Stay between `5e-7` and `5e-6`.
2. **Watch the reward margin.** In KTO, an increasing reward margin over time means
   the model is learning your preferences.
3. **Use LoRA/PEFT** for memory-efficient training on consumer GPUs:

```python
from peft import LoraConfig

peft_config = LoraConfig(
    r=16,
    lora_alpha=32,
    target_modules=["q_proj", "v_proj"],
    lora_dropout=0.05,
    task_type="CAUSAL_LM",
)

trainer = DPOTrainer(
    model=model,
    args=training_args,
    processing_class=tokenizer,
    train_dataset=dataset,
    peft_config=peft_config,
)
```

---

## Further Reading

- [TRL v1.8.0 Documentation](https://huggingface.co/docs/trl/v1.8.0)
- [DPOTrainer Reference](https://huggingface.co/docs/trl/v1.8.0/en/dpo_trainer)
- [KTOTrainer Reference](https://huggingface.co/docs/trl/v1.8.0/en/kto_trainer)
- [TRL Dataset Formats](https://huggingface.co/docs/trl/v1.8.0/en/dataset_formats)
- [DPO Paper](https://arxiv.org/abs/2305.18290)
- [KTO Paper](https://arxiv.org/abs/2402.01306)
