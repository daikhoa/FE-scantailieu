# Benchmark engine scan — bằng chứng đang tích lũy

- Cập nhật: 2026-10-13
- Trạng thái: **spike đang chạy; chưa đủ điều kiện chọn engine production**
- Dataset hiện tại: 4 fixture tổng hợp 640×480 để smoke test và 15 frame camera SmartDoc 2015 sample ở cạnh dài 960 px, tách development/holdout

## Nguyên tắc đọc kết quả

Kết quả trong tài liệu này chỉ có giá trị trong đúng môi trường và dataset được ghi lại. Fixture tổng hợp giúp kiểm tra wiring, mapping, false-crop cơ bản và khả năng tái lập; nó không đại diện cho ảnh camera thật có bóng, lóa, nhòe, nền phức tạp, giấy cong/nhăn hoặc thiết bị yếu. Không dùng các con số dưới đây để tuyên bố sản phẩm đã đạt Checkpoint B.

## Candidate A — Scanic 1.6.0 classical

### Provenance và dependency

- Package: `scanic@1.6.0`, pin exact trong `package.json`/lockfile.
- License: MIT trong package đã cài.
- Registry integrity: `sha512-p9qYL9cITvQ/BOrafsJvhm++Y8NA8GfRnwngUASqAyKUTRHqMuJzcrCuHjveHxQg29tNuEORUBDAAcigvFigPg==`.
- Package không có runtime, optional hoặc peer dependency và không có install/postinstall script.
- `npm audit --audit-level=high`: 0 vulnerability; 263 registry signature và 107 attestation được xác minh sau khi cài.
- Spike chỉ dùng classical detector. ML detector/runtime không được tải hay bật.

Kích thước artifact package tại máy kiểm thử:

| Artifact | SHA-256 | Raw | gzip | Brotli |
| --- | --- | ---: | ---: | ---: |
| `dist/scanic.js` | `4f4f494d291d8a18daf2833e6b68ac4e8f712f150331a85c1e4b3d227ef24680` | 106.590 B | 42.624 B | 36.902 B |
| `dist/scanic.umd.cjs` | `3e7d2ad666b3f5fb65c7621aa18d44f22bebc345909519624e31a954e77f8ada` | 111.735 B | 44.384 B | 38.465 B |

Hai file ML có trong tarball nhưng không thuộc đường chạy spike: `scanic-mlDetector.js` 4.645 B và `scanic-ort.wasm.min.js` 48.514 B raw. Kích thước package không phải kích thước chunk production; phải đo lại sau khi engine được nối vào entry và tree-shake bằng production build.

### Adapter và resource boundary

- Input là RGBA copy có giới hạn 8.192 px mỗi cạnh và 16 MP mỗi working frame.
- Một module Worker riêng sở hữu singleton WASM; dispose, timeout 30 giây hoặc backend failure đều terminate worker.
- Queue chỉ giữ tối đa một job chạy và một job chờ; preview scheduler sau này phải drop frame dư.
- Kết quả vendor được validate confidence, finite coordinates và quad trước khi đi qua contract chung.
- Ngưỡng spike hiện là `0,72`. Đây là heuristic được tune trên smoke set, chưa được hiệu chuẩn trên development set đủ rộng và tuyệt đối không được tune tiếp bằng holdout.
- Perspective render của Scanic không được dùng: bản 1.6.0 gọi DOM canvas trực tiếp và không đáp ứng worker/orientation/filter/dewarp contract. Dự án dùng renderer RGBA độc lập trong cùng Worker; Scanic chỉ còn phụ trách nhận diện classical.

### Perspective primitive độc lập

Đã có primitive inverse projective warp thuần RGBA, không dùng DOM và có thể chuyển vào Worker. Nó lấy kích thước từ cạnh đối diện nên giữ tỷ lệ tự nhiên của tài liệu, dùng bilinear sampling trong premultiplied-alpha space, giới hạn cả input/output theo working-buffer policy và từ chối quad sai winding thay vì âm thầm lật ảnh. Năm unit test khóa identity, crop theo continuous image-edge coordinates, tỷ lệ output, input/geometry lỗi và alpha interpolation.

Primitive đã được nối thành luồng render dùng thực tế: codec trình duyệt chỉ nhận JPEG/PNG/WebP có giới hạn 64 MiB, kiểm tra kích thước khai báo khớp bitmap đã decode, có `OffscreenCanvas` và DOM-canvas fallback cho Safari; Worker nhận RGBA theo transfer ownership, warp rồi xoay 0/90/180/270; output được encode PNG. `ScannerEngine.render()` hỗ trợ `original`, `ocr-color`, `grayscale` và `black-and-white`, tạo khóa SHA-256 bao phủ bytes nguồn/recipe/orientation/engine version và trả dewarp outcome trung thực. `perspective-only` là `not-requested`; `auto` vẫn chạy perspective nhưng báo `fallback/unavailable`, không giả là đã làm phẳng cong.

Các boundary đã có test cho input/output RGBA malformed, giới hạn tài nguyên, MIME không hỗ trợ, mismatch dimension, abort không lộ `signal.reason`, buffer transfer, thứ tự pixel sau xoay, cache-key ổn định giữa thứ tự tham số, backend failure cleanup và lifecycle. Chưa có golden output mở bằng browser thật, benchmark decode+warp+encode end-to-end hoặc so sánh CER/WER trước/sau filter; do đó luồng đã dùng được nhưng chưa được gọi là renderer production-qualified và không làm Task 7 pass.

Micro-benchmark Node 22.23.3, ba vòng identity RGBA opaque, không decode/encode và không throttling: median 16,6 ms ở 640×480 và 91,4 ms ở 1920×1080. Kết quả chỉ chứng minh vòng inverse-map không có allocation theo từng pixel và đủ khả năng tiếp tục spike; chưa đại diện iPhone/Android hoặc capture-to-editor latency.

### Smoke test Chromium thật

Môi trường: Node 22.23.3, Vite dev server local, Codex in-app Chromium, Worker + `OffscreenCanvas` + `ImageData` khả dụng. Không có request tài liệu ra ngoài origin. Chạy ba vòng sau khi siết ngưỡng; số liệu là browser `performance.now()`, không throttling và không phải device qualification.

| Fixture | Nhãn | Kết quả | Confidence | IoU | detect median 3 vòng |
| --- | --- | --- | ---: | ---: | ---: |
| flat-document | document | document | 0,9298 | 0,9631 | 37,2 ms |
| perspective-document | document | document | 0,9118 | 0,9615 | 26,1 ms |
| no-document-room | no-document | full-frame / low-confidence | n/a | n/a | 62,0 ms |
| no-document-clutter | no-document | full-frame / low-confidence | n/a | n/a | 68,0 ms |

Warm initialization median là 20,1 ms. Lần chạy đầu trước khi dependency dev-server ổn định là 49,1 ms, nên chưa được gọi là production cold-start.

Kết quả smoke sau tuning: geometry 2/2 đạt IoU ≥0,90; false crop 0/2. Trước tuning, ngưỡng 0,60 cắt nhầm `no-document-room` với confidence 0,6635 (1/2 false crop). Regression test đã khóa việc confidence 0,664 phải fallback full-frame. Đây là bằng chứng rõ rằng ngưỡng upstream mặc định không thể dùng nguyên trạng.

Không có console warning/error trong ba vòng sau tuning. Chưa đo FPS camera, p75/p95 trên workload đủ lớn, memory/WASM heap, render output, iPhone/Safari hay Android/Chrome thật.

### SmartDoc 2015 sample — baseline khóa ngưỡng

Nguồn là sample chính thức của SmartDoc 2015 Challenge 1 (CC BY 4.0), gồm video quay tài liệu bằng điện thoại và ground-truth tứ giác theo từng frame. Script tái lập chọn đều năm frame hợp lệ từ mỗi video, resize giữ tỷ lệ về cạnh dài 960 px, scale ground truth và khóa SHA-256. `datasheet001` + `letter001` tạo development 10 ảnh; `magazine001` tạo holdout 5 ảnh. Chi tiết provenance và cách tái tạo nằm trong [`tests/fixtures/smartdoc15/README.md`](../../tests/fixtures/smartdoc15/README.md).

Ngưỡng Scanic `0,72` đã được khóa từ smoke set trước khi chạy tập này và không thay đổi sau khi mở holdout. Đây là phép baseline của cấu hình hiện tại, không phải tuning bằng holdout. Chrome headless chạy bằng thời gian thật trên Windows, mỗi frame ba lần, Worker/`OffscreenCanvas`/`ImageData` khả dụng và không có request khác origin.

| Split | Tài liệu | Miss/full-frame | IoU ≥0,90 | Geometry pass rate |
| --- | ---: | ---: | ---: | ---: |
| development | 10 | 10 | 0 | 0% |
| holdout | 5 | 5 | 0 | 0% |

Cold initialization ở vòng xác nhận là 31,7 ms. Trên 45 lần detect, median 96,8 ms và p95 144,8 ms; cả 15 kết quả đều fallback `low-confidence`. Không có fixture `no-document` trong SmartDoc sample nên phép đo này không tạo được false-crop rate. Kết luận: tốc độ desktop nằm trong ngân sách preview đề xuất nhưng **cấu hình Scanic classical hiện tại fail geometry gate** và không được adopt. Chỉ được tiếp tục theo hướng `adapt` nếu có development set rộng hơn, đặc biệt thêm cảnh không có tài liệu, rồi hiệu chuẩn confidence/detector mà không nhìn holdout.

Runner tái lập là `npm run benchmark:scanic-smartdoc` khi Vite dev server local đang chạy. Runner chỉ chấp nhận URL loopback, điều khiển Chrome headless bằng DevTools local, chờ kết quả thật rồi đóng Chrome và xóa profile tạm.

## Candidate A2 — Scanic 1.6.0 ML tự lưu cùng origin

Sau khi người dùng xác nhận classical nhận diện kém trên điện thoại, detector ML của cùng phiên bản Scanic được bật làm đường chính; classical chỉ là fallback khi ML runtime không thể thực thi. `scanic-ml@0.2.0` được pin exact, MIT, không có install script và ba artifact được đưa vào production build tại `/scanic-ml/`, không gọi CDN:

| Artifact | SHA-256 | Raw |
| --- | --- | ---: |
| `doccornernet_lean.ort` | `732eb8d02d83cc63efb3f9467f01e0c458205a89b2547de3870bc6db1a80c8b3` | 1.925.824 B |
| `ort-wasm-simd-threaded.mjs` | `d6841aca121bba413020e1de9009c9e557cc8b424cc4b5d3ebfd8c5e0fec4fce` | 19.531 B |
| `ort-wasm-simd-threaded.wasm` | `8acb4d26fe0537379e83478e52b20e681035ca70a3eca45f2a147c19e1241f87` | 1.523.774 B |

ML dùng `minScore=0,50`; fallback classical vẫn giữ `minDetectionConfidence=0,72`. Smoke Chromium nhận đúng 2/2 tài liệu và giữ full-frame 2/2 cảnh không có tài liệu. SmartDoc 2015 đạt 10/10 development và 5/5 holdout ở gate IoU ≥0,90; mean IoU lần lượt 0,9779 và 0,9523, không miss/error. Cold initialization 151 ms; warm detect trên 15 ảnh có median quan sát khoảng 15–18 ms. Network gate ghi nhận 0 request khác origin.

Đây là cải thiện có kiểm chứng so với classical 0/15, nhưng chưa thay thế qualification iPhone/Android thật, camera FPS, memory dài hạn hoặc tập no-document lớn hơn.

## Candidate B — OpenCV.js 4.14.0

### Artifact chính thức và phép đo tải

Release chính thức chỉ cung cấp runtime prebuilt bên trong `opencv-docs-4.14.0.zip`, không có package runtime tối ưu riêng cho ứng dụng. File zip tải từ GitHub Release có đúng 125.891.542 B và SHA-256 `051dc998f5e550ae1077bdc98f7f7ff4527f0ab2cba6580806d73d13f2d2922b`, khớp digest release. Entry `js/bin/opencv.js` có:

| Artifact | SHA-256 | Raw | gzip | Brotli |
| --- | --- | ---: | ---: | ---: |
| official prebuilt `opencv.js` | `840050731ee0e3d8783f85226dae3e66a42ad8698d270b87072b6acdf69c2aca` | 11.059.007 B | 3.559.472 B | 2.591.300 B |

Factory Node trả về Promise sau 111 ms nhưng runtime không ready trong 60 giây nên phép thử bị dừng. Chromium local cùng artifact cũng khóa main thread và vẫn không trả kết quả sau hơn 60 giây; vì UI/CDP không phản hồi nên không thể lấy detection/memory/network record hợp lệ. Đây được tính là startup failure, không được biến thành kết quả detect thành công.

Vì vậy **official prebuilt bị reject cho production path hiện tại**: kích thước lớn hơn Scanic khoảng hai bậc và cold initialization đã vượt xa ngân sách 2 giây trước cả bước detect. Điều này chưa kết luận mọi custom build OpenCV đều không phù hợp. Một bản build export-minimal, WASM tách file có thể được đánh giá lại khi có toolchain Emscripten/CMake được pin và chạy tái lập; máy hiện tại chưa có Docker, `emcc` hoặc CMake nên không tự nhận là đã build/đo biến thể đó.

Pipeline đối chứng đã được khóa và có prototype ranking thuần qua 4 unit test: RGBA bounded input → grayscale → Gaussian 5×5 → Canny 50/150 → morphology close 3×3 → tối đa 15 contour lớn → `approxPolyDP(0,02 × perimeter)` → edge-support/geometry/area ranking → full-frame fail-safe. Harness browser giải phóng toàn bộ `cv.Mat` trong `finally`, nhưng chưa tạo được số đo detection vì runtime không ready.

Một package MIT không chính thức (`@haoking/opencvjs@3.0.0`) chỉ được đọc metadata, không cài hoặc chạy: tarball 7.758.896 B, unpacked 27.242.550 B, mang đồng thời baseline WASM 12.104.983 B và SIMD WASM 14.595.094 B. Nó không giải quyết ngân sách tải và nằm ngoài phạm vi official-only đã khóa, nên không được dùng để “lách” kết quả thất bại của candidate B.

## Việc còn thiếu trước Checkpoint B

1. Mở rộng development/holdout có quyền sử dụng rõ ràng ngoài SmartDoc sample: cảnh `no-document`, bóng, lóa, blur, nền phức tạp, tài liệu gần mép, receipt/card, chữ ký, con dấu, chữ viết tay, giấy cong và nếp gấp.
2. Nếu muốn mở lại OpenCV: build export-minimal từ source chính thức bằng toolchain pin, tách WASM và bắt runtime qua startup budget trước khi chạy detection benchmark.
3. Bổ sung golden mapping/output mở được trong browser thật và đo end-to-end decode + warp + encode; bộ lọc OCR vẫn thuộc Task 12.
4. Chạy ít nhất ba vòng trên desktop throttled, iPhone/Safari và Android/Chrome; báo cold/warm, median/p75/p95/MAD, FPS, memory proxy và lỗi.
5. Freeze tham số trên development split, rồi mới mở holdout và đưa verdict `adopt`, `adapt` hoặc `reject` cho chủ dự án duyệt.

