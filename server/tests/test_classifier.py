from pathlib import Path
import sys
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from app.classifier import LABELS, ModelUnavailableError, OnnxDocumentClassifier, _default_session_factory


class FakeInput:
    name = "pixels"
    shape = [1, 3, 224, 224]


class FakeSession:
    def __init__(self, output: np.ndarray) -> None:
        self.output = output
        self.input_seen: np.ndarray | None = None

    def get_inputs(self) -> list[FakeInput]:
        return [FakeInput()]

    def run(self, _names: object, inputs: dict[str, np.ndarray]) -> list[np.ndarray]:
        self.input_seen = inputs["pixels"]
        return [self.output]


def test_classifier_preprocesses_image_and_maps_logits(tmp_path: Path) -> None:
    model_path = tmp_path / "classifier.onnx"
    model_path.write_bytes(b"fixture")
    session = FakeSession(np.zeros((1, len(LABELS)), dtype=np.float32))
    classifier = OnnxDocumentClassifier(
        model_path=model_path,
        model_id="doc-defects",
        model_version="test-1",
        session_factory=lambda _path, _providers: session,
    )

    result = classifier.classify(Image.new("RGB", (640, 480), "white"))

    assert result.model_id == "doc-defects"
    assert result.model_version == "test-1"
    assert all(score == pytest.approx(0.5) for score in result.scores.as_dict().values())
    assert session.input_seen is not None
    assert session.input_seen.shape == (1, 3, 224, 224)
    assert np.isfinite(session.input_seen).all()


def test_missing_model_fails_closed(tmp_path: Path) -> None:
    classifier = OnnxDocumentClassifier(
        model_path=tmp_path / "missing.onnx",
        model_id="doc-defects",
        model_version="test-1",
    )

    with pytest.raises(ModelUnavailableError):
        classifier.classify(Image.new("RGB", (32, 32), "white"))


def test_invalid_output_shape_is_rejected(tmp_path: Path) -> None:
    model_path = tmp_path / "classifier.onnx"
    model_path.write_bytes(b"fixture")
    classifier = OnnxDocumentClassifier(
        model_path=model_path,
        model_id="doc-defects",
        model_version="test-1",
        session_factory=lambda _path, _providers: FakeSession(np.zeros((1, 2), dtype=np.float32)),
    )

    with pytest.raises(ValueError, match="output shape"):
        classifier.classify(Image.new("RGB", (32, 32), "white"))


def test_default_session_preloads_cuda_dependencies(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[object] = []
    expected_session = object()
    fake_runtime = SimpleNamespace(
        preload_dlls=lambda: calls.append("preload"),
        InferenceSession=lambda path, providers: (
            calls.append((path, providers)),
            expected_session,
        )[1],
    )
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_runtime)

    session = _default_session_factory(
        "classifier.onnx", ("CUDAExecutionProvider", "CPUExecutionProvider")
    )

    assert session is expected_session
    assert calls == [
        "preload",
        ("classifier.onnx", ["CUDAExecutionProvider", "CPUExecutionProvider"]),
    ]

