# Web / C++ browser comparison

Current update 2026-10-25: both C++ runners load WASM v3, with adaptive OpenCV v2.
V1/v2 assets are retained for provenance. See [the tuning report](opencv-tuning-v2.md).

Update 2026-10-24: the comparison now has Web/OpenCV, custom C++/OpenCV and the
original Web/custom C++ pair, plus three OpenCV profiles. Both C++ runners use
the new v2 WASM; the normal scanner and v1 assets remain unchanged. See
[OpenCV implementation, API, settings and verification](opencv-comparison.md).

## Accepted scope

Keep the existing scanner and defaults. Add an opt-in, lazy-loaded comparison page
at `?compare=1`, linked from Home. Images remain on the device. Compile the sibling
`../thuvien` C++ raster implementation to WebAssembly; never call the Windows DLL
or upload images. This is a browser raster comparison, not a native DLL benchmark.

Compare the current perspective warp and Enhanced/Original filters with those same
stages compiled from the library. Share input decoding, a user-adjustable crop,
output long side (3000), browser encoding and PDF export. Detection/classifier and
native JPEG/PDF codecs are outside the comparison: neither runner invokes them.
Show that boundary in the UI and exported measurements. No automatic downsampling
of inputs. Explicit resource errors must not fall back to JS and call it C++.

## Delivery slices

1. Build/test a small WASM bridge against the actual native geometry, quality and
   filter source. Extract model-independent declarations without changing ABI1.
2. Run both implementations in dedicated, disposable workers. Bound input,
   duration, repetitions and output retention. Cancellation terminates the worker.
3. Add file selection, shared manual crop, separate single-engine runs, sequential
   comparison (reverse order on the next comparison), synchronized zoom, PNG/PDF downloads, JSON measurements and a short
   physical-device test guide. Warmup and repetitions are explicit.
4. Verify numerical contracts, cancellation/failure paths, default scanner tests,
   production browser behavior and publish to the existing public Site.

## Measurement contract

Report fresh-worker setup separately (network/browser caches can be warm). Each
sample includes decode, processing and PNG encode; the whole-run wall time also
includes setup and worker roundtrip. PDF is a common download action, not included
in sample timings. Report medians for repeated measurements, with raw samples.
Measure UI frame gaps while processing. Report WASM reserved linear memory and
known pixel-buffer bytes with accurate labels, never as whole-device peak RAM.
CPU percentage, temperature and total battery energy are unavailable from this
page; represent them as unavailable, never zero. Provide manual device notes.
Run engines sequentially, allow separate sessions/cooldown for thermal testing;
do not infer quality, heat or power from speed or image byte size.

## Conventions and verification

React/TypeScript follows existing colocated tests and formatting; C++17 follows
the sibling `.clang-format`. Add no npm runtime dependency. Worker protocols use
explicit discriminated unions; validate dimensions and byte lengths on entry.
Build: `npm run build`. Check: `npm test -- --exclude '**/.tmp-*/**' --maxWorkers 2`,
`npm run lint -- --ignore-pattern '**/.tmp-*/**'`, and focused formatting checks.
Build WASM from the real sibling library with `./scripts/build-docscan-wasm.ps1`;
run `node scripts/test-docscan-wasm.mjs` to compare its pixels with web kernels.
Always preserve the native public C ABI and current scanner. Dependency downloads
use official upstream sources. Physical-device heat/power findings require real
measurements and are not part of desktop verification.

## Rebuild and runtime boundaries

The optional C++ module is built from `../thuvien/wasm/CMakeLists.txt` with official
[Emscripten](https://emscripten.org/docs/getting_started/downloads.html) 6.0.13,
using the library's existing OpenCV source commit
`ea8e60798e0319ccbe902f7994153b574f639809` (core/imgproc only). No ONNX Runtime,
native codecs or native PDF writer enter this WASM target. `src/pixels.hpp` and
`src/quality.cpp` are the model-independent seam; the native C ABI stays ABI1.

Install the official SDK into an ignored local directory, then activate the pinned
version (no permanent PATH change is needed):

```powershell
git clone https://github.com/emscripten-core/emsdk.git .tmp-wasm/emsdk
python .tmp-wasm/emsdk/emsdk.py install 6.0.13
python .tmp-wasm/emsdk/emsdk.py activate 6.0.13
./scripts/build-docscan-wasm.ps1
node scripts/test-docscan-wasm.mjs
```

Pass `-LibraryRoot`, `-SdkRoot`, `-Cmake` and `-Ninja` when those locations differ.
The build script verifies the SDK version. The tracked output under
`public/docscan-wasm/v3/` includes a SHA-256 manifest of native source and WASM.
Ordinary npm builds use these assets and do not require a C++ compiler.
WASM/glue are approximately 1.75 MiB uncompressed and are only requested when
running C++. The comparison screen/worker are lazy; normal scan processing and
defaults are preserved. Public generated modules have a narrow Vite dev middleware
because Vite otherwise rejects source imports from public; production serves them
as static files.

The experiment accepts at most **50 million input pixels**, at most 16384 per side,
1–20 repetitions, output long side <=3000, and a 180-second worker lifetime per
engine run. Common 8064×6048 "48 MP" files fit. Inputs are never resized to meet
this bound; larger files get an explicit error. The normal scanner retains its
existing independent limits. The module can grow linear memory to 768 MiB, but
this is a ceiling, not a device allocation guarantee. Bitmap/canvas, JS, WASM and
browser memory are separate; the displayed known buffers/reserved WASM bytes are
not process peak RAM. Each worker is terminated on completion/error/cancel; the
page keeps only the last encoded output per engine. Switching apps/hiding the tab
aborts a running measurement so background throttling cannot produce a valid sample.

## Physical-device procedure

Use the same photo/crop/filter/repetitions on each engine, with fixed brightness,
similar battery/ambient conditions and no charging. For heat/power tests run one
engine alone, cool the device back to baseline, then the other, and repeat in the
opposite order. Record actual elapsed workload duration: 20 quick repetitions may
be too short to establish a thermal or battery trend. Do not infer a temperature
from UI frame gaps or execution speed. Use an external surface-temperature meter
or the device's profiling tools when available; system thermal severity and surface
temperature in Celsius are different quantities. The page exports unavailable
CPU/total RAM/temperature/energy fields as null and keeps manual notes local.

See [Android thermal monitoring](https://developer.android.com/games/optimize/adpf/thermal)
and [Apple thermal state](https://developer.apple.com/documentation/foundation/processinfo/thermalstate-swift.property)
for native monitoring boundaries. WASM browser results do not characterize native
DLL performance. No physical iPhone/Android thermal measurements have been made.

## Verified on 2026-10-24

- 523 web tests / 59 files passed, along with lint, TypeScript and production build.
- The unchanged native ABI and pipeline passed all 5 CTest suites after extraction;
  the refreshed Windows package's 43-file checksum manifest was verified.
- Real WASM/web pixel parity: 12 synthetic image/filter/crop combinations passed,
  dimensions matched and the largest channel difference was 1 level. Invalid
  filters/dimensions returned errors and released the previous output. See
  `benchmarks/wasm-pixel-parity.json`; this is not an OCR accuracy benchmark.
- A packaged browser run accepted an actual 8064×6048 (48.77 MP) synthetic PNG
  without resizing the input. Both downloaded PNGs were 3000×2250 and byte-for-byte
  equal in RGB pixels on this case. PNG and JSON download were exercised; unavailable
  CPU/RAM/heat/energy fields were null. Raw single-run measurements are in
  `benchmarks/wasm-comparison-48mp.json`. A single synthetic run is not evidence
  that one engine is generally faster or more efficient.
- Development browser runs also exercised five repetitions of each engine and
  shared manual crop adjustment, with matching output dimensions and no console
  errors after the dev asset-serving fix.
- The packaged browser C++ PDF download was independently parsed: one 720×540 pt
  page with a 3000×2250 embedded image. Cancelling a 20-repeat run showed the stopped
  state and discarded its result; a subsequent five-repeat run on both engines
  succeeded.

The runtime still emits the existing upstream ORT minimal-WASM URL build warning;
the optional comparison does not invoke that runtime. Physical device compatibility,
peak browser memory, temperature and battery energy remain unverified.
