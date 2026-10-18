from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from training.manifest import ManifestError, load_manifest


def write_image(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), "white").save(path)


def write_manifest(path: Path, records: list[dict[str, object]]) -> None:
    path.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")


def record(path: str, *, group: str = "document-1", split: str = "train") -> dict[str, object]:
    return {
        "path": path,
        "group_id": group,
        "split": split,
        "labels": ["shadow", "blur"],
        "source": "owner-captured",
        "license": "owner-provided",
    }


def test_load_manifest_preserves_provenance_and_allows_clean_documents(tmp_path: Path) -> None:
    write_image(tmp_path / "shadow.png")
    write_image(tmp_path / "clean.jpg")
    manifest = tmp_path / "manifest.jsonl"
    clean = record("clean.jpg", group="document-2", split="validation")
    clean["labels"] = []
    write_manifest(manifest, [record("shadow.png"), clean])

    records = load_manifest(manifest, tmp_path)

    assert records[0].labels == ("shadow", "blur")
    assert records[0].source == "owner-captured"
    assert records[1].labels == ()
    assert records[1].split == "validation"


def test_load_manifest_rejects_group_leakage_across_splits(tmp_path: Path) -> None:
    write_image(tmp_path / "one.png")
    write_image(tmp_path / "two.png")
    manifest = tmp_path / "manifest.jsonl"
    write_manifest(
        manifest,
        [record("one.png", split="train"), record("two.png", split="test")],
    )

    with pytest.raises(ManifestError, match="crosses dataset splits"):
        load_manifest(manifest, tmp_path)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"path": "../outside.png"}, "escapes the dataset root"),
        ({"labels": ["made-up-defect"]}, "unsupported labels"),
        ({"source": ""}, "source must be a non-empty string"),
        ({"license": ""}, "license must be a non-empty string"),
    ],
)
def test_load_manifest_rejects_invalid_or_untraceable_records(
    tmp_path: Path,
    change: dict[str, object],
    message: str,
) -> None:
    write_image(tmp_path / "scan.png")
    manifest = tmp_path / "manifest.jsonl"
    payload = record("scan.png")
    payload.update(change)
    write_manifest(manifest, [payload])

    with pytest.raises(ManifestError, match=message):
        load_manifest(manifest, tmp_path)
