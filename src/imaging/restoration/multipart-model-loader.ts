const DEFAULT_MAXIMUM_MODEL_BYTES = 64 * 1024 * 1024;

interface MultipartModelOptions {
  readonly fetchPart?: (url: string) => Promise<Response>;
  readonly maximumBytes?: number;
}

export async function loadMultipartModel(
  urls: readonly string[],
  options: MultipartModelOptions = {},
): Promise<Uint8Array> {
  if (urls.length === 0) throw new RangeError('At least one model part is required.');
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_MODEL_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError('Invalid model byte limit.');
  }
  const fetchPart = options.fetchPart ?? ((url: string) => fetch(url));
  const responses = await Promise.all(urls.map((url) => fetchPart(url)));
  for (const response of responses) {
    if (!response.ok) throw new Error(`Model part request failed (${String(response.status)}).`);
  }
  const buffers = await Promise.all(responses.map((response) => response.arrayBuffer()));
  const totalBytes = buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
  if (totalBytes > maximumBytes) {
    throw new Error(`Model exceeds the ${String(maximumBytes)}-byte limit.`);
  }
  if (totalBytes === 0) throw new Error('Model parts are empty.');

  const model = new Uint8Array(totalBytes);
  let offset = 0;
  for (const buffer of buffers) {
    model.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return model;
}
