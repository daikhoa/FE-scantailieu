# Web scan tài liệu

Frontend React + TypeScript + Vite, dùng SDK `@docscan/browser` và lõi C++/WebAssembly để xử lý ảnh trên thiết bị. Người dùng đăng ký bằng email/mật khẩu, đăng nhập, chỉnh ảnh, xem trước PDF và lưu tài liệu để mở sửa lại.

## Các repository

- [Frontend](https://github.com/daikhoa/FE-scantailieu)
- [Backend Python/FastAPI](https://github.com/daikhoa/BE-scantailieu)
- [Thư viện C++ và browser SDK](https://github.com/daikhoa/thuvien-scantailieu)

## Chạy frontend

Cần Node.js 22.18 trở lên trong nhánh 22 và npm 10.9 trở lên trong nhánh 10.

```powershell
npm ci
npm run dev -- --port 5173 --strictPort
```

Mở `http://localhost:5173`. Chạy backend trên `127.0.0.1:8000` theo README trong repo backend; Vite chuyển tiếp `/api` đến backend. Gói SDK đã có trong `vendor/`, không cần build lại thư viện để chạy frontend.

Luồng tài khoản, lưu và mở sửa tài liệu, giới hạn kiểm thử điện thoại: [tài liệu local](docs/accounts-and-local-backend.md). Đăng ký hiện dùng ngay, xác minh email và khôi phục mật khẩu chưa triển khai.

## Kiểm tra

```powershell
npm test
npm run lint
npm run build
npm run library:test
```

`npm run build` tạo frontend tĩnh trong `dist/`. Bản Render build FE từ commit ghim trong Dockerfile BE và phục vụ web cùng `/api/v1`; tài khoản và tệp lưu ở PostgreSQL/Storage riêng tư của Supabase. Local vẫn dùng SQLite. Sau khi cập nhật FE, đổi SHA `DOCSCAN_FRONTEND_REF` trong Dockerfile BE rồi push BE để Render nhận bản mới.

## PDF trên điện thoại

PDF mới dùng các trang A4 dọc (210 × 297 mm) bằng nhau. Ảnh được căn giữa trên nền trắng, phóng vừa trang mà không méo hay cắt ảnh. Tài liệu PDF đã tạo bằng bản cũ cần mở **Chỉnh sửa → PDF** để tạo/lưu lại trên A4; tệp đã chia sẻ trước đó không tự thay đổi.

Luồng chính: chỉnh ảnh → bấm **PDF** → tạo PDF và chờ API lưu thành công → mở thẳng trang đọc toàn bộ PDF. Trang này có Chỉnh sửa, Tải PDF, Chia sẻ và quay lại kho tài liệu; không có trang xem trước hoặc nút Mở PDF trung gian. Tài liệu mở lại từ trang chủ dùng cùng trang đọc. Các trang hiển thị theo thứ tự và bố trí A4 của PDF, không cần plugin PDF native của webview.

Trong khi tạo/lưu, các thao tác thay đổi ảnh bị khóa. Nếu lưu lỗi, giữ nguyên ảnh chỉnh sửa, hiện thông báo và cho bấm PDF thử lại. Bản PDF được giữ để retry sử dụng cùng idempotency receipt, tránh tạo trùng khi máy chủ đã lưu nhưng phản hồi bị mất. Quay lại sửa rồi bấm PDF sẽ cập nhật cùng tài liệu; mở lại PDF không có thay đổi không tạo thêm phiên bản. Chia sẻ/Lưu vào Tệp dùng PDF đã chuẩn bị sẵn trên thiết bị. Các giới hạn riêng của ứng dụng nhúng cần kiểm tra trực tiếp trên điện thoại.

Bấm một tài liệu ở trang chủ sẽ vào ngay màn hình tài liệu, có trạng thái đang mở, quay lại và thử lại khi mất kết nối. Chỉ metadata và ảnh trang đang xem được lấy để hiển thị; không tải toàn bộ PDF trước khi mở. Nút Tải PDF dùng liên kết tệp đã lưu, nên có thể tải sau khi đăng nhập lại mà không chụp/tạo lại. Với tài liệu đã lưu, Chuẩn bị chia sẻ PDF mới lấy tệp vào thiết bị; bấm Chia sẻ sau đó để giữ thao tác trực tiếp theo yêu cầu của iPhone.
