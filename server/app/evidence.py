from __future__ import annotations

import numpy as np
from PIL import Image, ImageOps

from app.policy import DetailLevel, RestorationEvidence


def analyze_restoration_evidence(image: Image.Image) -> RestorationEvidence:
    grayscale = ImageOps.grayscale(ImageOps.exif_transpose(image))
    grayscale.thumbnail((512, 512), Image.Resampling.BILINEAR)
    pixels = np.asarray(grayscale, dtype=np.float32)
    lower, upper = np.percentile(pixels, (10, 90))
    highlight_ratio = float(np.mean(pixels >= 245))
    horizontal_detail = np.mean(np.abs(np.diff(pixels, axis=1))) if pixels.shape[1] > 1 else 0
    vertical_detail = np.mean(np.abs(np.diff(pixels, axis=0))) if pixels.shape[0] > 1 else 0
    detail_score = float((horizontal_detail + vertical_detail) / 2)
    detail: DetailLevel = "low" if detail_score < 5 else "medium" if detail_score < 12 else "high"
    return RestorationEvidence(
        illumination_range=float(upper - lower),
        highlight_ratio=highlight_ratio,
        detail=detail,
    )

