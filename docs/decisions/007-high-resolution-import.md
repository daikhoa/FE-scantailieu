# High-resolution originals and bounded processing copies

The importer previously rejected encoded files over 64 MiB and originals over
16,777,216 pixels, although phone photos can exceed both. Original validation now
allows 128 MiB per file, 64,000,000 pixels and a 16,384-pixel maximum side. Batch
selection remains bounded to 20 files and 256 MiB total, processed sequentially.
RAW/DNG and arbitrary image/document formats remain unsupported. These limits
are admission bounds, not a guarantee that every low-memory phone can decode
the largest file; browser allocation/decoder errors remain recoverable failures.

The original encoded Blob is retained. A separate max-1280 PNG display preview
is created for originals above 4 MP and HEIF, so crop UI avoids decoding the
large original (and works where HTML images cannot display HEIF). Crop geometry
continues in original coordinates. This preview never becomes the render/PDF
source. Existing final long-side cap 3000, no-upscale policy, JPEG quality 0.96,
filter order and PDF image embedding are unchanged.

Encoded originals now cross the renderer boundary as Blob plus metadata rather
than full original RGBA. A region reader decodes one native full-size bitmap,
then reads integer 1:1 source patches with interpolation halo. Reads are bounded
to 1,048,576 pixels and 4096 per side, recursively subdividing output tiles for
extreme perspective/aspect ratios. Output uses the shared projective grid and
bilinear sampler; filters run after whole-output assembly. No extra JPEG pass,
pre-warp resize, model/resolution reduction or different color filter is added.
The native bitmap still occupies full-resolution browser-managed memory; this
removes avoidable JavaScript RGBA copies, not all source allocation. The iframe
path yields a macrotask between strips. Dispose terminates its processing realm;
an isolated job abort without engine disposal may finish rendering before discard.

Live sampling now checks scheduler capacity before capturing pixels. Fresh camera
and import detection frames transfer their owned one-shot buffers; reusable
external frames retain copy semantics. Working RGBA limits (8192 side and
16,777,216 pixels) remain separate and unchanged. Returning home aborts the batch
and retires its processor, including one still initializing.

JPEG/PNG/WebP and AVIF use the browser decoder. HEIC/HEIF uses native decoding
first, otherwise a temporary module Worker loads a self-hosted CSP build of
heic-to 1.6.6 only on demand. The build has one documented patch: select the unique
primary image instead of vendor data[0]. It preserves vendor finally cleanup.
The wrapper terminates on completion/error/abort or 30-second timeout, releasing
its nested worker and decoder heap. The library internally copies encoded/RGBA
data, so large fallback HEIF has a higher memory peak than native JPEG. HEIF HDR,
depth/live-photo sequences and RAW fidelity are not promised by this 8-bit scan
pipeline. ISO header traversal is bounded to 1 MiB, 2048 boxes and depth 6;
compatible brands are inspected (AVIF takes precedence over generic mif1).
Largest ispe is a conservative allocation preflight; decoded primary dimensions
are validated independently and used for geometry. Unusual metadata outside the
bounded header can fail with a clear import error.

The CSP variant avoids unsafe-eval. Nested Blob Workers still need blob: worker
permission if a deployment adds CSP; this change does not relax CSP. License
inventory, LGPL/GPL texts, exact source archives, patch/build/relink instructions
are distributed under /licenses/. Rebuild the committed optional decoder with
node scripts/build-heif-decoder.mjs after reviewing dependency or patch changes;
version its URL when changing it. It is not fetched by the initial home screen.

Verification on desktop Chrome, 2026-10-23:
- Full unit/component suite plus typecheck, lint and production build (see handoff).
- Real 8000x6000 JPEG padded to 65 MiB imported, rendered and exported to PDF in
  both Worker and forced iframe paths. Final detected crop: 3000x1639; 0 external
  requests across realms. One local run ~1.25 s Worker / ~1.24 s iframe.
- Same 3 MP input through old full-RGBA vs region path: max pixel difference 0.
  Region path ~108 ms vs ~100 ms old; this is a memory/copy optimization and does
  not establish a general latency improvement or lower device temperature.
- Real HEIC 1280x854 and AVIF 800x533 preserved original Blobs and exported PDF.
  A second HEIC fixture changes pitm to the second equally-sized top-level item;
  both preview and final JPEG change, preventing silent first-item selection.
- Synthetic alpha/skew parity, skinny strong-perspective region bounds, cleanup,
  one-shot ownership, pre-capture backpressure and preview crop coordinates.
- Physical iPhone/Android peak RAM, sustained camera temperature and photo-picker
  behavior across OS/browser versions remain unverified.

Reproduce browser checks: build Vite with tests/browser/high-resolution-smoke.html
and phone-formats-smoke.html as entries, self-host the build with correct .mjs
MIME, then use scripts/run-browser-benchmark.mjs against localhost. Append
?fallback to high-resolution-smoke.html to force iframe rendering. Download QA
fixtures into the smoke build's tests/fixtures (not the published app):
https://raw.githubusercontent.com/strukturag/libheif/master/examples/example.heic
SHA256 7f8b363e4936c0666a25f64f3a92fda10bd8e5453be4592530b65a55dd98f3f2
https://raw.githubusercontent.com/strukturag/libheif/master/examples/example.avif
SHA256 54a0dc31d02b6f5d9d4b66027d4787861b7af15ffd8fab8eab963d10c5411469
The smoke checks the HEIC primary ID before patching its fixture copy. QA fixture copies are not shipped in the main application. The separate
upstream source archives retain their original example assets and notices.

