# Chạy web cùng backend tài khoản

Ngày 27/10/2026. Backend ở thư mục `../backendcamscanner`; xem [README backend](../../backendcamscanner/README.md) để biết thiết lập, API cho app, lưu trữ và giới hạn.

1. Từ `backendcamscanner`, chạy `.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-proxy-headers`.
2. Từ `camscanner2`, chạy `npm run dev -- --port 5173 --strictPort`.
3. Mở `http://localhost:5173`, tạo tài khoản email/mật khẩu rồi đăng nhập.
4. Chụp hoặc chọn ảnh → chỉnh trang (có thể thêm ảnh từ thư viện hoặc chụp thêm) → PDF → xem trước, đặt tên, tải hoặc Lưu vào tài khoản.
5. Về Trang chủ → chọn tài liệu đã lưu → Chỉnh sửa tài liệu → thay đổi/thêm/xoá trang → PDF → Lưu. Lần lưu này cập nhật cùng tài liệu.

Web bắt buộc đăng nhập, kể cả khu vực so sánh. Đăng ký hiện chưa xác minh email và chưa có quên mật khẩu, theo yêu cầu giai đoạn đầu. Ảnh vẫn xử lý tại thiết bị; khi lưu, ảnh nguồn, ảnh kết quả, recipe và PDF được gửi tới backend. Kho trong tài khoản là dữ liệu đã được server xác nhận; bản đang chỉnh sửa chưa bấm Lưu chưa phải bản đồng bộ.

`Application` quản lý boundary tài khoản; `AccountApplication` gọi API và kho cá nhân; `App` tiếp tục sở hữu phiên camera/chỉnh sửa và giữ ID/revision tài liệu đang mở. API client dùng `/api/v1` tương đối, cookie HttpOnly và header CSRF, có timeout/cancellation. Backend cũng có endpoint bearer token để app khác sử dụng cùng hợp đồng.

PDF dùng cùng ảnh đầu ra và thứ tự trang với màn hình xem trước, không phụ thuộc trình đọc PDF nhúng. Tệp được chuẩn bị trước khi người dùng bấm Tải PDF. Liên kết Blob giữ hiệu lực suốt màn hình; tài liệu đã lưu có đường tải riêng tư từ backend, cùng các nút Mở PDF và Chia sẻ khi được hỗ trợ. Lỗi tạo/lưu không được chuyển thành thông báo thành công.

Đã tái hiện trên môi trường Vite một lỗi nạp động `pdf-lib`: dependency bị phát hiện muộn lúc xuất PDF gây lỗi tải module và yêu cầu reload trong khi còn bản nháp. `optimizeDeps.include` chuẩn bị dependency từ lúc khởi động; `preparePdf` chặn chờ vô hạn và giải phóng timer khi huỷ. Đây là bằng chứng trên local, chưa chứng minh là nguyên nhân duy nhất của lỗi tải trên điện thoại trước đây.

Backend chấp nhận `/Annots []` rỗng mà pdf-lib tạo trên trang ảnh, vẫn từ chối annotation có nội dung. Pillow kiểm tra PNG trên handle mới sau khi đọc metadata/EXIF. Cả hai lỗi tương thích được khoá bằng kiểm thử hồi quy.

Trang QA local `http://localhost:5173/tests/browser/accounts-pdf-smoke.html` dùng tài khoản giả được tạo ngẫu nhiên, tạo JPEG/PDF thật trong trình duyệt rồi kiểm tra API. Trang này chỉ chạy trên localhost, không ghi mật khẩu/token vào source hoặc kết quả. Giới hạn đăng ký/đăng nhập vẫn có hiệu lực; nếu chạy lặp nhanh bị 429 thì chờ hết cửa sổ 5 phút. Không mở nhiều tab QA cùng lúc vì mỗi lượt tải trang tạo một tài khoản thử mới.

Để thử điện thoại cùng Wi-Fi, dùng URL Network của Vite. Camera/Web Share trên điện thoại cần HTTPS được tin cậy; xem README backend. Tải trên Android Chrome, iPhone Safari/Chrome và Google/Cốc Cốc webview vẫn cần kiểm tra trên thiết bị thật. Trình duyệt có chính sách tải riêng; khi Blob bị hạn chế, lưu vào tài khoản rồi tải từ máy chủ hoặc mở PDF bằng trình đọc của thiết bị.

Các tài liệu v1 nói không có backend hoặc ảnh không rời thiết bị là lịch sử. Luồng mới được mô tả tại đây và [đặc tả tài khoản](specs/accounts-editable-documents.md).

## Kết quả kiểm tra bản local — 27/10/2026

- FE: 77 file / 627 kiểm thử qua; ESLint, TypeScript app/SDK và production build qua. Build tiếp tục có cảnh báo ONNX Runtime về một URL được phân giải ở runtime; tài nguyên SDK vẫn được đóng gói và kiểm tra worker/đường raster native qua.
- Backend: 16 kiểm thử qua; ruff lint và format check qua. Có cảnh báo deprecation của Starlette TestClient với httpx hiện tại, không có kiểm thử lỗi.
- Trình duyệt thật: đăng ký/đăng nhập, nhập hai ảnh, mở tài liệu đã lưu, xoá trang, tạo lại PDF bằng SDK, đổi tên/lưu cùng ID, tải tệp thực xuống Downloads và mở lại sau reload đã kiểm tra. Tệp tải được pypdf kiểm tra có một trang và image XObject hợp lệ.
- Trang QA browser/API trả PASS cho đăng ký, bearer token, JPEG → PDF, lưu/mở nguồn và recipe, cập nhật cùng ID, xung đột 409, tải PDF và thu hồi phiên 401.
- Bố cục xem PDF kiểm tra tại viewport điện thoại: clientWidth/scrollWidth đều 375px. Đây là kiểm tra bố cục trên trình duyệt desktop, không thay thế thử thiết bị thật.
- Chưa xác minh camera, tải và Web Share trên Android/iPhone thật hoặc mọi webview. Chưa triển khai HTTPS/hosting, xác minh email hoặc khôi phục mật khẩu.
