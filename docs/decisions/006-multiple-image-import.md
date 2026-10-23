# Multiple images from the library

The home file input accepts multiple JPEG, PNG, WebP, HEIC/HEIF or AVIF files. One selected image
keeps the existing single-page editor flow. Multiple images create one batch,
with page order taken directly from the browser's FileList (no filename sorting).

The existing background processor validates and processes each file sequentially;
no parallel full-resolution decoding or second import pipeline is introduced.
Each queued file has its own page identity and cancellation signal. A failed file
remains a failed page with retry/remove actions while other pages continue. PDF
export waits until all remaining pages are ready and uses their current variants
in batch order. Filters, crop, rotation and camera retakes reuse existing actions.

An import selection is bounded to 20 images and 256 MiB of encoded data before
enqueueing. Existing per-image byte/type/dimension validation still applies.
Oversized selections remain on the home screen with recovery guidance. Cancelling
the file picker leaves state unchanged; clearing the input permits selecting the
same files again. Returning home clears the batch, aborts outstanding page jobs
and retires the processor; the next import uses a fresh queue. The processor owns
its engine during initialization as well, so disposal can terminate a loading
worker. Application disposal also cancels processing. Images remain on-device;
no storage/auth changes.

Regression coverage checks multiple selection, page order despite out-of-order
completion, partial failure/removal, limits, picker cancellation, selecting the
same files again and cancellation when leaving/unmounting. Existing processor
tests cover sequential validation/processing and existing review tests cover PDF
image order. Physical Android/iPhone photo picker behavior remains device testing.

