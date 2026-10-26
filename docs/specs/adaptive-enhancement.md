# Adaptive enhanced-color pipeline (2026-10-26)

## Objective

Integrate pretrained shadow correction into the default enhanced-color render for Web and native C++, preserve original resolution/ownership, improve existing thin ink locally, and keep dark artwork/colored paper from being treated as illumination. No training, external OCR upload or new production dependencies. Original and other filters remain available.

## Plan and contracts

1. Freeze the current enhanced-color/GCNet baselines on the ten supplied photos. Use the same manually reviewed crop and orientation for image/OCR comparisons so detector errors are not mistaken for filter quality. Assess document detection separately; these comparisons do not prove perfect auto cropping.
2. Build a bounded sample/grid policy: background quantiles, chroma, thin-ink evidence, bright-paper reference and shadow range. Skip model load on even illumination or untrusted/colorful surfaces; infer at <=384-side when needed. Normalize learned illumination using nearby trusted paper rather than whitening material colors indiscriminately. Protect mismatching printed gray regions.
3. Apply bounded illumination gains and local thin-ink darkening to owned full-resolution pixels in one pass with bounded row buffers. Remove global RGB contrast from this new default path. On missing model, preserve a usable classical result and explicitly report fallback; explicit AI remains an error on unavailable inference.
4. Port the same policy to native C++ and check deterministic synthetic parity. The browser comparison must label any shared JS/ORT appearance stage honestly; it is not a native DLL inference benchmark.
5. Run OCR locally with fixed Vietnamese/English pretrained Tesseract settings, compare raw crop/baseline/new output. Check selected manually transcribed text regions, not confidence alone. Mathematical typesetting, diagrams, occlusion and glare remain separate OCR limitations.
6. Package native DLL, run relevant checks and publish to the existing public Site.

## Boundaries and commands

- Always: preserve color controls, glyph geometry, alpha, dimensions and untouched source; validate every model field before mutation; release inference tensors and workers; keep source photos/OCR text ignored and local.
- No new model training, destructive native API changes, cloud OCR, text synthesis or claims of universal shadow removal/phone heat improvement.
- Tests live beside restoration modules; native tests in thuvien/tests; docs in docs/. Follow existing strict TS/C++17 RAII conventions and version the changed preset.
- `npm test -- src/imaging/restoration`; `npm run typecheck`; `npm run build`; changed-file ESLint; native established CMake/CTest. OCR is a test-only tool under ignored local storage.

## Acceptance and limitations

All ten photos must produce usable output on both implementations with no missing page, crop/size change or new clipping/painting of text. White-page shadows should reduce visibly, colored glossy covers should not be bleached, printed-gray controls should retain their fill, and local OCR checks must be reported with a fixed protocol. Include actual timings and distinguish cold startup from steady work. Finite samples do not establish correctness for every document or prove unreadable glare/math will be recognized.
