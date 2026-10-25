# Comparison worker entry re-import — 2026-10-25

User's v9 iPhone screenshot reported `initialize/invalid-input` for both native
engines while Web succeeded. The earlier memory improvement did not address
this failure. No photo/crop data was available; this diagnosis used the shipped
module graph and a runtime reproduction, not an assumption about bad corners.

## Cause

The generated v9 lazy `wasm-raster` chunk imported `COMPARISON_WASM_BASE` from
the comparison worker's entry chunk. The emitted cycle was:

`comparison.worker-BDvxjP8h.js -> wasm-raster-FNbxEmMr.js -> comparison.worker-BDvxjP8h.js`.

[WebKit issue324459](https://bugs.webkit.org/show_bug.cgi?id=324459) describes
re-evaluation of a module worker's entry when a lazy chunk imports it back.
Re-evaluation installs a new message handler whose `engine` is null. The first
module's initialization still posts `ready`, then the next run reaches the new
handler and fails its state check before image decoding. The old state check
called that `invalid-input`, with stage still `initialize`, incorrectly blaming
the photograph. The Web path never imports the WASM adapter, so it avoids this
cycle. This explains the code and engine split in the user's screenshot. The
exact affected physical browser has not been remotely inspected.

## Fix

The adapter takes its asset base as a required argument; its imports from the
contract are now type-only. The worker passes the authoritative versioned base.
The generated lazy adapter has no imports back into the worker. Actual WASM
loading remains lazy; no scanner startup, pixel/filter, native DLL, resolution
or memory policy changes. WASMv5 and all historical binaries remain unchanged.

State violations now report `invalid-state`, and input validation has a separate
`validate` stage. The UI distinguishes lost state from invalid photo/corners.
The default production build now checks emitted static and literal dynamic
imports with `scripts/test-comparison-build.mjs`, failing if any dependency
re-imports the comparison entry. This catches bundler-created cycles that source
dependency checks miss. No dependency was added; the check uses existing TypeScript.

## Regression evidence

The emitted-graph check fails on saved v9 assets at the exact cycle above and
passes on the fixed build (2 emitted modules, no entry re-import).

A browser probe loads the production worker with a query on its entry URL. A
lazy import of the canonical entry then creates a second instance in Chromium,
reproducing the module-state loss without pretending Chromium is Safari. Before
the fix: Web20/20 successful; C++ and OpenCV0 samples, both exactly
`initialize/invalid-input`. After the fix, the same probe/crop passes20/20 for
all three, output74x105 from an80x112 source and the same skewed four corners.
This is stronger than a normal Chromium success test, but still requires a
physical iPhone retest after publication.

Reproduce after `npm run build`:

1. `node scripts/prepare-comparison-reentry-probe.mjs`
2. Serve the production build with Vite preview.
3. Open `/worker-reentry-probe.html`, leave the reproduction checkbox checked,
   and run the three engines. The fixture executes20 iterations per engine.

The probe is generated only for local QA. Publishing runs a fresh production
build which removes it; it is not a runtime feature or public debug hook.

Web538 tests, lint, TypeScript/production build and the emitted-graph guard pass.
The new state-classification test failed before the change and passes afterward.
Review confirmed one caller updated, asset base remains authoritative, dynamic
native loading stays opt-in, private data is not sent in diagnostics, and all
WASM/filter/source codec contracts stay unchanged.
