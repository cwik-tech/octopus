import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Toaster } from 'sonner';
import { OpenInNewWindowButton } from '../open-in-new-window-button';
afterEach(() => { delete window.pipeline; });
it('keeps a draft unavailable and guards a saved chat against overlapping opens', async () => {
  let finish: (() => void) | undefined;
  let requests = 0;
  // Only the native preload boundary is replaced; the button and action hook are real.
  window.pipeline = { selectBatchFolder: async () => null, selectSharedFolder: async () => null,
    openWindow: async () => { requests += 1; await new Promise<void>((resolve) => { finish = resolve; }); } };
  const view = render(<OpenInNewWindowButton sessionId="ad605beb-dadc-403a-bca4-b05df6e00001" isDraft />);
  expect(screen.getByRole('button', { name: 'Open in new window' })).toBeDisabled();
  view.rerender(<OpenInNewWindowButton sessionId="ad605beb-dadc-403a-bca4-b05df6e00001" isDraft={false} />);
  const button = screen.getByRole('button', { name: 'Open in new window' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(requests).toBe(1);
  await act(async () => { finish?.(); });
  expect(button).toBeEnabled();
});
it('shows a failed open without changing the chat', async () => {
  window.pipeline = { selectBatchFolder: async () => null, selectSharedFolder: async () => null,
    openWindow: async () => { throw new Error('native load failed'); } };
  render(<><Toaster /><OpenInNewWindowButton sessionId="ad605beb-dadc-403a-bca4-b05df6e00001" isDraft={false} /></>);
  fireEvent.click(screen.getByRole('button', { name: 'Open in new window' }));
  expect(await screen.findByText('Could not open a new window')).toBeVisible();
});
