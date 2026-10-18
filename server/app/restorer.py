from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from PIL import Image

from app.policy import RestorationDecision


class RestorationUnavailableError(RuntimeError):
    """Raised when no verified heavy restoration provider is configured."""


@dataclass(frozen=True, slots=True)
class RestoredImage:
    data: bytes
    media_type: str
    provider_id: str
    provider_version: str


class RestorationProvider(Protocol):
    def restore(self, image: Image.Image, decision: RestorationDecision) -> RestoredImage: ...

