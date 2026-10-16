# Kế hoạch triển khai: clonecamscanner v1

## 1. Mục tiêu và nguyên tắc giao hàng

Xây dựng web scan tài liệu mobile-first chạy tốt trên Safari iPhone/iPad và Chrome Android, xử lý ảnh hoàn toàn trên thiết bị, lưu cục bộ và xuất PDF ảnh giữ tỷ lệ tự nhiên của từng trang để hệ thống OCR phía sau đạt độ chính xác cao. Việc triển khai bám theo [đặc tả đã duyệt](../docs/specs/mobile-document-scanner.md), đi theo lát dọc nhỏ, test trước cho logic có hành vi và đo trước khi tối ưu.

Mỗi task dưới đây phải để project ở trạng thái chạy được. Không đưa engine hoặc model vào production chỉ vì demo chạy trên desktop; engine phải vượt qua gate giấy phép, chất lượng, bộ nhớ và thiết bị thật.

## 2. Quyết định kiến trúc

- Ứng dụng là SPA tĩnh React + TypeScript strict + Vite, không có backend trong v1.
- Ảnh và tài liệu không rời thiết bị. IndexedDB giữ ảnh gốc bất biến, edit recipe và cache có thể tái tạo.
- UI chỉ phụ thuộc các contract nội bộ (`ScannerEngine`, `DocumentStore`, `PdfExporter`); không rò rỉ kiểu OpenCV, WASM hay model lên component.
- Preview detection dùng ảnh giảm kích thước, một worker job tại một thời điểm và bỏ frame cũ để tránh backlog. Ảnh chụp cuối luôn được phát hiện lại ở độ phân giải cao hơn.
- Khi detection không chắc chắn, hành vi an toàn là giữ toàn khung. Không tự crop sai và không báo dewarp thành công khi đã fallback.
- Perspective correction là đường xử lý bắt buộc. Dewarp cong/nhăn là lớp nâng cao có timeout, hủy, so sánh và fallback về perspective-only.
- Bộ lọc mặc định hướng OCR nhưng không được xóa chữ ký, con dấu, chữ viết tay, bảng hoặc hình. Ảnh gốc không bao giờ bị ghi đè.
- PDF giữ tỷ lệ tự nhiên của từng trang, cho phép kích thước trang hỗn hợp, không ép A4/Letter.
- Tính năng nặng được lazy-load sau khi vào luồng scan; asset WASM/model được self-host và khóa phiên bản.
- Giao diện dùng design tokens, ưu tiên thao tác một tay, safe-area, màn hình 320 px đến tablet, WCAG 2.1 AA và không sao chép nhận diện CamScanner.

## 3. Dependency policy được đề nghị duyệt cùng kế hoạch

Nhóm nền tảng được phép bootstrap sau khi kế hoạch được duyệt:

- Runtime/build: React, React DOM, TypeScript, Vite và plugin React chính thức.
- Quality: Vitest, React Testing Library, jest-dom, jsdom, Playwright, ESLint, TypeScript ESLint, React Hooks lint và Prettier.
- Ứng dụng: `idb` cho giao dịch IndexedDB và `pdf-lib` cho PDF, sau khi xác nhận đúng giấy phép và audit phiên bản cụ thể.

Chưa phê duyệt làm dependency production ở thời điểm lập kế hoạch: Scanic, OpenCV.js, ONNX Runtime Web và UVDoc. Task spike chỉ được bắt đầu sau khi ghi nhận phiên bản/license/provenance; kết quả benchmark sẽ được đưa về checkpoint để chọn engine trước khi tích hợp production. Không dùng SDK trả phí, trial, AGPL hoặc package/model không rõ nguồn gốc.

## 4. Sơ đồ phụ thuộc

```text
Toolchain + quality gates
        |
        v
Domain contracts ---> Geometry primitives ---> Engine spike/gate
        |                     |                       |
        |                     v                       v
        +--------------> Camera/capture ------> Crop + filters
        |                                             |
        v                                             v
Storage schema <----------------------------- Page workflow
        |                                             |
        v                                             v
Local library                                Multipage + PDF
        \_____________________________________________/
                              |
                              v
                  E2E + device + quality gates
                              |
                              v
                    Temporary HTTPS deployment
```

Advanced dewarp depends on a separate feasibility gate and must not block a correct perspective-only flow.

## 5. Kế hoạch theo task

### Phase A — Nền tảng có thể kiểm chứng

#### Task 1A: Bootstrap dependency manifest có khóa phiên bản

**Mô tả:** Khai báo React/TypeScript/Vite bằng npm, khóa phiên bản trong lockfile và cấu hình cài đặt fail-closed cho install script/peer dependency.

**Tiêu chí nghiệm thu:**

- [ ] `package.json` có đúng các script đã cam kết trong đặc tả và khai báo Node 22.
- [ ] Có một `package-lock.json` duy nhất; dependency trực tiếp có license phù hợp và không có package thừa.
- [ ] Optional peer không dùng không được unpack; install script bị chặn mặc định và peer trực tiếp vẫn được khai báo rõ.

**Xác minh:**

- [ ] `npm ci`; kiểm installed tree/license và native audit.

**Phụ thuộc:** Không.

**File dự kiến:** `package.json`, `package-lock.json`, `tsconfig.json`, `.npmrc`.

**Phạm vi:** M — 4 file.

#### Task 1B: Entry tối thiểu có thể build

**Mô tả:** Tạo HTML entry và React mount tối thiểu để chứng minh toolchain thực sự compile/bundle được trước khi làm UI.

**Tiêu chí nghiệm thu:**

- [ ] Trang tối thiểu có ngôn ngữ, viewport, title và root mount hợp lệ.
- [ ] Lỗi thiếu root được báo rõ; không dùng non-null assertion để che invariant.
- [ ] TypeScript strict và production build đều thành công trên Node 22.

**Xác minh:**

- [ ] `npm run typecheck` và `npm run build` thành công.

**Phụ thuộc:** Task 1A.

**File dự kiến:** `index.html`, `src/main.tsx`.

**Phạm vi:** S — 2 file.

#### Task 2A: Khóa dependency cho quality gates

**Mô tả:** Thêm đúng các package test/lint/format và React Vite plugin đã duyệt, khóa version và kiểm license/provenance trước khi dùng.

**Tiêu chí nghiệm thu:**

- [ ] Package test/lint/format là dependency dev, pin exact và tương thích Node 22/React 19/Vite 7.
- [ ] Installed tree chỉ có license đã cho phép; install script tiếp tục bị chặn.
- [ ] Native audit không có high/critical reachable finding; signature/provenance được ghi nhận.

**Xác minh:**

- [ ] `npm ci`, installed-license query, `npm audit --audit-level=high`, `npm audit signatures`.

**Phụ thuộc:** Task 1B.

**File dự kiến:** `package.json`, `package-lock.json`.

**Phạm vi:** S — 2 file.

#### Task 2B: Test harness và vòng RED–GREEN

**Mô tả:** Cấu hình Vitest/Testing Library và chứng minh test quan sát được thật sự đỏ trước khi implementation xanh.

**Tiêu chí nghiệm thu:**

- [ ] Vitest chạy được một smoke test; coverage có ngưỡng ban đầu và không tính file cấu hình/generated.
- [ ] Test phải thất bại khi assertion smoke cố ý sai và xanh lại sau khi sửa.

**Xác minh:**

- [ ] `npm run test`, `npm run test:coverage` và `npm run typecheck` đều qua.

**Phụ thuộc:** Task 2A.

**File dự kiến:** `vitest.config.ts`, `src/test/setup.ts`, `src/main.test.tsx`, `src/main.tsx`.

**Phạm vi:** M — 4 file.

#### Task 2C: Lint, format và generated-file policy

**Mô tả:** Cấu hình ESLint/Prettier và ignore policy để chặn code/type không an toàn, không commit dependency/build output và giữ format nhất quán.

**Tiêu chí nghiệm thu:**

- [ ] ESLint chặn explicit `any`, floating promise và Hook sai; generated/vendor file bị loại.
- [ ] Prettier có cấu hình thống nhất; `node_modules`, `dist`, coverage và local environment không vào version control.
- [ ] Lint và format-check chạy được trên code hiện tại mà không che lỗi bằng blanket disable.

**Xác minh:**

- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build` đều qua.

**Phụ thuộc:** Task 2B.

**File dự kiến:** `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitignore`.

**Phạm vi:** M — 4 file.

#### Task 3A: App shell behavior và navigation foundation

**Mô tả:** Tạo shell semantic với màn hình thư viện trống/loading/error, CTA chuyển sang phần chuẩn bị scan và đường quay lại; chưa truy cập camera.

**Tiêu chí nghiệm thu:**

- [ ] Empty/error/loading state có nội dung tiếng Việt thực tế và test truy cập được bằng role/name.
- [ ] CTA scan chuyển view có heading/focus phù hợp; back quay lại thư viện mà không reload.
- [ ] Camera chưa tích hợp được biểu diễn trung thực, không có handler giả/no-op báo thành công.

**Xác minh:**

- [ ] Component test bằng Testing Library cho navigation và ba library states.
- [ ] `npm run test`, `npm run typecheck` và `npm run lint` qua.

**Phụ thuộc:** Task 2C.

**File dự kiến:** `vite.config.ts`, `src/vite-env.d.ts`, `src/main.tsx`, `src/app/App.tsx`, `src/app/App.test.tsx`.

**Phạm vi:** M — 5 file.

#### Task 3B: Design tokens và responsive visual system

**Mô tả:** Áp dụng visual system mobile-first riêng cho sản phẩm, safe-area và responsive phone/tablet mà không sao chép nhận diện CamScanner.

**Tiêu chí nghiệm thu:**

- [ ] Hoạt động tại 320, 768, 1024 và 1440 px, portrait/landscape, không tràn ngang.
- [ ] Tất cả control có focus rõ và vùng chạm tối thiểu 44×44 CSS px; contrast đạt WCAG AA.
- [ ] Loading/error/empty/scan-intro có hierarchy nhất quán, reduced-motion và forced-colors fallback hợp lý.

**Xác minh:**

- [ ] Kiểm tra thủ công bàn phím và bốn kích thước viewport; không có console error.
- [ ] `npm run format:check`, `npm run build` và focused component tests qua.

**Phụ thuộc:** Task 3A.

**File dự kiến:** `src/styles/tokens.css`, `src/styles/global.css`.

**Phạm vi:** S — 2 file.

#### Checkpoint A

- [ ] Full test/typecheck/lint/build xanh.
- [ ] Review dependency tree, lockfile, licenses và native audit; không tự dùng `audit fix --force`.
- [ ] App shell được xem ở bốn breakpoint; không có lỗi console/accessibility cơ bản.

### Phase B — Hợp đồng ảnh và rủi ro engine

#### Task 4: Định nghĩa domain contract và trạng thái hợp lệ

**Mô tả:** Định nghĩa kiểu thuần TypeScript cho document, page, edit recipe, detection, engine lifecycle và scan-session state machine.

**Tiêu chí nghiệm thu:**

- [ ] State bất hợp lệ không biểu diễn bằng nhiều boolean chồng chéo.
- [ ] Operation dài nhận `AbortSignal`; contract nêu rõ ownership/disposal của bitmap/blob.
- [ ] UI contract không chứa kiểu của DOM canvas, OpenCV, Scanic hoặc ONNX.

**Xác minh:**

- [ ] Type-level/unit tests cho transition hợp lệ, cancel và lỗi engine.
- [ ] `npm run typecheck` qua ở strict mode.

**Phụ thuộc:** Task 2C.

**File dự kiến:** `src/domain/document.ts`, `src/domain/scan-session.ts`, `src/imaging/contracts/scanner-engine.ts`, `src/domain/scan-session.test.ts`.

**Phạm vi:** M — 4 file.

#### Task 5: Geometry primitives theo TDD

**Mô tả:** Viết các hàm thuần cho thứ tự bốn góc, validate tứ giác, scale preview↔original, rotation và kích thước đầu ra.

**Tiêu chí nghiệm thu:**

- [ ] Test đỏ tồn tại trước implementation cho quad tự cắt, ngoài biên, diện tích nhỏ và mọi orientation.
- [ ] Mapping giữ sai số tối đa 1 px trong tập test.
- [ ] Không có `any`, mutation ẩn hoặc phụ thuộc canvas/UI.

**Xác minh:**

- [ ] `npm run test -- geometry` và property/boundary cases qua.
- [ ] Review numeric stability với ảnh rất dài và ảnh độ phân giải cao.

**Phụ thuộc:** Task 4.

**File dự kiến:** `src/imaging/geometry/quad.ts`, `src/imaging/geometry/coordinates.ts`, `src/imaging/geometry/geometry.test.ts`.

**Phạm vi:** M — 3 file.

#### Task 6: Dataset contract và benchmark harness không chứa dữ liệu cá nhân

**Mô tả:** Tạo format manifest cho fixture/golden label và CLI benchmark đo IoU, false crop, thời gian, memory proxy và kết quả OCR test-only. Không đưa bốn ảnh người dùng gửi vào repo vì có thông tin/cảnh riêng tư.

**Tiêu chí nghiệm thu:**

- [ ] Fixture manifest bắt buộc ghi license/provenance, nhãn `document`/`no-document`, corners và content-risk tags.
- [ ] Benchmark tạo JSON kết quả tái lập; không gửi ảnh ra mạng và không trở thành tính năng production.
- [ ] Có fixture tổng hợp nhỏ để chứng minh scoring đúng trước khi dùng dataset thật.

**Xác minh:**

- [ ] Unit test metric với kết quả biết trước; kiểm tra network bằng mock fail-closed.
- [ ] `npm run test -- benchmark` qua.

**Phụ thuộc:** Task 5.

**File dự kiến:** `tests/golden/schema.ts`, `tests/golden/metrics.ts`, `tests/golden/benchmark.test.ts`, `tests/fixtures/manifest.example.json`, `scripts/benchmark-scanner.ts`.

**Phạm vi:** M — 5 file.

#### Task 7: Spike engine nhận diện và perspective correction

**Mô tả:** Đánh giá Scanic và pipeline OpenCV.js qua cùng contract/harness trên cùng dữ liệu; ghi số đo và quyết định thay vì chọn theo README. Chỉ một ứng viên được chọn làm production dependency.

**Tiêu chí nghiệm thu:**

- [ ] Ghi rõ version, source, license, kích thước bundle/WASM, install scripts và transitive dependencies của từng ứng viên.
- [ ] So sánh độ chính xác quad, no-document false crop, init time, xử lý/frame và peak memory proxy trên desktop throttled cùng ít nhất một iPhone và một Android đại diện.
- [ ] Có quyết định `adopt`, `adapt` hoặc `reject`, cùng điểm yếu và fallback; không giữ cả hai engine production nếu không có lý do đo được.

**Xác minh:**

- [ ] Chạy benchmark cố định ít nhất ba lần mỗi engine/thiết bị; ghi median và độ biến thiên.
- [ ] Perspective output mở được và corners ánh xạ đúng về ảnh gốc.

**Phụ thuộc:** Tasks 4–6; cần checkpoint phê duyệt dependency candidate trước khi tải/tích hợp.

**File dự kiến:** `src/imaging/engines/candidate-engine.ts`, `src/imaging/worker/candidate.worker.ts`, `tests/golden/engine.integration.test.ts`, `docs/decisions/001-scanner-engine.md`, `docs/benchmarks/scanner-engine.md`.

**Phạm vi:** M — 5 file.

#### Checkpoint B — Gate chọn engine

- [ ] Chủ dự án xem benchmark và duyệt một engine/pipeline production.
- [ ] License/dependency/security review không có phí, trial, AGPL hoặc nguồn không rõ.
- [ ] Nếu chưa đạt ngưỡng chất lượng, điều chỉnh dataset/pipeline hoặc dừng để quyết định; không xây UI lên engine chưa chứng minh.

### Phase C — Luồng scan phẳng hoàn chỉnh

#### Task 8: Camera lifecycle và fallback nhập ảnh

**Mô tả:** Xây camera service và screen xin quyền sau thao tác người dùng, chọn camera sau, xử lý lỗi, giải phóng track và fallback nhập ảnh hợp lệ.

**Tiêu chí nghiệm thu:**

- [ ] Không xin quyền trước khi bấm mở scan; lỗi denied/busy/missing có thông báo và recovery action.
- [ ] Track dừng khi rời scan/background/đổi camera; object URL và listener được giải phóng.
- [ ] File import kiểm tra MIME, magic bytes có thể xác nhận, kích thước và decode bounds trước khi xử lý.

**Xác minh:**

- [ ] Unit/integration test mock permission, teardown, abort và file sai.
- [ ] Manual trên Safari iOS và Chrome Android qua HTTPS dev endpoint.

**Phụ thuộc:** Tasks 3B–4.

**File dự kiến:** `src/features/camera/camera-service.ts`, `src/features/camera/CameraScreen.tsx`, `src/features/camera/CameraScreen.test.tsx`, `src/features/camera/image-import.ts`, `src/features/camera/image-import.test.ts`.

**Phạm vi:** M — 5 file.

#### Task 9: Live detection worker và overlay ổn định

**Mô tả:** Nối video preview với engine trong worker, downscale, backpressure, smoothing và overlay full-frame/document quad có status text ngoài màu sắc.

**Tiêu chí nghiệm thu:**

- [ ] Tối đa một detection đang chạy; frame cũ bị bỏ và bitmap luôn đóng khi success/error/cancel.
- [ ] Không tài liệu hoặc confidence thấp hiển thị full-frame; tài liệu ổn định mới thu quad.
- [ ] Preview giữ mục tiêu ≥24 FPS và overlay 5–10 Hz trên thiết bị đại diện.

**Xác minh:**

- [ ] Test scheduler/backpressure/smoothing bằng clock kiểm soát.
- [ ] Performance trace trước/sau và manual rotate/background/foreground.

**Phụ thuộc:** Tasks 7–8 và Checkpoint B.

**File dự kiến:** `src/imaging/worker/scanner.worker.ts`, `src/features/scanner/detection-scheduler.ts`, `src/features/scanner/detection-scheduler.test.ts`, `src/features/scanner/DocumentOverlay.tsx`, `src/features/scanner/DocumentOverlay.test.tsx`.

**Phạm vi:** M — 5 file.

#### Task 10: Chụp độ phân giải cao và quyết định crop an toàn

**Mô tả:** Chụp bằng ImageCapture khi hỗ trợ, fallback video frame, re-detect ảnh chụp và tạo page draft giữ original bất biến.

**Tiêu chí nghiệm thu:**

- [ ] Không dùng trực tiếp preview corners để render ảnh cuối.
- [ ] Confidence thấp tạo draft full-frame; confidence đủ tạo suggested corners nhưng chưa phá original.
- [ ] Capture có cancel/error/retry và không giữ bitmap thừa.

**Xác minh:**

- [ ] Contract tests cho ImageCapture/fallback, scale corners và low-confidence path.
- [ ] Manual capture trên ít nhất một iPhone và Android.

**Phụ thuộc:** Task 9.

**File dự kiến:** `src/features/camera/capture-service.ts`, `src/features/camera/capture-service.test.ts`, `src/features/scanner/create-page-draft.ts`, `src/features/scanner/create-page-draft.test.ts`.

**Phạm vi:** M — 4 file.

#### Task 11: Editor bốn góc bằng cảm ứng

**Mô tả:** Tạo editor kéo bốn góc có vùng chạm lớn, kính lúp, reset và validation theo ảnh gốc.

**Tiêu chí nghiệm thu:**

- [ ] Pointer/touch/keyboard đều chỉnh được; handle trực quan không che điểm ảnh chính xác.
- [ ] Không chấp nhận quad tự cắt, quá nhỏ hoặc ngoài ảnh; lỗi có hướng dẫn sửa.
- [ ] Reset về suggested corners hoặc full frame và không làm mất original.

**Xác minh:**

- [ ] Component tests cho pointer mapping, keyboard và invalid quad.
- [ ] Manual ở 320 px, landscape và tablet với ảnh dọc/dài.

**Phụ thuộc:** Tasks 5 và 10.

**File dự kiến:** `src/features/scanner/CornerEditor.tsx`, `src/features/scanner/CornerEditor.test.tsx`, `src/features/scanner/use-corner-drag.ts`, `src/features/scanner/CornerMagnifier.tsx`, `src/features/scanner/corner-editor.css`.

**Phạm vi:** M — 5 file.

#### Task 12: Perspective render và bốn preset ảnh

**Mô tả:** Render crop phối cảnh ngoài main thread và áp dụng Gốc/Màu OCR/Xám/Đen trắng theo recipe có version, không encode nhiều thế hệ.

**Tiêu chí nghiệm thu:**

- [ ] Kích thước output theo chiều dài cạnh, không kéo méo; orientation đúng.
- [ ] Filter có preview và fallback; preset mặc định không làm mất golden marks/tables/signatures.
- [ ] Render hủy được, có error state và cache key xác định từ recipe/version.

**Xác minh:**

- [ ] Golden regression cho geometry/filter; đo CER/WER test-only trước/sau.
- [ ] Capture-to-edit p75 mục tiêu ≤2 giây hoặc có benchmark ghi chênh lệch rõ.

**Phụ thuộc:** Tasks 7, 10–11.

**File dự kiến:** `src/imaging/worker/render-page.ts`, `src/imaging/filters/filter-presets.ts`, `src/imaging/filters/filter-presets.test.ts`, `src/features/scanner/FilterPicker.tsx`, `src/features/scanner/FilterPicker.test.tsx`.

**Phạm vi:** M — 5 file.

#### Checkpoint C — Luồng một trang

- [ ] Camera/import → detect/full-frame → chụp → chỉnh góc → filter chạy end-to-end.
- [ ] Không có request upload ảnh trong Network panel.
- [ ] Test/typecheck/lint/build xanh; review năm trục correctness/readability/architecture/security/performance.

### Phase D — Dewarp cong/nhăn có gate riêng

#### Task 13: Spike UVDoc/ứng viên dewarp on-device

**Mô tả:** Chuyển/đóng gói ứng viên dewarp dưới worker trên WASM, WebGPU chỉ là tăng tốc tùy chọn; đo trên ảnh cong/nhăn nhẹ và thiết bị thật trước khi bật.

**Tiêu chí nghiệm thu:**

- [ ] Xác minh model/license/source/hash, runtime/license, kích thước tải, peak memory và browser support.
- [ ] Có timeout/cancel/progress và so sánh với perspective-only; lỗi luôn trả về fallback trung thực.
- [ ] Chỉ `adopt` nếu hình học/chữ cải thiện trên golden set mà không gây sai nội dung đáng kể và p75 mục tiêu khả thi; nếu không thì ghi `reject/defer`.

**Xác minh:**

- [ ] Benchmark lặp lại trên iPhone tối thiểu, iPhone hiện hành, iPad, Android 10 RAM thấp/trung bình và Android hiện hành tầm trung.
- [ ] OCR CER/WER, line straightness, visual golden review và memory/reload behavior được ghi lại.

**Phụ thuộc:** Task 12; cần phê duyệt model/runtime candidate trước khi tải.

**File dự kiến:** `src/imaging/dewarp/dewarp-engine.ts`, `src/imaging/worker/dewarp.worker.ts`, `tests/golden/dewarp.integration.test.ts`, `docs/decisions/002-dewarp.md`, `docs/benchmarks/dewarp.md`.

**Phạm vi:** M — 5 file.

#### Task 14: Tích hợp dewarp được chọn hoặc fallback sản phẩm

**Mô tả:** Nếu Task 13 đạt gate, tích hợp default auto-when-needed, compare và rollback. Nếu không đạt, cung cấp perspective-only rõ ràng và ghi giới hạn v1, không dựng tính năng giả.

**Tiêu chí nghiệm thu:**

- [ ] Hệ thống quyết định `not-needed/running/applied/fallback/failed` bằng state rõ ràng.
- [ ] Người dùng so sánh và quay lại perspective-only; original và recipe không mất.
- [ ] Máy yếu/thiếu RAM/không WebGPU vẫn hoàn thành scan bằng đường WASM phù hợp hoặc perspective fallback.

**Xác minh:**

- [ ] Tests cho detect-need, timeout, cancel, OOM-like failure và rollback.
- [ ] Manual device matrix theo verdict của Task 13.

**Phụ thuộc:** Task 13 và duyệt verdict tại checkpoint.

**File dự kiến:** `src/features/scanner/dewarp-policy.ts`, `src/features/scanner/dewarp-policy.test.ts`, `src/features/scanner/DewarpReview.tsx`, `src/features/scanner/DewarpReview.test.tsx`.

**Phạm vi:** M — 4 file.

#### Checkpoint D — Gate dewarp

- [ ] Chủ dự án duyệt số liệu và verdict; không cam kết “làm phẳng hoàn hảo” ngoài bằng chứng.
- [ ] Nếu model không đạt, v1 tiếp tục với perspective-only ổn định và tài liệu giới hạn rõ ràng.
- [ ] Asset nặng chỉ tải khi cần, self-host, có integrity/version inventory.

### Phase E — Lưu trữ, nhiều trang và PDF

#### Task 15: IndexedDB schema, migration và quota-safe store

**Mô tả:** Xây adapter lưu Document/PageAsset/EditRecipe với transaction logic, original immutable, autosave và xử lý quota/private mode.

**Tiêu chí nghiệm thu:**

- [ ] Create/update/delete/reorder atomic ở mức transaction phù hợp; delete dọn blob/thumbnail liên quan.
- [ ] `QuotaExceededError` không phá dữ liệu cũ và đưa UI về trạng thái có thể phục hồi.
- [ ] Migration idempotent; cache có thể xóa/tái tạo nhưng original + recipe được bảo toàn.

**Xác minh:**

- [ ] Integration tests bằng IndexedDB test environment cho CRUD, migration, quota và rollback.
- [ ] Manual reload/tab eviction/private mode behavior được ghi nhận.

**Phụ thuộc:** Task 4; dependency `idb` qua audit đã duyệt.

**File dự kiến:** `src/storage/schema.ts`, `src/storage/document-store.ts`, `src/storage/document-store.test.ts`, `src/storage/quota.ts`, `src/storage/quota.test.ts`.

**Phạm vi:** M — 5 file.

#### Task 16: Phiên scan nhiều trang và autosave

**Mô tả:** Kết nối page workflow với store để thêm, chọn, rotate, reorder, delete, retake và khôi phục draft.

**Tiêu chí nghiệm thu:**

- [ ] Một và nhiều trang dùng chung state machine; mỗi thay đổi bền vững được autosave có debounce/flush hợp lý.
- [ ] Không giữ full-resolution bitmap của trang không hoạt động trong RAM.
- [ ] Reload phục hồi đúng thứ tự, active page và recipe.

**Xác minh:**

- [ ] Reducer/service tests cho mọi operation và failure khi autosave.
- [ ] Integration flow 20 trang bằng blob fixture không crash trong budget test.

**Phụ thuộc:** Tasks 10, 12, 15; Task 14 nếu dewarp được adopt.

**File dự kiến:** `src/features/scanner/session-reducer.ts`, `src/features/scanner/session-reducer.test.ts`, `src/features/scanner/ScanSession.tsx`, `src/features/scanner/ScanSession.test.tsx`, `src/features/scanner/PageStrip.tsx`.

**Phạm vi:** M — 5 file.

#### Task 17: Thư viện cục bộ

**Mô tả:** Hiển thị document list, thumbnail, dung lượng ước tính, đổi tên, mở lại, tiếp tục chỉnh và xóa có xác nhận.

**Tiêu chí nghiệm thu:**

- [ ] Empty/loading/error/quota states đầy đủ; tên được validate và render như text, không HTML.
- [ ] Xóa cần xác nhận và không để orphan; lỗi không biến thành success giả.
- [ ] Danh sách dài không decode ảnh gốc và dùng pagination/virtualization chỉ khi đo cho thấy cần.

**Xác minh:**

- [ ] Component/integration tests cho rename/open/delete/error.
- [ ] Accessibility + performance trace với dữ liệu đại diện.

**Phụ thuộc:** Tasks 3B và 15–16.

**File dự kiến:** `src/features/library/LibraryScreen.tsx`, `src/features/library/LibraryScreen.test.tsx`, `src/features/library/DocumentCard.tsx`, `src/features/library/RenameDocumentDialog.tsx`, `src/features/library/DeleteDocumentDialog.tsx`.

**Phạm vi:** M — 5 file.

#### Task 18: Xuất PDF giữ tỷ lệ tự nhiên

**Mô tả:** Render tuần tự từng page ở chất lượng OCR, tạo PDF kích thước hỗn hợp đúng tỷ lệ, sanitize filename và giải phóng tài nguyên giữa các trang.

**Tiêu chí nghiệm thu:**

- [ ] Page box giữ đúng ratio/orientation của tài liệu và không stretch; mixed sizes đúng thứ tự.
- [ ] Không thêm OCR text layer/metadata nhạy cảm; filename an toàn và có fallback hợp lệ.
- [ ] Export 20 trang không giữ tất cả full-res bitmap đồng thời; lỗi/cancel không tạo file báo thành công giả.

**Xác minh:**

- [ ] Unit/integration test đọc lại PDF để kiểm page count, dimensions, order và metadata.
- [ ] Mở PDF trên Safari, Chrome và reader độc lập; downstream OCR smoke test.

**Phụ thuộc:** Tasks 12, 15–16; dependency `pdf-lib` qua audit đã duyệt.

**File dự kiến:** `src/features/export/pdf-exporter.ts`, `src/features/export/pdf-exporter.test.ts`, `src/features/export/ExportDialog.tsx`, `src/features/export/ExportDialog.test.tsx`, `src/features/export/file-name.ts`.

**Phạm vi:** M — 5 file.

#### Checkpoint E — Sản phẩm chức năng đầy đủ

- [ ] Camera/import → multi-page edit → autosave/reload → PDF chạy end-to-end.
- [ ] 20 trang không crash trên thiết bị mục tiêu và PDF được downstream OCR đọc.
- [ ] Không có dữ liệu ảnh rời origin trong network/CSP review.

### Phase F — Hardening, nghiệm thu và triển khai test

#### Task 19: E2E camera/storage/export và security headers

**Mô tả:** Viết Playwright với camera/permission mock, kiểm fallback/error/lifecycle/quota/reload/export và cấu hình header triển khai tĩnh hạn chế origin.

**Tiêu chí nghiệm thu:**

- [ ] E2E phủ permission grant/deny, import fallback, one/multi page, reopen và export.
- [ ] Test fail nếu ảnh bị gửi qua `fetch`/XHR/WebSocket; CSP chỉ cho asset self-host cần thiết.
- [ ] Không có stack trace/raw document data trong log hoặc error UI.

**Xác minh:**

- [ ] `npm run test:e2e`, native audit triage, CSP/network manual review.
- [ ] Kiểm dependency signature/provenance khi registry hỗ trợ.

**Phụ thuộc:** Tasks 17–18.

**File dự kiến:** `playwright.config.ts`, `e2e/scan-flow.spec.ts`, `e2e/privacy.spec.ts`, `e2e/fixtures/camera.ts`, `public/_headers`.

**Phạm vi:** M — 5 file.

#### Task 20: Accessibility, responsive và UX recovery pass

**Mô tả:** Review toàn bộ UI theo WCAG 2.1 AA, safe-area, orientation, reduced motion, focus restoration và các trạng thái lỗi có recovery.

**Tiêu chí nghiệm thu:**

- [ ] Không có axe violation nghiêm trọng; contrast, label, focus order và live status đạt yêu cầu.
- [ ] Dùng tốt ở 320/768/1024/1440 px, iPhone notch/safe-area, tablet và landscape.
- [ ] Mọi lỗi camera/worker/decode/storage/PDF có hành động tiếp theo cụ thể.

**Xác minh:**

- [ ] Automated accessibility tests cộng keyboard/screen-reader manual pass.
- [ ] Screenshot baseline cho các màn hình/trạng thái chính.

**Phụ thuộc:** Task 19.

**File dự kiến:** `src/test/accessibility.test.tsx`, `e2e/responsive.spec.ts`, `docs/qa/accessibility.md`, `docs/qa/responsive.md`.

**Phạm vi:** M — 4 file.

#### Task 21: Performance và memory qualification

**Mô tả:** Đo baseline/thay đổi cho bundle, Core Web Vitals, preview FPS, capture latency, dewarp, export 20 trang và memory trên thiết bị thật; chỉ giữ tối ưu có số đo.

**Tiêu chí nghiệm thu:**

- [ ] Có số trước/sau cùng điều kiện, độ biến thiên và ledger cả thử nghiệm bị revert.
- [ ] Không có worker/frame queue không giới hạn, bitmap/object URL/track leak hoặc bundle model vào initial route.
- [ ] Budget cuối được ghi và CI chặn regression có thể tự động hóa.

**Xác minh:**

- [ ] Performance trace/Lighthouse/bundle report và device run matrix có bằng chứng.
- [ ] Full tests vẫn xanh sau từng tối ưu được giữ.

**Phụ thuộc:** Tasks 19–20.

**File dự kiến:** `scripts/check-budgets.ts`, `docs/benchmarks/performance.md`, `docs/benchmarks/optimization-ledger.md`, `e2e/performance.spec.ts`.

**Phạm vi:** M — 4 file.

#### Task 22: Final review, runbook và HTTPS test deployment

**Mô tả:** Review diff theo năm trục, hoàn thiện tài liệu setup/device testing/known limits/license inventory, chạy toàn bộ gate rồi triển khai bản HTTPS tạm thời để chủ dự án test trên thiết bị.

**Tiêu chí nghiệm thu:**

- [ ] Không còn placeholder/debug output/dead code/secrets; mọi dependency/model có version, license, source và hash khi phù hợp.
- [ ] README nêu setup, privacy, browser minimum, giới hạn dewarp/storage và cách test thiết bị.
- [ ] URL HTTPS tạm thời mở được trên iPhone/iPad/Android và camera hoạt động; hosting production vẫn chưa bị tự quyết.

**Xác minh:**

- [ ] `npm ci`, `npm run typecheck`, `npm run lint`, `npm run test:coverage`, `npm run test:e2e`, `npm run build` đều qua từ checkout sạch.
- [ ] Manual acceptance theo ma trận thiết bị và network privacy review; báo rõ mục nào chưa xác minh.

**Phụ thuộc:** Tasks 19–21 và thông tin/ủy quyền deployment tại thời điểm triển khai.

**File dự kiến:** `README.md`, `docs/qa/device-matrix.md`, `docs/dependencies.md`, `docs/deployment.md`, cấu hình hosting được chọn.

**Phạm vi:** M — tối đa 5 file.

#### Checkpoint F — Nghiệm thu v1

- [ ] Tất cả tiêu chí hoàn thành trong đặc tả được đối chiếu bằng bằng chứng.
- [ ] Chủ dự án test bản HTTPS trên thiết bị thật và ghi nhận lỗi theo thiết bị/browser.
- [ ] Chỉ sau khi chất lượng scan đạt mới quyết định domain/hosting production và tên thương hiệu chính thức.

## 6. Chiến lược TDD và verification chung

1. Với mỗi hành vi mới: viết test quan sát được, chạy thấy RED đúng lý do, viết implementation nhỏ nhất, chạy GREEN, rồi refactor.
2. Logic geometry/state/storage/PDF dùng unit/integration tests; UI dùng Testing Library theo role/name; camera/browser lifecycle dùng E2E và thiết bị thật.
3. Image quality không được đánh giá chỉ bằng snapshot pixel. Dùng geometric metrics + golden review + OCR CER/WER test harness.
4. Mỗi task chạy focused checks; mỗi checkpoint chạy full suite, typecheck, lint, build và review dependency/security khi có thay đổi lockfile.
5. Không giảm assertion, skip test hoặc đổi golden chỉ để làm build xanh. Mọi thay đổi contract phải cập nhật spec/ADR trước.

## 7. Threat model rút gọn

| Boundary/asset | Abuse/failure | Kiểm soát |
|---|---|---|
| Camera và ảnh import | File giả, ảnh quá lớn, decode bomb, quyền bị lạm dụng | Xin quyền sau gesture; MIME + signature + dimension/size bounds; abort và giải phóng track |
| Worker/WASM/model | Asset bị thay, job treo, OOM, leak bitmap | Self-host + version/hash; timeout/cancel; one-in-flight; dispose mọi path |
| IndexedDB | Quota, partial write, dữ liệu cũ/malformed | Schema validation, transaction, migration idempotent, honest recovery |
| Tên tài liệu/file | XSS, path/control chars, tên gây lỗi | React text escaping, length/character normalization, safe fallback |
| Privacy | Ảnh bị upload/telemetry/log | Không backend/analytics; CSP/connect-src; E2E chặn network; không log blob/content |
| Supply chain | Package/model độc hại hoặc license sai | Pin lockfile, scripts disabled-first, provenance/license/audit, explicit gate |
| Resource exhaustion | Không giới hạn trang làm tab crash | Không hard cap sản phẩm nhưng xử lý tuần tự, release memory, quota warning và cancel |

## 8. Rủi ro và giảm thiểu

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Document detection tốt trên desktop nhưng kém nền rối/giấy trắng | Cao | Golden dataset đa dạng, false-crop safe default, engine gate sớm, manual corner editor |
| Dewarp ML quá nặng hoặc làm méo chữ trên iOS | Cao | Spike riêng, metric OCR + visual, timeout/cancel, perspective fallback và có thể defer trung thực |
| Safari iOS thiếu/khác API | Cao | Progressive capability detection, ImageCapture/OffscreenCanvas/WebGPU đều có fallback, test iOS 16 sớm |
| Tab reload do RAM khi nhiều trang | Cao | Blob trong IndexedDB, thumbnail trong UI, xử lý tuần tự, đóng bitmap và device memory tests |
| Browser xóa storage hoặc quota thấp | Trung bình | Estimate/persist khi hỗ trợ, autosave transaction, cảnh báo quota, không che giấu giới hạn platform |
| OCR đẹp mắt nhưng accuracy giảm | Cao | CER/WER và golden preservation gate; original + compare + revert |
| Dependency/model license hoặc supply-chain không phù hợp | Cao | Inventory trước tải, permissive-only, lock/hash/provenance, checkpoint con người |
| Camera chỉ hoạt động trên HTTPS | Trung bình | Dev HTTPS/temporary HTTPS test deployment và hướng dẫn permission rõ ràng |
| Tên `clonecamscanner` gây rủi ro thương hiệu khi public | Trung bình | Chỉ dùng nội bộ/test; review tên riêng trước production public |

## 9. Đầu vào cần từ chủ dự án trong quá trình làm

Không còn câu hỏi chặn việc bootstrap sau khi kế hoạch được duyệt. Ở các checkpoint sau sẽ cần:

- Duyệt engine/model dependency dựa trên benchmark và license, không duyệt mù trước số liệu.
- Cung cấp hoặc phê duyệt bộ ảnh công ty đã ẩn danh/có quyền dùng để quality gate; không mặc định dùng ảnh cá nhân đã gửi làm fixture repo.
- Cho phép kiểm thử trên ma trận thiết bị thật và cấp cách triển khai HTTPS tạm thời khi tới Task 22.

## Bổ sung 2026-10-16 — Document restoration v2

Nguồn: `docs/specs/document-restoration-v2.md`.

### R1: Quality analyzer và router on-device

**Mô tả:** thêm phân tích bounded-sample cho shadow gradient, clipping, detail và color-content; quyết định stage nào cần chạy mà không cấp phát full-frame buffer mới.

**Nghiệm thu:** kết quả deterministic, validated input, không làm thay đổi ảnh; test khóa trang đều, bóng mượt, highlight cháy và vùng màu.

**File:** `src/imaging/analysis/document-quality.ts`, test cùng module.

### R2: Robust illumination map

**Mô tả:** thay box mean dễ nhiễm chữ bằng estimator nền theo percentile/downsample có nội suy; router chỉ bật correction khi gradient đủ lớn.

**Nghiệm thu:** bóng tổng hợp giảm ít nhất 60%, tương phản chữ không giảm, trang đều và màu bão hòa an toàn; worker/main-thread dùng cùng implementation.

**File:** `src/imaging/rendering/document-filter.ts`, test cùng module, preset/engine version.

### R3: Neural restoration provider

**Mô tả:** contract-first cho DocRes/UVDoc với timeout/cancel/fallback, sau đó spike backend GPU và ONNX/WebGPU riêng biệt.

**Nghiệm thu:** không upload khi chưa cấu hình/cho phép; model identity/version trong recipe outcome; candidate vượt paired quality gate trước default-on.

### R4: Paired quality/PDF qualification

**Mô tả:** benchmark cùng input/output, xác nhận PDF nhúng final variant và chạy device matrix.

**Nghiệm thu:** CER/WER, background uniformity, clipping, color error, dewarp line error và latency được ghi; không tuyên bố parity nếu thiếu dữ liệu.

