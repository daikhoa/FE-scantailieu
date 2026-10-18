from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat

from training.build_classifier_dataset import (
    BuildError,
    assign_group_splits,
    build_classifier_dataset,
)
from training.manifest import LABELS, load_manifest


def _write_source_image(path: Path, *, color: bool) -> str:
    image = Image.new("RGB", (240, 320), "white")
    draw = ImageDraw.Draw(image)
    for y in range(30, 290, 18):
        draw.rectangle((25, y, 210, y + 3), fill=(35, 35, 35))
    if color:
        draw.rectangle((35, 80, 205, 145), fill=(30, 110, 220))
        draw.ellipse((70, 170, 170, 270), fill=(220, 55, 70))
    image.save(path, quality=95)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_source_manifest(root: Path, count: int = 12) -> Path:
    manifest = root / "sources.jsonl"
    records: list[str] = []
    for index in range(count):
        relative = Path("images") / f"document-{index:02d}.jpg"
        absolute = root / relative
        absolute.parent.mkdir(parents=True, exist_ok=True)
        sha256 = _write_source_image(absolute, color=index % 3 == 0)
        records.append(
            json.dumps(
                {
                    "path": relative.as_posix(),
                    "group_id": f"document-{index:02d}",
                    "source": "unit-test-documents",
                    "license": "CC0-1.0",
                    "source_uri": "https://example.test/dataset",
                    "sha256": sha256,
                }
            )
        )
    manifest.write_text("\n".join(records), encoding="utf-8")
    return manifest


def test_assign_group_splits_is_deterministic_and_keeps_all_splits() -> None:
    groups = [f"document-{index:02d}" for index in range(12)]

    first = assign_group_splits(groups, seed=2026)
    second = assign_group_splits(reversed(groups), seed=2026)

    assert first == second
    assert set(first.values()) == {"train", "validation", "test"}
    assert len([split for split in first.values() if split == "train"]) == 8
    assert len([split for split in first.values() if split == "validation"]) == 2
    assert len([split for split in first.values() if split == "test"]) == 2


def test_builder_generates_every_label_without_group_leakage(tmp_path: Path) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    source_manifest = _write_source_manifest(source_root)
    output_root = tmp_path / "dataset"

    summary = build_classifier_dataset(
        source_manifest_path=source_manifest,
        source_root=source_root,
        output_root=output_root,
        seed=2026,
    )
    records = load_manifest(output_root / "manifest.jsonl", output_root)

    assert summary.source_count == 12
    assert summary.output_count == 156
    assert len(records) == 156
    assert {label for record in records for label in record.labels} == set(LABELS)
    assert all(record.source == "unit-test-documents+synthetic-v1" for record in records)
    assert all(record.license == "CC0-1.0" for record in records)
    assert len({record.group_id for record in records}) == 12
    assert all(
        record.labels == () for record in records if record.path.name.endswith("-clean.jpg")
    )


def test_builder_is_byte_deterministic_for_same_seed(tmp_path: Path) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    source_manifest = _write_source_manifest(source_root, count=3)
    first = tmp_path / "first"
    second = tmp_path / "second"

    build_classifier_dataset(source_manifest, source_root, first, seed=41)
    build_classifier_dataset(source_manifest, source_root, second, seed=41)

    assert (first / "manifest.jsonl").read_bytes() == (second / "manifest.jsonl").read_bytes()
    first_hashes = sorted(
        hashlib.sha256(path.read_bytes()).hexdigest() for path in (first / "images").glob("*.jpg")
    )
    second_hashes = sorted(
        hashlib.sha256(path.read_bytes()).hexdigest() for path in (second / "images").glob("*.jpg")
    )
    assert first_hashes == second_hashes


def test_generated_variants_have_the_expected_visual_signal(tmp_path: Path) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    source_manifest = _write_source_manifest(source_root, count=3)
    output_root = tmp_path / "dataset"

    build_classifier_dataset(source_manifest, source_root, output_root, seed=57)

    def open_variant(name: str) -> Image.Image:
        path = next((output_root / "images").glob(f"00001-*-{name}.jpg"))
        return Image.open(path).convert("RGB")

    clean = open_variant("clean")
    for name in (
        "shadow",
        "curved",
        "blur",
        "moire",
        "finger",
        "low-contrast",
        "color",
        "shadow-curved",
        "blur-moire",
        "finger-shadow-low-contrast",
    ):
        assert ImageChops.difference(clean, open_variant(name)).getbbox() is not None

    clean_luma = clean.convert("L")
    shadow_luma = open_variant("shadow").convert("L")
    low_contrast_luma = open_variant("low-contrast").convert("L")
    blur_luma = open_variant("blur").convert("L")
    assert ImageStat.Stat(shadow_luma).mean[0] < ImageStat.Stat(clean_luma).mean[0] - 8
    assert ImageStat.Stat(low_contrast_luma).stddev[0] < ImageStat.Stat(clean_luma).stddev[0]
    assert ImageStat.Stat(blur_luma.filter(ImageFilter.FIND_EDGES)).mean[0] < ImageStat.Stat(
        clean_luma.filter(ImageFilter.FIND_EDGES)
    ).mean[0]
    assert ImageStat.Stat(open_variant("color").convert("HSV").getchannel("S")).mean[0] > 8


def test_builder_rejects_source_paths_outside_the_source_root(tmp_path: Path) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    outside = tmp_path / "outside.jpg"
    sha256 = _write_source_image(outside, color=False)
    manifest = source_root / "sources.jsonl"
    manifest.write_text(
        json.dumps(
            {
                "path": "../outside.jpg",
                "group_id": "outside",
                "source": "bad-source",
                "license": "CC0-1.0",
                "source_uri": "https://example.test/dataset",
                "sha256": sha256,
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(BuildError, match="escapes the source root"):
        build_classifier_dataset(manifest, source_root, tmp_path / "dataset", seed=1)
