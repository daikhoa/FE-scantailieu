from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from app.classifier import LABELS


DatasetSplit = Literal["train", "validation", "test"]
ALLOWED_SPLITS = frozenset({"train", "validation", "test"})
ALLOWED_SUFFIXES = frozenset({".jpg", ".jpeg", ".png", ".webp"})


@dataclass(frozen=True, slots=True)
class ManifestRecord:
    path: Path
    group_id: str
    split: DatasetSplit
    labels: tuple[str, ...]
    source: str
    license: str


class ManifestError(ValueError):
    """Raised when dataset provenance or split isolation is invalid."""


def _non_empty_string(value: object, field: str, line_number: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"line {line_number}: {field} must be a non-empty string")
    return value.strip()


def _resolve_sample_path(root: Path, value: object, line_number: int) -> Path:
    raw_path = Path(_non_empty_string(value, "path", line_number))
    if raw_path.is_absolute():
        raise ManifestError(f"line {line_number}: path must be relative to the dataset root")
    resolved = (root / raw_path).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ManifestError(f"line {line_number}: path escapes the dataset root") from error
    if resolved.suffix.lower() not in ALLOWED_SUFFIXES:
        raise ManifestError(f"line {line_number}: unsupported image extension")
    if not resolved.is_file():
        raise ManifestError(f"line {line_number}: image does not exist")
    return resolved


def _labels(value: object, line_number: int) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(label, str) for label in value):
        raise ManifestError(f"line {line_number}: labels must be an array of strings")
    labels = tuple(value)
    if len(set(labels)) != len(labels):
        raise ManifestError(f"line {line_number}: labels must not contain duplicates")
    unsupported = set(labels).difference(LABELS)
    if unsupported:
        raise ManifestError(f"line {line_number}: unsupported labels: {sorted(unsupported)}")
    return labels


def load_manifest(manifest_path: Path, dataset_root: Path) -> tuple[ManifestRecord, ...]:
    root = dataset_root.resolve()
    if not root.is_dir():
        raise ManifestError("dataset root does not exist")
    if not manifest_path.is_file():
        raise ManifestError("manifest does not exist")

    records: list[ManifestRecord] = []
    group_splits: dict[str, str] = {}
    for line_number, raw_line in enumerate(manifest_path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw_line.strip():
            continue
        try:
            payload = json.loads(raw_line)
        except json.JSONDecodeError as error:
            raise ManifestError(f"line {line_number}: invalid JSON") from error
        if not isinstance(payload, dict):
            raise ManifestError(f"line {line_number}: record must be an object")

        group_id = _non_empty_string(payload.get("group_id"), "group_id", line_number)
        split = _non_empty_string(payload.get("split"), "split", line_number)
        if split not in ALLOWED_SPLITS:
            raise ManifestError(f"line {line_number}: unsupported split")
        previous_split = group_splits.setdefault(group_id, split)
        if previous_split != split:
            raise ManifestError(
                f"line {line_number}: group_id {group_id!r} crosses dataset splits"
            )

        records.append(
            ManifestRecord(
                path=_resolve_sample_path(root, payload.get("path"), line_number),
                group_id=group_id,
                split=split,  # type: ignore[arg-type]
                labels=_labels(payload.get("labels"), line_number),
                source=_non_empty_string(payload.get("source"), "source", line_number),
                license=_non_empty_string(payload.get("license"), "license", line_number),
            )
        )

    if not records:
        raise ManifestError("manifest must contain at least one record")
    return tuple(records)
