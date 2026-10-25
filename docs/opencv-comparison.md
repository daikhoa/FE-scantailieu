# OpenCV raster experiment — 2026-10-24

Historical v1 implementation below. Current implementation is adaptive OpenCV v2
in WASM v3; see [tuning, parameters and before/after results](opencv-tuning-v2.md).

Keep the web scanner and existing custom web/C++ algorithms. Add an explicit
OpenCV candidate, not a replacement default. Compare pairs: Web/OpenCV (default),
custom C++/OpenCV, and the existing Web/custom C++ pair. Both sides share decoded
opaque input, clockwise crop, output sizing (max3000), PNG encoder and PDF export.
No AI detection/classification is part of browser timing. Original isolates warp;
Enhanced adds the candidate's contrast/detail stages. Native automatic corner
detection remains the existing model when called through the library's new entry.

OpenCV candidate uses getPerspectiveTransform + warpPerspective (linear,
BORDER_REPLICATE, explicit edge-to-center coordinate conversion), cvtColor Lab,
CLAHE on lightness, GaussianBlur/subtract/min for bounded dark-edge detail,
insertChannel and addWeighted for conservative blending with the original.
Only size policy, input validation, preset selection and cancellation remain domain
logic. No replacement handwritten warp or CLAHE pixel loop. Presets:
gentle/balanced/text; tune and report them on the existing licensed/synthetic sample
set. Do not claim universal superiority from contrast metrics.

Add a separate native C API entry without changing existing structs, enums or
defaults. It supports Original and Enhanced; other modes fail explicitly. Use the
same native implementation in WASM v2 and Windows. Keep WASM v1 assets untouched.
Both custom C++ and OpenCV browser runners use v2 so integration/encoding costs
are comparable. Include backend, preset and implementation version in downloads.

Slices: (1) failing native contract tests, implement OpenCV and additive API;
(2) build WASM, retain custom parity and add OpenCV tests/parameter inspection;
(3) pair/preset UI, tests and honest stage timings; (4) full checks, browser tests,
package Windows and publish the existing public Site.

Verify native CTest incl ABI/error/cancel/image cases; node
scripts/test-docscan-wasm.mjs; npm test -- --exclude '**/.tmp-*/**' --maxWorkers 2;
npm run lint -- --ignore-pattern '**/.tmp-*/**'; npm run build; focused formatting,
source diff and production browser runs. Cancel terminates workers as before.
No new npm dependency; existing OpenCV/Emscripten builds are reused. Performance,
memory and thermal limitations from docs/wasm-comparison.md remain applicable.

References: https://docs.opencv.org/4.x/da/d54/group__imgproc__transform.html and
https://docs.opencv.org/4.x/d6/dc7/group__imgproc__hist.html .

## Implemented settings

| UI / C preset | CLAHE clip | Original/candidate blend (candidate weight) | Dark detail scale |
| --- | ---: | ---: | ---: |
| Nhẹ / DS_OPENCV_GENTLE | 1.2 | 0.22 | 0.25 |
| Cân bằng / DS_OPENCV_BALANCED | 1.6 | 0.35 | 0.40 |
| Rõ chữ / DS_OPENCV_TEXT | 2.2 | 0.45 | 0.60 |

CLAHE grid is at most 8×8. Gaussian sigma is 0.85; dark detail is capped at 12
before scaling. Color pages multiply candidate weight by 0.65, periodic texture
by 0.4. Near-uniform lightness (range <8) is unchanged. These are conservative
experimental profiles, selected after inspecting the existing sample set, not
trained or universally optimal parameters. Only lightness is edited before the
final RGB blend. No new enhancement clipping was found in the tested cases;
interpolation and JPEG can still change pixel values.

## Native integration

The sibling library adds `ds_document_add_image_opencv(document, source, options,
preset, page_index)`. Existing `ds_document_add_image` and ABI1 struct layouts
remain unchanged. Callers choosing the new entry must ship the new header **and**
DLL; an older ABI1 DLL does not export it. Original and Enhanced are supported;
Auto/gray/black-white return `DS_INVALID_ARGUMENT` without appending a page.
Auto corner detection remains the existing model; full/manual crops need no model.
The OpenCV Enhanced path does not run defect classification. It retains native
JPEG/PDF encoding and resource/ownership rules. OpenCV working-buffer preflight
reserves 20 bytes per output pixel, separate from source buffers and model memory.
Cancellation is checked between OpenCV operations; a running OpenCV call cannot
be interrupted halfway. Browser cancellation terminates the whole worker.

## Verification and observations

Six native CTest suites passed (ABI, C API, runtime, custom pixels, OpenCV contract,
independent integration). The new contract includes identity/skew warp, invalid
corners and preset/filter errors, no source mutation, uniform/color/text images,
cancellation/reset, append and JPEG/PDF output. Real WASM tests cover 12 existing
custom parity cases and 36 OpenCV original/enhanced/preset cases. Web tests cover
both old pairs, new default/preset forwarding, cancellation and failure paths.

19 quality inputs ×4 profiles use identical annotated crops: four synthetic
pages and 15 SmartDoc frames. Results, attribution and limitations are in
[the benchmark report](benchmarks/opencv-v1.md). OpenCV improved faint synthetic
marks; the custom filter retained stronger contrast in several other examples.
No overall winner is established and OCR accuracy has not been measured.

Production preview on this Windows desktop processed an 8064×6048 synthetic PNG
through custom C++ and OpenCV to 3000×2250. One cold run measured 558.3/928.1ms for
warp+filter, and 975.1/1385.0ms including shared decode+PNG. Both modules reserved
392.9 MiB linear memory; these are neither peak process RAM nor a phone guarantee.
See [raw browser measurements](benchmarks/opencv-browser-48mp.json). The synthetic
file is small on disk; this verifies decoded pixel size, not every large codec.
Physical Android/iPhone quality, heat and power remain unverified.

Browser QA also covered all three comparison pairs, all OpenCV profiles,
Original, shared manual crop, cancellation followed by restart, and one-page
OpenCV PDF export parsed independently. A 390px viewport had no document
horizontal overflow. Browser console reported no warnings/errors in these runs.

WASM v2 is 1,493,157 bytes uncompressed (v1 remains available). Both C++ backends
load this same module only on explicit comparison runs. Setup includes fetching,
compilation and allocation; a fresh worker can still use browser/network caches.

## Reproduce the quality samples

With test-only Pillow installed:

```text
python scripts/prepare-quality-samples.py
python scripts/prepare-opencv-samples.py
node scripts/benchmark-opencv.mjs
python scripts/prepare-opencv-samples.py
```

Generated inputs, lossless outputs and contact sheet are under `.tmp-opencv/`.
The contact sheet preserves aspect ratios; inspect full-resolution PNG downloads
at the same zoom when deciding which appearance is useful. The runtime manifest
under `public/docscan-wasm/v2/build.json` records source and binary SHA-256.
