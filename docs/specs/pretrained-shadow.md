# Pretrained illumination correction (2026-10-26)

## Objective and scope

Use an existing trained model to correct wide cast shadows in the Web and custom C++ pipeline without training, replacing the document pixels, changing PDF geometry, or loading a model in the live camera loop. Preserve the existing filters and classical fallback. Native OpenCV legacy APIs are outside this change.

## Selection and budget

Evaluate the 6,078,861-byte GCNet ONNX checkpoint distributed by RapidUnDistort for the MIT-licensed GCDRNet paper against the supplied shadowed document. Its first stage outputs three-channel illumination, not restored text. Reject the 120,041,674-byte DocShadow checkpoint for default mobile deployment. No additional production runtime dependency: reuse ONNX Runtime already installed in Web and C++.

Inference uses one thread and an aspect-preserving sample bounded to a 384-pixel long side (dimensions rounded to multiples of 32). Apply the interpolated illumination to the existing full-resolution pixel buffer; no full-resolution floating-point tensor. Lazy-load only for the explicit `shadow-removal` filter, serialize inference, reuse the session within its owner, release with the worker/engine. Validate finite positive model output before any mutation. Report unavailable model/runtime as a failed AI operation; the existing filters remain selectable and must never be reported as successful model inference.

The original-photo probe reduced the wide shadow, but controls showed GCNet can brighten colored paper and printed gray fills. Therefore this release adds an opt-in filter, not a replacement for the default enhanced-color policy. No phone thermal or broad mobile latency claim is made.

## Implementation order

1. Confirm pinned model input/output, BGR/0..1 normalization, license/provenance, image quality and bounded inference cost.
2. Add tested pure sampling and illumination application; connect a lazy runtime to final Web rendering and both comparison crop paths. Recompute contrast analysis after shadow correction.
3. Add the same optional model stage to native C++ using the existing ONNX Runtime and model directory, preserving C ABI sizes and old filter behavior when the optional model is absent. Package its checkpoint and notices.
4. Run focused new-contract checks, typecheck and build; publish the existing Site. Do not repeat the user's completed long browser stress test.

## Contracts and verification

- Original/other filters do not fetch or run GCNet.
- Missing/invalid model output leaves the caller's pixels unchanged and reports failure.
- Preserve dimensions, alpha and source ownership; never reconstruct glyphs with a low-resolution RGB output.
- Unit tests use small deterministic fields; one actual ONNX inference verifies model compatibility and records time. Private supplied images remain ignored local QA inputs.
- Commands: `npm test -- src/imaging/restoration/shadow-field.test.ts src/imaging/restoration/enhanced-appearance.test.ts`; `npm run typecheck`; `npm run build`. Native CMake/CTest uses the established Windows build scripts.
- Image improvement is not evidence of reduced device heat. Report unmeasured mobile power/thermal behavior honestly.

## Code style and structure

Follow strict TypeScript and the existing owned `RgbaBackendInput` boundary, e.g. `applyShadowField(input, field)`. Pure pixel math belongs in restoration modules, inference/loading in its runtime adapter, and UI only presents outcomes. Follow existing C++17 RAII, one-thread inference mutex and cancellation conventions. Do not add training code or upload document pixels.
