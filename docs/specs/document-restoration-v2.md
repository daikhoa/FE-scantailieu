# Đặc tả: phục hồi ảnh tài liệu chất lượng cao v2

## Trạng thái và quyết định đã duyệt

- Chủ dự án đã duyệt triển khai ngày 2026-10-16 sau khi xem pipeline APK và chấp nhận hướng router chất lượng + dự đoán trường sáng + model chuyên biệt.
- Slice đầu tiên chạy hoàn toàn trên thiết bị và không upload ảnh.
- Neural restoration/dewarp là tầng tùy chọn tiếp theo; chỉ bật mặc định sau khi vượt quality, privacy, license và performance gate.

## Mục tiêu

Ảnh OCR màu mặc định và PDF phải giữ chi tiết từ ảnh gốc, làm phẳng nền/bóng mà không xóa chữ mờ, chữ ký, con dấu, đường bảng hoặc màu tài liệu. Pipeline phải có cấu trúc giống hành vi đã quan sát trong APK: phân tích khuyết tật, chỉ chạy bước cần thiết, phục hồi ánh sáng trước, tăng chi tiết sau và encode đúng một lần.

## Phạm vi

### Slice 1 — on-device quality router và trường sáng

- Phân tích ảnh đã sửa phối cảnh bằng mẫu điểm có giới hạn để phân loại gradient ánh sáng, clipping, độ chi tiết và mức nội dung màu.
- Dùng bản đồ nền bền vững với chữ đậm thay cho box mean thuần khi cần khử bóng.
- Không làm sáng trang đồng đều hoặc ảnh màu/photo-heavy một cách hung hăng.
- OCR color, grayscale và black-and-white dùng chung quyết định chất lượng nhưng giữ chính sách đầu ra riêng.
- Mọi xử lý vẫn ở worker khi trình duyệt hỗ trợ; fallback main thread giữ cùng kết quả.

### Slice 2 — model ONNX cục bộ trong trình duyệt

- Classifier multi-label nhỏ được tải sớm và chạy bằng ONNX Runtime Web trong worker.
- UVDoc và RT-Focuser chỉ được tải lười khi classifier chọn `dewarp` hoặc `deblur`.
- Model chuyên biệt chạy trên đầu vào có giới hạn để giữ độ trễ tương tác; kết quả cuối được render lại
  ở kích thước ảnh scan để PDF không mất pixel budget.
- Ánh sáng, màu, tương phản và sharpen dùng WebGPU compute khi có; Canvas là fallback trung thực.
- Toàn bộ ảnh và suy luận ở trình duyệt, không có REST API hay backend upload.

### Slice 3 — quality gate và PDF

- So sánh cùng ảnh đầu vào giữa original crop, classical v2, neural candidate và APK tham chiếu.
- Đo OCR CER/WER, độ đều nền, clipping, thẳng dòng, sai màu và thời gian riêng biệt.
- PDF nhúng trực tiếp rendered variant cuối; không dùng thumbnail và không encode lại nếu định dạng đã được hỗ trợ.

## Tiêu chí nghiệm thu

- Bóng tổng hợp mượt giảm chênh lệch nền ít nhất 60% và tương phản chữ không giảm.
- Trang đồng đều không bị kéo trắng; vùng màu bão hòa vẫn giữ phân tách màu.
- Router không yêu cầu buffer ảnh thứ hai kích thước full-frame và thời gian là O(pixel).
- Ảnh/PDF giữ đúng kích thước pixel của kết quả perspective/restoration trong giới hạn 8.192 px và 16,7 MP hiện tại.
- Failure/cancel/model-unavailable luôn fallback về kết quả perspective/classical, không báo model đã áp dụng.
- Không tuyên bố ngang CamScanner trước khi có paired dataset và quality gate đạt.

## Công nghệ và lệnh

- React 19, TypeScript 6 strict, Vite 7, Vitest 4, Scanic/Scanic ML và ONNX Runtime Web 1.27.
- Focused test: `npm test -- --run <test-files>`.
- Full verification: `npm test -- --run --testTimeout 15000`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`.

## Cấu trúc và chuẩn mã

- `src/imaging/analysis/`: phân tích chất lượng thuần TypeScript, không DOM/vendor type.
- `src/imaging/rendering/`: ước lượng trường sáng và áp filter trên buffer do worker sở hữu.
- Feature/UI chỉ chọn preset và hiển thị trạng thái; không chứa thuật toán ảnh.
- Không log pixel, blob, tên tài liệu hoặc output model.

## Ranh giới

- Luôn: giữ original bất biến, bounded input, cancellation, fallback trung thực, test trước code.
- Cần quality gate bằng ảnh điện thoại thật trước khi xem classifier bootstrap là production-ready.
- Không: mô hình tạo sinh/inpainting, tải model từ CDN `latest`, giữ ảnh trên server, hoặc tuyên bố phục hồi dữ liệu đã mất.

## Quyết định FE-only WebGPU và classifier (cập nhật 2026-10-21)

- Người dùng chốt chỉ xử lý ở frontend; không còn endpoint, cấu hình backend hay nhánh upload ảnh.
- Nhấn chụp lấy RGBA trực tiếp từ video; trang xuất hiện ngay trong batch và classical crop/filter chạy
  nền, không encode PNG rồi decode lại.
- Classifier multi-label dự đoán `shadow`, `curved`, `blur`, `moire`, `finger`, `low_contrast` và
  `color_document`; rule router kết hợp xác suất với bằng chứng ảnh cổ điển trước khi chọn stage.
- Stage có thứ tự ổn định: dewarp → deshadow → deblur → appearance. `finger` và `moire` hiện tạo
  cảnh báo chụp lại/không hỗ trợ thay vì bịa nội dung hoặc âm thầm báo đã sửa.
- Nếu Worker/model lỗi, trang giữ nguyên biến thể perspective/classical đã hoàn tất và UI báo fallback.
- Original/crop/recipe không bị model cục bộ sửa; chỉ rendered variant được thay trong nền.
- Fine-tune dùng manifest có provenance/license, group-aware split để ngăn cùng một tài liệu lọt sang
  nhiều split, MobileNetV3 Small pretrained, BCE multi-label và export ONNX. Không checkpoint nào được
  coi là production nếu thiếu holdout thật và paired quality gate.
- Với `finger`, nếu vật che nội dung thì không được inpaint/hallucinate; sản phẩm phải yêu cầu chụp lại.

