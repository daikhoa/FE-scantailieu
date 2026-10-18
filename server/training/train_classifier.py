from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path
from typing import Any, Sequence

from app.classifier import LABELS
from training.manifest import ManifestRecord, load_manifest


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def binary_metrics(
    probabilities: Sequence[Sequence[float]],
    targets: Sequence[Sequence[int]],
    threshold: float = 0.5,
) -> dict[str, object]:
    if len(probabilities) != len(targets) or not probabilities:
        raise ValueError("probabilities and targets must contain the same non-zero sample count")
    if not 0 < threshold < 1:
        raise ValueError("threshold must be between zero and one")

    per_label: dict[str, dict[str, float]] = {}
    for label_index, label in enumerate(LABELS):
        true_positive = false_positive = false_negative = 0
        for scores, expected in zip(probabilities, targets, strict=True):
            if len(scores) != len(LABELS) or len(expected) != len(LABELS):
                raise ValueError("every sample must contain one value per classifier label")
            predicted = scores[label_index] >= threshold
            actual = expected[label_index] == 1
            true_positive += int(predicted and actual)
            false_positive += int(predicted and not actual)
            false_negative += int(not predicted and actual)
        precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else 0.0
        recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_label[label] = {"precision": precision, "recall": recall, "f1": f1}

    macro = {
        metric: sum(values[metric] for values in per_label.values()) / len(LABELS)
        for metric in ("precision", "recall", "f1")
    }
    return {"threshold": threshold, "macro": macro, "per_label": per_label}


def target_vector(record: ManifestRecord) -> list[float]:
    selected = set(record.labels)
    return [1.0 if label in selected else 0.0 for label in LABELS]


def positive_weights(records: Sequence[ManifestRecord]) -> list[float]:
    if not records:
        raise ValueError("training split must not be empty")
    positives = [0] * len(LABELS)
    for record in records:
        for index, value in enumerate(target_vector(record)):
            positives[index] += int(value)
    missing = [label for label, count in zip(LABELS, positives, strict=True) if count == 0]
    if missing:
        raise ValueError(f"training split has no positive samples for: {missing}")
    total = len(records)
    return [min(10.0, (total - count) / count) for count in positives]


def _training_dependencies() -> tuple[Any, Any, Any, Any]:
    try:
        import torch
        from torch import nn
        from torch.utils.data import DataLoader, Dataset
        from torchvision import models, transforms
    except ImportError as error:
        raise RuntimeError(
            "Training dependencies are not installed. Install the server 'training' extra first."
        ) from error
    return torch, nn, (DataLoader, Dataset), (models, transforms)


def export_onnx(torch: Any, model: Any, output_path: Path) -> None:
    """Export through the stable legacy path without Unicode console output on Windows."""
    torch.onnx.export(
        model,
        torch.zeros(1, 3, 224, 224),
        output_path,
        input_names=["image"],
        output_names=["logits"],
        dynamic_axes={"image": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=18,
        dynamo=False,
    )


def train(args: argparse.Namespace) -> None:
    torch, nn, data_api, vision_api = _training_dependencies()
    DataLoader, Dataset = data_api
    models, transforms = vision_api

    records = load_manifest(args.manifest, args.dataset_root)
    train_records = tuple(record for record in records if record.split == "train")
    validation_records = tuple(record for record in records if record.split == "validation")
    test_records = tuple(record for record in records if record.split == "test")
    if not validation_records:
        raise ValueError("validation split must not be empty")
    weights = positive_weights(train_records)

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    torch.use_deterministic_algorithms(True, warn_only=True)

    normalize = transforms.Normalize(
        mean=(0.485, 0.456, 0.406),
        std=(0.229, 0.224, 0.225),
    )
    train_transform = transforms.Compose(
        [
            transforms.Resize(256),
            transforms.RandomResizedCrop(224, scale=(0.75, 1.0)),
            transforms.RandomRotation(3),
            transforms.ColorJitter(brightness=0.12, contrast=0.12, saturation=0.06),
            transforms.ToTensor(),
            normalize,
        ]
    )
    evaluation_transform = transforms.Compose(
        [transforms.Resize(256), transforms.CenterCrop(224), transforms.ToTensor(), normalize]
    )

    class DatasetView(Dataset):
        def __init__(self, items: Sequence[ManifestRecord], transform: Any) -> None:
            self.items = items
            self.transform = transform

        def __len__(self) -> int:
            return len(self.items)

        def __getitem__(self, index: int) -> tuple[Any, Any]:
            from PIL import Image

            record = self.items[index]
            with Image.open(record.path) as image:
                pixels = self.transform(image.convert("RGB"))
            return pixels, torch.tensor(target_vector(record), dtype=torch.float32)

    generator = torch.Generator().manual_seed(args.seed)
    train_loader = DataLoader(
        DatasetView(train_records, train_transform),
        batch_size=args.batch_size,
        shuffle=True,
        generator=generator,
        num_workers=args.workers,
    )
    validation_loader = DataLoader(
        DatasetView(validation_records, evaluation_transform),
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=args.workers,
    )

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.DEFAULT)
    input_features = model.classifier[3].in_features
    model.classifier[3] = nn.Linear(input_features, len(LABELS))
    model.to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    loss_function = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(weights, device=device))

    def evaluate(loader: Any) -> tuple[float, dict[str, object]]:
        model.eval()
        total_loss = 0.0
        probabilities: list[list[float]] = []
        targets: list[list[int]] = []
        with torch.no_grad():
            for pixels, expected in loader:
                pixels = pixels.to(device)
                expected = expected.to(device)
                logits = model(pixels)
                total_loss += float(loss_function(logits, expected).item()) * pixels.shape[0]
                probabilities.extend(torch.sigmoid(logits).cpu().tolist())
                targets.extend(expected.to(dtype=torch.int32).cpu().tolist())
        return total_loss / len(loader.dataset), binary_metrics(probabilities, targets)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = args.output_dir / "classifier.pt"
    best_f1 = -1.0
    epochs_without_improvement = 0
    history: list[dict[str, object]] = []
    for epoch in range(1, args.epochs + 1):
        model.train()
        for pixels, expected in train_loader:
            optimizer.zero_grad(set_to_none=True)
            logits = model(pixels.to(device))
            loss = loss_function(logits, expected.to(device))
            loss.backward()
            optimizer.step()
        validation_loss, metrics = evaluate(validation_loader)
        macro_f1 = float(metrics["macro"]["f1"])
        history.append({"epoch": epoch, "validation_loss": validation_loss, "metrics": metrics})
        print(
            json.dumps(
                {"epoch": epoch, "validation_loss": validation_loss, "validation_macro_f1": macro_f1}
            ),
            flush=True,
        )
        if macro_f1 > best_f1:
            best_f1 = macro_f1
            epochs_without_improvement = 0
            torch.save(model.state_dict(), checkpoint_path)
        else:
            epochs_without_improvement += 1
            if epochs_without_improvement >= args.patience:
                break

    model.load_state_dict(torch.load(checkpoint_path, map_location=device, weights_only=True))
    test_metrics = evaluate(
        DataLoader(
            DatasetView(test_records, evaluation_transform),
            batch_size=args.batch_size,
            shuffle=False,
            num_workers=args.workers,
        )
    )[1] if test_records else None

    model.eval().cpu()
    onnx_path = args.output_dir / "classifier.onnx"
    export_onnx(torch, model, onnx_path)
    metadata = {
        "model_id": args.model_id,
        "model_version": args.model_version,
        "labels": list(LABELS),
        "architecture": "mobilenet_v3_small",
        "input": {"shape": [1, 3, 224, 224], "color": "RGB", "normalization": "ImageNet"},
        "seed": args.seed,
        "record_counts": {
            "train": len(train_records),
            "validation": len(validation_records),
            "test": len(test_records),
        },
        "positive_weights": weights,
        "best_validation_macro_f1": best_f1,
        "test_metrics": test_metrics,
        "history": history,
        "manifest": {"sha256": sha256_file(args.manifest), "record_count": len(records)},
    }
    (args.output_dir / "metadata.json").write_text(
        json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fine-tune and export the document defect classifier")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--model-id", default="document-defects-mobilenet-v3-small")
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--patience", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--seed", type=int, default=20261018)
    args = parser.parse_args()
    if min(args.epochs, args.patience, args.batch_size) <= 0:
        parser.error("epochs, patience and batch-size must be positive")
    if args.workers < 0 or args.learning_rate <= 0:
        parser.error("workers must be non-negative and learning-rate must be positive")
    return args


if __name__ == "__main__":
    train(parse_args())
