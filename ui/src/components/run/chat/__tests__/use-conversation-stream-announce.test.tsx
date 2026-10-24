import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useConversationStream } from '../use-conversation-stream';

afterEach(() => { vi.unstubAllGlobals(); delete window.pipeline; });

it.each(['success', 'failure', 'Stop'] as const)('announces the first live frame once and terminal %s once', async (outcome) => {
  const sessionId = 'ad605beb-dadc-403a-bca4-b05df6e00001';
  const announcements: string[] = [];
  window.pipeline = { selectBatchFolder: async () => null, selectSharedFolder: async () => null,
    announceSessionChanged: (id) => { announcements.push(id); } };
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finish: (response: Response) => void = () => {};
  // Only HTTP is replaced. The hook, request contracts and SSE parser are real.
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url.includes('/agent-chat/stream')) return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(next) { controller = next; init?.signal?.addEventListener('abort', () => next.close(), { once: true }); },
    })));
    if (url.endsWith('/cancel')) { finish(Response.json({ error: 'Cancelled' }, { status: 409 })); return Promise.resolve(Response.json({ status: 'cancelling' }, { status: 202 })); }
    if (init?.method === 'POST') return new Promise<Response>((resolve, reject) => {
      finish = resolve;
      init.signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
    });
    return Promise.resolve(Response.json({ messages: [], activeTurnIds: [] }));
  });
  const noop = () => {};
  const view = renderHook(() => useConversationStream({ sessionId, isDraft: false,
    onUserMessagePresenceChange: undefined, onPendingResponseChange: undefined, onSessionActivityStarted: undefined,
    onSessionUpdated: undefined, onRunPlanUpdated: undefined, onTaskStarted: undefined, onReplyLanded: noop, onSendSettled: noop }));
  await waitFor(() => { expect(view.result.current.loading).toBe(false); });
  let sent = Promise.resolve();
  act(() => { sent = view.result.current.sendTurn({ text: 'Question', target: undefined, model: null, projectContext: undefined, restoreDraft: noop }); });
  await waitFor(() => { expect(controller).toBeDefined(); });
  await act(async () => {
    controller?.enqueue(new TextEncoder().encode('id: 0\ndata: {"type":"delta","replyId":"analyst:0","text":"First","channel":"text","channelId":"turn","cursor":0}\n\nid: 1\ndata: {"type":"delta","replyId":"analyst:0","text":" second","channel":"text","channelId":"turn","cursor":1}\n\n'));
  });
  expect(announcements).toEqual([sessionId]);
  const settle = {
    success: () => finish(Response.json({ user: { id: 'user', role: 'user', text: 'Question', createdAt: '2026-10-18T10:00:00Z' },
      messages: [], dispatch: { kind: 'agents', agentNames: ['analyst'] }, meta: { replies: [] }, replayed: false })),
    failure: () => finish(new Response('Provider refused', { status: 400 })),
    Stop: () => view.result.current.abortReply(),
  };
  await act(async () => { settle[outcome](); await sent; });
  expect(announcements).toEqual([sessionId, sessionId]);
  expect(view.result.current.submitting).toBe(false);
  view.unmount();
});

it('restores busy state from an active turn and sends Stop to that exact turn', async () => {
  const sessionId = 'ad605beb-dadc-403a-bca4-b05df6e00001';
  const turnId = 'ad605beb-dadc-403a-bca4-b05df6e00002';
  const cancellations: string[] = [];
  let stopped = false;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  // Only HTTP is replaced; transcript parsing, recovery and Stop remain real.
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url.includes('/agent-chat/stream')) return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(next) { stream = next; init?.signal?.addEventListener('abort', () => next.close(), { once: true }); },
    })));
    if (url.endsWith(`/turns/${turnId}/cancel`)) {
      cancellations.push(url);
      stopped = true;
      stream?.enqueue(new TextEncoder().encode(': channel-complete\n\n'));
      return Promise.resolve(Response.json({ status: 'cancelling' }, { status: 202 }));
    }
    return Promise.resolve(Response.json({ messages: [], activeTurnIds: stopped ? [] : [turnId] }));
  });
  const noop = () => {};
  const view = renderHook(() => useConversationStream({ sessionId, isDraft: false,
    onUserMessagePresenceChange: undefined, onPendingResponseChange: undefined, onSessionActivityStarted: undefined,
    onSessionUpdated: undefined, onRunPlanUpdated: undefined, onTaskStarted: undefined, onReplyLanded: noop, onSendSettled: noop }));
  await waitFor(() => { expect(view.result.current.pendingResponse?.turnId).toBe(turnId); });
  expect(view.result.current.submitting).toBe(true);
  act(() => view.result.current.abortReply());
  await waitFor(() => { expect(cancellations).toHaveLength(1); });
  await waitFor(() => { expect(view.result.current.submitting).toBe(false); });
  view.unmount();
});

it('keeps the local send busy after Stop is accepted until the server finishes the turn', async () => {
  const sessionId = 'ad605beb-dadc-403a-bca4-b05df6e00001';
  let requestSignal: AbortSignal | null | undefined;
  let finish: (response: Response) => void = () => {};
  let cancelAccepted = false;
  // Only HTTP is replaced: cancellation acceptance is deliberately earlier than completion.
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url.includes('/agent-chat/stream')) return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { init?.signal?.addEventListener('abort', () => controller.close(), { once: true }); },
    })));
    if (url.endsWith('/cancel')) { cancelAccepted = true; return Promise.resolve(Response.json({ status: 'cancelling' }, { status: 202 })); }
    if (init?.method === 'POST') {
      requestSignal = init.signal;
      return new Promise<Response>((resolve, reject) => { finish = resolve; init.signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }); });
    }
    return Promise.resolve(Response.json({ messages: [], activeTurnIds: [] }));
  });
  const noop = () => {};
  const view = renderHook(() => useConversationStream({ sessionId, isDraft: false,
    onUserMessagePresenceChange: undefined, onPendingResponseChange: undefined, onSessionActivityStarted: undefined,
    onSessionUpdated: undefined, onRunPlanUpdated: undefined, onTaskStarted: undefined, onReplyLanded: noop, onSendSettled: noop }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  let sent = Promise.resolve();
  act(() => { sent = view.result.current.sendTurn({ text: 'Question', target: undefined, model: null, projectContext: undefined, restoreDraft: noop }); });
  act(() => view.result.current.abortReply());
  await waitFor(() => expect(cancelAccepted).toBe(true));
  expect(requestSignal?.aborted).toBe(false);
  expect(view.result.current.submitting).toBe(true);
  await act(async () => { finish(Response.json({ error: 'Cancelled' }, { status: 409 })); await sent; });
  expect(view.result.current.submitting).toBe(false);
  expect(view.result.current.error).toBeNull();
  view.unmount();
});
