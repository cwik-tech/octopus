import { renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useWindowSessionReport } from '../use-window-session-report';
afterEach(() => { delete window.pipeline; });
it('reports the saved selection and clears the routing hint on unmount', () => {
  const reports: (string | null)[] = [];
  // Only the native preload boundary is replaced in jsdom.
  window.pipeline = { selectBatchFolder: async () => null, selectSharedFolder: async () => null,
    reportWindowSession: (id) => { reports.push(id); } };
  const view = renderHook(({ id }) => useWindowSessionReport(id), { initialProps: { id: 'ad605beb-dadc-403a-bca4-b05df6e00001' } });
  expect(reports.at(-1)).toBe('ad605beb-dadc-403a-bca4-b05df6e00001');
  view.rerender({ id: 'ad605beb-dadc-403a-bca4-b05df6e00002' });
  expect(reports.at(-1)).toBe('ad605beb-dadc-403a-bca4-b05df6e00002');
  view.unmount();
  expect(reports.at(-1)).toBeNull();
});
