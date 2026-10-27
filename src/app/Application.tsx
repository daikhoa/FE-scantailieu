import { lazy, Suspense } from 'react';
import { AccountApplication } from './AccountApplication';

const ComparisonScreen = lazy(() =>
  import('../features/comparison/ComparisonScreen').then((module) => ({
    default: module.ComparisonScreen,
  })),
);

export function Application() {
  return new URLSearchParams(location.search).get('compare') === '1' ? (
    <AccountApplication
      comparison={
        <Suspense fallback={<p role="status">Đang mở khu vực so sánh…</p>}>
          <ComparisonScreen />
        </Suspense>
      }
    />
  ) : (
    <AccountApplication />
  );
}
