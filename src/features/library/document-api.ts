import type { EditRecipe, ImageAsset, RenderedVariant } from '../../domain/document';
import type { ScanBatchPage } from '../scanner/scan-batch';
import { apiBlob, apiJson } from '../account/api-client';
import { MAX_DOCUMENT_PAGES } from '../../domain/document-limits';

export interface DocumentSummary {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly pageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ImageInfo {
  readonly width: number;
  readonly height: number;
  readonly mime: string;
}

export interface StoredPage {
  readonly id: string;
  readonly original: ImageInfo;
  readonly rendered: ImageInfo;
  readonly recipe: EditRecipe;
  readonly engineVersion: string;
  readonly recipeKey: string;
  readonly outcome: RenderedVariant['dewarp'];
  readonly enhancement?: RenderedVariant['enhancement'];
  readonly enhancementFailure?: RenderedVariant['enhancementFailure'];
  readonly originalUrl: string;
  readonly renderedUrl: string;
  readonly thumbnailUrl: string;
}

export interface StoredDocument extends DocumentSummary {
  readonly schemaVersion: 1;
  readonly pages: readonly StoredPage[];
  readonly pdfUrl: string;
}

export interface EditableDocument {
  readonly document: DocumentSummary;
  readonly pages: readonly ScanBatchPage[];
}

export interface DocumentListing {
  readonly items: readonly DocumentSummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

const BASE = '/api/v1/documents';
const createRequests = new WeakMap<Blob, Map<string, string>>();

function createRequestKey(pdf: Blob, manifest: string): string {
  let requests = createRequests.get(pdf);
  if (!requests) {
    requests = new Map();
    createRequests.set(pdf, requests);
  }
  let key = requests.get(manifest);
  if (!key) {
    key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    requests.set(manifest, key);
  }
  return key;
}
const info = (image: ImageAsset): ImageInfo => ({ ...image.dimensions, mime: image.blob.type });

export const documentApi = {
  list: (offset = 0, signal?: AbortSignal) =>
    apiJson<DocumentListing>(`${BASE}?limit=20&offset=${String(offset)}`, signal ? { signal } : {}),
  async get(id: string, signal: AbortSignal): Promise<StoredDocument> {
    const document = await apiJson<
      Omit<StoredDocument, 'schemaVersion'> & { readonly schemaVersion: number }
    >(`${BASE}/${encodeURIComponent(id)}`, { signal });
    if (
      document.schemaVersion !== 1 ||
      document.pages.length === 0 ||
      document.pages.length > MAX_DOCUMENT_PAGES
    )
      throw new Error('Phiên bản dữ liệu tài liệu chưa được hỗ trợ.');
    return { ...document, schemaVersion: 1 };
  },
  async save(
    pages: readonly ScanBatchPage[],
    pdf: Blob,
    name: string,
    existing: DocumentSummary | null,
    signal: AbortSignal,
  ): Promise<DocumentSummary> {
    if (
      !pages.length ||
      pages.length > MAX_DOCUMENT_PAGES ||
      pages.some((page) => page.kind !== 'ready')
    )
      throw new Error('Cần hoàn tất từ 1 đến 50 trang trước khi lưu.');
    const form = new FormData();
    const stored = pages.map((page, index) => {
      if (page.kind !== 'ready') throw new Error('Trang chưa sẵn sàng.');
      form.append(
        `original_${String(index)}`,
        page.page.original.blob,
        `original-${String(index)}`,
      );
      form.append(
        `rendered_${String(index)}`,
        page.page.variant.image.blob,
        `rendered-${String(index)}`,
      );
      return {
        id: page.id,
        original: info(page.page.original),
        rendered: info(page.page.variant.image),
        recipe: page.page.recipe,
        engineVersion: page.page.variant.engineVersion,
        recipeKey: page.page.variant.recipeKey,
        outcome: page.page.variant.dewarp,
        enhancement: page.page.variant.enhancement,
        enhancementFailure: page.page.variant.enhancementFailure,
      };
    });
    const manifest = JSON.stringify({
      schemaVersion: 1,
      name,
      revision: existing?.revision ?? null,
      pages: stored,
    });
    form.append('manifest', manifest);
    form.append('pdf', pdf, 'document.pdf');
    return apiJson<DocumentSummary>(
      existing ? `${BASE}/${encodeURIComponent(existing.id)}` : BASE,
      {
        method: existing ? 'PUT' : 'POST',
        body: form,
        signal,
        ...(!existing ? { headers: { 'Idempotency-Key': createRequestKey(pdf, manifest) } } : {}),
      },
      120_000,
    );
  },
  async edit(document: StoredDocument, signal: AbortSignal): Promise<EditableDocument> {
    const pages: ScanBatchPage[] = [];
    // Sequential downloads bound memory/network pressure on phones; decoding remains in the SDK.
    for (const page of document.pages) {
      const original: ImageAsset = {
        blob: await apiBlob(page.originalUrl, signal),
        dimensions: { width: page.original.width, height: page.original.height },
      };
      const image: ImageAsset = {
        blob: await apiBlob(page.renderedUrl, signal),
        dimensions: { width: page.rendered.width, height: page.rendered.height },
      };
      pages.push({
        id: page.id,
        source: original.blob,
        kind: 'ready',
        page: {
          original,
          crop: page.recipe.crop,
          recipe: page.recipe,
          variant: {
            image,
            engineVersion: page.engineVersion,
            recipeKey: page.recipeKey,
            dewarp: page.outcome,
            ...(page.enhancement ? { enhancement: page.enhancement } : {}),
            ...(page.enhancementFailure ? { enhancementFailure: page.enhancementFailure } : {}),
          },
        },
      });
    }
    return { document, pages };
  },
};
