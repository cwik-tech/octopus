import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useObservedTurns } from '../use-observed-turns';
afterEach(() => { vi.unstubAllGlobals(); });
it('restores progress for the exact remote turn without turning it into answer text', async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  // Only the network is replaced; real stream validation and the recovery hook run.
  vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(next) {
    controller = next; init?.signal?.addEventListener('abort', () => next.close(), { once: true });
  } }))));
  const view = renderHook(() => useObservedTurns({ sessionId: 'session', activeTurnIds: ['remote'], ownTurnId: null, onSettled: () => {} }));
  await act(async () => { controller?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'progress-snapshot', channelId: 'remote', replyId: 'analyst:0', progress: { revision: 2, startedAt: 1000, updatedAt: 2000, current: { kind: 'observed', phase: 'retry', attempt: 2 }, history: [] } })}\n\n`)); });
  await waitFor(() => expect(view.result.current.stream.progress?.[0]?.snapshot.revision).toBe(2));
  expect(view.result.current.stream.progress?.[0]?.replyId).toBe('analyst:0:remote');
  expect(view.result.current.stream.replies).toEqual([]);
  view.unmount();
});
it('observes two remote channels beside a local send without merging equal speaker reply IDs', async () => {
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  // Network-only replacement: the stream parser and subscription lifecycle remain real.
  vi.stubGlobal('fetch', (url: string) => {
    const id = new URL(url, 'http://localhost').searchParams.get('channelId');
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { if (id) streams.set(id, controller); } }), { status: 200 }));
  });
  const onSettled = () => {};
  const view = renderHook(() => useObservedTurns({ sessionId: 'session', activeTurnIds: ['local', 'remote-a', 'remote-b'], ownTurnId: 'local', onSettled }));
  await waitFor(() => { expect([...streams.keys()].sort()).toEqual(['remote-a', 'remote-b']); });
  await act(async () => {
    streams.get('remote-a')?.enqueue(new TextEncoder().encode('id: 0\ndata: {"type":"delta","replyId":"analyst:0","text":"Alpha","channel":"text","channelId":"remote-a","cursor":0}\n\n'));
    streams.get('remote-b')?.enqueue(new TextEncoder().encode('id: 0\ndata: {"type":"delta","replyId":"analyst:0","text":"Beta","channel":"text","channelId":"remote-b","cursor":0}\n\n'));
  });
  await waitFor(() => { expect(view.result.current.stream.replies.map((reply) => reply.text).sort()).toEqual(['Alpha', 'Beta']); });
  expect(new Set(view.result.current.stream.replies.map((reply) => reply.replyId)).size).toBe(2);
  view.unmount();
  for (const controller of streams.values()) controller.close();
});

it('reopening an observed channel starts a fresh preview without duplicating its replay', async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  // Network-only replacement; a reconnected subscription replays the channel from cursor zero.
  vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
    start(next) { controller = next; init?.signal?.addEventListener('abort', () => next.close(), { once: true }); },
  }))));
  const noop = () => {};
  const view = renderHook(({ ids }) => useObservedTurns({ sessionId: 'session', activeTurnIds: ids, ownTurnId: null, onSettled: noop }), { initialProps: { ids: ['remote'] } });
  const frame = new TextEncoder().encode('id: 0\ndata: {"type":"delta","replyId":"analyst:0","text":"Alpha","channel":"text","channelId":"remote","cursor":0}\n\n');
  await act(async () => { controller?.enqueue(frame); });
  await waitFor(() => { expect(view.result.current.stream.replies[0]?.text).toBe('Alpha'); });
  const originalController = controller;
  view.rerender({ ids: [] });
  expect(view.result.current.stream.replies).toEqual([]);
  view.rerender({ ids: ['remote'] });
  expect(controller).not.toBe(originalController);
  await act(async () => { controller?.enqueue(frame); });
  await waitFor(() => { expect(view.result.current.stream.replies[0]?.text).toBe('Alpha'); });
  view.unmount();
});
