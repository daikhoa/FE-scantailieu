from __future__ import annotations

from pathlib import Path

import pytest

from training.manifest import ManifestRecord
from training.train_classifier import binary_metrics, positive_weights, target_vector


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
