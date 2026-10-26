# Web dùng thư viện C++

Luồng chụp, nhập nhiều ảnh, xem lại và editor hiện dùng bộ xử lý C++ chính thức.
WebAssembly là bản biên dịch từ `../thuvien`, cùng nguồn với `docscan.dll`.
Không có API máy chủ, không gửi ảnh lên server và không gọi DLL Windows trong trình duyệt.

## Nơi chỉnh thuật toán

Trong thư mục `thuvien`:

| Phần | Nguồn dùng chung |
| --- | --- |
| Tỷ lệ, phối cảnh, chọn vùng nguồn, lấy mẫu | `src/geometry.cpp` |
| Đánh giá ảnh | `src/quality.cpp` |
| Quy tắc từ điểm classifier sang tham số | `src/appearance-plan.cpp` |
| Tăng cường mặc định, bảo vệ màu, bù bóng và nét chữ | `src/adaptive-enhancement.cpp` |
| Các bộ lọc xám, đen trắng, tự động | `src/filters.cpp` |
| Giao diện chạy trong trình duyệt | `wasm/bridge.cpp`, `wasm/CMakeLists.txt` |

JS không còn quyết định tham số hoặc sửa pixel trong renderer production.
Classifier chỉ gửi điểm model thô; C++ tự đo ảnh và lập kế hoạch. JS cũ được giữ
làm mốc đối chiếu trong trang so sánh và được đánh dấu rõ là Web cũ.
Build kiểm tra production không import các kernel JS đó.

Browser vẫn quản lý camera, giải mã JPEG/PNG/HEIC, inference của detector/GCNet,
giao diện, hàng đợi, lưu ảnh gốc, mã hóa ảnh và ghép PDF. Đây là lớp tích hợp với
nền tảng. Thay thuật toán cắt/tăng cường/bù bóng chỉ sửa nguồn thư viện; thay giao
diện, định dạng nhập, model/runtime hoặc hợp đồng tích hợp có thể cần cập nhật
adapter. Detector vẫn là model Scanic hiện có. Không thay model hoặc giảm độ phân giải.

## Build sau khi sửa thư viện

Từ thư mục web:

```powershell
npm run library:build
npm run library:test
npm test -- --maxWorkers=2
npm run build
```

`library:build` dùng CMake/Emscripten build đã cấu hình trong
`.tmp-wasm/docscan` trỏ tới `../thuvien/wasm`. Máy mới cần Emscripten và OpenCV
core/imgproc đã build cho Emscripten; cấu hình CMake theo tài liệu `thuvien/docs/wasm.md`.
Có thể chỉ định `--native-root`, `--build-dir`, `--cmake` sau `npm run library:build --`.
Script xác minh build tree thuộc đúng nguồn thư viện trước khi build.

Script tự tạo thư mục public theo hash nội dung, ghi hash nguồn/binary vào
`build.json`, cập nhật `docscan-assets.ts` và thay danh tính cache engine. Không
copy thuật toán sang TypeScript, không sửa tay file generated, không ghi đè ABI
cũ. Cần build/phát hành web sau đó để người dùng nhận thư viện mới. Hosted build
dùng artifact đã kiểm tra, không cần compiler C++ hoặc thư mục thư viện trên host.
DLL native build bằng quy trình `thuvien/scripts/build-windows.ps1` riêng.

## Bộ nhớ và lỗi

C++ chia ảnh thành các vùng nguồn tối đa 1.048.576 pixel, cạnh tối đa 4096.
Browser chỉ giữ một bitmap và đọc vùng được yêu cầu ở độ phân giải gốc. Không
chuyển toàn ảnh 48MP thành thêm một buffer RGBA đầy đủ trong JS/WASM. Bản cuối
vẫn tối đa cạnh dài 3000 như trước; bản phân tích dùng giới hạn riêng do caller
yêu cầu. Xoay thực hiện sau xử lý và giữ tỷ lệ trang PDF.

Mỗi realm xử lý một trang; buffer tạm được giải phóng trong `finally`, page native
được release cả khi lỗi. GCNet vẫn chạy trong worker riêng có khởi tạo lại sau lỗi.
Nếu model lỗi, Tăng cường báo fallback nhẹ cùng mã lỗi an toàn; Khử bóng AI rõ ràng
báo thất bại. Không thay C++ lỗi bằng JS rồi báo thành công. Worker/iframe còn giữ
giới hạn thời gian và hủy theo lifecycle ứng dụng.

## Xác minh khi tích hợp

- Bài kiểm tra mới đã thất bại với ABI v8 trước khi triển khai.
- Binary thật: toàn khung giữ pixel gốc, cắt phối cảnh, xoay, giới hạn preview,
  các bộ lọc, giới hạn vùng 48MP, lỗi/giải phóng và chạy lại.
- 595 test ứng dụng và 9 CTest native qua; typecheck/lint/build qua.
- Trình duyệt desktop: nhập đồng thời ảnh giấy có bóng và bìa màu, xử lý mặc định,
  xám/đen trắng, xoay, áp dụng vùng cắt, xuất PDF hai trang với tỷ lệ khác nhau.
- Không có phép đo mới trên iPhone/Android thật, nhiệt độ hoặc pin. Không khẳng
  định nhanh hơn theo hệ số hoặc chất lượng mới vượt bản C++ đã duyệt.
