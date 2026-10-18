from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal


DetailLevel = Literal["low", "medium", "high"]
RestorationStage = Literal[
    "finger-segmentation",
    "dewarp",
    "deshadow",
    "demoire",
    "deblur",
    "appearance",
]

HIGH_CONFIDENCE = 0.75
MEDIUM_CONFIDENCE = 0.45
COLOR_PROTECTION_CONFIDENCE = 0.6


@dataclass(frozen=True, slots=True)
class DefectScores:
    shadow: float
    curved: float
    blur: float
    moire: float
    finger: float
    low_contrast: float
    color_document: float

    def __post_init__(self) -> None:
        for label, value in self.as_dict().items():
            if not 0 <= value <= 1:
                raise ValueError(f"{label} probability must be between 0 and 1")

    def as_dict(self) -> dict[str, float]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class RestorationEvidence:
    illumination_range: float
    highlight_ratio: float
    detail: DetailLevel

    def __post_init__(self) -> None:
        if self.illumination_range < 0:
            raise ValueError("illumination_range must be non-negative")
        if not 0 <= self.highlight_ratio <= 1:
            raise ValueError("highlight_ratio must be between 0 and 1")


@dataclass(frozen=True, slots=True)
class RestorationDecision:
    route: Literal["local", "gpu"]
    stages: tuple[RestorationStage, ...]
    protect_color: bool


def _selected(score: float, confirmed: bool = False) -> bool:
    return score >= HIGH_CONFIDENCE or (score >= MEDIUM_CONFIDENCE and confirmed)


def choose_restoration(
    scores: DefectScores,
    evidence: RestorationEvidence,
) -> RestorationDecision:
    stages: list[RestorationStage] = []
    if _selected(scores.finger):
        stages.append("finger-segmentation")
    if _selected(scores.curved):
        stages.append("dewarp")
    if _selected(
        scores.shadow,
        evidence.illumination_range >= 18 and evidence.highlight_ratio < 0.55,
    ):
        stages.append("deshadow")
    if _selected(scores.moire):
        stages.append("demoire")
    if _selected(scores.blur, evidence.detail == "low"):
        stages.append("deblur")
    if _selected(scores.low_contrast):
        stages.append("appearance")
    return RestorationDecision(
        route="gpu" if stages else "local",
        stages=tuple(stages),
        protect_color=scores.color_document >= COLOR_PROTECTION_CONFIDENCE,
    )

