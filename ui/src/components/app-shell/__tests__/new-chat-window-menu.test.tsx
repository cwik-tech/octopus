import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { NewChatWindowMenu } from '../new-chat-window-menu';
import { Button } from '@/components/ui/button';
afterEach(() => { delete window.pipeline; });
it('offers a separate draft window on Run and keeps its left click action', async () => {
  let opened = false;
  let clicked = false;
  // Electron is unavailable here; replace only the preload capability boundary.
  window.pipeline = { selectBatchFolder: async () => null, selectSharedFolder: async () => null,
    openWindow: async (request) => { opened = request.kind === 'new-chat'; } };
  render(<NewChatWindowMenu enabled><Button onClick={() => { clicked = true; }}>New chat</Button></NewChatWindowMenu>);
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  expect(clicked).toBe(true);
  fireEvent.contextMenu(screen.getByRole('button', { name: 'New chat' }), { button: 2, clientX: 50, clientY: 50 });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New chat in new window' }));
  expect(opened).toBe(true);
});
it('offers no chat-window menu on other tabs', () => {
  render(<NewChatWindowMenu enabled={false}><Button>New project</Button></NewChatWindowMenu>);
  fireEvent.contextMenu(screen.getByRole('button', { name: 'New project' }));
  expect(screen.queryByRole('menuitem')).toBeNull();
});
