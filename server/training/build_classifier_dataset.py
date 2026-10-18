from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageOps

from training.manifest import LABELS


class BuildError(ValueError):
    pass


@dataclass(frozen=True)
class SourceRecord:
    path: Path
    group_id: str
    source: str
    license: str
    source_uri: str
    sha256: str


@dataclass(frozen=True)
class BuildSummary:
    source_count: int
    output_count: int
    split_counts: dict[str, int]


VARIANTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("clean", ()),
    ("shadow", ("shadow",)),
    ("curved", ("curved",)),
    ("blur", ("blur",)),
    ("moire", ("moire",)),
    ("finger", ("finger",)),
    ("low-contrast", ("low_contrast",)),
    ("color", ("color_document",)),
    ("color-shadow", ("color_document", "shadow")),
    ("color-low-contrast", ("color_document", "low_contrast")),
    ("shadow-curved", ("shadow", "curved")),
    ("blur-moire", ("blur", "moire")),
    ("finger-shadow-low-contrast", ("finger", "shadow", "low_contrast")),
)


def assign_group_splits(group_ids: Iterable[str], seed: int) -> dict[str, str]:
    groups = sorted(set(group_ids))
    if len(groups) < 3:
        raise BuildError("at least three source groups are required")
    ranked = sorted(
        groups,
        key=lambda group: hashlib.sha256(f"{seed}:{group}".encode()).digest(),
    )
    validation_count = max(1, round(len(ranked) * 0.15))
    test_count = max(1, round(len(ranked) * 0.15))
    if validation_count + test_count >= len(ranked):
        validation_count = 1
        test_count = 1
    train_end = len(ranked) - validation_count - test_count
    validation_end = train_end + validation_count
    return {
        group: (
            "train"
            if index < train_end
            else "validation"
            if index < validation_end
            else "test"
        )
        for index, group in enumerate(ranked)
    }


def _required_string(payload: dict[str, object], key: str, line: int) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise BuildError(f"line {line}: {key} must be a non-empty string")
    return value.strip()


def _source_path(root: Path, relative: str, line: int) -> Path:
    path = (root / relative).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as error:
        raise BuildError(f"line {line}: path escapes the source root") from error
    if path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
        raise BuildError(f"line {line}: unsupported source image extension")
    if not path.is_file():
        raise BuildError(f"line {line}: source image does not exist")
    return path


def _load_sources(manifest_path: Path, source_root: Path) -> list[SourceRecord]:
    records: list[SourceRecord] = []
    for line_number, raw_line in enumerate(manifest_path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw_line.strip():
            continue
        try:
            payload = json.loads(raw_line)
        except json.JSONDecodeError as error:
            raise BuildError(f"line {line_number}: invalid JSON") from error
        if not isinstance(payload, dict):
            raise BuildError(f"line {line_number}: record must be an object")
        relative = _required_string(payload, "path", line_number)
        path = _source_path(source_root, relative, line_number)
        expected_hash = _required_string(payload, "sha256", line_number).lower()
        actual_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        if not re.fullmatch(r"[0-9a-f]{64}", expected_hash) or expected_hash != actual_hash:
            raise BuildError(f"line {line_number}: sha256 does not match source image")
        records.append(
            SourceRecord(
                path=path,
                group_id=_required_string(payload, "group_id", line_number),
                source=_required_string(payload, "source", line_number),
                license=_required_string(payload, "license", line_number),
                source_uri=_required_string(payload, "source_uri", line_number),
                sha256=expected_hash,
            )
        )
    if not records:
        raise BuildError("source manifest is empty")
    return records


def _bounded_rgb(path: Path) -> Image.Image:
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    image.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
    return image


def _add_shadow(image: Image.Image, rng: random.Random) -> Image.Image:
    width, height = image.size
    mask = Image.new("L", image.size, 255)
    draw = ImageDraw.Draw(mask)
    side = rng.choice(("left", "right", "top", "bottom", "diagonal"))
    darkness = rng.randint(70, 145)
    if side == "left":
        draw.ellipse((-width, -height // 3, int(width * 0.65), int(height * 1.35)), fill=darkness)
    elif side == "right":
        draw.ellipse((int(width * 0.35), -height // 3, width * 2, int(height * 1.35)), fill=darkness)
    elif side == "top":
        draw.ellipse((-width // 3, -height, int(width * 1.35), int(height * 0.55)), fill=darkness)
    elif side == "bottom":
        draw.ellipse((-width // 3, int(height * 0.45), int(width * 1.35), height * 2), fill=darkness)
    else:
        draw.polygon(
            ((0, 0), (int(width * 0.7), 0), (int(width * 0.35), height), (0, height)),
            fill=darkness,
        )
    mask = mask.filter(ImageFilter.GaussianBlur(radius=max(width, height) * rng.uniform(0.06, 0.14)))
    return ImageChops.multiply(image, Image.merge("RGB", (mask, mask, mask)))


def _add_curvature(image: Image.Image, rng: random.Random) -> Image.Image:
    width, height = image.size
    columns, rows = 8, 10
    amplitude_x = width * rng.uniform(0.015, 0.045) * rng.choice((-1, 1))
    amplitude_y = height * rng.uniform(0.008, 0.025) * rng.choice((-1, 1))

    def source_point(x: float, y: float) -> tuple[float, float]:
        shifted_x = x + amplitude_x * math.sin(math.pi * y / height)
        shifted_y = y + amplitude_y * math.sin(math.pi * x / width)
        return max(0.0, min(width - 1.0, shifted_x)), max(0.0, min(height - 1.0, shifted_y))

    mesh: list[tuple[tuple[int, int, int, int], tuple[float, ...]]] = []
    for row in range(rows):
        y0, y1 = round(row * height / rows), round((row + 1) * height / rows)
        for column in range(columns):
            x0, x1 = round(column * width / columns), round((column + 1) * width / columns)
            top_left = source_point(x0, y0)
            bottom_left = source_point(x0, y1)
            bottom_right = source_point(x1, y1)
            top_right = source_point(x1, y0)
            mesh.append(((x0, y0, x1, y1), (*top_left, *bottom_left, *bottom_right, *top_right)))
    return image.transform(image.size, Image.Transform.MESH, mesh, Image.Resampling.BICUBIC, fillcolor="white")


def _add_moire(image: Image.Image, rng: random.Random) -> Image.Image:
    width, height = image.size
    scale = 2
    overlay = Image.new("RGBA", (width * scale, height * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    spacing = rng.randint(9, 17) * scale
    alpha = rng.randint(22, 46)
    tint = rng.choice(((30, 45, 120, alpha), (110, 35, 90, alpha), (35, 95, 80, alpha)))
    for offset in range(-height * scale, width * scale + height * scale, spacing):
        draw.line((offset, 0, offset + height * scale, height * scale), fill=tint, width=1)
    second = (tint[1], tint[2], tint[0], max(12, alpha - 10))
    for y in range(0, height * scale, spacing + rng.randint(2, 6)):
        draw.line((0, y, width * scale, y + rng.randint(-8, 8)), fill=second, width=1)
    overlay = overlay.resize(image.size, Image.Resampling.LANCZOS)
    return Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")


def _add_finger(image: Image.Image, rng: random.Random) -> Image.Image:
    width, height = image.size
    finger_width = max(26, int(width * rng.uniform(0.16, 0.25)))
    finger_height = max(80, int(height * rng.uniform(0.38, 0.58)))
    pad = max(12, finger_width // 3)
    tile = Image.new("RGBA", (finger_width + pad * 2, finger_height + pad * 2), (0, 0, 0, 0))
    shadow = Image.new("RGBA", tile.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    box = (pad, pad, pad + finger_width, pad + finger_height)
    shadow_draw.rounded_rectangle(
        (box[0] + 5, box[1] + 8, box[2] + 8, box[3] + 10),
        radius=finger_width // 2,
        fill=(0, 0, 0, 105),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=max(4, finger_width * 0.1)))
    tile = Image.alpha_composite(tile, shadow)
    draw = ImageDraw.Draw(tile)
    skin = rng.choice(((229, 176, 135, 255), (190, 126, 88, 255), (139, 86, 62, 255), (244, 194, 158, 255)))
    draw.rounded_rectangle(box, radius=finger_width // 2, fill=skin)
    highlight = tuple(min(255, channel + 24) for channel in skin[:3]) + (80,)
    draw.ellipse(
        (box[0] + finger_width * 0.18, box[1] + finger_width * 0.18, box[2] - finger_width * 0.12, box[1] + finger_width),
        fill=highlight,
    )
    nail_color = tuple(min(255, channel + 35) for channel in skin[:3]) + (230,)
    draw.rounded_rectangle(
        (
            box[0] + finger_width * 0.24,
            box[1] + finger_width * 0.14,
            box[2] - finger_width * 0.24,
            box[1] + finger_width * 0.58,
        ),
        radius=max(3, finger_width // 8),
        fill=nail_color,
    )
    tile = tile.rotate(rng.uniform(-28, 28), resample=Image.Resampling.BICUBIC, expand=True)
    x = rng.choice((-tile.width // 3, width - tile.width * 2 // 3))
    y = rng.randint(max(-tile.height // 3, -tile.height + 1), max(0, height - tile.height // 2))
    result = image.convert("RGBA")
    result.alpha_composite(tile, (x, y))
    return result.convert("RGB")


def _add_low_contrast(image: Image.Image, rng: random.Random) -> Image.Image:
    reduced = ImageEnhance.Contrast(image).enhance(rng.uniform(0.34, 0.58))
    haze = Image.new("RGB", image.size, rng.choice(((238, 238, 234), (224, 228, 231), (242, 235, 220))))
    return Image.blend(reduced, haze, rng.uniform(0.18, 0.34))


def _add_color_content(image: Image.Image, rng: random.Random) -> Image.Image:
    width, height = image.size
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    colors = ((20, 105, 210, 205), (222, 55, 70, 195), (32, 155, 98, 190), (244, 178, 35, 150))
    y = rng.randint(int(height * 0.12), int(height * 0.35))
    draw.rectangle((int(width * 0.08), y, int(width * 0.92), y + max(8, height // 28)), fill=colors[3])
    chart_top = rng.randint(int(height * 0.48), int(height * 0.64))
    bar_width = max(6, width // 14)
    for index, color in enumerate(colors[:3]):
        x0 = int(width * 0.58) + index * int(bar_width * 1.4)
        bar_height = rng.randint(max(15, height // 15), max(25, height // 5))
        draw.rectangle((x0, chart_top - bar_height, x0 + bar_width, chart_top), fill=color)
    stamp_radius = max(12, min(width, height) // 14)
    center = (int(width * 0.22), int(height * 0.76))
    draw.ellipse(
        (center[0] - stamp_radius, center[1] - stamp_radius, center[0] + stamp_radius, center[1] + stamp_radius),
        outline=colors[1],
        width=max(2, stamp_radius // 6),
    )
    return Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")


def _render_variant(image: Image.Image, labels: tuple[str, ...], rng: random.Random) -> Image.Image:
    result = image.copy() if "color_document" in labels else ImageOps.grayscale(image).convert("RGB")
    if "curved" in labels:
        result = _add_curvature(result, rng)
    if "color_document" in labels:
        result = _add_color_content(result, rng)
    if "blur" in labels:
        result = result.filter(ImageFilter.GaussianBlur(radius=rng.uniform(1.5, 3.2)))
    if "shadow" in labels:
        result = _add_shadow(result, rng)
    if "moire" in labels:
        result = _add_moire(result, rng)
    if "finger" in labels:
        result = _add_finger(result, rng)
    if "low_contrast" in labels:
        result = _add_low_contrast(result, rng)
    return result


def build_classifier_dataset(
    source_manifest_path: Path,
    source_root: Path,
    output_root: Path,
    *,
    seed: int,
) -> BuildSummary:
    source_manifest_path = source_manifest_path.resolve()
    source_root = source_root.resolve()
    output_root = output_root.resolve()
    if output_root.exists() and any(output_root.iterdir()):
        raise BuildError("output directory must not exist or must be empty")
    sources = _load_sources(source_manifest_path, source_root)
    splits = assign_group_splits((record.group_id for record in sources), seed)
    image_dir = output_root / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    output_records: list[dict[str, object]] = []
    split_counts = {"train": 0, "validation": 0, "test": 0}
    for source_index, source in enumerate(sorted(sources, key=lambda record: (record.group_id, record.path.name))):
        base = _bounded_rgb(source.path)
        for variant_index, (variant_name, variant_labels) in enumerate(VARIANTS):
            variant_seed = int.from_bytes(
                hashlib.sha256(f"{seed}:{source.sha256}:{variant_name}".encode()).digest()[:8],
                "big",
            )
            rendered = _render_variant(base, variant_labels, random.Random(variant_seed))
            filename = f"{source_index:05d}-{variant_index:02d}-{variant_name}.jpg"
            rendered.save(image_dir / filename, "JPEG", quality=92, optimize=False, progressive=False)
            split = splits[source.group_id]
            split_counts[split] += 1
            labels = tuple(label for label in LABELS if label in set(variant_labels))
            output_records.append(
                {
                    "path": f"images/{filename}",
                    "group_id": source.group_id,
                    "split": split,
                    "labels": list(labels),
                    "source": f"{source.source}+synthetic-v1",
                    "license": source.license,
                }
            )
    manifest_path = output_root / "manifest.jsonl"
    manifest_path.write_text(
        "\n".join(json.dumps(record, sort_keys=True) for record in output_records) + "\n",
        encoding="utf-8",
    )
    provenance = {
        "schema_version": 1,
        "seed": seed,
        "variant_count_per_source": len(VARIANTS),
        "labels": list(LABELS),
        "sources": [
            {
                "path": str(record.path.relative_to(source_root)).replace("\\", "/"),
                "group_id": record.group_id,
                "source": record.source,
                "license": record.license,
                "source_uri": record.source_uri,
                "sha256": record.sha256,
            }
            for record in sources
        ],
    }
    (output_root / "provenance.json").write_text(
        json.dumps(provenance, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return BuildSummary(len(sources), len(output_records), split_counts)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the document defect classifier dataset")
    parser.add_argument("--source-manifest", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=2026)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    result = build_classifier_dataset(
        arguments.source_manifest,
        arguments.source_root,
        arguments.output_root,
        seed=arguments.seed,
    )
    print(json.dumps(result.__dict__, sort_keys=True))
