# ADR 002: Browser-local document restoration

## Status

Accepted.

## Decision

Camera scans are restored entirely in the browser. There is no document-restoration backend and no
page upload.

The capture path freezes the current camera preview into an owned RGBA buffer at the shutter press.
The camera's bounded live frames feed Scanic document detection before capture. At capture, the
full-resolution RGBA buffer is passed directly to the Scanic render path for perspective correction
and the fast document filter without encoding and decoding an intermediate PNG. A high-quality JPEG
is encoded once as the durable original; post-capture detection may decode that durable image when
it needs to validate the live crop. After the page becomes reviewable, a second worker performs the
optional AI pass:

1. `document-defects.onnx` classifies shadow, curvature, blur, moiré, finger occlusion, low contrast
   and color-document content at 224 × 224.
2. Classical luminance and detail evidence confirms uncertain shadow and blur predictions.
3. UVDoc is fetched only for a high-confidence curved page. Its two static parts are fetched in
   parallel and reassembled inside the worker before ONNX Runtime creates the session.
4. RT-Focuser is fetched only for a confirmed blurred page.
5. ONNX Runtime Web selects WebGPU where available and WASM otherwise. The final lighting, color,
   contrast and sharpening pass uses a WebGPU compute shader, with a Canvas 2D fallback.
6. Finger and moiré predictions produce honest warnings; the application does not invent occluded
   content or claim complete moiré removal.

The base crop/filter result is published first so the user can continue capturing. The AI result
replaces only the rendered variant when it is ready. PDF export waits for every background operation
to finish. Once a raw captured frame has been encoded successfully, batch state replaces its large
RGBA buffer with the durable JPEG to bound memory during multi-page capture.

## Constraints and consequences

- The classifier is a bootstrap model trained substantially with synthetic data. Its routing policy
  uses conservative thresholds and still requires validation with representative phone photos.
- WebGPU support and performance vary by browser and device. WASM/Canvas fallbacks preserve
  correctness but can be slower.
- The classifier is loaded while the camera is opening. UVDoc and RT-Focuser remain lazy assets so
  ordinary flat, sharp pages do not download them.
- Perspective correction remains in the established Scanic worker. WebGPU accelerates ONNX and the
  adaptive appearance pass; it does not replace Scanic's validated geometry implementation.
- Model provenance, licenses, hashes and limitations are recorded in `THIRD_PARTY_MODELS.md`.
