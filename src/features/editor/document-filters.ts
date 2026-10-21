import type { CropRegion, EditRecipe, FilterMode, QuarterTurn } from '../../domain/document';

export interface DocumentFilterOption {
  readonly mode: FilterMode;
  readonly label: string;
  readonly description: string;
}

export const DOCUMENT_FILTERS: readonly DocumentFilterOption[] = [
  { mode: 'original', label: 'Gốc', description: 'Chỉ cắt và làm thẳng' },
  { mode: 'ocr-color', label: 'Tự động', description: 'Làm nét chữ, giữ màu' },
  { mode: 'grayscale', label: 'Xám', description: 'Nền trung tính, chữ rõ' },
  { mode: 'black-and-white', label: 'Đen trắng', description: 'Tách chữ khỏi nền' },
];

function presetVersion(mode: FilterMode): string {
  return mode === 'original'
    ? 'original-v1'
    : mode === 'black-and-white'
      ? 'black-and-white-v5'
      : `${mode}-v7`;
}

export function createDocumentRecipe(
  crop: CropRegion,
  mode: FilterMode,
  rotation: QuarterTurn = 0,
): EditRecipe {
  return {
    version: 1,
    crop,
    rotation,
    dewarp: { mode: 'perspective-only' },
    filter: { mode, presetVersion: presetVersion(mode), parameters: {} },
  };
}

export function recipeWithFilter(recipe: EditRecipe, mode: FilterMode): EditRecipe {
  return {
    ...recipe,
    filter: { mode, presetVersion: presetVersion(mode), parameters: {} },
  };
}

export function documentFilterLabel(mode: FilterMode): string {
  return DOCUMENT_FILTERS.find((option) => option.mode === mode)?.label ?? 'Tự động';
}
