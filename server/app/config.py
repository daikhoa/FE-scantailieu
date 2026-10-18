from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _positive_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = int(raw)
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    max_upload_bytes: int = 64 * 1024 * 1024
    max_image_pixels: int = 16_777_216
    max_image_side: int = 8_192
    classifier_model_path: Path | None = None
    classifier_model_id: str = "document-defects"
    classifier_model_version: str = "untrained"
    allowed_origins: tuple[str, ...] = ()

    @classmethod
    def from_env(cls) -> "Settings":
        model_path = os.getenv("CLASSIFIER_MODEL_PATH")
        origins = tuple(
            origin.strip()
            for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
            if origin.strip()
        )
        if "*" in origins:
            raise ValueError("ALLOWED_ORIGINS must list explicit origins")
        return cls(
            max_upload_bytes=_positive_int("MAX_UPLOAD_BYTES", 64 * 1024 * 1024),
            max_image_pixels=_positive_int("MAX_IMAGE_PIXELS", 16_777_216),
            max_image_side=_positive_int("MAX_IMAGE_SIDE", 8_192),
            classifier_model_path=Path(model_path).resolve() if model_path else None,
            classifier_model_id=os.getenv("CLASSIFIER_MODEL_ID", "document-defects"),
            classifier_model_version=os.getenv("CLASSIFIER_MODEL_VERSION", "untrained"),
            allowed_origins=origins,
        )

