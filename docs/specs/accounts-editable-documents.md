# Tài khoản và kho tài liệu có thể chỉnh sửa

Ngày: 27/10/2026. Trạng thái: triển khai theo nghiệp vụ người dùng; cập nhật yêu cầu bỏ xác minh email ngày 27/10/2026. Người dùng giao các lựa chọn kỹ thuật cho người triển khai.

## 1. Mục tiêu và yêu cầu đã xác nhận

- Bắt buộc đăng nhập trước khi dùng các chức năng tài liệu trên web.
- Đăng ký bằng email và mật khẩu, dùng được ngay. Xác minh email và quên mật khẩu để giai đoạn sau; không đăng nhập Google.
- Chụp/chọn ảnh, chỉnh sửa, xem PDF trước khi tải hoặc lưu vào tài khoản.
- Đăng nhập lại có thể xem PDF đã lưu; bấm Chỉnh sửa để mở lại các trang, sửa ảnh bằng công cụ hiện có, thêm/xoá trang rồi lưu lại chính tài liệu đó.
- Chạy backend trên máy phát triển trước. Triển khai hosting là giai đoạn sau.
- Điều tra lỗi trên điện thoại: bấm tải PDF thì xoay chờ rồi kết thúc mà không có tệp tải xuống. Chưa xác định hệ điều hành, ứng dụng trình duyệt và nguyên nhân.

## 2. Hành vi triển khai

### Đăng ký và đăng nhập

1. Nhập email và mật khẩu; backend kiểm tra đầu vào, băm mật khẩu và tạo tài khoản ngay.
2. Đăng nhập bằng email và mật khẩu. Web dùng cookie HttpOnly; app tương lai có endpoint cấp bearer token qua cùng dịch vụ phiên đăng nhập.
3. Đăng xuất thu hồi phiên ở backend. Mọi API tài liệu yêu cầu xác thực và kiểm tra chủ sở hữu.
4. Chưa gửi email, chưa thêm SMTP vào bản này.

### Tạo, xem và sửa tài liệu

1. Đăng nhập thành công mở Tài liệu của tôi, có trạng thái tải, rỗng và lỗi/thử lại.
2. Chụp/chọn ảnh và chỉnh sửa dùng pipeline SDK hiện có trên thiết bị.
3. Hoàn tất chỉnh sửa chuyển sang màn hình xem trước PDF. Có Quay lại chỉnh sửa, tên tài liệu, Tải PDF và Lưu.
4. Bản xem trước và tệp tải phải cùng nội dung và thứ tự trang. Cách hiển thị cần hoạt động trên điện thoại, không chỉ dựa vào trình xem PDF nhúng của desktop.
5. Chỉ báo đã lưu sau khi backend xác nhận. Quay lại kho có tài liệu vừa lưu; tải lại trang hoặc đăng nhập lại vẫn mở được.
6. Mở tài liệu đã lưu để xem PDF; Chỉnh sửa nạp lại các trang và công thức chỉnh sửa. Giữ thứ tự đã lưu; cho thêm/xoá và dùng lại các công cụ cắt, xoay, bộ lọc hiện có.
7. Lưu chỉnh sửa cập nhật chính tài liệu đang mở, không tự tạo thêm bản sao. PDF mới được tạo từ toàn bộ danh sách trang hiện tại.
8. Bản đã lưu chỉ được thay thế khi dữ liệu phiên bản mới hoàn chỉnh. Lỗi upload, tạo PDF hoặc ghi dữ liệu giữ nguyên phiên bản đã lưu trước đó và cho thử lại.
9. Dùng phiên bản tài liệu để phát hiện sửa đồng thời; không âm thầm ghi đè thay đổi mới từ phiên khác.
10. Bản đầu lưu khi người dùng bấm Lưu. Cần thông báo khi rời bản chỉnh sửa chưa lưu; chưa bổ sung tự động lưu ngầm.

## 3. Công nghệ và kiến trúc

- Backend: Python 3.12 + FastAPI + Uvicorn. Đã xác nhận có trên máy tại bản Python của người dùng; `python` trên PATH hiện trỏ sang MSYS2 nên phải dùng đúng interpreter/venv.
- SQLite cho tài khoản, phiên đăng nhập, metadata tài liệu và các phiên bản. Tệp ảnh/PDF trong thư mục dữ liệu riêng của backend.
- Frontend tiếp tục React + TypeScript + Vite; dùng lại SDK `@docscan/browser` và `pdf-lib` hiện có, không đưa xử lý ảnh lên backend.
- Không chỉ lưu PDF: mỗi trang giữ ảnh nguồn bền vững từ SDK, kích thước, công thức `EditRecipe`, ảnh kết quả và thumbnail cần thiết. PDF là sản phẩm từ tập trang; không bóc ảnh từ PDF để khôi phục khả năng chỉnh sửa.
- Lưu thứ tự trang, tên, chủ sở hữu, phiên bản hợp đồng dữ liệu và mốc thời gian UTC. Hiển thị giờ theo ngữ cảnh người dùng.
- Không lưu buffer RGBA tạm, worker, object URL hoặc trạng thái đang xử lý vào kho bền vững.
- Ghi tệp phiên bản mới vào vị trí riêng, kiểm tra đầy đủ rồi chuyển tham chiếu phiên bản hiện hành trong giao dịch DB. Dọn tệp mồ côi theo quy trình có giới hạn, không xoá bản hiện hành khi request lỗi.
- API cùng origin qua proxy `/api` khi phát triển để điện thoại dùng đúng host của web. Không hardcode `localhost` trong FE.
- Khi lưu, ảnh nguồn và ảnh kết quả được gửi lên backend. Cập nhật thông báo quyền riêng tư đang nói ảnh không bao giờ lên máy chủ để phản ánh đúng hành vi mới.

## 4. Cấu trúc và phong cách mã

Backend dự kiến trong `../backendcamscanner/`:

```text
app/                 cấu hình, tạo ứng dụng và API
app/auth.py          đăng ký, mật khẩu và phiên đăng nhập
app/documents/       hợp đồng, nghiệp vụ tài liệu và lưu trữ
tests/               kiểm thử API/nghiệp vụ với dữ liệu tạm
data/                DB và tệp runtime, không đưa vào Git
.env.example         tên biến cấu hình, không chứa bí mật
README.md            thiết lập, API dùng cho app và chạy thử LAN/HTTPS
```

FE giữ cấu trúc hiện tại: `src/app`, `src/features`; bổ sung chức năng tài khoản, kho tài liệu và xem PDF ở boundary phù hợp. Logic xử lý ảnh/PDF của SDK tiếp tục thuộc `../thuvien/browser/src`, không sửa trực tiếp `node_modules` hoặc gói vendor.

Theo các contract readonly và union hiện có, ví dụ:

```typescript
type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly revision: number }
  | { readonly kind: 'error'; readonly message: string };
```

Python dùng type annotations và model kiểm tra tại boundary; route chỉ xác thực, kiểm tra đầu vào và gọi nghiệp vụ. Cấu hình, xác thực, persistence và nghiệp vụ tách theo trách nhiệm; không tạo framework nội bộ tổng quát.

## 5. Giới hạn và bảo mật

- Backend kiểm tra đăng nhập và chủ sở hữu cho mọi API tài liệu, ảnh và PDF, kể cả URL xem/tải. Không public thư mục upload.
- Mật khẩu băm bằng scrypt; session token ngẫu nhiên chỉ lưu bản băm. Không đưa mật khẩu, mã, cookie hoặc nội dung tài liệu vào log.
- Giới hạn đăng ký và đăng nhập theo IP; phiên có hạn dùng và có thể thu hồi; không cho vượt giới hạn bằng request đồng thời.
- Cookie HttpOnly, SameSite, Secure khi HTTPS; kiểm tra CSRF/origin cho thao tác thay đổi dữ liệu. Dùng cấu hình local rõ ràng, không tự mở CORS cho mọi nguồn.
- Giới hạn số trang, kích thước request/tệp, kích thước ảnh và tổng tài liệu; kiểm tra định dạng/nội dung, không tin filename/MIME do client gửi. ID tệp và đường dẫn lưu do server quản lý.
- Query tham số hoá, transaction cho thay đổi nhiều bước, hợp đồng có phiên bản; lỗi trả về không lộ đường dẫn hoặc stack trace.
- Bản đầu chưa bao gồm OCR/chỉnh sửa chữ trong PDF, nhập PDF bất kỳ để sửa, chia sẻ tài liệu, Google OAuth, đồng bộ offline, lịch sử phiên bản cho người dùng, xác minh email, quên mật khẩu hoặc triển khai hosting.

## 6. Lệnh và chiến lược kiểm thử

Các lệnh FE hiện có, chạy từ `camscanner2`:

```powershell
npm test -- src/features/export/image-pdf.test.ts src/features/scanner/ScanBatchReview.test.tsx
npm test
npm run typecheck
npm run lint
npm run build
npm run dev
```

Các lệnh backend, chạy từ `backendcamscanner`:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Chốt dependency và hướng dẫn tạo venv bằng đúng Python 3.12 khi triển khai. Kiểm thử tự động dùng DB/tệp tạm và không gọi dịch vụ bên ngoài.

Kiểm thử cần chứng minh:

- Đăng ký → đăng nhập → đăng xuất; email trùng/không hợp lệ, mật khẩu sai, giới hạn lượt, phiên hết hạn, bearer token và CSRF cho cookie.
- Người chưa đăng nhập bị chặn; người A không xem/tải/sửa được tài liệu và tệp của B.
- Tạo tài liệu nhiều trang, liệt kê có giới hạn, mở lại sau đăng nhập; tên/thứ tự/ảnh nguồn/công thức được bảo toàn.
- Mở sửa → đổi bộ lọc/cắt/xoay → thêm/xoá trang → lưu → PDF và số trang cập nhật; xung đột phiên bản và lưu dở không mất bản cũ.
- Xem trước PDF, tải đúng Blob/nội dung; lỗi xuất/tải có thông báo và có thể thử lại, không mắc ở trạng thái chờ.
- Test hồi quy cho nguyên nhân lỗi tải PDF sau khi tái hiện. Desktop giả lập kích thước mobile không thay thế thử tải thực tế trên điện thoại.
- Test FE/API, typecheck, lint, build và kiểm tra giao diện bằng trình duyệt; ghi rõ phần chưa xác minh trên thiết bị thật .

## 7. Ranh giới thực hiện và hỗ trợ trình duyệt

- Luôn giữ nguyên thay đổi không liên quan; làm theo các bước nhỏ có kiểm thử, kiểm tra diff trước khi bàn giao.
- Hỏi trước khi đổi yêu cầu sản phẩm, đưa dữ liệu lên dịch vụ bên ngoài hoặc triển khai hosting. Các lựa chọn kỹ thuật thường lệ được xử lý trong phạm vi đặc tả đã thống nhất.
- Không commit bí mật hoặc dữ liệu runtime; không báo gửi/lưu thành công giả.
- Hỗ trợ Android/iPhone và nhiều trình duyệt theo khả năng nền tảng: xem trang bằng ảnh kết quả, PDF chuẩn, tải bằng thao tác trực tiếp sau khi tạo xong, mở tệp và chia sẻ nếu trình duyệt hỗ trợ. Không cam kết vượt giới hạn webview; ghi rõ kết quả thử trên thiết bị thật.
- Camera và Web Share cần secure context; hướng dẫn HTTPS/tunnel cho điện thoại, proxy /api cùng origin; HTTP LAN vẫn dùng được nhập ảnh/xem/tải nếu trình duyệt cho phép.
- Bản đặc tả này bổ sung luồng tài khoản/kho backend, thay thế giới hạn không có backend và lưu chỉ trên thiết bị trong các tài liệu v1 lịch sử.
