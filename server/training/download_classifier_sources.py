from __future__ import annotations

import argparse
import hashlib
from io import BytesIO
import json
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


CORD_REVISION = "7f0115a4b758a71d6473b8d085751692da2fef98"
CORD_DATASET = "naver-clova-ix/cord-v2"
CORD_CONFIG = "default"
ROWS_ENDPOINT = "https://datasets-server.huggingface.co/rows"
ALLOWED_HOST = "datasets-server.huggingface.co"
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_SOURCE_IMAGE_PIXELS = 50_000_000
MAX_SOURCE_IMAGE_SIDE = 16_384
DEFAULT_SPLIT_COUNTS = {"train": 0, "validation": 100, "test": 100}


class DownloadError(RuntimeError):
    pass


@dataclass(frozen=True)
class DownloadSummary:
    source_count: int
    total_bytes: int
    manifest_path: Path


def _trusted_https_url(raw_url: str) -> str:
    parsed = urllib.parse.urlparse(raw_url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != ALLOWED_HOST
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
    ):
        raise DownloadError("asset URL is not an allowlisted HTTPS Hugging Face URL")
    return raw_url


def parse_cord_rows(payload: object, revision: str) -> list[tuple[int, str]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
        raise DownloadError("CORD rows response has an unexpected shape")
    parsed_rows: list[tuple[int, str]] = []
    for entry in payload["rows"]:
        try:
            row_index = entry["row_idx"]
            source_url = entry["row"]["image"]["src"]
        except (KeyError, TypeError) as error:
            raise DownloadError("CORD row does not contain an image asset") from error
        if not isinstance(row_index, int) or not isinstance(source_url, str):
            raise DownloadError("CORD row index or image URL has an invalid type")
        trusted_url = _trusted_https_url(source_url)
        expected_path = f"/{CORD_DATASET}/--/{revision}/--/{CORD_CONFIG}/"
        if expected_path not in urllib.parse.urlparse(trusted_url).path:
            raise DownloadError("CORD asset URL does not match the pinned dataset and revision")
        parsed_rows.append((row_index, trusted_url))
    return parsed_rows


def _read_url(url: str, *, limit: int, timeout: float = 60.0) -> bytes:
    _trusted_https_url(url)
    request = urllib.request.Request(url, headers={"User-Agent": "camscanner2-dataset-builder/1"})
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                _trusted_https_url(response.geturl())
                content_length = response.headers.get("Content-Length")
                if content_length is not None and int(content_length) > limit:
                    raise DownloadError(f"download exceeds the {limit}-byte limit")
                content = response.read(limit + 1)
                if len(content) > limit:
                    raise DownloadError(f"download exceeds the {limit}-byte limit")
                return content
        except (OSError, urllib.error.URLError) as error:
            last_error = error
            if attempt < 2:
                time.sleep(0.5 * (2**attempt))
    raise DownloadError(f"download failed after retries: {url}") from last_error


def _rows_url(split: str, offset: int, length: int) -> str:
    query = urllib.parse.urlencode(
        {
            "dataset": CORD_DATASET,
            "config": CORD_CONFIG,
            "split": split,
            "offset": offset,
            "length": length,
        }
    )
    return f"{ROWS_ENDPOINT}?{query}"


def _fetch_rows(split: str, count: int) -> list[tuple[int, str]]:
    rows: list[tuple[int, str]] = []
    for offset in range(0, count, 100):
        length = min(100, count - offset)
        payload = json.loads(_read_url(_rows_url(split, offset, length), limit=MAX_JSON_BYTES))
        page = parse_cord_rows(payload, CORD_REVISION)
        if len(page) != length:
            raise DownloadError(f"CORD returned {len(page)} rows for requested page length {length}")
        rows.extend(page)
    return rows


def _save_bounded_jpeg(content: bytes, destination: Path) -> tuple[str, int]:
    temporary = destination.with_suffix(".jpeg.part")
    try:
        with Image.open(BytesIO(content)) as source:
            width, height = source.size
            if (
                width <= 0
                or height <= 0
                or max(width, height) > MAX_SOURCE_IMAGE_SIDE
                or width * height > MAX_SOURCE_IMAGE_PIXELS
            ):
                raise DownloadError("source image dimensions exceed the safety limit")
            source.verify()
        with Image.open(BytesIO(content)) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
        image.save(temporary, "JPEG", quality=95, optimize=False, progressive=False)
        temporary.replace(destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    encoded = destination.read_bytes()
    return hashlib.sha256(encoded).hexdigest(), len(encoded)


def download_cord_sources(
    output_root: Path,
    *,
    split_counts: dict[str, int],
    workers: int = 8,
) -> DownloadSummary:
    unsupported = set(split_counts) - {"train", "validation", "test"}
    if unsupported or any(count < 0 for count in split_counts.values()):
        raise DownloadError("split counts must be non-negative CORD split names")
    if workers < 1 or workers > 16:
        raise DownloadError("workers must be between 1 and 16")
    output_root = output_root.resolve()
    image_dir = output_root / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    planned: list[tuple[str, int, str, Path]] = []
    for split in ("train", "validation", "test"):
        for row_index, url in _fetch_rows(split, split_counts.get(split, 0)):
            destination = image_dir / f"cord-v2-{split}-{row_index:04d}.jpg"
            planned.append((split, row_index, url, destination))

    def download_one(item: tuple[str, int, str, Path]) -> tuple[str, int, str, Path, str, int]:
        split, row_index, url, destination = item
        content = _read_url(url, limit=MAX_IMAGE_BYTES)
        sha256, size = _save_bounded_jpeg(content, destination)
        return split, row_index, url, destination, sha256, size

    completed: list[tuple[str, int, str, Path, str, int]] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(download_one, item) for item in planned]
        for future in as_completed(futures):
            completed.append(future.result())
    completed.sort(key=lambda item: (item[0], item[1]))
    records: list[dict[str, str]] = []
    provenance_rows: list[dict[str, Any]] = []
    for split, row_index, url, destination, sha256, size in completed:
        records.append(
            {
                "path": f"images/{destination.name}",
                "group_id": f"cord-v2:{split}:{row_index}",
                "source": f"CORD-v2@{CORD_REVISION}",
                "license": "CC-BY-4.0",
                "source_uri": f"https://huggingface.co/datasets/{CORD_DATASET}/tree/{CORD_REVISION}",
                "sha256": sha256,
            }
        )
        provenance_rows.append(
            {"split": split, "row_index": row_index, "asset_url": url, "sha256": sha256, "bytes": size}
        )
    manifest_path = output_root / "sources.jsonl"
    manifest_path.write_text(
        "\n".join(json.dumps(record, sort_keys=True) for record in records) + "\n",
        encoding="utf-8",
    )
    (output_root / "provenance.json").write_text(
        json.dumps(
            {
                "dataset": CORD_DATASET,
                "revision": CORD_REVISION,
                "license": "CC-BY-4.0",
                "homepage": "https://github.com/clovaai/cord",
                "rows": provenance_rows,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return DownloadSummary(len(completed), sum(item[5] for item in completed), manifest_path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download the pinned public classifier source images")
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--train-count", type=int, default=DEFAULT_SPLIT_COUNTS["train"])
    parser.add_argument("--validation-count", type=int, default=DEFAULT_SPLIT_COUNTS["validation"])
    parser.add_argument("--test-count", type=int, default=DEFAULT_SPLIT_COUNTS["test"])
    parser.add_argument("--workers", type=int, default=8)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    summary = download_cord_sources(
        arguments.output_root,
        split_counts={
            "train": arguments.train_count,
            "validation": arguments.validation_count,
            "test": arguments.test_count,
        },
        workers=arguments.workers,
    )
    print(
        json.dumps(
            {
                "source_count": summary.source_count,
                "total_bytes": summary.total_bytes,
                "manifest_path": str(summary.manifest_path),
            },
            sort_keys=True,
        )
    )
