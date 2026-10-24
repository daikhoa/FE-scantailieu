# Shared image intake and review

Camera captures and file selections (including exactly one file) enter the same App `appendPage` → `processPage` → `BackgroundPageProcessor.enqueue` → `ScanBatchReview` path. There is no App route into the legacy standalone DocumentEditor for a single imported file.

The input adapters remain appropriate to their source: camera capture provides frozen RGBA pixels and optional live corner hints; file import validates and decodes a Blob. The processor performs corner detection, creates the shared default enhanced-color recipe, analyzes/renders and returns a ProcessedScanPage. Source images stay available for later crop/filter edits. App edit commands call the same analyzed renderer used by initial processing.

The shared review screen handles one/many pages, crop/filter/rotate/remove/retry, camera additions and PDF export. A file decode failure appears as a failed page with the same retry/remove actions as camera-page failures; PDF export stays disabled until all retained pages are ready. Returning home from review or unmounting aborts page jobs; returning home from review also retires the old processor so a stalled detector does not block a new batch. Selection limits (20 files / 256 MiB combined) are checked before queueing. Individual image limits remain enforced by the existing importer.

Regression coverage: one/two-file selections use the shared queue/review and enhanced default, failed single-file retry, one/many-file cancellation on unmount, mixed imported+captured pages, frozen-capture processing, batch edits, selection order and partial failure. The separate native library is not connected by this change.
