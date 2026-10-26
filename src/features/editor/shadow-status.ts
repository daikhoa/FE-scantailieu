import type { EnhancementFailureCode } from '../../domain/document';

const reasons: Record<EnhancementFailureCode, string> = {
  download: 'Chưa tải được model khử bóng.',
  'model-invalid': 'Dữ liệu khử bóng chưa hợp lệ.',
  memory: 'Chưa đủ bộ nhớ để chạy bộ khử bóng.',
  runtime: 'Chưa khởi tạo được bộ khử bóng.',
  inference: 'Bộ khử bóng chưa xử lý được ảnh này.',
  timeout: 'Bộ khử bóng phản hồi quá lâu.',
  busy: 'Bộ khử bóng đang bận.',
};
export function shadowFallbackMessage(code?: EnhancementFailureCode): string {
  return `${code ? reasons[code] : 'Bộ khử bóng chưa sẵn sàng.'} Đã giữ bản tăng cường nhẹ; chọn lại Tăng cường để thử lại.${code ? ` Mã kiểm tra: shadow-${code}.` : ''}`;
}
