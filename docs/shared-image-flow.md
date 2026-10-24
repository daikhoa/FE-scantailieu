# Shared image intake and review

Camera captures and file selections (including exactly one file) enter the same App `appendPage` → `processPage` → `BackgroundPageProcessor.enqueue` → `ScanBatchReview` path. There is no App route into the legacy standalone DocumentEditor for a single imported file.

The input adapters remain appropriate to their source: camera capture provides frozen RGBA pixels and optional live corner hints; file import validates and decodes a Blob. The processor performs corner detection, creates the shared default enhanced-color recipe, analyzes/renders and returns a ProcessedScanPage. Source images stay available for later crop/filter edits. App edit commands call the same analyzed renderer used by initial processing.

The shared review screen handles one/many pages, crop/filter/rotate/remove/retry, camera additions and PDF export. A file decode failure appears as a failed page with the same retry/remove actions as camera-page failures; PDF export stays disabled until all retained pages are ready. Returning home from review or unmounting aborts page jobs; returning home from review also retires the old processor so a stalled detector does not block a new batch. Selection limits (20 files / 256 MiB combined) are checked before queueing. Individual image limits remain enforced by the existing importer.

Regression coverage: one/two-file selections use the shared queue/review and enhanced default, failed single-file retry, one/many-file cancellation on unmount, mixed imported+captured pages, frozen-capture processing, batch edits, selection order and partial failure. The separate native library is not connected by this change.

## Live detection recovery and memory

A finite ML corner prediction that is outside the image, crossed, degenerate, too small or reversed is an uncertain detection: retain the full frame and keep the engine ready for the next frame. Never crop using that prediction. Malformed response shapes, non-finite values and actual inference/worker failures still follow the existing error and bounded retry path.

`ScanicDetectorRuntime` owns two reusable preprocessing canvases and one 224 × 224 × 3 Float32 input buffer per worker/DOM realm. Resize, smoothing and RGB normalization match pinned Scanic 1.6.0; its implemented `ml.inputData` hook bypasses the vendor's per-frame temporary canvases. Clear the model canvas before drawing so transparent inputs cannot retain pixels from the previous frame. Backends serialize inference, and terminating the owned realm releases its canvases and ONNX cache. Original photo resolution, output filters and PDF settings are unchanged.

`tests/browser/camera-reentry-smoke.html` checks 12 imported pages, 4 detector re-entries and 60 inference frames in both worker and forced DOM modes. It also compares preprocessing values exactly with the vendor's resize/normalization and enforces a two-canvas allocation budget over 100 frames. Run with `node scripts/run-browser-benchmark.mjs http://127.0.0.1:5174/tests/browser/camera-reentry-smoke.html` (append `?fallback` for the DOM mode) while the local dev server is running. These are desktop browser checks; physical iPhone/Android camera testing remains necessary for device-specific failures.
