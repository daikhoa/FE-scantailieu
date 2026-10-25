import { describe, expect, it } from 'vitest';
import {
  classifyComparisonError,
  ComparisonError,
  comparisonErrorMessage,
} from './comparison-error';

describe('comparison failure classification', () => {
  it('reports lost worker state without blaming the photo or crop', () => {
    const error = classifyComparisonError(new Error('invalid-state'), 'initialize');
    expect(error).toMatchObject({ code: 'invalid-state', stage: 'initialize' });
    expect(comparisonErrorMessage(error)).toContain('Trạng thái bộ xử lý');
    expect(comparisonErrorMessage(error)).not.toContain('vùng cắt');
  });
  it('distinguishes load, unsupported WASM and heap failures', () => {
    expect(classifyComparisonError(new TypeError('Fetch failed'), 'initialize')).toMatchObject({
      code: 'load-failed',
      stage: 'initialize',
    });
    expect(
      classifyComparisonError(new WebAssembly.CompileError('feature'), 'initialize'),
    ).toMatchObject({ code: 'wasm-unsupported' });
    expect(
      classifyComparisonError(
        new WebAssembly.RuntimeError('Aborted(CompileError: unsupported feature)'),
        'initialize',
      ),
    ).toMatchObject({ code: 'wasm-unsupported' });
    expect(
      classifyComparisonError(new RangeError('WebAssembly memory allocation failed'), 'process'),
    ).toMatchObject({ code: 'out-of-memory', stage: 'process' });
    expect(classifyComparisonError(new Error('out-of-memory'), 'process')).toMatchObject({
      code: 'out-of-memory',
    });
    expect(classifyComparisonError(new Error('invalid-input'), 'process')).toMatchObject({
      code: 'invalid-input',
    });
  });
  it('retains stage context without exposing raw exception text', () => {
    const error = classifyComparisonError(new Error('private engine details'), 'decode');
    expect(error).toMatchObject({ code: 'failed', stage: 'decode' });
    expect(comparisonErrorMessage(error)).toContain('decode/failed');
    expect(comparisonErrorMessage(error)).not.toContain('private engine details');
    expect(
      classifyComparisonError(new ComparisonError('out-of-memory', 'encode'), 'process'),
    ).toMatchObject({ stage: 'encode' });
  });
});
