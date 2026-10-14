# Todo: clonecamscanner v1

Nguồn yêu cầu: [đặc tả đã duyệt](../docs/specs/mobile-document-scanner.md)  
Kế hoạch chi tiết: [tasks/plan.md](./plan.md)

## Phase A — Nền tảng

- [x] Task 1A — Bootstrap dependency manifest có khóa phiên bản
- [x] Task 1B — Entry tối thiểu có thể build
- [x] Task 2A — Khóa dependency cho quality gates
- [x] Task 2B — Test harness và vòng RED–GREEN
- [x] Task 2C — Lint, format và generated-file policy
- [x] Task 3A — App shell behavior và navigation foundation
- [x] Task 3B — Design tokens và responsive visual system
- [x] Checkpoint A — Build/test/lint/license/accessibility baseline

Verification 2026-10-08: Node 22.23.2/npm 10.9.8; clean `npm ci` thành công với scripts bị chặn; installed licenses MIT/Apache-2.0/BSD-3-Clause/ISC; audit 0 vulnerability; 22 registry signatures và 12 attestations được xác minh; typecheck và production build qua. Vite build cần chạy ngoài Windows sandbox vì sandbox chặn native `realpath`; Node đọc file và non-native realpath bình thường.

Verification Task 2: TDD RED được xác nhận cho accessible main landmark rồi GREEN 2/2 tests; coverage 100% bootstrap; lint/typecheck/format/build qua. Clean install 262 packages, 0 vulnerability, 262 registry signatures, 106 attestations, `npm ls --all` không có peer problem. Vitest 5 bị loại do type declaration không tương thích `jest-dom 7`; Vitest 4.1.11 tương thích. Npm 10.9.8 có bug Arborist với `omit=peer`, nên dùng `legacy-peer-deps=true`, khai báo peer trực tiếp và bắt buộc kiểm `npm ls --all`; optional MPL `lightningcss` không được cài.

Verification Checkpoint A: navigation, loading/error/empty states và thông báo privacy có component tests; regression test Strict Mode xác nhận trang không tự cướp focus lúc mount nhưng chuyển focus đúng sau điều hướng. Full suite 6/6 qua, statements/lines/functions 100%, branches 92.3%; lint, typecheck, format-check và production build đều qua. Visual QA bằng trình duyệt thật tại 320/768/1024/1440 px không tràn ngang, vùng chạm nhỏ nhất 45.6 px, focus đúng và không có console warning/error. Build hiện tại 228.89 kB JS (71.24 kB gzip) và 13.80 kB CSS (3.44 kB gzip). `npm audit --audit-level=high` báo 0 vulnerability; 262/262 package có registry signature và 106 package có attestation; installed tree không có peer problem ngoài các optional dependency dự kiến.

## Phase B — Contract và engine gate

- [x] Task 4 — Domain contract và state machine
- [x] Task 5 — Geometry primitives theo TDD
- [x] Task 6 — Dataset contract và benchmark harness
- [ ] Task 7 — Spike engine detection/perspective
- [ ] Checkpoint B — Chủ dự án duyệt engine production từ số liệu

Verification Tasks 4–6 (2026-10-09, kiểm tra lại 2026-10-11): domain contract bất biến và scan-session state machine có cancel/stale-operation/failure guards; geometry dùng image-edge coordinates liên tục, validate/scale/rotate/ước lượng output có boundary và high-resolution cases; benchmark manifest bắt buộc provenance/license/risk tags, xác minh hash và đường dẫn local, fail-closed network evidence, giới hạn tài nguyên, metric IoU/corner/false-crop/timing/memory và CER/WER test-only. Các vòng review độc lập đã tìm và sửa lỗi finish-after-continue, orientation render/cache, quad validation, clipping số rất nhỏ, median/MAD chẵn, OCR accounting, overflow với số hữu hạn rất lớn và hai đường làm sai lệch gate. `geometryGate` hiện tính tỷ lệ IoU ≥ 0,90 trên toàn bộ tài liệu đủ điều kiện (miss/error đều fail); `noDocumentGate` tính false crop trên toàn bộ ảnh âm tính; aggregate tự chấm từ manifest + prediction nên caller không thể giả nhãn/score. Full suite tại mốc này 149/149 và benchmark 39/39 test qua; typecheck ứng dụng/tooling, lint và format-check qua. Production build qua với 228,89 kB JS (71,24 kB gzip) và 13,80 kB CSS (3,44 kB gzip). Máy hiện dùng Node 22.23.3/npm 10.9.9 chính thức. Bốn ảnh riêng tư người dùng gửi không được dùng làm fixture.

Progress Task 7 (2026-10-11): pin exact `scanic@1.6.0`, audit 0 vulnerability, xác minh MIT/integrity/signature/attestation và không có install script/runtime dependency. Adapter classical-only dùng Worker riêng, giới hạn RGBA, queue có backpressure, timeout/dispose/cancel và validate output; review độc lập đã tái hiện rồi khóa regression cho double-dispose khi cleanup chồng lấn và trạng thái `ready` giả khi caller cancel giữa cleanup lỗi. Bộ smoke 4 PNG synthetic deterministic đã thay placeholder. Chromium thật nhận đúng 2/2 tài liệu với IoU 0,9631/0,9615 và sau khi tune ngưỡng 0,72 giữ full-frame cho 2/2 cảnh âm tính qua ba vòng; ngưỡng 0,60 ban đầu từng false-crop 1/2 và đã có regression test. Đây chưa phải holdout hay kiểm thử điện thoại. Official OpenCV 4.14.0 artifact đã khớp release SHA-256 nhưng runtime 11,06 MB không ready trong 60 giây ở Node và khóa Chromium local quá 60 giây, nên official prebuilt bị reject trước detect; prototype contour ranking thêm 4 unit test. Custom export-minimal chưa build vì thiếu Docker/Emscripten/CMake. Renderer độc lập hiện đã nối Blob codec có giới hạn → Worker perspective warp → quarter-turn rotation → PNG encode, giữ tỷ lệ tự nhiên, hỗ trợ Safari main-thread canvas fallback, tạo recipe key SHA-256 và báo dewarp fallback trung thực; filter hiện chỉ là `original`. Primitive Node micro-benchmark median 16,6 ms ở 640×480 và 91,4 ms ở 1920×1080 (chưa phải số điện thoại/end-to-end). Focused render/codec/key review thêm boundary cho MIME, dimension, abort, transfer và backend cleanup. Golden browser render, holdout/device benchmark và verdict còn thiếu nên Task 7 chưa hoàn tất.

Progress Task 7 (2026-10-12): thêm adapter lấy preview RGBA dùng lại canvas, mặc định cạnh dài tối đa 960 px, không upscale và có dispose; 7 unit test khóa scale/lifecycle/error. Sample chính thức SmartDoc 2015 CC BY 4.0 được nhập tái lập thành 10 frame development + 5 frame holdout, có ground-truth quad và SHA-256; importer có 8 test. Benchmark Chrome headless thời gian thật chạy Scanic ba lần/frame, không request khác origin: cold init 31,7 ms, detect median/p95 96,8/144,8 ms nhưng ngưỡng đã khóa `0,72` fallback low-confidence 15/15, geometry pass rate 0% ở cả hai split. Không tune lại bằng holdout. Cấu hình hiện tại fail geometry gate và chỉ còn verdict `adapt`; Task 7/Checkpoint B vẫn mở vì sample chưa có cảnh âm tính, giấy cong/nhăn và chưa có số liệu iPhone/Android. Full suite 300/300, typecheck, lint, format-check và production build đều qua; build vẫn 241,93 kB JS (75,21 kB gzip) và 17,14 kB CSS (4,01 kB gzip).

## Phase C — Luồng scan phẳng

- [x] Task 8 — Camera lifecycle và import fallback
- [x] Task 9 — Live detection worker và overlay
- [x] Task 10 — High-resolution capture và safe crop decision
- [ ] Task 11 — Touch corner editor
- [x] Task 12 — Perspective render và bốn filter
- [ ] Checkpoint C — Luồng một trang end-to-end

Progress Tasks 8–9 (2026-10-12): camera chỉ xin quyền sau thao tác người dùng, ưu tiên camera sau, phân loại lỗi an toàn và dừng track khi hủy/rời màn hình/background/pagehide. Fallback thư viện xác minh MIME + magic bytes JPEG/PNG/WebP, giới hạn tệp 64 MiB, cạnh tối đa 8.192 px và 16 MP trước decode; chấp nhận hoán đổi trục do EXIF nhưng từ chối mismatch khác, luôn đóng bitmap và không tạo object URL/upload. Scheduler độc lập sở hữu frame, tối đa một detection đang chạy, thay/đóng frame chờ cũ, mặc định giới hạn 8 Hz, abort/dispose an toàn và chỉ co quad sau ba kết quả hình học ổn định; overlay có trạng thái chữ cho full-frame/không chắc/chưa ổn định/đã nhận diện. Scheduler/overlay chưa nối vào camera production vì Task 7 và Checkpoint B chưa có đủ benchmark thiết bị/holdout. Theo yêu cầu chủ dự án, lát này không mở browser/camera để chụp thử; manual Safari iOS/Chrome Android, rotate/background và performance trace được để lại cho vòng test thiết bị. Full suite 285/285, typecheck/lint/format-check và production build qua; build hiện 241,93 kB JS (75,21 kB gzip) và 17,14 kB CSS (4,01 kB gzip). Một lần chạy tests song song với bốn quality gate làm synthetic fixture vượt timeout 5 giây; chạy riêng đạt 3,06 giây và chạy lại full suite độc lập đạt, nên không nới timeout hay sửa yếu test.

Progress Tasks 8–10/12 và PDF một trang (2026-10-12): theo quyết định của chủ dự án, Scanic classical đã được nối vào luồng sử dụng thực dù Checkpoint B vẫn chưa đạt. Camera chạy nhận diện giới hạn 8 Hz và vẽ khung trực tiếp; người dùng tự bấm chụp, ưu tiên `ImageCapture.takePhoto()` rồi fallback ảnh video đầy đủ. Khung live tại đúng thời điểm bấm chụp được chốt làm khung cắt cuối, quy đổi sang tọa độ ảnh độ phân giải cao và không bị editor nhận diện lại thay đổi; không có tài liệu hoặc confidence thấp thì giữ toàn ảnh. Editor render perspective với bốn chế độ `original`, `ocr-color`, `grayscale`, `black-and-white`; Safari/iOS không có `OffscreenCanvas` được fallback sang Scanic main thread. Có xuất PDF một trang 300 DPI giữ đúng tỷ lệ tự nhiên và tải tên `clonecamscanner.pdf`; `pdf-lib@1.17.1` được lazy-load, pin exact và có giấy phép MIT. Touch corner editor, nhiều trang/IndexedDB, dewarp giấy cong và qualification thiết bị vẫn chưa có. Không mở camera/browser để test thủ công theo yêu cầu; sau cập nhật chốt khung live, full suite 335/335, typecheck, lint, format-check và production build qua. Audit gần nhất báo 0 vulnerability; 268 package có registry signature và 107 package có attestation. Main JS hiện 278,99 kB (85,98 kB gzip), Scanic worker 97,05 kB raw, fallback main-thread lazy 94,30 kB (39,38 kB gzip), PDF lazy 437,92 kB (181,22 kB gzip), CSS 19,89 kB (4,42 kB gzip).

Progress detector ML (2026-10-13): bật Scanic ML làm detector chính, tự lưu `scanic-ml@0.2.0` cùng origin và giữ classical 0,72 làm fallback chỉ khi runtime ML lỗi. Boundary chấp nhận score ML thấp như full-frame thay vì làm engine fail. Focused tests 55/55; smoke Chromium đạt 2/2 tài liệu và 0/2 false crop. SmartDoc tăng từ classical 0/15 lên ML 15/15 đạt IoU ≥0,90; mean IoU development/holdout 0,9779/0,9523, 0 request khác origin. Chưa có kiểm thử camera/iPhone/Android thật; chủ dự án sẽ test bản web đã deploy.

Progress bộ lọc làm nét v3 (2026-10-14): bỏ cơ chế kéo nền về khoảng 238/255 vì làm giấy màu và ảnh tối bị sáng gắt. `ocr-color` và `grayscale` nay giữ mức phơi sáng gốc, dùng tương phản cục bộ có ngưỡng khử nhiễu và unsharp bất đối xứng để làm đậm nét chữ nhiều hơn phần viền sáng; vùng highlight từ 246 trở lên không bị đẩy sáng thêm. Preset tăng lên v3 để không tái dùng cache cũ. Synthetic regression chứng minh trang đều 168/255 vẫn là 168/255, độ sáng trung bình của trang có gradient lệch không quá 3 mức và tương phản chữ tăng. Chưa có đánh giá OCR/ảnh thật trên điện thoại; chủ dự án sẽ kiểm tra bản deploy.

## Phase D — Dewarp cong/nhăn

- [ ] Task 13 — Spike dewarp on-device
- [ ] Task 14 — Tích hợp verdict hoặc perspective fallback
- [ ] Checkpoint D — Chủ dự án duyệt chất lượng/giới hạn dewarp

## Phase E — Local-first, nhiều trang và PDF

- [ ] Task 15 — IndexedDB schema/migration/quota handling
- [ ] Task 16 — Scan session nhiều trang và autosave
- [ ] Task 17 — Local document library
- [ ] Task 18 — PDF giữ tỷ lệ tự nhiên
- [ ] Checkpoint E — Full product flow và 20-page qualification

Progress nhiều trang/PDF (2026-10-14): camera nay chụp liên tiếp và giữ mở trong khi một hàng đợi tuần tự import, khóa đúng khung nhận diện tại thời điểm bấm chụp, perspective-warp và áp bộ lọc OCR màu ở nền. Màn hình xem lại giữ thứ tự chụp, báo rõ trang đang xử lý/lỗi, cho xử lý lại, xóa hoặc chỉnh từng trang, và chỉ cho xuất một `clonecamscanner.pdf` khi mọi trang đã sẵn sàng; PDF giữ tỷ lệ riêng của từng trang. Không thêm dependency. Focused tests 30/30; full suite 351/351 khi giới hạn 4 worker để tránh synthetic fixture tranh CPU; typecheck, lint, format-check và production build qua. Chưa đánh dấu Task 15–18 hoàn tất vì IndexedDB/autosave/reload, reorder, kiểm thử 20 trang và kiểm thử thiết bị thật vẫn còn.

## Phase F — Hardening và test deployment

- [ ] Task 19 — E2E, privacy và security headers
- [ ] Task 20 — Accessibility/responsive/recovery pass
- [ ] Task 21 — Performance/memory qualification
- [ ] Task 22 — Final review, runbook và HTTPS test deployment
- [ ] Checkpoint F — Nghiệm thu v1 trên device matrix

## Gate áp dụng cho mọi task

- [ ] Viết test quan sát được và thấy RED trước implementation cho hành vi mới.
- [ ] Focused tests xanh; checkpoint chạy full tests/typecheck/lint/build.
- [ ] Không thêm dependency/model ngoài danh sách đã duyệt; mọi bản cụ thể phải qua license/provenance/audit.
- [ ] Không upload/log ảnh tài liệu; original luôn bất biến; failure/fallback được báo trung thực.
- [ ] Cập nhật todo và bằng chứng verification ngay sau mỗi lát hoàn tất.
