import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EngineLifecycle, ScannerEngine } from '../imaging/contracts/scanner-engine';
import { App } from './App';

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:review');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

it('imports, changes filter, rotates and recrops with one processing runtime', async () => {
  const file = new File(['original'], 'page.jpg', { type: 'image/jpeg' });
  const original = { blob: file, dimensions: { width: 900, height: 1200 } };
  let lifecycle: EngineLifecycle = { kind: 'uninitialized' };
  const renderPage = vi.fn<ScannerEngine['render']>((request) =>
    Promise.resolve({
      recipeKey: `${request.recipe.filter.mode}-${String(request.recipe.rotation)}`,
      engineVersion: 'test',
      image: original,
      dewarp: { kind: 'not-requested' },
    }),
  );
  const engine: ScannerEngine = {
    get lifecycle() {
      return lifecycle;
    },
    initialize: () => {
      lifecycle = { kind: 'ready' };
      return Promise.resolve();
    },
    detect: (frame) =>
      Promise.resolve({ kind: 'full-frame', reason: 'no-document', dimensions: frame.dimensions }),
    render: renderPage,
    dispose: () => {
      lifecycle = { kind: 'disposed' };
      return Promise.resolve();
    },
  };
  const factory = vi.fn(() => {
    if (factory.mock.calls.length > 1) throw new Error('Second ML realm exceeds device budget');
    return engine;
  });
  render(
    <App
      restorationClient={null}
      editorEngineFactory={factory}
      imageImporter={() => Promise.resolve({ original })}
      editorFrameSource={{
        create: () => Promise.resolve({ dimensions: original.dimensions, close: () => undefined }),
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText('Dùng ảnh có sẵn'), { target: { files: [file] } });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Tải PDF 1 trang' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Khử bóng AI' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Khử bóng AI' })).toHaveAttribute(
      'aria-pressed',
      'true',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Xoay trái' }));
  await waitFor(() => {
    expect(renderPage.mock.calls.at(-1)?.[0].recipe.rotation).toBe(270);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cắt trang 1' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Cắt trang 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Áp dụng vùng cắt' }));
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: 'Điều chỉnh 4 góc' })).not.toBeInTheDocument(),
  );
  expect(factory).toHaveBeenCalledOnce();
  expect(renderPage).toHaveBeenCalledTimes(4);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
