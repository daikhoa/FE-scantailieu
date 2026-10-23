# Detector startup recovery and matching ONNX assets

Date: 2026-10-23

## Evidence and scope

A user on iOS 18.7.7 reported a working camera preview with a Scanic failure banner and a permanent “Đang tìm tài liệu…” status. Live model/loader/WASM requests returned 200 with correct MIME types. The previous runtime works in Chromium; the exact device failure has not been reproduced locally and is not proven to have one specific Safari cause.

Repository inspection found Scanic 1.6.0 bundles ONNX Runtime JS 1.27.0, while the optional scanic-ml 0.2.0 package documents its minimal WASM as built with ORT 1.23.2. Mixing these runtime releases is unsupported. Both detector loader and CPU WASM now come from the installed pinned onnxruntime-web 1.27.0 package. The corner model, ML threshold and detection policy are unchanged. A versioned asset directory prevents reuse of the previous browser-cached loader/WASM. The Vite config rejects an installed runtime version that differs from the declared asset version; dependency updates must also verify the Scanic bundle's ORT version.

The stock CPU WASM is 13,479,978 bytes versus the previous custom 1,523,774 bytes. This increases first-load download size. It still uses shared WASM memory even with numThreads=1, so this change does not claim to remove all WebKit memory limitations. No dependency was added and the classifier GPU/WASM path is unchanged.

## Platform scope

Routing is capability-based, with no user-agent, phone-model or iOS-version special case. Worker and OffscreenCanvas/ImageData availability select the available execution realm. The same ML model and policy apply to Android browsers and Safari/WebKit. The existing camera resolution negotiation and video-frame capture fallback remain unchanged. Unsupported ML capability is reported honestly while full-frame capture remains enabled; this does not promise ML support on every historical browser release.

## Recovery contract

Worker startup failure, including failure of its first actual inference (the vendor initialize method swallows errors), retires the worker before trying one owned same-origin DOM realm with the same ML model and a retained reduced frame. A resolved no-document or low-confidence result is normal, not a runtime failure. Once worker inference has succeeded, an operational failure retains the existing one-fresh-worker retry. Both routes failing propagates a real error; warp errors do not trigger inference fallback. No classical detector is enabled.

The owned DOM realm inserts an external module with DOM APIs and transfers its MessagePort only after the module load event. This avoids closing-script HTML escaping in built string literals and makes module-load failures reject promptly. Disposal removes handlers, closes both ports and removes the frame.

The live session stops automatic retries after three consecutive failed cycles and clears its sampling timer. A successful result resets the failure count. The camera remains usable for full-frame capture. Error status replaces “searching” and a manual detection retry waits for the old session's cleanup before creating another; it leaves the MediaStream and captured pages alone. The existing stale-corner invalidation policy remains intact.

## Verification

Regression tests cover worker initialization failures, rejected first inference, failure of both ML routes, preserved operational worker retry, bounded consecutive failures, and manual retry without restarting the camera. HTTP integration checks SHA-256 and MIME types for the served loader/WASM/model against the selected installed files. The UI regressions were observed failing before their fixes; the retry limit test observed 28 engine creations in 10 simulated seconds before the limit, and expects three.

The final 452-test suite, TypeScript, lint and production build pass. Actual Chromium production smoke passes both Worker and owned-frame routes on two document fixtures and two background fixtures; document corners match between routes and the network audit finds zero external requests. Development smoke also passes with the matching runtime.

The production smoke entry now starts an async function instead of using top-level await: the fallback lazy chunk imports shared entry symbols, so awaiting its own dynamic import from the entry's top-level evaluation deadlocked the harness. This correction keeps failures observable rather than changing any detector threshold or skipping a fixture.

Physical Android and iPhone/Safari device checks remain unverified locally. Desktop Chromium and capability/failure tests do not establish that the reported phone issue or every hardware-specific issue is resolved.
