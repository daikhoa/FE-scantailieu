# Nhập lại ảnh sau khi về trang chủ — 27/10/2026

## Lỗi và phạm vi kết luận

Người dùng báo lượt nhập đầu thành công, về trang chủ rồi nhập bộ khác có thể báo `shadow-memory`. Đã tái hiện hai thiếu sót về vòng đời bằng kiểm thử xác định:

- `App` gọi `dispose()` bất đồng bộ nhưng không chờ trước khi giải mã/khởi tạo lượt nhập tiếp theo. Kiểm thử giữ việc đóng bộ cũ chưa hoàn tất cho thấy importer của bộ mới vẫn chạy.
- Backend chỉ huỷ worker cha hoặc gỡ iframe. Bộ khử bóng là worker con do realm đó tạo, chưa có bước chủ động dừng con và xác nhận dọn trước khi huỷ cha. Kiểm thử yêu cầu xác nhận này thất bại trên bản cũ.

Đây là lỗi quyền sở hữu tài nguyên được xác nhận trong mã. Chưa đo heap native hoặc tái hiện trực tiếp thông báo trên iPhone thật; không kết luận mọi lỗi thiếu bộ nhớ đều có cùng nguyên nhân. WebKit cũng có các báo cáo về [bộ nhớ của worker đã terminate](https://bugs.webkit.org/show_bug.cgi?id=250569), nhưng không dùng chúng làm bằng chứng thiết bị người dùng mắc đúng lỗi đó.

## Bản sửa

1. `App` ghi nhận completion của các processor đang nghỉ. Lượt mới chờ completion trước khi bắt đầu importer/enqueue. Lượt bị huỷ trong lúc chờ không được hồi sinh khi việc dọn xong. Mở camera và chỉnh trang cũng tôn trọng hàng rào này.
2. SDK thêm thông điệp nội bộ `dispose` cho cả worker và iframe. Realm nhận lệnh gọi `disposeShadowRuntime()` để dừng worker khử bóng con trước khi gửi xác nhận.
3. Backend từ chối/settle công việc đang chạy, chờ đúng mã xác nhận rồi huỷ worker cha/gỡ iframe. Kết quả cũ tới muộn không được coi là xác nhận dọn. Nếu realm kẹt hoặc không trả lời, cưỡng chế đóng sau tối đa 1 giây; timer/port/listener được thu hồi.

Không đổi C ABI, DLL, model, kích thước tensor khử bóng, độ phân giải xuất hoặc thuật toán màu. Đây là sửa vòng đời trong SDK trình duyệt và phần điều phối ứng dụng; không giảm chất lượng để né thiếu bộ nhớ. C++/WASM raster giữ nguyên `cpp-3db972ad01f3`.

## Xác minh

- Hai kiểm thử hồi quy đã thất bại trên hành vi cũ trước khi sửa.
- Bộ kiểm thử toàn dự án: 614 kiểm thử / 71 tệp đạt. Sau chỉnh lint, 36 kiểm thử liên quan được chạy lại và đạt.
- Lint, TypeScript và build production đạt. Kiểm tra worker production: 4 entry / 12 module, không import ngược entry.
- `library:test` đạt với SDK `0.2.0-78f36fa702c1`: hash nguồn/tài sản, WASM thực, pixel controls, ảnh 48MP, cleanup và lặp tinh chỉnh không tăng heap.
- Kiểm tra UI production trên máy tính: nhập nhiều bộ ảnh liên tiếp qua trang chủ, các trang hoàn tất; kiểm tra thêm khử bóng AI và xoay ở lượt sau. Đây không phải phép đo nhiệt độ/bộ nhớ iPhone hoặc Android thật.

Nguồn SDK có thẩm quyền ở `../thuvien/browser/src`; web cài gói SDK được đóng phiên bản, không chép lại logic model vào ứng dụng. Các tệp/model thử tạm sẽ được dọn sau phát hành; giữ nguyên ảnh gốc người dùng.
