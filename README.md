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

`npm run build` tạo frontend tĩnh trong `dist/`. Proxy API trong cấu hình Vite chỉ phục vụ dev/preview; khi deploy cần cấu hình đường dẫn API trên hosting. Backend hiện dùng SQLite và file local. Cấu hình Render và Supabase sẽ được thực hiện ở bước triển khai sau.
