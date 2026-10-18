from __future__ import annotations

import pytest

from training.download_classifier_sources import (
    DEFAULT_SPLIT_COUNTS,
    DownloadError,
    parse_cord_rows,
)


def test_default_split_counts_only_use_cord_splits_served_reliably() -> None:
    assert DEFAULT_SPLIT_COUNTS == {"train": 0, "validation": 100, "test": 100}


def test_parse_cord_rows_accepts_only_the_pinned_revision_and_expected_host() -> None:
    revision = "a" * 40
    payload = {
        "rows": [
            {
                "row_idx": 7,
                "row": {
                    "image": {
                        "src": (
                            "https://datasets-server.huggingface.co/cached-assets/"
                            f"naver-clova-ix/cord-v2/--/{revision}/--/default/train/7/image/image.jpg"
                        )
                    }
                },
            }
        ]
    }

    assert parse_cord_rows(payload, revision) == [(7, payload["rows"][0]["row"]["image"]["src"])]


@pytest.mark.parametrize(
    "src",
    [
        "https://datasets-server.huggingface.co/cached-assets/repo/--/wrong/image.jpg",
        f"https://example.test/cached-assets/repo/--/{'a' * 40}/image.jpg",
        f"http://datasets-server.huggingface.co/cached-assets/repo/--/{'a' * 40}/image.jpg",
        (
            "https://datasets-server.huggingface.co/cached-assets/another/repo/--/"
            f"{'a' * 40}/--/default/test/0/image/image.jpg"
        ),
        (
            "https://user@datasets-server.huggingface.co/cached-assets/naver-clova-ix/cord-v2/--/"
            f"{'a' * 40}/--/default/test/0/image/image.jpg"
        ),
    ],
)
def test_parse_cord_rows_rejects_untrusted_or_unpinned_assets(src: str) -> None:
    payload = {"rows": [{"row_idx": 0, "row": {"image": {"src": src}}}]}

    with pytest.raises(DownloadError):
        parse_cord_rows(payload, "a" * 40)
