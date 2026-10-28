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

PDF mới dùng các trang A4 dọc (210 × 297 mm) bằng nhau. Ảnh được căn giữa trên nền trắng, phóng vừa trang mà không méo hay cắt ảnh. Tài liệu PDF đã tạo bằng bản cũ cần mở **Chỉnh sửa → Xem PDF → Lưu** để tạo lại trên A4; tệp đã chia sẻ trước đó không tự thay đổi.

Mở PDF hiển thị trình đọc toàn bộ trang ngay trong web, dùng các ảnh đầu ra theo cùng thứ tự và bố trí A4 của PDF, không cần popup hay plugin PDF native của webview. Nếu bấm Tải PDF khi chưa lưu, web lưu tài liệu trước rồi yêu cầu bấm lại để tải tệp HTTPS bằng một thao tác trực tiếp, tránh mất user activation trong webview iPhone. Chia sẻ/Lưu vào Tệp dùng PDF đã chuẩn bị sẵn trên thiết bị. Các giới hạn riêng của ứng dụng nhúng cần kiểm tra trực tiếp trên điện thoại.
