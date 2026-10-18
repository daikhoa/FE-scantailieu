from io import BytesIO

import httpx
import pytest
from anyio import fail_after
from PIL import Image

from app.classifier import ClassificationResult
from app.config import Settings
from app.main import create_app
from app.policy import DefectScores
from app.restorer import RestoredImage


class CleanClassifier:
    def classify(self, _image: Image.Image) -> ClassificationResult:
        return ClassificationResult(
            scores=DefectScores(
                shadow=0.1,
                curved=0.1,
                blur=0.1,
                moire=0.1,
                finger=0.1,
                low_contrast=0.1,
                color_document=0.1,
            ),
            model_id="fixture-classifier",
            model_version="1",
        )


class HeavyClassifier:
    def classify(self, _image: Image.Image) -> ClassificationResult:
        return ClassificationResult(
            scores=DefectScores(
                shadow=0.95,
                curved=0.1,
                blur=0.1,
                moire=0.1,
                finger=0.1,
                low_contrast=0.1,
                color_document=0.1,
            ),
            model_id="fixture-classifier",
            model_version="1",
        )


class InvalidRestorer:
    def restore(self, _image: Image.Image, _decision: object) -> RestoredImage:
        return RestoredImage(
            data=b"not-an-image",
            media_type="image/png",
            provider_id="fixture-provider",
            provider_version="1",
        )


def image_bytes(fmt: str = "PNG", size: tuple[int, int] = (64, 48)) -> bytes:
    stream = BytesIO()
    Image.new("RGB", size, "white").save(stream, format=fmt)
    return stream.getvalue()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def client_for(app: object) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_health_does_not_claim_model_is_ready() -> None:
    client = client_for(create_app(settings=Settings(), classifier=None))

    async with client:
        with fail_after(3):
            response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "classifier": "unavailable"}


@pytest.mark.anyio
async def test_valid_clean_document_returns_original_with_auditable_headers() -> None:
    client = client_for(create_app(settings=Settings(), classifier=CleanClassifier()))
    payload = image_bytes()

    async with client:
        response = await client.post(
            "/v1/restorations",
            files={"image": ("scan.png", payload, "image/png")},
        )

    assert response.status_code == 200
    assert response.content == payload
    assert response.headers["x-restoration-route"] == "local"
    assert response.headers["x-restoration-stages"] == ""
    assert response.headers["x-classifier-model"] == "fixture-classifier@1"


@pytest.mark.anyio
async def test_missing_model_returns_explicit_service_error() -> None:
    client = client_for(create_app(settings=Settings(), classifier=None))

    async with client:
        response = await client.post(
            "/v1/restorations",
            files={"image": ("scan.png", image_bytes(), "image/png")},
        )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "model_unavailable"


@pytest.mark.anyio
async def test_upload_rejects_spoofed_content_type() -> None:
    client = client_for(create_app(settings=Settings(), classifier=CleanClassifier()))

    async with client:
        response = await client.post(
            "/v1/restorations",
            files={"image": ("scan.jpg", b"not an image", "image/jpeg")},
        )

    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "invalid_image"


@pytest.mark.anyio
async def test_upload_rejects_oversized_payload() -> None:
    settings = Settings(max_upload_bytes=128)
    client = client_for(create_app(settings=settings, classifier=CleanClassifier()))

    async with client:
        response = await client.post(
            "/v1/restorations",
            files={"image": ("scan.png", image_bytes(size=(256, 256)), "image/png")},
        )

    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "image_too_large"


@pytest.mark.anyio
async def test_upload_rejects_excessive_decoded_pixels() -> None:
    settings = Settings(max_image_pixels=1_000)
    client = client_for(create_app(settings=settings, classifier=CleanClassifier()))

    async with client:
        response = await client.post(
            "/v1/restorations",
            files={"image": ("scan.png", image_bytes(size=(64, 48)), "image/png")},
        )

    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "image_dimensions_too_large"


@pytest.mark.anyio
async def test_invalid_restoration_provider_output_is_not_forwarded_to_the_browser() -> None:
    client = client_for(
        create_app(
            settings=Settings(),
            classifier=HeavyClassifier(),
            restorer=InvalidRestorer(),
        )
    )

    async with client:
        response = await client.post(
            "/v1/restorations",
            files={"image": ("scan.png", image_bytes(), "image/png")},
        )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "inference_failed"
