from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Callable, Protocol, Sequence

import numpy as np
from PIL import Image, ImageOps

from app.policy import DefectScores


LABELS = (
    "shadow",
    "curved",
    "blur",
    "moire",
    "finger",
    "low_contrast",
    "color_document",
)


class ModelUnavailableError(RuntimeError):
    """Raised when the configured classifier cannot be loaded."""


@dataclass(frozen=True, slots=True)
class ClassificationResult:
    scores: DefectScores
    model_id: str
    model_version: str


class DocumentClassifier(Protocol):
    def classify(self, image: Image.Image) -> ClassificationResult: ...


class SessionInput(Protocol):
    name: str
    shape: Sequence[object]


class InferenceSession(Protocol):
    def get_inputs(self) -> Sequence[SessionInput]: ...

    def run(self, output_names: object, inputs: dict[str, np.ndarray]) -> Sequence[np.ndarray]: ...


SessionFactory = Callable[[str, Sequence[str]], InferenceSession]


def _default_session_factory(path: str, providers: Sequence[str]) -> InferenceSession:
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise ModelUnavailableError("ONNX Runtime is not installed") from error
    try:
        return ort.InferenceSession(path, providers=list(providers))
    except Exception as error:
        raise ModelUnavailableError("The classifier model could not be loaded") from error


class OnnxDocumentClassifier:
    def __init__(
        self,
        *,
        model_path: Path,
        model_id: str,
        model_version: str,
        providers: Sequence[str] = ("CUDAExecutionProvider", "CPUExecutionProvider"),
        session_factory: SessionFactory = _default_session_factory,
    ) -> None:
        self._model_path = model_path
        self._model_id = model_id
        self._model_version = model_version
        self._providers = tuple(providers)
        self._session_factory = session_factory
        self._session: InferenceSession | None = None
        self._lock = Lock()

    def _session_for_inference(self) -> InferenceSession:
        if not self._model_path.is_file():
            raise ModelUnavailableError("The classifier model file is unavailable")
        if self._session is not None:
            return self._session
        with self._lock:
            if self._session is None:
                self._session = self._session_factory(str(self._model_path), self._providers)
        return self._session

    def classify(self, image: Image.Image) -> ClassificationResult:
        session = self._session_for_inference()
        inputs = session.get_inputs()
        if len(inputs) != 1:
            raise ValueError("classifier must expose exactly one input")
        shape = inputs[0].shape
        height = int(shape[2]) if len(shape) == 4 and isinstance(shape[2], int) else 224
        width = int(shape[3]) if len(shape) == 4 and isinstance(shape[3], int) else 224
        pixels = self._preprocess(image, width, height)
        outputs = session.run(None, {inputs[0].name: pixels})
        if len(outputs) != 1:
            raise ValueError("classifier must expose exactly one output")
        logits = np.asarray(outputs[0], dtype=np.float32)
        if logits.shape != (1, len(LABELS)):
            raise ValueError(f"unexpected classifier output shape: {logits.shape}")
        if not np.isfinite(logits).all():
            raise ValueError("classifier output contains non-finite values")
        probabilities = 1.0 / (1.0 + np.exp(-np.clip(logits[0], -80, 80)))
        values = {label: float(probabilities[index]) for index, label in enumerate(LABELS)}
        return ClassificationResult(
            scores=DefectScores(**values),
            model_id=self._model_id,
            model_version=self._model_version,
        )

    @staticmethod
    def _preprocess(image: Image.Image, width: int, height: int) -> np.ndarray:
        rgb = ImageOps.exif_transpose(image).convert("RGB")
        fitted = ImageOps.fit(rgb, (width, height), method=Image.Resampling.BILINEAR)
        pixels = np.asarray(fitted, dtype=np.float32) / 255.0
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        standard_deviation = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        normalized = (pixels - mean) / standard_deviation
        return np.transpose(normalized, (2, 0, 1))[np.newaxis, ...].astype(np.float32)

