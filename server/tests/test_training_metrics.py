from __future__ import annotations

from pathlib import Path

import pytest

from training.manifest import ManifestRecord
from training.train_classifier import (
    binary_metrics,
    export_onnx,
    positive_weights,
    sha256_file,
    target_vector,
)


def sample(*labels: str) -> ManifestRecord:
    return ManifestRecord(
        path=Path("unused.png"),
        group_id="fixture",
        split="train",
        labels=labels,
        source="fixture",
        license="fixture",
    )


def test_target_vector_uses_runtime_label_order() -> None:
    assert target_vector(sample("shadow", "color_document")) == [1, 0, 0, 0, 0, 0, 1]


def test_positive_weights_rejects_unlearnable_label() -> None:
    with pytest.raises(ValueError, match="no positive samples"):
        positive_weights([sample("shadow")])


def test_binary_metrics_reports_per_label_and_macro_scores() -> None:
    positives = [0.9] * 7
    negatives = [0.1] * 7

    metrics = binary_metrics([positives, negatives], [[1] * 7, [0] * 7])

    assert metrics["macro"] == {"precision": 1.0, "recall": 1.0, "f1": 1.0}
    assert metrics["per_label"]["shadow"]["f1"] == 1.0


def test_export_onnx_uses_legacy_exporter_for_windows_console_compatibility(tmp_path: Path) -> None:
    captured: dict[str, object] = {}

    class FakeOnnx:
        @staticmethod
        def export(*args: object, **kwargs: object) -> None:
            captured["args"] = args
            captured["kwargs"] = kwargs

    class FakeTorch:
        onnx = FakeOnnx()

        @staticmethod
        def zeros(*shape: int) -> tuple[int, ...]:
            return shape

    export_onnx(FakeTorch(), object(), tmp_path / "classifier.onnx")

    assert captured["kwargs"]["dynamo"] is False
    assert captured["kwargs"]["opset_version"] == 18


def test_sha256_file_identifies_the_exact_training_manifest(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_bytes(b'{"group_id":"example"}\n')

    assert sha256_file(manifest) == "4693e6a8555118134e3917ce53f073fa8f27dae98625fe3bd8dd332812804541"
