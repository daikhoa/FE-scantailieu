# ADR 001: Phạm vi spike engine scan phẳng

- Trạng thái: **Đang adapt — Scanic đã được nối theo quyết định chủ dự án, chưa đạt qualification production**
- Ngày rà soát nguồn: 2026-10-11
- Phạm vi: Task 7 và Checkpoint B

## Phạm vi spike đã được duyệt

Chạy một spike cổ điển, local-only với đúng hai ứng viên trên cùng contract, dữ liệu và thiết bị:

1. **Scanic 1.6.0**, pin source tại commit `3633d5f9292948400c4a6809964e7f75c43661ec`.
2. **OpenCV 4.14.0**, build từ source chính thức bằng `platforms/js/build_js.py`; pin Emscripten SDK `4.0.23` và ghi lại full commit, lệnh build, cờ build, hash artifact trong báo cáo spike.

Kết quả benchmark ban đầu không đủ để `adopt`. Ngày 2026-10-12, chủ dự án quyết định tiếp tục hướng `adapt` và nối Scanic vào luồng thực để kiểm thử thiết bị sớm. Quyết định này không làm Checkpoint B tự động đạt: confidence thấp vẫn phải giữ toàn khung và kết quả chỉ được nâng thành production-qualified sau benchmark thiết bị/dataset còn thiếu.

## Vì sao chọn hai ứng viên này

| Ứng viên | Vai trò trong spike | Nguồn/giấy phép đã xác minh | Rủi ro phải chứng minh |
| --- | --- | --- | --- |
| Scanic 1.6.0 | Thư viện chuyên scan tài liệu, có detector và perspective warp sẵn | Repository/package khai báo MIT; tag/source pin tồn tại; package không khai báo runtime dependency và không có `install`/`postinstall` | Dự án còn trẻ, bus factor thấp; npm tarball ↔ source và `dist.integrity` chưa được xác minh; số liệu kích thước/tốc độ hiện chỉ là claim upstream; lifecycle không có `dispose`; đường worker trên iOS cũ cần kiểm chứng |
| OpenCV 4.14.0 | Baseline minh bạch gồm các primitive CV; pipeline do dự án khóa rõ | Source/build script và release artifact chính thức, Apache-2.0 | Official prebuilt đã fail startup budget; custom export-minimal chưa build vì thiếu toolchain; mọi `cv.Mat` phải `delete` |

Không dùng package npm OpenCV.js không chính thức trong spike đầu tiên. Không lặp lại con số kích thước OpenCV trong README của Scanic như một số đo; kích thước raw/gzip/Brotli phải đo trên artifact thực tế của chính build này.

## Phạm vi kỹ thuật bị khóa

### Scanic

- Spike **classical detector** trước.
- Không bật detector ML trong vòng đầu. ML mặc định tải model/runtime từ CDN; điều này không đạt chính sách asset production cùng origin. Nếu classical không đạt và muốn thử ML, model, ORT JS/WASM, weight/license và cơ chế self-host phải qua một gate riêng.
- Adapter phải biến lỗi init thành lỗi thật, hỗ trợ cancel/dispose trung thực; có thể phải hủy worker để giải phóng engine.
- Phải kiểm thử Safari ở mức tối thiểu. `OffscreenCanvas` 2D chỉ có từ Safari 16.4, trong khi sản phẩm hỗ trợ iOS 16+; DOM-canvas fallback không dùng được bên trong worker.

### OpenCV.js

- Build từ tag source chính thức, không lấy binary trôi nổi.
- Khóa một pipeline cụ thể: resize/grayscale/blur/edge/morphology, contour ranking, confidence/full-frame fallback, thứ tự góc, perspective interpolation và output sizing.
- Baseline single-thread; chưa bật pthread/`SharedArrayBuffer` để tránh phụ thuộc COOP/COEP. Có thể đo thêm SIMD như một biến thể, không trộn kết quả.
- Ưu tiên WASM tách file, self-host cùng origin, lazy-load khi vào chức năng scan; đo artifact thật và phục vụ với MIME phù hợp.
- Mọi `cv.Mat` và buffer trung gian phải được giải phóng ở success, failure, cancel và dispose.

## Giao thức benchmark

1. Dùng fixture có quyền sử dụng rõ ràng; không dùng bốn ảnh riêng tư người dùng đã gửi. Tách tập phát triển và holdout chưa dùng để tuning.
2. Hai ứng viên nhận cùng ảnh, preview resolution, original-coordinate contract, tuning budget và cache state.
3. Mỗi engine/thiết bị chạy ít nhất ba lần; báo cold init, warm detect, render, median, p75/p95, MAD, lỗi và memory proxy riêng.
4. Thiết bị tối thiểu trong spike: desktop throttled, một iPhone/Safari thật và một Android/Chrome thật. Ưu tiên iOS 16.x và Android 10 RAM thấp/trung bình để lộ incompatibility sớm.
5. Network test fail-closed trên cold init, lazy asset, worker, lỗi và render; không có document/content egress hoặc request bên thứ ba.

## Gate đo được

- **Geometry:** ít nhất 90% của *toàn bộ* fixture tài liệu phẳng đủ điều kiện đạt IoU ≥ 0,90. Miss, engine error và fallback full-frame đều tính fail; không chỉ lấy trung bình trên những ảnh detect thành công.
- **No-document:** zero observed false crop trên toàn bộ holdout `no-document`, kèm sample count và danh sách failure. Đây là bằng chứng trên tập kiểm thử, không phải cam kết xác suất bằng 0 ngoài đời.
- **Mapping/render:** synthetic mapping sai số không quá 1 px; orientation đúng; output mở được, giữ tỷ lệ tự nhiên và không mất mép nội dung.
- **Preview:** camera vẫn ≥24 FPS và overlay cập nhật 5–10 Hz. Ngân sách ban đầu cho một preview job là p75 ≤200 ms để đạt 5 Hz; đây là ngưỡng spike đề xuất, không thay thế đo end-to-end.
- **Capture:** từ bấm chụp đến editor p75 ≤2 giây trên thiết bị đại diện.
- **Resource:** không tăng bộ nhớ không giới hạn qua detect/render/cancel/dispose lặp lại; báo WASM heap, pixel allocation và browser proxy khi đo được.
- **Content:** không làm mất chữ ký, con dấu hoặc đường bảng trong golden cases. Filter/OCR enhancement thuộc phase sau; khi so CER/WER phải dùng paired pre/post với cùng OCR version/model/ngôn ngữ.

Không được chọn engine chỉ vì nó tốt hơn ứng viên còn lại. Nếu cả hai không đạt gate, verdict phải là `adapt` hoặc `reject`, rồi mới xem xét ứng viên dự phòng như các crate detection/transform của OpenDocScan.

## Bằng chứng hiện có và phần chưa có

- Contract, geometry và benchmark harness đã có unit test. Bộ smoke 4 fixture synthetic tái lập được đã thay placeholder; nó chỉ dùng để kiểm wiring/tuning ban đầu, chưa đủ kết luận chất lượng engine. Sample chính thức SmartDoc 2015 (CC BY 4.0) đã bổ sung 10 frame development và 5 frame holdout có ground truth, cạnh dài 960 px và hash khóa trong manifest.
- `scanic@1.6.0` đã được pin exact, xác minh registry integrity/signature/attestation/license/install scripts và bọc bằng adapter classical-only trong Worker có lifecycle, timeout, dispose và validation rõ ràng.
- Smoke test Chromium thật đã phát hiện ngưỡng 0,60 gây false crop 1/2 cảnh âm tính; ngưỡng spike 0,72 sửa smoke set thành 0/2 false crop trong khi hai tài liệu đạt IoU 0,9631 và 0,9615. Đây không phải holdout hay device qualification. Số liệu chi tiết ở [báo cáo benchmark](../benchmarks/scanner-engine.md).
- Với ngưỡng `0,72` đã khóa trước khi mở SmartDoc holdout, Scanic fallback `low-confidence` cho 10/10 development và 5/5 holdout: geometry pass rate 0%. Median/p95 của 45 lượt detect desktop là 96,8/144,8 ms và không có request khác origin. Cấu hình Scanic classical hiện tại vì vậy fail geometry gate; verdict vẫn là `adapt`, không phải `adopt`, và không được hạ ngưỡng bằng cách nhìn holdout.
- Đường extractDocument của Scanic vẫn bị loại vì phụ thuộc DOM canvas. Thay vào đó, primitive inverse projective warp RGBA độc lập đã được nối qua Worker với xoay quarter-turn, codec JPEG/PNG/WebP có giới hạn, PNG output, abort và khóa recipe SHA-256. Renderer hiện hỗ trợ `original`, `ocr-color`, `grayscale` và `black-and-white`; yêu cầu dewarp `auto` vẫn trả fallback perspective trung thực. Golden browser output, so sánh OCR và số đo thiết bị vẫn còn thiếu nên chưa được tính là renderer production-qualified.
- Official OpenCV 4.14.0 docs artifact đã được tải và xác minh đúng release digest. Runtime 11.059.007 B (3.559.472 B gzip, 2.591.300 B Brotli) không ready trong 60 giây ở Node và làm Chromium local không phản hồi quá 60 giây; official prebuilt vì vậy bị reject khỏi production path hiện tại trước bước detect. Prototype contour/ranking có 4 unit test nhưng không được tính là benchmark engine hoàn chỉnh. Custom export-minimal chưa build vì máy không có Docker/Emscripten/CMake.
- Chưa test iPhone/Android thật, camera FPS, memory hoặc perspective output, nên Checkpoint B vẫn chưa thể pass. Candidate Scanic hiện chỉ là hướng `adapt`, chưa phải dependency production được duyệt.
- Trước production adoption phải có hash/license inventory của mọi artifact được ship và benchmark trên dataset/thiết bị đã khóa.

## Nguồn chính

- [Scanic repository](https://github.com/marquaye/scanic)
- [Scanic package manifest](https://github.com/marquaye/scanic/blob/main/package.json)
- [Scanic source pin 1.6.0](https://github.com/marquaye/scanic/commit/3633d5f9292948400c4a6809964e7f75c43661ec)
- [Scanic ML asset behavior](https://marquaye.github.io/scanic/guide/ml-detection)
- [OpenCV releases](https://github.com/opencv/opencv/releases)
- [OpenCV 4.14.0 license](https://github.com/opencv/opencv/blob/4.14.0/LICENSE)
- [Official OpenCV.js build script](https://github.com/opencv/opencv/blob/4.14.0/platforms/js/build_js.py)
- [Official OpenCV.js build guide](https://docs.opencv.org/5.0/js_tutorials/js_setup/js_setup/js_setup.html)
- [OpenCV.js resource lifecycle](https://docs.opencv.org/4.13.0/d0/d84/tutorial_js_usage.html)
- [Emscripten pthread requirements](https://emscripten.org/docs/porting/pthreads.html)
- [Safari 16.4 OffscreenCanvas support](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)

