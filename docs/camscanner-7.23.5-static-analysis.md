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

## Independent web implementation

The web app already uses Scanic/Scanic ML for corners and has a sound inverse-homography warp with premultiplied-alpha bilinear sampling. Its geometry goes beyond a naive max-edge rule by estimating the perspective aspect ratio from a camera prior.

The first clean-room enhancement implemented from the observed principle is an illumination normalization stage in `src/imaging/rendering/document-filter.ts`:

1. estimate a smooth local light field using an O(n) separable box mean;
2. detect whether the page actually contains a meaningful light gradient using background percentiles;
3. normalize darker regions toward the estimated paper level with bounded gain;
4. retain color ratios and protect highlights from clipping;
5. run the existing local text-detail enhancement afterward.

It intentionally does not use CamScanner's model, weights, constants, or recovered implementation. Uniform pages bypass normalization. A regression test verifies that a synthetic smooth shadow is reduced by at least 40% while dark-text contrast increases.

## Recommended next increments

1. Build a licensed evaluation set containing shadows, folds, colored receipts, glossy pages, handwriting and low light. Report background-uniformity, OCR character/word error rate, clipping and runtime separately.
2. Replace the box background estimator only if measurements justify it. Candidate independent implementations are a downsampled rolling-ball/morphological background map or a small model trained from owned/synthetic data.
3. Add a content classifier for photo/color-document/plain-text routing. Do not apply aggressive whitening to photographs or artwork.
4. Add curved-page dewarp as a separate optional model. The current `auto` dewarp contract honestly falls back to perspective-only; CamScanner contains dedicated `dewarp_net`/curve-line functionality that the web app does not yet reproduce.
5. Preserve the original full-resolution capture, perform detection on a smaller frame, and render from the original. Treat 3000 pixels as an export-quality target only when memory limits and source resolution permit it; upscaling cannot recreate missing detail.

## Limits

- The Java application layer is protected and was not dynamically unpacked because execution was explicitly out of scope.
- Native decompilation recovers control/data flow but not original names for every internal helper, comments, training data or exact high-level intent.
- The embedded neural model weights are proprietary application assets. This project should train or license its own models rather than extract or redistribute them.
