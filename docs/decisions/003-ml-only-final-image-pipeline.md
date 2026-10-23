# ML-only detection and one final image

Implemented 2026-10-23, continuing Site version 25 (`73b00dc`).

## Detection

Scanic is always created with `detector: 'ml'`, self-hosted assets and minScore 0.5. The live budget remains 960 px / 125 ms: all 15 existing SmartDoc fixtures pass IoU ≥ 0.90. High-confidence results require two stable frames; other results require three. The 3% diagonal drift bound and one-frame miss tolerance remain. Quads must be convex, in bounds and occupy at least 2% of the frame.

Scanic caches ONNX sessions at module scope and exports no reset/release API. Constructing another Scanner in the same realm cannot recover a failed session. Recovery destroys the failed Worker, creates a fresh realm and retries the reduced frame once. A second failure reaches the existing scheduler, with backoff from 250 ms to 2 seconds. A healthy engine remains alive. No classical detector is used.

For missing Worker/canvas capability, an owned same-origin iframe runs the same ML detector on the main thread. Disposal closes its MessageChannel, rejects pending work and removes the iframe. Reclamation of the unloaded realm depends on browser GC. Real-model smoke tests cover both execution paths in development and production builds.

## Pixels and analysis

The shutter snapshots video pixels synchronously into RGBA. A 128 px temporary preview is sampled without encoding, and the page is queued immediately. A durable original JPEG is saved before transfer, preserving retry after a later processing failure. Frozen-frame detection uses reduced captured pixels without decoding this JPEG; its corners take precedence over stable live corners, then full-frame.

`ScannerEngine.renderPixels()` returns an unencoded 720 px untreated crop. The classifier sees 224 × 224; bounded measurements use the untreated crop. The optional render/transient-pixels adapter path remains compatible with injected engines. Production no longer renders a 1600 px intermediate preview.

Analysis combines classifier scores with exposure, percentiles, dark/highlight ratios, contrast, saturation, background variation, Laplacian detail and periodic texture evidence. Correction strengths are continuous and bounded. Periodicity prevents a classifier-only moiré false positive from smoothing ordinary text. Strong measured uneven lighting can request limited correction when the bootstrap classifier misses a shadow.

The persistent classifier Worker prefers WebGPU and retires a failed GPU session before one WASM retry. Input/output tensors are disposed in `finally`; nonfinite logits reject analysis. Warmup and inference are serialized. The 15-second watchdog remains active after cancellation until a terminal acknowledgement; a stuck Worker is terminated. Classifier failure produces an honest local fallback.

Final rendering applies warp, bounded smoothing, illumination correction, paper/gamma lift, CLAHE on Lab L*, color protection and final sharpening before JPEG encoding at quality 0.96. Original mode bypasses enhancement. There is no heavy dewarp model or new OpenCV dependency. Small crops are not forcibly enlarged; the final long side is capped at 3000 px. Thumbnails come from final pixels, and PDF embeds the exact displayed JPEG without running image processing again.

Camera and imported images share this helper. Filter/rotation changes reuse page analysis; crop changes invalidate it. Opening a ready page does not render again. Curvature, fingers, severe blur and moiré receive retake warnings rather than fabricated content.

## Evidence and limits

See [numeric results](../benchmarks/ml-only-pipeline-2026-10-23.json). Chrome headless on the Windows development machine, with GPU disabled, processed generated 2400 × 3200 captures with median totals of 444 ms (normal), 900 ms (shadow) and 387 ms (color), three runs each. The first normal run was 826 ms. Engines are warmed as in the camera flow; mobile-network model downloads are excluded. Stage medians need not sum to a total median.

SmartDoc development/holdout mean IoU is 0.9779/0.9523, with 15/15 passing IoU ≥ 0.90. Synthetic smoke detects 2/2 documents and avoids 2/2 negative fixtures. Page/Worker/iframe network audits report zero requests outside the local origin. No image data is logged.

The detector runtime assets and bootstrap recovery were subsequently corrected in [decision 004](004-detector-runtime-compatibility.md); the original measurements below describe the earlier build. The classifier explicitly references the installed ORT 1.27 asyncify WASM. A trial adding 26.8 MB JSEP was discarded; the final build keeps the existing 24.3 MB asyncify binary (about 6 MB gzip) and Scanic's 1.52 MB WASM. Dependency and model versions are unchanged. The adaptive pixel path uses bounded CPU operations in the Scanic Worker; no performance advantage over GPU processing on phones is claimed.

Numeric timing collection is capped at 24 measurements and disabled in production unless `VITE_SCAN_TIMINGS=true`. Phone latency, prolonged camera thermals, long-session memory, real OCR accuracy and classifier calibration remain device-validation work. Synthetic fixtures and this small SmartDoc sample do not qualify every lighting, stamp or handwriting case.

The build retains a known vendor warning about an unused `ort.wasm.min.mjs` URL; production model smoke exercises the configured asset path. Audit finds no high/critical issue and two moderate findings in the existing Vitest dev dependency; versions were left unchanged in this feature change.
