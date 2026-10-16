# Đặc tả: clonecamscanner — Web scan tài liệu thành PDF tối ưu cho OCR

## 1. Trạng thái tài liệu

- Trạng thái: Đã được chủ dự án duyệt ngày 2026-10-08; sẵn sàng lập kế hoạch triển khai.
- Phạm vi: Phiên bản 1 (v1).
- Nguyên tắc: Không triển khai các câu hỏi mở hoặc giả định chưa được duyệt.

## 2. Mục tiêu

Xây dựng một web mobile-first cho phép người dùng dùng camera điện thoại hoặc máy tính bảng để chụp giấy tờ, tự phát hiện biên tài liệu, sửa phối cảnh, cố gắng làm phẳng tài liệu hơi cong/nhăn, tăng cường ảnh và xuất một PDF ảnh có chất lượng tốt cho hệ thống OCR phía sau.

Chất lượng được đánh giá theo khả năng bảo toàn và cải thiện ký tự cho OCR, không chỉ theo cảm nhận hình ảnh. Ứng dụng không được dùng xử lý tạo sinh có nguy cơ tự sửa, thêm hoặc xóa nội dung tài liệu.

Tên dự án và bản test là **clonecamscanner**. Đây là tên nội bộ/tạm thời; không dùng logo, tài sản hoặc tuyên bố liên kết với sản phẩm CamScanner. Trước khi phát hành công khai chính thức, tên thương hiệu cần được công ty rà soát về pháp lý và nhận diện riêng.

### Người dùng và nền tảng

- Nhân viên sử dụng chủ yếu trên điện thoại và máy tính bảng.
- Hỗ trợ tối thiểu: iOS/iPadOS 16+ và Android 10+.
- Trình duyệt ưu tiên kiểm thử: Safari trên iPhone/iPad và Chrome trên Android.
- Giao diện phải dùng tốt ở màn hình dọc, ngang, điện thoại nhỏ và tablet.

### Loại tài liệu v1

- Tài liệu văn phòng A4/A5, biểu mẫu và hợp đồng.
- Hóa đơn, biên lai và giấy tờ có tỷ lệ dài.
- Thẻ ID.
- Trang vở và tài liệu có chữ viết tay.
- Nội dung tiếng Việt và tiếng Anh.
- Phải bảo toàn chữ viết tay, chữ ký, con dấu, đường bảng và hình minh họa.

## 3. Phạm vi chức năng

### 3.1. Mở camera

- Chỉ yêu cầu quyền camera sau thao tác rõ ràng của người dùng.
- Ưu tiên camera sau (`environment`) và độ phân giải cao mà thiết bị hỗ trợ ổn định.
- Hiển thị lỗi có hướng dẫn khi quyền bị từ chối, camera đang bị ứng dụng khác sử dụng hoặc không tồn tại.
- Khi không thể dùng camera, cho phép nhập ảnh từ thư viện thiết bị.
- Dừng và giải phóng toàn bộ camera track khi rời màn hình scan, chuyển camera hoặc đóng phiên.

### 3.2. Phát hiện tài liệu trực tiếp

- Phân tích bản sao khung hình đã giảm kích thước trong Web Worker; không xử lý ảnh camera đầy đủ trên main thread.
- Khi không phát hiện được tài liệu đủ tin cậy, viền xanh bao vùng xem camera và trạng thái chụp là `full-frame`.
- Khi phát hiện được tài liệu, viền xanh trở thành tứ giác bám theo bốn cạnh tài liệu.
- Làm ổn định tọa độ qua nhiều frame để khung không rung hoặc nhảy giữa các contour.
- Hiển thị hướng dẫn không xâm lấn như: thiếu sáng, ảnh mờ, tài liệu chưa đủ trong khung, góc chụp quá xiên hoặc giữ máy chắc hơn.
- Không tự động chụp. Người dùng luôn chủ động bấm nút chụp.

### 3.3. Chụp và quyết định cắt

- Chế độ zero-lag ưu tiên luồng preview độ phân giải cao để không phụ thuộc độ trễ của still-photo API.
- Với chế độ chụp tức thời, pixel của frame preview độ phân giải cao phải được sao chép đồng bộ ngay trong lượt bấm và trước lần `await` đầu tiên; mã hóa được phép hoàn tất bất đồng bộ nhưng chuyển động sau khi bấm không được làm thay đổi ảnh đã chốt.
- Sau khi chụp, chạy lại phát hiện trên ảnh gốc hoặc ảnh được downscale có ánh xạ tọa độ chính xác về ảnh gốc.
- Không dùng trực tiếp bốn góc từ preview để cắt ảnh cuối.
- Nếu độ tin cậy không đạt ngưỡng, giữ nguyên toàn khung ảnh và không âm thầm crop sai.
- Luôn lưu ảnh gốc bất biến trước mọi bước chỉnh sửa.

### 3.4. Chỉnh biên thủ công

- Sau khi chụp tài liệu, hiển thị bốn điểm góc có thể kéo bằng cảm ứng.
- Vùng chạm phải đủ lớn; điểm chính xác vẫn được ánh xạ về pixel ảnh gốc.
- Có kính lúp tại góc đang kéo để đặt điểm chính xác.
- Cho phép đặt lại theo kết quả tự động hoặc theo khung mặc định.
- Không cho phép tứ giác tự cắt nhau, có diện tích quá nhỏ hoặc vượt ngoài ảnh.

### 3.5. Sửa hình học

- Tài liệu phẳng nhưng chụp nghiêng: dùng biến đổi phối cảnh để tạo ảnh nhìn trực diện.
- Tài liệu hơi cong hoặc có nếp gấp: pipeline dewarp nâng cao chạy sau khi chụp và chỉ dùng mô hình có giấy phép phù hợp.
- Dewarp nâng cao được bật mặc định. Hệ thống tự áp dụng khi đánh giá hình học cho thấy tài liệu có độ cong cần chỉnh; không ép chạy trên tài liệu đã phẳng nếu bước xử lý có nguy cơ giảm chất lượng hoặc chỉ làm tăng thời gian vô ích.
- Người dùng có thể so sánh với kết quả chỉ sửa phối cảnh và quay lại kết quả đó nếu dewarp làm sai hình học hoặc chữ.
- UVDoc là ứng viên để thử nghiệm, chưa phải dependency được duyệt cho production cho đến khi vượt qua kiểm tra license, chuyển đổi mô hình, hiệu năng và chất lượng trên thiết bị thật.
- Dewarp nâng cao phải có timeout, hủy được và chạy ngoài main thread.
- Khi dewarp không khả dụng, thiếu RAM hoặc thất bại, giữ kết quả sửa phối cảnh thông thường và thông báo trung thực; không báo thành công giả.
- Không dùng inpainting hoặc mô hình tạo sinh để đoán lại vùng chữ bị che, cháy sáng hoặc mất dữ liệu.

### 3.6. Tăng cường ảnh

Cung cấp ít nhất bốn chế độ, luôn có bản xem trước và không ghi đè ảnh gốc:

1. **Gốc**: chỉ áp dụng hình học đã xác nhận.
2. **Màu tăng cường cho OCR**: cân bằng nền/ánh sáng, tăng tương phản cục bộ và làm nét có giới hạn.
3. **Xám**: bảo toàn nét mảnh và dải xám.
4. **Đen trắng**: threshold thích nghi, dành cho tài liệu phù hợp; không phải mặc định cho mọi trang.

Các phép tăng cường phải giới hạn nhiễu halo, không làm dày/mỏng ký tự quá mức, không xóa con dấu màu, chữ ký, đường bảng hoặc chữ viết tay. Nếu phát hiện lóa cháy sáng hay mờ nặng không thể phục hồi, đề nghị người dùng chụp lại.

### 3.7. Phiên nhiều trang

- Một luồng chung hỗ trợ tài liệu một trang và nhiều trang.
- Sau mỗi lần chụp, thêm thumbnail và cho phép tiếp tục chụp.
- Cho phép xem, chỉnh biên, đổi filter, xoay, xóa, chụp lại và sắp xếp trang.
- Có nút Hoàn tất rõ ràng; không tự kết thúc phiên.
- Tự lưu bản nháp sau mỗi thay đổi bền vững.

### 3.8. Thư viện cục bộ

- Lưu tài liệu, trang, ảnh gốc và công thức chỉnh sửa trong IndexedDB hoặc lớp lưu trữ tương đương trên thiết bị.
- Cho phép mở lại, đổi tên, tiếp tục chỉnh sửa và xóa.
- Không có tài khoản, backend, upload hoặc đồng bộ cloud trong v1.
- Hiển thị và xử lý rõ ràng khi trình duyệt thiếu dung lượng, xóa dữ liệu site hoặc ở chế độ riêng tư.
- Ứng dụng không tự đặt giới hạn cứng về số trang, dung lượng một tài liệu hoặc tổng dung lượng thư viện. Giới hạn thực tế là dung lượng/quota mà hệ điều hành và trình duyệt cấp cho origin.
- Hiển thị dung lượng ước tính/cảnh báo sớm khi có thể và xử lý `QuotaExceededError` mà không làm mất tài liệu đã lưu trước đó.
- Khi xóa tài liệu, xóa các blob và thumbnail liên quan theo một giao dịch logic, không để dữ liệu mồ côi.

### 3.9. Xuất PDF

- Xuất một PDF ảnh cho một hoặc nhiều trang, đúng thứ tự người dùng đã chọn.
- Tự xoay trang đúng chiều đã chỉnh.
- Mỗi trang PDF giữ tỷ lệ tự nhiên của chính tài liệu sau khi làm phẳng: A4 giữ tỷ lệ A4, trang vở giữ tỷ lệ trang vở, hóa đơn dài giữ tỷ lệ hóa đơn. Không kéo giãn và không ép mọi trang lên cùng khổ A4/Letter.
- Kích thước vật lý của trang PDF được suy ra nhất quán từ tỷ lệ và độ phân giải ảnh; PDF nhiều trang được phép có kích thước trang khác nhau.
- Giữ độ phân giải hữu ích cho OCR; tránh encode JPEG lặp lại qua nhiều thế hệ.
- PDF v1 không có lớp OCR text và không tuyên bố là PDF searchable.
- Cho phép đặt tên tệp hợp lệ trước khi tải/chia sẻ.
- Metadata PDF không được chứa dữ liệu nhạy cảm không cần thiết.

## 4. Ngoài phạm vi v1

- OCR tích hợp trong sản phẩm và PDF có lớp text tìm kiếm được.
- Tài khoản, đăng nhập, phân quyền và đồng bộ cloud.
- Backend lưu trữ hoặc xử lý ảnh.
- Tự động chụp.
- Cam kết hoạt động hoàn toàn offline.
- Xóa ngón tay, vật che hoặc tái tạo phần chữ bị mất bằng AI tạo sinh.
- Làm phẳng hoàn hảo tài liệu bị vò nặng, gập chồng, mất nét hoặc bị che khuất.
- Sao chép logo, tài sản, mã nguồn hoặc nhận diện giao diện của CamScanner.

## 5. Kiến trúc và công nghệ

### 5.1. Stack đề xuất

- Runtime phát triển: Node.js 22 LTS.
- UI: React + TypeScript strict + Vite; phiên bản cụ thể được khóa trong lockfile khi bootstrap dự án.
- Camera: MediaDevices/getUserMedia, ImageCapture khi có và fallback dựa trên canvas.
- Lập lịch frame: `requestVideoFrameCallback` khi có, fallback an toàn khi trình duyệt thiếu API.
- Xử lý nền: Web Worker + transferable buffers/ImageBitmap + OffscreenCanvas khi có.
- Engine biên/phối cảnh: đánh giá Scanic (MIT) và pipeline OpenCV.js (Apache-2.0) qua một spike có benchmark; không chọn chỉ dựa vào README hoặc số sao.
- Dewarp: đánh giá UVDoc với runtime on-device; chỉ tích hợp sau quality/performance/license gate.
- ML runtime nếu cần: ONNX Runtime Web, self-host asset; WebGPU là tăng tốc tùy chọn, WASM là fallback.
- PDF: `pdf-lib` (MIT), sau khi audit phiên bản và dependency.
- Lưu trữ: IndexedDB qua một adapter nhỏ; ưu tiên `idb` (ISC) nếu giúp giảm lỗi giao dịch.
- Kiểm thử: Vitest, React Testing Library và Playwright.
- Lint/format: ESLint và Prettier.

Không dùng CDN `latest` hoặc tải model/runtime từ bên thứ ba trong production. Mọi asset runtime phải được khóa phiên bản và self-host từ domain của công ty.

### 5.2. Ranh giới module

```text
src/
  app/                 Khởi tạo ứng dụng, routing và error boundary
  features/camera/     Vòng đời camera, constraints và capture
  features/scanner/    Overlay, phiên scan, chỉnh góc và trang
  features/library/    Danh sách tài liệu và thao tác lưu cục bộ
  features/export/     Tạo, đặt tên và chia sẻ/tải PDF
  imaging/contracts/   Hợp đồng engine độc lập với thư viện bên thứ ba
  imaging/worker/      Worker protocol, detection, warp, dewarp, filter
  imaging/geometry/    Tọa độ, scale, rotation và validation thuần TypeScript
  storage/             IndexedDB schema, migration và quota handling
  shared/              UI primitive, kiểu dùng chung và tiện ích nhỏ
tests/
  fixtures/            Ảnh kiểm thử có nguồn gốc/quyền sử dụng rõ ràng
  golden/              Kết quả mong đợi và metadata bốn góc
e2e/                   Luồng trình duyệt và camera mock
docs/                  Đặc tả, quyết định kiến trúc và hướng dẫn kiểm thử thiết bị
```

### 5.3. Hợp đồng engine

Engine không được rò rỉ kiểu DOM hoặc kiểu riêng của OpenCV/Scanic ra feature/UI.

```ts
type DocumentCorners = readonly [Point, Point, Point, Point];

interface ScannerEngine {
  initialize(signal: AbortSignal): Promise<void>;
  detect(frame: ImageBitmap, signal: AbortSignal): Promise<DetectionResult>;
  render(request: RenderPageRequest, signal: AbortSignal): Promise<Blob>;
  dispose(): Promise<void>;
}
```

- Tất cả operation dài phải nhận `AbortSignal`.
- Tài nguyên WASM, bitmap, canvas và media track phải được giải phóng trên success, failure và cancellation.
- UI chỉ biết `DetectionResult`, `EditRecipe` và `PageAsset`; không biết thư viện nào đang xử lý.

### 5.4. Mô hình dữ liệu

- `Document`: id, tên, ngày tạo/cập nhật, thứ tự page.
- `PageAsset`: id, original blob, thumbnail, kích thước, orientation và trạng thái xử lý.
- `EditRecipe`: bốn góc, rotation, dewarp mode/version, filter và tham số đã xác nhận.
- `RenderedVariant`: cache có thể tái tạo, gắn với hash/version của `EditRecipe`.

Ảnh gốc là immutable. Cache kết quả có thể xóa và tái tạo; ảnh gốc và edit recipe là dữ liệu nguồn.

## 6. Hiệu năng và khả năng phục hồi

- Detection preview dùng frame giảm kích thước và có backpressure: không xếp hàng vô hạn nếu worker chưa xử lý xong.
- Mục tiêu overlay cập nhật 5–10 lần/giây mà preview vẫn đạt tối thiểu 24 FPS trên thiết bị mục tiêu.
- Mục tiêu từ bấm chụp đến màn hình chỉnh sửa đối với tài liệu phẳng: p75 không quá 2 giây trên thiết bị kiểm thử đại diện.
- Dewarp nâng cao có progress/cancel; mục tiêu ban đầu p75 không quá 8 giây, được xác nhận hoặc điều chỉnh sau spike thiết bị thật.
- Một tài liệu 20 trang phải có thể chụp, chỉnh và xuất mà không crash/reload tab trên ma trận thiết bị nghiệm thu.
- Không giữ đồng thời bitmap độ phân giải đầy đủ của mọi trang trong RAM.
- Phục hồi bản nháp sau reload hoặc tab bị hệ điều hành thu hồi, trong giới hạn dữ liệu trình duyệt còn tồn tại.

## 7. Chiến lược kiểm thử

### 7.1. Unit

- Sắp xếp bốn góc, scale giữa preview và ảnh gốc, rotation và kích thước đầu ra.
- Validation tứ giác, điểm ngoài biên và trường hợp tự cắt.
- Smoothing/stability của overlay và state machine camera.
- Edit recipe, cache key, document/page ordering và file-name sanitation.
- PDF page sizing, orientation và metadata.

### 7.2. Regression ảnh/golden dataset

Bộ ảnh phải có quyền sử dụng nội bộ rõ ràng và bao phủ:

- Không có tài liệu.
- Giấy trắng trên nền sáng; giấy màu trên nền rối.
- Thiếu một cạnh/góc hoặc tài liệu sát biên ảnh.
- Góc phối cảnh mạnh.
- Tối, bóng, lóa, rung và mất nét.
- Nếp gấp, cong một chiều và gợn nhẹ.
- Hóa đơn dài, thẻ ID, bảng, con dấu, chữ ký và chữ viết tay.
- Tiếng Việt có dấu, tiếng Anh và cỡ chữ nhỏ.

Theo dõi ít nhất corner error/IoU, tỷ lệ false crop, thời gian và bộ nhớ. Chạy OCR trong test harness để đo CER/WER trước và sau xử lý; OCR test harness không trở thành tính năng production.

### 7.3. Mục tiêu chất lượng ban đầu

Các mục tiêu này là ngưỡng đề xuất để chủ dự án duyệt, sau đó khóa lại khi có bộ dữ liệu thật:

- Không crop trong 100% ảnh được gắn nhãn `no-document` khi confidence dưới ngưỡng.
- Với tài liệu phẳng đủ bốn cạnh và điều kiện hợp lý: ít nhất 90% mẫu có quad IoU >= 0,90 so với nhãn.
- Default enhancement không làm CER xấu đi quá 5% tương đối trên ít nhất 95% mẫu hợp lệ.
- Trên tập mẫu degraded (bóng/nền không đều/cong nhẹ), mục tiêu median CER giảm ít nhất 10% tương đối so với ảnh crop nhưng chưa enhance.
- Không mất chữ ký, con dấu hoặc đường bảng trong kiểm tra golden dành cho preset mặc định.

### 7.4. Integration và E2E

- Quyền camera: cấp, từ chối, thu hồi và camera bị bận.
- Chuyển background/foreground, xoay màn hình và resize.
- Camera không hỗ trợ ImageCapture/OffscreenCanvas.
- Chụp một trang, nhiều trang, chỉnh, reorder, autosave, reload, mở lại và xuất.
- IndexedDB quota/error và thao tác xóa không để orphan.
- Worker init failure, WASM/model fetch failure, timeout và cancellation.
- PDF mở được bằng Safari, Chrome và một trình đọc PDF độc lập.

### 7.5. Ma trận thiết bị thật

Ít nhất một thiết bị cho mỗi nhóm trước khi nghiệm thu:

- iPhone chạy iOS 16 (mức tối thiểu).
- iPhone chạy iOS hiện hành.
- iPad chạy iPadOS 16 hoặc gần mức tối thiểu.
- Android 10 máy RAM thấp/trung bình.
- Android hiện hành máy tầm trung.

Không tuyên bố tương thích chỉ dựa trên emulator hoặc desktop responsive mode.

## 8. Lệnh dự án dự kiến

Các lệnh này trở thành hợp đồng sau khi bootstrap và phải tồn tại trong `package.json`:

```bash
npm install
npm run dev -- --host 0.0.0.0
npm run build
npm run typecheck
npm run lint
npm run test
npm run test:coverage
npm run test:e2e
```

## 9. Chuẩn mã nguồn

- TypeScript strict; không dùng `any` để bỏ qua lỗi kiểu.
- Component chỉ xử lý hiển thị/tương tác; hình học, xử lý ảnh, lưu trữ và PDF nằm ngoài component.
- Trạng thái bất hợp lệ phải được biểu diễn rõ bằng union/enum thay vì nhiều boolean chồng chéo.
- Hàm thuần cho hình học và edit recipe; side effect nằm sau interface.
- Không log blob ảnh, nội dung tài liệu, đường dẫn nhạy cảm hoặc dữ liệu cá nhân.
- Comment giải thích nguyên nhân/giới hạn, không lặp lại điều code đã nói.
- Mọi thư viện và model phải có version, license và nguồn gốc ghi trong dependency inventory.

## 10. Ranh giới thực hiện

### Luôn làm

- Bảo toàn ảnh gốc và có fallback không phá dữ liệu.
- Xử lý ảnh trên thiết bị, giải phóng tài nguyên và hỗ trợ cancellation.
- Thêm test cho hành vi, lỗi và regression ảnh mới.
- Kiểm thử trên thiết bị thật cho thay đổi camera/worker/WASM.
- Chạy typecheck, lint, test và build trước khi bàn giao.
- Cập nhật đặc tả/ADR trước khi thay đổi hợp đồng kiến trúc.

### Hỏi trước

- Thêm dependency hoặc model mới.
- Đổi framework, engine scan hoặc định dạng dữ liệu lưu trữ.
- Thêm backend, upload, analytics, telemetry hoặc crash reporting có dữ liệu bên ngoài thiết bị.
- Thay đổi browser/OS tối thiểu.
- Thêm OCR, auto-capture, cloud sync hoặc offline guarantee.
- Thay đổi mặc định filter/dewarp có thể ảnh hưởng nội dung tài liệu.

### Không bao giờ làm

- Gửi ảnh/tài liệu ra khỏi thiết bị trong v1.
- Dùng dependency không rõ license, phí ẩn, trial hoặc AGPL trong sản phẩm đóng.
- Ghi secret/license key vào repository.
- Báo xử lý thành công khi engine đã fallback/thất bại mà không thông báo.
- Xóa ảnh gốc sau khi tạo bản đã xử lý.
- Làm yếu/bỏ qua test chỉ để build xanh.

## 11. Tiêu chí hoàn thành v1

- Người dùng hoàn thành được luồng camera/import -> detect/full-frame -> chỉnh -> enhance -> nhiều trang -> PDF trên toàn bộ ma trận thiết bị.
- Không có upload ảnh và có thể chứng minh bằng kiểm tra network trong E2E/manual QA.
- Có local library và autosave hoạt động trong giới hạn storage của trình duyệt.
- Các mục tiêu chất lượng/hiệu năng đã được đo trên dataset và thiết bị đại diện; sai lệch được ghi rõ, không che giấu.
- PDF mở được, đúng thứ tự/hướng, không có lớp OCR giả và giữ chất lượng phù hợp cho OCR phía sau.
- Dependency/license inventory không có SDK trả phí, trial, AGPL hoặc nguồn không rõ.
- Unit, integration, E2E, typecheck, lint và production build đều qua.
- Có hướng dẫn triển khai HTTPS, kiểm thử thiết bị và giới hạn đã biết.
- Có bản triển khai HTTPS tạm thời để chủ dự án kiểm thử trên điện thoại/tablet thật; lựa chọn hosting production được quyết định sau khi chất lượng scan đã đạt yêu cầu.

## 12. Quyết định sản phẩm đã chốt

1. PDF giữ tỷ lệ tự nhiên của từng tài liệu; không ép A4/Letter và không kéo méo.
2. Ứng dụng không đặt giới hạn cứng; dung lượng thực tế phụ thuộc quota của thiết bị/trình duyệt và phải được xử lý an toàn.
3. Dewarp nâng cao bật mặc định và tự áp dụng khi cần, có đường quay lại kết quả chỉ sửa phối cảnh.
4. Tên dự án/bản test là `clonecamscanner`; chưa có bộ nhận diện thương hiệu chính thức.
5. Khi hoàn thành và qua kiểm thử nội bộ, tạo bản triển khai HTTPS tạm thời để kiểm thử trên điện thoại. Hosting/domain production được quyết định sau.

