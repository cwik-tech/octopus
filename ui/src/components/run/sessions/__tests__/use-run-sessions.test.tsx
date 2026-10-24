import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import {
  useRunSessions,
  type DraftSessionSources,
} from "@/components/run/sessions/use-run-sessions";
import {
  createSession,
  fetchSession,
  listSessions,
} from "@/lib/clients/session-client";
import type { SessionSummary } from "@/lib/models/session-model";

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  listSessions: vi.fn(),
}));

const requestedSession: SessionSummary = {
  id: "requested-session",
  title: "Requested session",
  status: "active",
  activityType: "workflow",
  createdAt: "2026-08-20T12:00:00.000Z",
  updatedAt: "2026-08-20T12:00:00.000Z",
};

const startupSession: SessionSummary = {
  ...requestedSession,
  id: "startup-session",
  title: "Startup session",
  activityType: "chat",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listSessions).mockResolvedValue([]);
  vi.mocked(fetchSession).mockResolvedValue(requestedSession);
});

it("keeps an externally requested session selected when a materialization finishes later", async () => {
  let finishCreate: ((session: SessionSummary) => void) | undefined;
  vi.mocked(createSession).mockReturnValue(
    new Promise<SessionSummary>((resolve) => {
      finishCreate = resolve;
    }),
  );

  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const { result, rerender } = renderHook(
    ({ request }) =>
      useRunSessions({ draftSources, sessionSelectionRequest: request }),
    {
      initialProps: {
        request: undefined as
          | { id: string; requestId: string }
          | undefined,
      },
    },
  );

  // The draft starts materializing, then the user opens a session from the
  // sidebar before the create comes back.
  act(() => {
    void result.current.ensureSession();
  });
  rerender({
    request: { id: requestedSession.id, requestId: "open-requested" },
  });
  await waitFor(() => {
    expect(result.current.selectedSession?.id).toBe(requestedSession.id);
  });

  await act(async () => {
    finishCreate?.(draftSummary(DRAFT_A));
    await Promise.resolve();
  });

  expect(result.current.selectedSession?.id).toBe(requestedSession.id);
});

/* ------------------------------------------------------------------ */
/*  Deferred creation: the draft                                       */
/* ------------------------------------------------------------------ */

/**
 * Draft identity is injected so each test can name the draft it is talking
 * about. Ids are handed out in order; a draft takes two — its id, then its
 * creation token.
 */
function scriptedDraftSources(ids: string[]): DraftSessionSources {
  let next = 0;
  return {
    newId: () => {
      const id = ids[next];
      next += 1;
      if (id === undefined) throw new Error("scripted ids exhausted");
      return id;
    },
    now: () => new Date("2026-09-06T00:00:00.000Z"),
  };
}

/** The selected id, narrowed rather than asserted non-null. */
function selectedIdOf(selectedSessionId: string | null): string {
  expect(selectedSessionId).not.toBeNull();
  if (selectedSessionId === null) throw new Error("no session is selected");
  return selectedSessionId;
}

const DRAFT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN_A = "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb";
const DRAFT_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN_B = "cccccccc-cccc-4ccc-8ccc-dddddddddddd";

function draftSummary(id: string): SessionSummary {
  return { ...startupSession, id, title: "Untitled session" };
}

it("opens on a client-only draft without creating anything", async () => {
  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const { result } = renderHook(() => useRunSessions({ draftSources }));

  await waitFor(() => {
    expect(result.current.selectedSession).not.toBeNull();
  });
  expect(createSession).not.toHaveBeenCalled();
  expect(result.current.sessions).toEqual([]);
  expect(result.current.selectedSessionId).toBe(DRAFT_A);
  expect(result.current.isDraftSession(DRAFT_A)).toBe(true);
});

it("creates exactly one session when concurrent triggers materialize a draft", async () => {
  vi.mocked(createSession).mockResolvedValue(draftSummary(DRAFT_A));
  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const { result } = renderHook(() => useRunSessions({ draftSources }));
  await waitFor(() => expect(result.current.selectedSession).not.toBeNull());

  await act(async () => {
    await Promise.all([
      result.current.ensureSession(),
      result.current.ensureSession(),
      result.current.ensureSession(),
    ]);
  });

  expect(createSession).toHaveBeenCalledWith({
    id: DRAFT_A,
    creationToken: TOKEN_A,
  });
  expect(createSession).toHaveBeenCalledTimes(1);
  expect(result.current.isDraftSession(DRAFT_A)).toBe(false);
});

it("keeps a materialized draft when the initial session list resolves later", async () => {
  let finishList: ((sessions: SessionSummary[]) => void) | undefined;
  vi.mocked(listSessions).mockReturnValue(
    new Promise<SessionSummary[]>((resolve) => {
      finishList = resolve;
    }),
  );
  vi.mocked(createSession).mockResolvedValue(draftSummary(DRAFT_A));
  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const { result } = renderHook(() => useRunSessions({ draftSources }));
  await waitFor(() => expect(listSessions).toHaveBeenCalledOnce());

  await act(async () => {
    await result.current.ensureSession();
  });
  expect(result.current.sessions.map((session) => session.id)).toEqual([DRAFT_A]);

  await act(async () => {
    finishList?.([]);
    await Promise.resolve();
  });

  await waitFor(() => {
    expect(result.current.sessions.map((session) => session.id)).toEqual([
      DRAFT_A,
    ]);
  });
});

it("does not restore a session deleted while the initial list is pending", async () => {
  let finishList: ((sessions: SessionSummary[]) => void) | undefined;
  vi.mocked(listSessions).mockReturnValue(
    new Promise<SessionSummary[]>((resolve) => {
      finishList = resolve;
    }),
  );
  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const { result, rerender } = renderHook(
    ({ deletionRequest }) =>
      useRunSessions({
        draftSources,
        sessionDeletionRequest: deletionRequest,
      }),
    {
      initialProps: {
        deletionRequest: undefined as
          | { id: string; requestId: string }
          | undefined,
      },
    },
  );
  await waitFor(() => expect(listSessions).toHaveBeenCalledOnce());

  rerender({
    deletionRequest: {
      id: startupSession.id,
      requestId: "delete-before-list",
    },
  });
  await waitFor(() => expect(result.current.sessions).toEqual([]));

  await act(async () => {
    finishList?.([startupSession]);
    await Promise.resolve();
  });

  await waitFor(() => expect(result.current.sessions).toEqual([]));
  expect(result.current.isDraftSession(startupSession.id)).toBe(true);
});

it("ignores a selected-session fetch that resolves after that session is deleted", async () => {
  let finishFetch: ((session: SessionSummary) => void) | undefined;
  vi.mocked(fetchSession).mockReturnValue(
    new Promise<SessionSummary>((resolve) => {
      finishFetch = resolve;
    }),
  );
  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const selectionRequest = {
    id: startupSession.id,
    requestId: "fetch-before-delete",
  };
  const { result, rerender } = renderHook(
    ({ deletionRequest }) =>
      useRunSessions({
        draftSources,
        sessionDeletionRequest: deletionRequest,
        sessionSelectionRequest: selectionRequest,
      }),
    {
      initialProps: {
        deletionRequest: undefined as
          | { id: string; requestId: string }
          | undefined,
      },
    },
  );
  await waitFor(() => expect(fetchSession).toHaveBeenCalledOnce());

  rerender({
    deletionRequest: {
      id: startupSession.id,
      requestId: "delete-before-fetch",
    },
  });

  await act(async () => {
    finishFetch?.(startupSession);
    await Promise.resolve();
  });

  await waitFor(() => expect(result.current.sessions).toEqual([]));
});

it("ignores a selected-session fetch failure after that session is deleted", async () => {
  let failFetch: ((reason: unknown) => void) | undefined;
  vi.mocked(fetchSession).mockReturnValue(
    new Promise<SessionSummary>((_resolve, reject) => {
      failFetch = reject;
    }),
  );
  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const selectionRequest = {
    id: startupSession.id,
    requestId: "fetch-failure-before-delete",
  };
  const { result, rerender } = renderHook(
    ({ deletionRequest }) =>
      useRunSessions({
        draftSources,
        sessionDeletionRequest: deletionRequest,
        sessionSelectionRequest: selectionRequest,
      }),
    {
      initialProps: {
        deletionRequest: undefined as
          | { id: string; requestId: string }
          | undefined,
      },
    },
  );
  await waitFor(() => expect(fetchSession).toHaveBeenCalledOnce());

  rerender({
    deletionRequest: {
      id: startupSession.id,
      requestId: "delete-before-fetch-failure",
    },
  });

  await act(async () => {
    failFetch?.(new Error("stale selected-session failure"));
    await Promise.resolve();
  });

  await waitFor(() => expect(result.current.sessionsError).toBeNull());
});

it("does not create again once a draft has been materialized", async () => {
  vi.mocked(createSession).mockResolvedValue(draftSummary(DRAFT_A));
  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const { result } = renderHook(() => useRunSessions({ draftSources }));
  await waitFor(() => expect(result.current.selectedSession).not.toBeNull());

  await act(async () => {
    await result.current.ensureSession();
  });
  await act(async () => {
    await result.current.ensureSession();
    await result.current.ensureSession();
  });

  expect(createSession).toHaveBeenCalledTimes(1);
});

it("keeps the draft id and stays unmaterialized when creation conflicts", async () => {
  vi.mocked(createSession).mockRejectedValue(
    new Error("Session id is already in use"),
  );
  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const { result } = renderHook(() => useRunSessions({ draftSources }));
  await waitFor(() => expect(result.current.selectedSession).not.toBeNull());

  await act(async () => {
    await expect(result.current.ensureSession()).rejects.toThrow();
  });

  expect(result.current.selectedSessionId).toBe(DRAFT_A);
  expect(result.current.isDraftSession(DRAFT_A)).toBe(true);
  expect(result.current.sessionsError).toContain("already in use");
});

it("does not mark a replacement draft materialized when an earlier create resolves", async () => {
  let finishFirst: ((session: SessionSummary) => void) | undefined;
  vi.mocked(createSession).mockReturnValue(
    new Promise<SessionSummary>((resolve) => {
      finishFirst = resolve;
    }),
  );
  const draftSources = scriptedDraftSources([
    DRAFT_A,
    TOKEN_A,
    DRAFT_B,
    TOKEN_B,
  ]);
  const { result } = renderHook(() => useRunSessions({ draftSources }));
  await waitFor(() => expect(result.current.selectedSession).not.toBeNull());

  act(() => {
    void result.current.ensureSession();
  });
  await act(async () => {
    await result.current.handleCreateSession();
  });
  expect(selectedIdOf(result.current.selectedSessionId)).toBe(DRAFT_B);

  await act(async () => {
    finishFirst?.(draftSummary(DRAFT_A));
    await Promise.resolve();
  });

  expect(result.current.selectedSessionId).toBe(DRAFT_B);
  expect(result.current.isDraftSession(DRAFT_B)).toBe(true);
  expect(result.current.isDraftSession(DRAFT_A)).toBe(false);
});

it("treats sessions the server already knows about as materialized", async () => {
  vi.mocked(listSessions).mockResolvedValue([requestedSession]);
  const fetched: SessionSummary = { ...requestedSession, id: "fetched-session" };
  vi.mocked(fetchSession).mockResolvedValue(fetched);

  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const { result, rerender } = renderHook(
    ({ request }) =>
      useRunSessions({ draftSources, sessionSelectionRequest: request }),
    {
      initialProps: {
        request: undefined as { id: string; requestId: string } | undefined,
      },
    },
  );

  await waitFor(() => {
    expect(result.current.isDraftSession(requestedSession.id)).toBe(false);
  });

  rerender({ request: { id: fetched.id, requestId: "open-fetched" } });

  await waitFor(() => {
    expect(result.current.isDraftSession(fetched.id)).toBe(false);
  });
});

it("retries a failed create with the same id and token", async () => {
  vi.mocked(createSession)
    .mockRejectedValueOnce(new Error("Network is down"))
    .mockResolvedValueOnce(draftSummary(DRAFT_A));
  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const { result } = renderHook(() => useRunSessions({ draftSources }));
  await waitFor(() => expect(result.current.selectedSession).not.toBeNull());

  await act(async () => {
    await expect(result.current.ensureSession()).rejects.toThrow("Network is down");
  });
  expect(result.current.isDraftSession(DRAFT_A)).toBe(true);

  // The settled attempt must not be left in the way of the next trigger, and
  // the retry has to present the same claim — a new one would be a new session.
  await act(async () => {
    await result.current.ensureSession();
  });
  expect(createSession).toHaveBeenCalledTimes(2);
  expect(vi.mocked(createSession).mock.calls).toEqual([
    [{ id: DRAFT_A, creationToken: TOKEN_A }],
    [{ id: DRAFT_A, creationToken: TOKEN_A }],
  ]);
  expect(result.current.isDraftSession(DRAFT_A)).toBe(false);
});

it("does not report an abandoned draft's failure against the draft that replaced it", async () => {
  let failFirst: ((error: Error) => void) | undefined;
  vi.mocked(createSession).mockReturnValueOnce(
    new Promise<SessionSummary>((_resolve, reject) => {
      failFirst = reject;
    }),
  );
  const draftSources = scriptedDraftSources([
    DRAFT_A,
    TOKEN_A,
    DRAFT_B,
    TOKEN_B,
  ]);
  const { result } = renderHook(() => useRunSessions({ draftSources }));
  await waitFor(() => expect(result.current.selectedSession).not.toBeNull());

  act(() => {
    void result.current.ensureSession().catch(() => undefined);
  });
  expect(result.current.creatingSession).toBe(true);

  await act(async () => {
    await result.current.handleCreateSession();
  });
  expect(result.current.selectedSessionId).toBe(DRAFT_B);
  // A create belonging to a conversation the user has left must not narrate
  // the one they are looking at now.
  expect(result.current.creatingSession).toBe(false);

  await act(async () => {
    failFirst?.(new Error("Draft A could not be created"));
    await Promise.resolve();
  });

  expect(result.current.sessionsError).toBeNull();
  expect(result.current.creatingSession).toBe(false);
});

it("notifies the parent when a create resolves for the draft still on screen", async () => {
  const onSessionCreated = vi.fn();
  vi.mocked(createSession).mockResolvedValue(draftSummary(DRAFT_A));
  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const { result } = renderHook(() =>
    useRunSessions({ draftSources, onSessionCreated }),
  );
  await waitFor(() => expect(result.current.selectedSession).not.toBeNull());

  await act(async () => {
    await result.current.ensureSession();
  });

  expect(onSessionCreated).toHaveBeenCalledTimes(1);
  expect(onSessionCreated).toHaveBeenCalledWith(DRAFT_A);
});

it("does not re-select an abandoned draft when its create resolves", async () => {
  const onSessionCreated = vi.fn();
  let finishFirst: ((session: SessionSummary) => void) | undefined;
  vi.mocked(createSession).mockReturnValueOnce(
    new Promise<SessionSummary>((resolve) => {
      finishFirst = resolve;
    }),
  );
  const draftSources = scriptedDraftSources([
    DRAFT_A,
    TOKEN_A,
    DRAFT_B,
    TOKEN_B,
  ]);
  const { result } = renderHook(() =>
    useRunSessions({ draftSources, onSessionCreated }),
  );
  await waitFor(() => expect(result.current.selectedSession).not.toBeNull());

  act(() => {
    void result.current.ensureSession();
  });
  await act(async () => {
    await result.current.handleCreateSession();
  });
  expect(result.current.selectedSessionId).toBe(DRAFT_B);

  await act(async () => {
    finishFirst?.(draftSummary(DRAFT_A));
    await Promise.resolve();
  });

  // The parent turns this notification into a selection request. Announcing a
  // conversation the user has already left would drag them back into it,
  // discarding whatever they had started writing in its replacement.
  expect(onSessionCreated).not.toHaveBeenCalled();
  expect(result.current.selectedSessionId).toBe(DRAFT_B);
  // A is real all the same, and stays listed so it can be opened deliberately.
  expect(result.current.sessions.map((session) => session.id)).toContain(
    DRAFT_A,
  );
});

it("prunes an abandoned draft once when its create fails, leaving no error behind", async () => {
  const onSessionDeleted = vi.fn();
  let failFirst: ((error: Error) => void) | undefined;
  vi.mocked(createSession).mockReturnValueOnce(
    new Promise<SessionSummary>((_resolve, reject) => {
      failFirst = reject;
    }),
  );
  const draftSources = scriptedDraftSources([
    DRAFT_A,
    TOKEN_A,
    DRAFT_B,
    TOKEN_B,
  ]);
  const { result } = renderHook(() =>
    useRunSessions({ draftSources, onSessionDeleted }),
  );
  await waitFor(() => expect(result.current.selectedSession).not.toBeNull());

  act(() => {
    void result.current.ensureSession().catch(() => undefined);
  });
  await act(async () => {
    await result.current.handleCreateSession();
  });
  // A is still in flight, so New could not yet know it would come to nothing.
  expect(onSessionDeleted).not.toHaveBeenCalled();

  await act(async () => {
    failFirst?.(new Error("Draft A could not be created"));
    await Promise.resolve();
  });

  // Now it has come to nothing: the id names no session anywhere, so the state
  // keyed by it is released, once.
  expect(onSessionDeleted).toHaveBeenCalledTimes(1);
  expect(onSessionDeleted).toHaveBeenCalledWith(DRAFT_A);
  expect(result.current.sessionsError).toBeNull();

  // Selecting B tells us nothing about A's error, because the panel only ever
  // shows the selected conversation's own. Looking at A's id again is the only
  // way to see whether the message was released or merely hidden.
  act(() => {
    result.current.selectSession(DRAFT_A);
  });
  expect(result.current.sessionsError).toBeNull();
});

it("shows the selected draft's creation failure even after session loading failed", async () => {
  vi.mocked(listSessions).mockRejectedValue(new Error("Sessions unavailable"));
  vi.mocked(createSession).mockRejectedValue(new Error("Create refused"));
  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const { result } = renderHook(() => useRunSessions({ draftSources }));
  await waitFor(() => {
    expect(result.current.sessionsError).toBe("Sessions unavailable");
  });

  await act(async () => {
    await expect(result.current.ensureSession()).rejects.toThrow();
  });

  // What just failed is what the user just did. A stale workspace-level error
  // must not stand in front of it.
  expect(result.current.sessionsError).toBe("Create refused");
});

it("does not announce a draft selected away from in the same tick as its create", async () => {
  const onSessionCreated = vi.fn();
  let finishFirst: ((session: SessionSummary) => void) | undefined;
  vi.mocked(createSession).mockReturnValueOnce(
    new Promise<SessionSummary>((resolve) => {
      finishFirst = resolve;
    }),
  );
  vi.mocked(listSessions).mockResolvedValue([requestedSession]);
  const draftSources = scriptedDraftSources([DRAFT_A, TOKEN_A]);
  const { result } = renderHook(() =>
    useRunSessions({ draftSources, onSessionCreated }),
  );
  await waitFor(() => expect(result.current.selectedSession).not.toBeNull());

  act(() => {
    void result.current.ensureSession();
  });

  // Selecting an existing session and the create coming back land in the same
  // tick. Selection has to be visible to the create the instant it is made:
  // deferring it to an effect leaves the guard reading the conversation the
  // user has just left.
  await act(async () => {
    result.current.selectSession(requestedSession.id);
    finishFirst?.(draftSummary(DRAFT_A));
    await Promise.resolve();
  });

  expect(onSessionCreated).not.toHaveBeenCalled();
  expect(result.current.selectedSessionId).toBe(requestedSession.id);
});
