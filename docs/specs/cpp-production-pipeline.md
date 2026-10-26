# C++ production image pipeline

The normal camera/import/editor path must use the same custom C++ source as the
native library, compiled to versioned WebAssembly. Keep the UI, original assets,
image resolution, filters, model weights and local-only processing contracts.

## Boundary

- C++ owns perspective geometry, bounded source-region selection, sampling,
  enhancement analysis/model decision, color protection, filters and rotation.
- Browser adapters own decoding/encoding, camera and detector inference, GCNet
  execution and lifecycle, user recipes, thumbnails and PDF packaging. Models
  remain lazy and isolated. A runtime/model failure must remain explicit.
- The old JS raster path remains only as the historical comparison reference;
  it must not silently replace the C++ production renderer.
- Native public ABI remains compatible. Private browser ABI is versioned.

## Delivery

1. Extend the native browser bridge with bounded tiled geometry, native model
   preparation and all existing filters, reusing native kernels.
2. Add a shared imaging adapter, with validation/resource regression tests and
   actual-WASM tests. Connect worker and DOM compatibility paths to it.
3. Make comparison C++ use this same adapter; retain JS reference for comparison.
4. Verify relevant native contracts, application tests, typecheck, lint, build,
   browser camera/import/edit/filter/PDF paths and publish to the existing Site.

## Acceptance

Production cannot import JS perspective/enhancement kernels. Large image input
must use bounded original-resolution patches rather than full-frame JS/WASM
copies. Final default enhancement matches the established C++ result. Preview
caps, rotation, color/gray/BW filters, model fallback metadata, cancellation and
retry remain supported. Document the one-source rebuild/release command and
what requires a browser adapter rather than an algorithm change.
