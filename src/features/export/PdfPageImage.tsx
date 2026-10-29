import { AssetImage } from '../../components/AssetImage';
import type { ImageAsset } from '../../domain/document';

export function PdfPageImage({
  image,
  number,
  lazy = false,
}: {
  readonly image: ImageAsset | string;
  readonly number: number;
  readonly lazy?: boolean;
}) {
  return <AssetImage image={image} alt={`Trang ${String(number)} của PDF`} lazy={lazy} />;
}
