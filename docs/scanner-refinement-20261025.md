# Web/native refinement — 2026-10-25

User requested a measured improvement of the existing scanner and C++ library.
Preserve UI flows, codecs/quality/resolution, C ABI, OpenCV adaptive settings,
and original assets. Do not add backend/authentication or dependencies.

Selected evidence-backed slices:
1. Reuse the existing lossless, bounded import preview for detection only, with
   geometry scaled back to original axes. Final rendering always uses original.
   Missing/invalid preview and decode failure retain original-source fallback.
2. Avoid inverse projective sampling for exact full-frame, same-size copies.
   Preserve validation, independent output ownership and alpha semantics.
   Implement in web and both native raster backends; resized/skew crops stay as-is.
3. Improve genuinely faint neutral ink in the custom Enhanced web/C++ filter,
   using bounded contrast only with measured low-contrast edge evidence. Keep
   flat/noisy/color pages guarded and preserve pixel endpoints. Existing detail,
   other filters and OpenCV's settings remain unchanged.

Freeze source/WASM before edits. Add regression tests first; verify cancellation,
preview/original coordinate mapping, no source mutation, color/noise/alpha and
custom web/native parity. Measure quality with masked synthetic and licensed real
fixtures; compare timing on fixed identical inputs, alternating order. Report
actual operation boundaries and regressions, not a universal best-quality claim.

Checks: focused Vitest then full `npm test -- --exclude '**/.tmp-*/**' --maxWorkers 2`,
`npm run lint -- --ignore-pattern '**/.tmp-*/**'`, `npm run build`, real WASM tests,
native CTest and package verification. Keep old WASM versions; new target is v4.
Browser smoke import/review/capture re-entry/export and compare before public
publication. Physical phone temperature/battery remain unmeasured.

## Results and limits

The importer retains its original Blob and lossless preview. Detection accepts
only an aligned PNG preview <=1280px; its frame coordinates are mapped to the
original. Decode failure retries the original, while AbortError (including DOM
exceptions) propagates. The final render receives the original, never the preview.
No full-resolution decoded cache was added. This removes an avoidable original
decode for imported large photos, not the decode required for final rendering.
The detector still uses its existing bounded frame/model input. Two resize stages
can produce slightly different sampled pixels; pixel-identical ML corners are
not promised, and physical phone capture validation remains necessary.

Exact full-frame, same-size opaque pixels now copy independently instead of
bilinear sampling. Skew and downscale follow the existing sampler; transparent
web tiles retain premultiplied-alpha behavior. A transparent identity tile may
require an additional bounded read before falling back. Native decoded BGR is
opaque. Cancellation/geometry validation and output budgets are preserved.

Custom Enhanced v3 only darkens faint neutral ink when percentile range is8..31,
edge score is0.3..range*0.18 and periodic ratio<0.18. The LUT darkening is bounded
to12 levels, with0/255 endpoints preserved. These are conservative heuristics,
not text recognition. Marks below the percentile support may remain unchanged.
OpenCV adaptive v2 filter settings are unchanged; its warp uses the same identity
shortcut. Public C ABI1, native JPEG96/4:4:4 and max output settings are unchanged.

Measured 33 fixed fixtures (19 previous quality samples including15 licensed
SmartDoc frames, plus14 development/holdout synthetic fixtures). Only the three
faint samples changed; the other30 stayed byte-identical in the Web comparison.
Masked paper/ink contrast rose22.61→30.83 on development and23.65→32.03 on
holdout (8-bit luminance units); mean paper changed by<0.07. The19-sample suite
had no newly clipped or brightened channels and preserved RGB differences.
These metrics do not establish OCR accuracy or universal perceptual improvement.

Warm desktop Node raster timings, six alternating runs after one warmup per
version, are retained in [raw results](benchmarks/scanner-refinement-v4.json).
At3000x2250, Enhanced Web440.04→75.19ms, custom C++ WASM296.00→54.43ms,
OpenCV WASM414.82→283.08ms. This synthetic full-frame case specifically exercises
the shortcut; it excludes network, image decode, PNG/PDF and model inference.
Native timings include heap input/output copies, excluding malloc/free. Reserved
linear WASM memory stayed99,155,968bytes for that case; it is not peak process
RAM. The new WASM is1,805,499bytes, +964bytes fromv3. No phone heat/power claim.

Reproduction: freeze exports `warpPerspectiveRgba`, `applyDocumentFilter` from
Web commit `ac792f610ddab8688e0a56cc18c126e9e4b52210` using esbuild before editing.
Generate fixtures with `scripts/prepare-quality-samples.py` and
`scripts/prepare-opencv-tuning.py` (see earlier quality reports for provenance).
Run `node scripts/benchmark-refinement.mjs <frozen-web.mjs> <report.json>`;
it loads preserved WASMv3 and currentv4. Run
`node scripts/benchmark-enhanced-quality.mjs <frozen-web.mjs> <index.json> <report.json>`
for clipping/channel metrics. The latter outputs comparison PPMs for inspection.

Verification: Web533 tests, lint and TypeScript/production build; native6 CTest
suites including24 raw golden cases; real WASM16 custom/48 OpenCV cases. Golden
tolerances were not weakened. Existing v1/v2/v3 assets remain immutable. Browser
and publication results are recorded after completion below.

Browser QA on desktop Chromium: the comparison screen ran Web/C++ v4 on the same
faint fixture, both720x520 lossless PNG. Main app accepted two images together,
completed both with Enhanced selected, entered the add-camera screen and returned
with both pages retained. Camera capture itself was not verified: that browser
remained at the permission wait, so no claim about hardware/iOS/Android capture.
The downloaded PDF was independently parsed:2 pages, embedded rasters471x508 and
620x550, page boxes113.04x121.92 and148.8x132 points respectively, preserving each
detected crop's aspect ratio. No cloud upload or persistence was introduced.

Final review covered coordinate axes, cancellation propagation, opaque/alpha
ownership, bounded work/memory, original-source rendering, unchanged C ABI and
codec quality, fixture provenance and versioned asset hashes. The preview is an
internal importer product; it cannot validate arbitrary unrelated same-aspect
image content. Native engine/model eager startup and platform codec limits remain
unchanged. Existing physical-device and OCR quality limits above remain open.
