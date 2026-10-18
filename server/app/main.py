from __future__ import annotations

from io import BytesIO
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, UnidentifiedImageError

from app.classifier import DocumentClassifier, ModelUnavailableError, OnnxDocumentClassifier
from app.config import Settings
from app.evidence import analyze_restoration_evidence
from app.policy import choose_restoration
from app.restorer import RestoredImage, RestorationProvider, RestorationUnavailableError


ALLOWED_MEDIA_TYPES = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
}
READ_CHUNK_BYTES = 1024 * 1024


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


async def _read_bounded(upload: UploadFile, maximum: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(min(READ_CHUNK_BYTES, maximum - total + 1))
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > maximum:
            raise _error(413, "image_too_large", "The encoded image exceeds the upload limit.")
        chunks.append(chunk)


def _decode_image(payload: bytes, media_type: str, settings: Settings) -> Image.Image:
    expected_format = ALLOWED_MEDIA_TYPES.get(media_type)
    if expected_format is None:
        raise _error(415, "unsupported_image_type", "Only JPEG, PNG and WebP are supported.")
    try:
        with Image.open(BytesIO(payload)) as candidate:
            if candidate.format != expected_format:
                raise _error(415, "invalid_image", "The image content does not match its media type.")
            width, height = candidate.size
            if (
                width <= 0
                or height <= 0
                or width > settings.max_image_side
                or height > settings.max_image_side
                or width * height > settings.max_image_pixels
            ):
                raise _error(
                    413,
                    "image_dimensions_too_large",
                    "The decoded image dimensions exceed the processing limit.",
                )
            candidate.load()
            return candidate.convert("RGB")
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise _error(415, "invalid_image", "The uploaded file is not a valid supported image.") from error


def _validate_restored_image(result: RestoredImage, settings: Settings) -> None:
    if not result.data or len(result.data) > settings.max_upload_bytes:
        raise ValueError("restoration provider returned an invalid encoded size")
    try:
        _decode_image(result.data, result.media_type, settings)
    except HTTPException as error:
        raise ValueError("restoration provider returned an invalid image") from error
    for identity in (result.provider_id, result.provider_version):
        if not identity or len(identity) > 64 or not all(
            character.isalnum() or character in "._-" for character in identity
        ):
            raise ValueError("restoration provider returned an invalid identity")


def _default_classifier(settings: Settings) -> DocumentClassifier | None:
    if settings.classifier_model_path is None:
        return None
    return OnnxDocumentClassifier(
        model_path=settings.classifier_model_path,
        model_id=settings.classifier_model_id,
        model_version=settings.classifier_model_version,
    )


def create_app(
    *,
    settings: Settings | None = None,
    classifier: DocumentClassifier | None = None,
    restorer: RestorationProvider | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings.from_env()
    resolved_classifier = classifier or _default_classifier(resolved_settings)
    app = FastAPI(title="Document restoration service", version="0.1.0", debug=False)
    if resolved_settings.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(resolved_settings.allowed_origins),
            allow_credentials=False,
            allow_methods=["POST", "GET"],
            allow_headers=["Content-Type"],
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {
            "status": "ok",
            "classifier": "configured" if resolved_classifier is not None else "unavailable",
        }

    @app.post("/v1/restorations")
    async def restore_document(
        image: Annotated[UploadFile, File(...)],
    ) -> Response:
        payload = await _read_bounded(image, resolved_settings.max_upload_bytes)
        decoded = await run_in_threadpool(
            _decode_image,
            payload,
            image.content_type or "",
            resolved_settings,
        )
        if resolved_classifier is None:
            raise _error(503, "model_unavailable", "No verified classifier model is configured.")
        try:
            classification = await run_in_threadpool(resolved_classifier.classify, decoded)
            evidence = await run_in_threadpool(analyze_restoration_evidence, decoded)
            decision = choose_restoration(classification.scores, evidence)
            model_identity = f"{classification.model_id}@{classification.model_version}"
            headers = {
                "X-Restoration-Route": decision.route,
                "X-Restoration-Stages": ",".join(decision.stages),
                "X-Classifier-Model": model_identity,
            }
            if decision.route == "local":
                return Response(content=payload, media_type=image.content_type, headers=headers)
            if restorer is None:
                raise RestorationUnavailableError("No restoration provider is configured")
            result = await run_in_threadpool(restorer.restore, decoded, decision)
            _validate_restored_image(result, resolved_settings)
            headers["X-Restoration-Provider"] = f"{result.provider_id}@{result.provider_version}"
            return Response(content=result.data, media_type=result.media_type, headers=headers)
        except ModelUnavailableError as error:
            raise _error(503, "model_unavailable", "The classifier model is unavailable.") from error
        except RestorationUnavailableError as error:
            raise _error(503, "restorer_unavailable", "The selected restoration provider is unavailable.") from error
        except (ValueError, RuntimeError) as error:
            raise _error(502, "inference_failed", "The restoration model returned an invalid result.") from error

    return app


app = create_app()

