import { lazy, Suspense } from 'react';
import { App } from './App';

const ComparisonScreen = lazy(() =>
  import('../features/comparison/ComparisonScreen').then((module) => ({
    default: module.ComparisonScreen,
  })),
);

export function Application() {
  return new URLSearchParams(location.search).get('compare') === '1' ? (
    <Suspense fallback={<p role="status">Đang mở khu vực so sánh…</p>}>
      <ComparisonScreen />
    </Suspense>
  ) : (
    <App />
  );
}
