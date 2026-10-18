# Hybrid document restoration service

FastAPI gateway for the optional server restoration path. The browser never calls it unless the
user enables **Tối ưu ảnh bằng GPU server**. The service validates encoded type, decoded dimensions,
classifier shape, provider output and model/provider identity; it does not persist images or log
request bodies.

## Current readiness

- The API, routing policy, ONNX classifier adapter and browser fallback contract are implemented.
- A provenance-checked multi-label fine-tuning/export pipeline is implemented in `training/`.
- No validated classifier checkpoint or DocRes/UVDoc provider is committed. Without one, the API
  intentionally returns `503 model_unavailable`/`restorer_unavailable` rather than pretending that
  neural restoration ran.
- The existing on-device pipeline remains the production-safe result until paired quality tests pass.

## Run the API

Use Python 3.12. Install from this directory:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[test]"
$env:ALLOWED_ORIGINS="https://clonecamscanner.secrethippo128.chatgpt.site"
$env:CLASSIFIER_MODEL_PATH="C:\absolute\path\classifier.onnx"
$env:CLASSIFIER_MODEL_VERSION="validated-version"
.venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

`GET /health` reports whether a classifier is configured. A configured path is not proof of model
quality; production readiness also requires the quality gate described below.

## Fine-tune the router classifier

Every JSONL record must include a dataset-relative image `path`, a `group_id`, one of the splits
`train`/`validation`/`test`, zero or more supported `labels`, and non-empty `source` and `license`.
All variants of the same source document must share a group and therefore cannot cross splits.

```json
{
  "path": "train/doc-001-shadow.jpg",
  "group_id": "doc-001",
  "split": "train",
  "labels": ["shadow"],
  "source": "owner-captured",
  "license": "owner-provided"
}
```

Install the optional training stack, then fine-tune MobileNetV3 Small and export ONNX:

```powershell
.venv\Scripts\python -m pip install -e ".[training,test]"
.venv\Scripts\python -m training.train_classifier `
  --manifest C:\dataset\manifest.jsonl `
  --dataset-root C:\dataset `
  --output-dir .\models\document-defects-v1 `
  --model-version document-defects-v1
```

The command emits `classifier.pt`, `classifier.onnx`, and `metadata.json` containing split counts,
label order, positive weights, training history and validation/test metrics. Synthetic defects may
bootstrap training but cannot be the sole evidence for enabling the model in production.

## Required gate before deployment

1. Each label has licensed, representative positives and hard negatives, grouped before splitting.
2. Per-label precision/recall/F1 and macro F1 are recorded on untouched test data.
3. Classifier decisions are evaluated end-to-end with the restoration provider, not in isolation.
4. Original, local filter, neural output and APK reference are paired for OCR CER/WER, illumination,
   clipping, color error, dewarp line error, latency and visual review.
5. Only a candidate that improves quality without deleting text, signatures, stamps or table lines
   receives a deployable model version.
