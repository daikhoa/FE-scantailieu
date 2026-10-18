# CamScanner 7.23.5 static analysis for the web scanner

## Scope and provenance

- APK: `com.intsig.camscanner_7.23.5.2608060000-72351_minAPI21(arm64-v8a)(nodpi)_apkmirror.com.apk`
- SHA-256: `0c471605e1bd2ce3c7a9c269d20aaad6317e0702d04686623f4616def13a7e5a`
- Package/version: `com.intsig.camscanner`, `7.23.5.2608060000` (`72351`)
- Static analysis only. The APK was not installed, modified, or executed.
- REA package evidence: `ev_91b42a60fcbed8cdae375ed5675a862c43f5a4459333fcb587c5047b7e296134`
- Parent artifact evidence: `ev_7de32e3ff92b85542b097851d7cc55bb7229280a69ed82e4eb96ccf05a99da82`
- Toolchain observed by REA: JADX Headless MCP 0.7.1 on Java 17.

This report separates directly observed behavior from design recommendations. Decompiled output is evidence about this build, not source code suitable for copying.

## Java protection and loader path

JADX exposes only six classes: `com.intsig.camscanner.R`, Kotlin's `DebugProbesKt`, and four `s.h.e.l.l.*` loader classes. This is why the main application algorithms are not visible as ordinary Java/Kotlin.

- `s.h.e.l.l.S.attachBaseContext` calls `N.l(this, "com.intsig.camscanner")`, then requests the real application class `com.intsig.camscanner.launch.CsApplication` through `N.r(...)`. REA evidence: `ev_4d803f9730ddfa82dd2f14092aa8e93e17f9e5c37c033e05ddef79cca80ac7f7`.
- `s.h.e.l.l.N.<clinit>` loads `libexec.so` and, conditionally, `libexecmain.so`. REA evidence: `ev_3e8a96dedc55d51c9fc5c1a3ffe742d822d9c339b542f4683bcdc26a76d4e381`.
- ABI selection is visible in `s.h.e.l.l.S.l`. REA evidence: `ev_f329180ecf7b468058d48d071e7f73ae32ed155fe888a72d696e441ede9c2c73`.

The APK's `classes.dex` is only 13,624 bytes. The protected loader assets are `assets/ijm_lib/arm64-v8a/libexec.so` (765,648 bytes) and `libexecmain.so` (138,520 bytes). Therefore a normal full JADX decompile cannot recover the application layer from this artifact.

## Native image stack

The APK contains a substantial native image pipeline:

| Library | Size | Direct evidence |
| --- | ---: | --- |
| `libpagescanner.so` | 12,618,200 | document crop, line/Hough logic, perspective transform, dewarp, illumination/background cleanup, several MNN models |
| `libmagicenhancer.so` | 5,458,208 | enhancement mode router, deshadow, document classifier, scan, color enhancement, moire and finger removal |
| `libopencv.so` | 6,463,592 | OpenCV runtime used by the native pipeline |
| `libMNN.so` | 1,899,368 | neural-network inference runtime |
| `libCVNN.so` | 1,882,960 | additional inference runtime |
| `libncnn.so` | 1,320,912 | neural-network inference runtime |
| `libscannercs.so` | 1,073,968 | JNI entry points for border detection, trimming and enhancement |
| `libimageprocessor.so` | 342,304 | deblur JNI and inference orchestration |
| `libenhance4draft.so` | 288,848 | draft enhancement |

The relevant JNI surface in `libscannercs.so` includes `detectBorder`, `detectImageS`, `detectYuvImage`, `trimBitmap`, `trimFile`, `trimImageS`, corner adjustment, `enhanceBitmap`, `enhanceFile`, `enhanceImageS`, and `computeDocumentPhysicalSize`. This supports the observed pipeline: detect/validate corners, perspective trim, then enhance.

## Observed processing pipeline

### 1. Document detection and crop

`pagescan::SingleRectCrop::findSingleRect` calls `documentCrop`, receives eight integer coordinates, and returns four X/Y corners. It can reject a result when at least three corners are too close to the image border; the check is normalized around a 601-pixel long side with an approximately 8-pixel margin. Local decompile: `../.rea-analysis/pagescanner-findSingleRect.c`.

`documentCrop` operates on a region and offsets the resulting corners back into full-image coordinates. Its object carries state across calls, consistent with video-frame detection rather than four independent point guesses. Local decompile: `../.rea-analysis/pagescanner-documentCrop.c`.

### 2. Perspective geometry

`pagescan::transformCrop` orders the four corners, can expand or contract them via `adjustCorners`, calls `transformCut`, and applies 90/180/270-degree orientation by transpose/flip. Local decompile: `../.rea-analysis/pagescanner-transformCrop.c`.

`getTargetPointsForPerspectiveTransform` measures all four edges. In the relevant branch it uses the average of opposite edges for output width and height. Another option enforces a long side of at least 3000 pixels while preserving aspect ratio. Local decompile: `../.rea-analysis/pagescanner-targetPoints.c`.

### 3. Content-aware enhancement selection

`scanet::enhance` is a mode router, not one universal filter:

- mode 1: `deshadow`, then `sharpEnhance(..., 4)`;
- mode 2: copy, `enhance_color`, then `sharpEnhance(..., 4)`;
- mode 3: optionally run `document_radar`, select `scan` or `scan_old`, then sharpen at strength 2 or 4;
- fallback: `scan_old`, then sharpen at strength 4.

Local decompile: `../.rea-analysis/magicenhancer-enhance.c`. `document_radar` uses MNN inference with padded tensor input and returns a class/document identifier plus confidence: `../.rea-analysis/magicenhancer-document_radar.c`.

### 4. Shadow removal

`scanet::deshadow` runs an `InferNet` model to estimate illumination, resizes the model output to the document size, then normalizes image channels with the observed form:

```text
output = clamp(input * 255 / estimated_illumination + 0.5, 0, 255)
```

The model path uses `InferNet::to_tensor` and `InferNet::forward`; on failure, the routine copies the original image. Local decompile: `../.rea-analysis/magicenhancer-deshadow.c` (notably the vectorized division around lines 846-888).

This is the most important quality difference from a simple contrast filter: CamScanner estimates the light field first, divides it out, and sharpens only afterward.

### 5. Classical background estimation and deblur

`libpagescanner.so` also contains non-neural background tools. `rollingBallBackground` chooses downsample factors 1, 2, 4, or 8 as radius grows and produces a clamped 0-255 background map. `EvaluationIllumination` uses local extrema to estimate illumination. Local decompiles: `../.rea-analysis/pagescanner-rollingBallBackground.c` and `../.rea-analysis/pagescanner-EvaluationIllumination.c`.

`ImageEnhance::deblur_process` in `libimageprocessor.so` uses OpenCV color conversion, split/resize/merge and an inference network. Local decompile: `../.rea-analysis/libimageprocessor-deblur_process.c`.

### 6. Model inventory and storage evidence

The enhancement path uses several specialist models rather than one universal model. Targeted static strings and decompilation identify the following roles:

- `document_radar` and `classifyShadowTypeBitmap`: classify document/content or shadow type before choosing an enhancement branch;
- `dewarp_net_2` and `curve_line_model`: estimate curved-page geometry;
- `deshadow` and `EvaluationIllumination`: estimate the illumination field and remove it;
- `deblur_net`: restore blurred text/edges;
- `init_moire_model`, `moire_extract`, `init_finger_model`, and `remove_finger`: optional artifact-specific cleanup;
- `scan`, `scan_old`, `enhance_color`, and `sharpEnhance`: produce the final scan appearance after model inference.

The model/data payloads are embedded in native ELF libraries, not shipped as browser-ready ONNX files:

| Library | `.rodata` size | REA evidence |
| --- | ---: | --- |
| `libmagicenhancer.so` | `0x4cf89e` (~4.81 MiB) | `ev_e636c08e834ea5748904e40bfc568050507562acd5034d9f3467c4be9d2c072d` |
| `libpagescanner.so` | `0x861f75` (~8.38 MiB) | `ev_7d1dd77ee5534ffcaefd1823fa554c08b58135ffd0b8ffad40f03f490f68b9f2` |
| `libimageprocessor.so` | `0x6e5d` | `ev_662f0905abf23e5994ea56ca09bf6e7be45cef448b4f136d3529e301a1ae63d1` |

`libmagicenhancer.so` also contains MNN/ncnn inference paths and `model_cipher::decrypt`/AES-related strings. This does not prove every model blob is encrypted, but it does prove that treating `.rodata` as a normal ONNX file would be incorrect. The binaries are Android ARM64 ELF libraries with JNI, OpenCV, MNN and ncnn dependencies, so a browser cannot load or execute them directly.

## Independent web implementation

The web app already uses Scanic/Scanic ML for corners and has a sound inverse-homography warp with premultiplied-alpha bilinear sampling. Its geometry goes beyond a naive max-edge rule by estimating the perspective aspect ratio from a camera prior.

The first clean-room enhancement implemented from the observed principle is an illumination normalization stage in `src/imaging/rendering/document-filter.ts`:

1. estimate a smooth local light field using an O(n) separable box mean;
2. detect whether the page actually contains a meaningful light gradient using background percentiles;
3. normalize darker regions toward the estimated paper level with bounded gain;
4. retain color ratios and protect highlights from clipping;
5. run the existing local text-detail enhancement afterward.

It intentionally does not use CamScanner's model, weights, constants, or recovered implementation. Uniform pages bypass normalization. A regression test verifies that a synthetic smooth shadow is reduced by at least 40% while dark-text contrast increases.

The black-and-white path now uses a Sauvola threshold derived from the local mean and standard deviation instead of the previous fixed `localMean * 0.85` rule. The implementation reuses the existing sliding window, adds only a width-sized squared-sum buffer in black-and-white mode, and has a regression test for retaining faint glyphs in a locally high-contrast form region.

The OCR-color path now has an on-device quality router. It samples at most 65,536 pixels to classify illumination range, highlight clipping, color content and edge detail. Uneven pages use a 4×4 to 16×16 percentile illumination grid with bilinear interpolation, which is resistant to dense dark text; already high-detail pages skip the local sharpen pass. This mirrors the APK's route-first architecture without claiming to reproduce its learned classifier.

The web capture and render path now also applies three concrete quality upgrades:

1. The shutter freezes the current high-resolution preview synchronously before the first asynchronous operation. It deliberately does not call `ImageCapture.takePhoto()`: that API may capture a later frame and reintroduce the hold-still delay. The stable live Scanic quad is frozen at the same moment and used only when post-capture detection on the original is uncertain.
2. Perspective output preserves the geometry-derived aspect ratio and targets a 3000-pixel long side when the source itself is at least 3000 pixels. Enlargement remains bounded by the source's total pixel count and the existing worker memory limits.
3. OCR-color/grayscale preset v7 adds neutral-paper tone restoration after illumination flattening. A quadratic lift brings dim paper toward 238 while applying much less lift to dark glyphs; color-rich content bypasses this stage and existing white highlights are never darkened.

## Recommended next increments

1. Build a licensed evaluation set containing shadows, folds, colored receipts, glossy pages, handwriting and low light. Report background-uniformity, OCR character/word error rate, clipping and runtime separately.
2. Replace the box background estimator only if measurements justify it. Candidate independent implementations are a downsampled rolling-ball/morphological background map or a small model trained from owned/synthetic data.
3. Add a content classifier for photo/color-document/plain-text routing. Do not apply aggressive whitening to photographs or artwork.
4. Add curved-page dewarp as a separate optional model. The current `auto` dewarp contract honestly falls back to perspective-only; CamScanner contains dedicated `dewarp_net`/curve-line functionality that the web app does not yet reproduce.
5. Preserve the original full-resolution capture, perform detection on a smaller frame, and render from the original. This path is now implemented, including the bounded 3000-pixel target; upscaling still cannot recreate detail absent from the camera frame.

## Replacement plan for production-quality web restoration

The web application can reproduce the same _architecture_ without importing the Android `.so` files. The highest-quality practical design is a hybrid: the browser handles capture and interactive corners; a GPU-capable restoration service handles the expensive neural stages; the current browser filter remains the offline fallback.

| Stage | APK behavior observed | Current web behavior | Recommended independent component |
| --- | --- | --- | --- |
| Capture and corners | native detector and tracked crop state | Scanic ML plus classical fallback | Keep Scanic; always render from the original full-resolution frame |
| Route by content/defect | `document_radar`, shadow classification and mode router | one user-selected filter path | Add a bounded quality analyzer first; later replace/augment it with a small owned classifier |
| Flat perspective | `transformCrop`/`transformCut` | inverse-homography warp | Keep the current implementation |
| Curved-page dewarp | `dewarp_net_2`, curve-line model | unavailable; perspective-only fallback | UVDoc or PaddleOCR's UVDoc module |
| Shadow/lighting | learned light field, then per-channel division | large-radius box-mean light field | DocRes `deshadowing`, or a small owned low-resolution illumination-map U-Net |
| Blur restoration | `deblur_net` | no learned deblur | DocRes `deblurring`, only when blur score warrants it |
| Document appearance | `scan`/`scan_old`/`enhance_color`, then sharpen | fixed OCR-color/grayscale adjustment | DocRes `appearance` or `end2end`, followed by conservative high-resolution finishing |
| Binarization | integral/adaptive threshold paths | Sauvola local mean/standard-deviation threshold | Keep the new Sauvola implementation; tune it only against paired document/OCR benchmarks |
| Moiré/finger cleanup | separate specialist models | unavailable | Add later as opt-in specialist stages; do not block the core restoration pipeline |

### Recommended execution order

1. Capture the largest real camera frame available and retain it unchanged.
2. Detect corners on a downscaled preview and map the points back to original-image coordinates.
3. Perspective-correct from the original pixels. If curvature is detected, run UVDoc before appearance enhancement.
4. Calculate blur, shadow-gradient, clipping, noise, color-content and photo-likelihood scores. These scores decide which expensive stages run.
5. Run restoration at a model-safe resolution. For illumination models, upscale the predicted smooth light field and apply it to the full-resolution image; do not blindly upscale a small restored bitmap.
6. Apply a final edge-aware text enhancement at full resolution, preserving highlights and color ratios.
7. Produce separate OCR-color, grayscale and adaptive black-and-white outputs. Preserve the original and transformation metadata so the user can change mode without recapturing.

### Candidate open implementations

- [DocRes](https://github.com/ZZZHANG-jx/DocRes) is the official CVPR 2024 implementation for dewarping, deshadowing, appearance enhancement, deblurring, binarization and end-to-end document restoration. The repository code is MIT-licensed. Its PyTorch/Restormer implementation is better suited to a GPU service first; checkpoint redistribution terms must still be verified separately from the code license.
- [UVDoc](https://github.com/tanguymagne/UVDoc) predicts a 3D document grid and a 2D unwarping grid for curved documents. Its repository is MIT-licensed. [PaddleOCR's UVDoc module](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/module_usage/text_image_unwarping.md) is another maintained integration route.
- [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) can run a converted compact model with WebGPU where supported and WASM as fallback. The official [WebGPU support page](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html) shows why a pure-client deployment still needs device/browser fallbacks and benchmarking.

For this project, the recommended first neural prototype is server-side DocRes plus UVDoc. The official DocRes inference builds a six-channel Restormer (`dim=48`) and uses a 1024×1024 deshadow prompt plus separately downloaded checkpoints. PaddleOCR currently lists UVDoc at about 30.3 MB. Those facts make a lazy GPU service the lower-risk first integration than adding both raw models to the mobile initial bundle. A pure-browser model should be considered only after the quality benchmark is green, then distilled/quantized to an ONNX model small enough for mobile.

### Acceptance gate

“As good as the APK” must be measured on the same captured originals. The comparison set should include flat pages, curved book pages, hard shadows, folds, glossy paper, colored receipts, low light, blur and photo-heavy documents. At minimum record:

- OCR character and word error rates;
- background uniformity without erasing faint text;
- highlight/shadow clipping percentages;
- line straightness after dewarp;
- color error on photo/colored-document regions;
- output resolution and runtime separately from image quality.

Without paired outputs from the APK and web for the same inputs, static analysis can establish the pipeline and model roles, but cannot honestly establish visual parity.

## Limits

- The Java application layer is protected and was not dynamically unpacked because execution was explicitly out of scope.
- Native decompilation recovers control/data flow but not original names for every internal helper, comments, training data or exact high-level intent.
- The embedded model blobs are technically not browser-ready assets: they are inside ARM64 ELF libraries, use native inference runtimes, and may pass through application-specific cipher/loader code. Exact extraction and conversion were not established. If those exact weights are ever recovered, their provenance and redistribution rights should be verified separately; the recovered processing behavior is already sufficient to guide an independent implementation.
