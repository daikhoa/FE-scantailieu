# Portable Docscan SDK

The caller imports the library and calls process; it never configures model
sessions or implements detect -> warp -> shadow -> enhance orchestration.
Preserve the current models, default enhancement, color protection and image limits.

## Deliverables

- Authoritative browser SDK source in ../thuvien/browser, with an installable
  npm archive containing source, C++ WASM, model files, ORT assets and licenses.
- Public createDocscan().process(input), render/edit, detection for live guides,
  PDF export and explicit dispose/cancel. Encapsulate existing owned worker and
  DOM compatibility paths, lazy inference and honest fallback diagnostics.
- Web imports the packaged SDK. Its remaining responsibilities are UI, camera
  acquisition, recipe selection and presenting/saving returned results.
- Keep native C ABI compatibility. Provide ready-to-call native Python facade
  and examples that process images/PDF in-process with the same packaged models.
- A standalone browser consumer outside the scanner source tree verifies the
  package contains all required resources and no imports back into the web app.

## Verification

Start with a failing SDK contract test. Then verify package closure, SDK process
and failure/disposal contracts, existing application tests, actual model + WASM
browser processing, edits and PDF. Build and deploy the same public Site.

Different operating systems still need a compatible native build/runtime and a
language binding; those are integration artifacts, not rewritten algorithms.
No claim of automatic support for unbuilt platforms or all photo formats.

Use existing React/TypeScript/Vite/Vitest conventions. No new model or third-party
runtime dependency, uploads, OCR component, authentication or UI redesign.
