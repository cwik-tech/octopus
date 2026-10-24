/// <reference types="node" />
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { resourceLibraryBrowserSnapshotSchema } from '@contracts/resource-library';

it.each([{ outcome: 'snapshot', status: 200, error: null }, { outcome: 'error', status: 503, error: 'Older refresh failed' }])('keeps the selected skill and current snapshot when an older section refresh finishes late ($outcome)', async ({ status, error }) => {
  const snapshot = resourceLibraryBrowserSnapshotSchema.parse({
    schemaVersion: 1, generation: 1, generationId: 'catalog-1',
    agents: [], teams: [], packages: [], agentDetails: [], teamDetails: [],
    skills: [{ id: 'skill-one', slug: 'planning', displayName: 'planning', description: '', origin: 'library', provenance: [], archived: false, currentRevisionId: 'revision-one', revisions: [{ id: 'revision-one', sequence: 1, parentRevisionId: null, digest: `sha256:${'0'.repeat(64)}`, createdAt: '2026-10-19T12:00:00.000Z', changeNote: '', files: [] }] }],
  });
  let receiveOlderResponse: (response: ServerResponse) => void = () => { throw new Error('Response receiver not initialized'); };
  const olderResponse = new Promise<ServerResponse>((resolve) => { receiveOlderResponse = resolve; });
  let resourceRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (!request.url?.endsWith('/resource-library')) {
      response.end(JSON.stringify({ projects: [] }));
      return;
    }
    resourceRequests += 1;
    if (resourceRequests === 2) {
      receiveOlderResponse(response);
      return;
    }
    response.end(JSON.stringify({ ...snapshot, generation: resourceRequests, generationId: `catalog-${resourceRequests}` }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  sessionStorage.setItem('pipeline.desktop-api-base-url', `http://127.0.0.1:${address.port}/_pipeline/${'a'.repeat(43)}`);
  vi.resetModules();
  const { useLibraryWorkspaceController } = await import('../use-library-workspace-controller');
  const hook = renderHook(() => useLibraryWorkspaceController({ activeTab: 'library' }));
  try {
    await waitFor(() => expect(hook.result.current.resourcesLoading).toBe(false));
    let olderRefresh: Promise<void> = Promise.resolve();
    act(() => { olderRefresh = hook.result.current.refreshResources(); });
    const response = await olderResponse;
    act(() => hook.result.current.changeSection('skills'));
    await waitFor(() => expect(hook.result.current.resourceSnapshot?.generation).toBe(3));
    act(() => hook.result.current.selectResource('skill-one'));

    await act(async () => {
      response.statusCode = status;
      response.end(JSON.stringify(error === null ? { ...snapshot, generation: 2, generationId: 'catalog-2' } : { error }));
      await olderRefresh;
    });

    expect(hook.result.current.selectedResourceId).toBe('skill-one');
    expect(hook.result.current.resourceSnapshot?.generation).toBe(3);
    expect(hook.result.current.resourcesError).toBeNull();
  } finally {
    hook.unmount();
    sessionStorage.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
