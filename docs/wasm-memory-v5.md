# Browser C++/OpenCV allocation failure — 2026-10-25

The phone report showed a successful Web result but failed C++/OpenCV runs.
The user confirmed failure happens after processing begins, not during startup.
The exact physical-device exception is unavailable; the old protocol collapsed
all engine exceptions into `failed` and the UI conflated loading/support/memory.

We reproduced a concrete shared failure: v4 cannot process the 8064x6048 fixture
when WASM growth is limited to320MiB. It returns7 (generic failure), because an
OpenCV allocation exception was caught by the generic handler. That same input
passes custom and OpenCV v5 with the same cap, output3000x2250, reserved linear
memory283,770,880bytes (270.625MiB). This is an allocation-budget reproduction,
not proof of the phone's exact memory cap or a peak-browser-RAM measurement.

## Change and contracts

The old bridge kept a full RGBA staging allocation and allocated a second BGR
source. New **private** owned-input exports compact RGBA into BGR in the staging
allocation. Each pixel's RGB values are read before writes can overlap it.
The Mat is a non-owning view; the JavaScript caller frees its staging pointer in
`finally`. The caller refills it for each request. This removes3 bytes/source
pixel of duplicate storage (139.5MiB at8064x6048), without resampling, compression,
different perspective geometry or a different filter. The legacy read-only
exports retain their contract. Native public C ABI1 and DLL behavior are unchanged.

OpenCV `StsNoMem` now maps to status8. The worker retains a classified error code
and initialize/decode/process/encode stage; the client preserves both, and the
screen identifies the failed engine with a readable explanation and short code.
Raw engine strings, filenames, image data and stack traces are not sent to the
UI or a server. Successful results are never substituted with another engine.
WASM v1..v4 are immutable; current comparison IDs identify v5. Web filterv11 stays.

## Verification

- Memory reproduction was red onv4 (status7); green onv5 for both raster backends.
- A210MiB budget exercises real allocation failure: status8, no output pointer.
- Real WASM16 custom and48 OpenCV crop/filter/preset cases pass their existing
  quality thresholds, plus exact byte parity between legacy and owned staging
  on every case. Legacy input remains read-only; no tolerance was relaxed.
- Protocol/UI regressions failed before the fix and pass afterward. Web537 tests,
  lint, TypeScript and production build pass.
- Reproduce with `node scripts/test-wasm-memory-budget.mjs v5`; passingv4 reproduces
  the old failure. Run from the web root. It generates synthetic pixels directly.
- Raw observations: [memory budget](benchmarks/wasm-memory-v5.json).

Physical iPhone/Android retesting is still required. Different failures (network,
unsupported browser, source decode, device memory) remain possible and now have
separate diagnostics. No claim that every image/device will fit in memory.

Browser verification and publication provenance are recorded after completion.

Desktop Chromium production-build preview: selected8064x6048 PNG, ran the
custom/OpenCV pair once and then5 times each with reversed order. Both completed,
output3000x2250, same270.6MiB WASM reserve, no UI frame gaps>50ms in the5-run test.
This verifies repeated staging refill/release through the real browser wrapper;
it does not substitute for an iPhone retest. Source remains8064x6048 throughout.

Final review: compacting writes only behind already-read source pixels; each RGB
triplet is captured before writing. Mat ownership stays external, legacy const
exports never compact, validation precedes compaction, and JS/native cleanup
runs on both success and failure. No raw diagnostic text or photo data leaves
the device. Existing published assets and native public API remain untouched.
