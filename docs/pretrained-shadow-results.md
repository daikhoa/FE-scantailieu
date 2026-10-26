# Pretrained shadow release verification — 2026-10-26

## Decision

Ship the unchanged pretrained GCNet first stage of GCDRNet as an explicit **Khử bóng AI** filter, not the enhanced-color default. It substantially reduces the supplied wide cast shadow, but colored-paper and printed-gray controls demonstrate that universal color preservation cannot be claimed. Original images remain immutable; users can select any existing filter. No training or new production dependency was added.

## Implementation

- Checkpoint, source, SHA-256, normalization and limits: [model card](../public/models/shadow/MODEL-CARD.md).
- <=384-side float32 illumination inference, BGR NCHW, one thread; interpolation and capped 1..4 gains on full-resolution owned pixels; contrast recomputed after correction. Existing final output dimensions/encoding unchanged.
- Lazy in the final render owner; not loaded for live detection, original, enhanced-color or other old filters. Session reused within its worker/iframe/engine lifetime. Model/runtime failure is an error, not a substituted model result.
- Comparison uses the Web or custom C++ WASM crop followed by the same JS/ORT appearance stage. Native DLL runs GCNet directly with ONNX Runtime C++ in process. Reports explicitly distinguish this boundary.
- Native ABI structure sizes/defaults/old enum values unchanged; optional filter 5, optional capability 32. Native OpenCV API remains outside this change.

## Evidence

- Focused Web checks: 227 tests in 18 files passed before final text-only UI clarifications; final focused new-filter/UI checks: 28 tests passed. Typecheck and changed-file ESLint passed. Production build and Safari comparison module-entry guard passed.
- Native CTest: all 8 suites passed, including the new real-ONNX public API test, missing model/no partial page, cancellation, existing ABI/pixel/PDF/integration suites.
- Actual ONNX WASM run in Node on the local development machine, supplied 720x960 image: setup 349.8 ms; sample+inference 121.1 ms; field application 42.3 ms. Single observations, not a statistical benchmark or phone measurement.
- One production-build browser run, one repetition each: both engines completed with two 720x960 PNGs; first end-to-end runs 814.9 ms Web and 551.6 ms C++ crop + shared AI. These include startup/cache differences and must not be treated as steady-state speed comparison. No repeated thermal stress run was performed.
- Private source photos and local diagnostic outputs were not added to the repository/public Site.

## Limits

Model size is 6.08 MB, not total runtime download or peak RAM. The Web path reuses the pinned ONNX Runtime CPU binary already served for corner detection; the comparison page may still need to download it. Total browser RAM, mobile speed, battery and heat have not been measured. Dense paper dewarping, recovery of missing text, universal shadow removal and accurate color on every document are not claimed.
