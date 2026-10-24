import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
  fetchSession as apiFetchSession,
  listSessions as apiListSessions,
} from "@/lib/clients/session-client";
import type { SessionSummary } from "@/lib/models/session-model";

/** What an unused conversation is called before it has earned a real title. */
const DRAFT_SESSION_TITLE = "New chat";

/**
 * A conversation that exists only here.
 *
 * It carries a real id from its first render, which is the whole point: every
 * React key, state map, and file owner is keyed by that id before the session
 * is durable, and they all keep working unchanged at the moment it becomes so.
 * The token beside it is what proves, on a retry, that this client is the one
 * that minted the id.
 */
interface DraftSession {
  id: string;
  creationToken: string;
  session: SessionSummary;
}

/**
 * Where a draft's identity and timestamps come from.
 *
 * Injected rather than read from the global `crypto` and `Date` so a test can
 * state which draft it is talking about instead of matching a UUID pattern and
 * hoping.
 */
export interface DraftSessionSources {
  newId: () => string;
  now: () => Date;
}

const defaultDraftSources: DraftSessionSources = {
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};

function newDraftSession(sources: DraftSessionSources): DraftSession {
  const id = sources.newId();
  const timestamp = sources.now().toISOString();
  return {
    id,
    creationToken: sources.newId(),
    session: {
      id,
      title: DRAFT_SESSION_TITLE,
      status: "idle",
      activityType: "chat",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function deletionVersionOf(
  versions: Readonly<Record<string, number>>,
  sessionId: string,
): number {
  return versions[sessionId] ?? 0;
}

export function useRunSessions({
  draftSources = defaultDraftSources,
  onCreateSessionActionChange,
  onSessionCreated,
  onSessionDeleted,
  sessionDeletionRequest,
  sessionSelectionRequest,
}: {
  draftSources?: DraftSessionSources;
  onCreateSessionActionChange?: ((action: (() => void) | null) => void) | undefined;
  onSessionCreated?: ((sessionId: string) => void) | undefined;
  /**
   * Prune per-session keyed state (run plans, agent names). Called after a
   * delete, and after a draft is abandoned without ever having been created —
   * both leave an id nothing will refer to again.
   */
  onSessionDeleted?: (sessionId: string) => void;
  sessionDeletionRequest?: { id: string; requestId: string } | null | undefined;
  sessionSelectionRequest?: { id: string; requestId: string } | null | undefined;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const sourcesRef = useRef(draftSources);
  const [draft, setDraft] = useState<DraftSession>(() =>
    newDraftSession(draftSources),
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    () => draft.id,
  );
  /**
   * Which drafts are being created, and what went wrong for each.
   *
   * Keyed by id rather than held as one flag and one message: a create belongs
   * to the conversation that started it, and the user may well have moved to
   * another one before it settles. A shared flag would leave the new draft
   * looking busy, and a shared message would blame it for a failure that was
   * not its own.
   */
  const [creatingSessionIds, setCreatingSessionIds] = useState<
    ReadonlySet<string>
  >(() => new Set<string>());
  const [creationErrorBySessionId, setCreationErrorBySessionId] = useState<
    Readonly<Record<string, string>>
  >({});
  /**
   * Which ids the server is known to hold. Keyed by id rather than carried as
   * one flag, so a create that resolves after the user has moved on marks the
   * session it actually made and nothing else. Seeded from every server answer,
   * because a session opened from the sidebar or the Library was never a draft
   * here and must not be gated as one.
   */
  const [materializedIds, setMaterializedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  /**
   * The authoritative copy. Written synchronously by `rememberMaterialized`
   * and never re-derived from state during render: a render between that write
   * and its commit would otherwise put the old set back, and a create that had
   * already resolved would look unfinished.
   */
  const materializedIdsRef = useRef(materializedIds);
  /**
   * A list or fetch that started before a deletion is stale for that id. The
   * per-id version lets those responses be ignored without blocking a later,
   * explicit selection of a session recreated under the same id.
   */
  const deletionVersionBySessionIdRef = useRef<Record<string, number>>({});
  /** One create per draft in flight; entries are dropped once they settle. */
  const creationAttemptsRef = useRef(new Map<string, Promise<SessionSummary>>());
  /**
   * What `ensureSession` reads. Kept in refs because it is called from event
   * handlers whose closures must see the current draft and selection, and
   * synced in an effect rather than during render.
   */
  const draftRef = useRef(draft);
  const selectedSessionIdRef = useRef(selectedSessionId);
  useEffect(() => {
    sourcesRef.current = draftSources;
    draftRef.current = draft;
    selectedSessionIdRef.current = selectedSessionId;
  }, [draft, draftSources, selectedSessionId]);

  const markCreating = useCallback((sessionId: string, creating: boolean) => {
    setCreatingSessionIds((current) => {
      if (current.has(sessionId) === creating) return current;
      const next = new Set(current);
      if (creating) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);

  const clearCreationError = useCallback((sessionId: string) => {
    setCreationErrorBySessionId((current) => {
      if (!(sessionId in current)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  const recordSessionDeletion = useCallback((sessionId: string) => {
    deletionVersionBySessionIdRef.current[sessionId] =
      deletionVersionOf(deletionVersionBySessionIdRef.current, sessionId) + 1;
  }, []);

  const rememberMaterialized = useCallback((...ids: string[]) => {
    const missing = ids.filter((id) => !materializedIdsRef.current.has(id));
    if (missing.length === 0) return;
    const next = new Set(materializedIdsRef.current);
    for (const id of missing) next.add(id);
    // Written to the ref as well as to state, so a create resolving in the same
    // tick as another sees the decision immediately rather than on re-render.
    materializedIdsRef.current = next;
    setMaterializedIds(next);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadExistingSessions() {
      const deletionVersionsAtRequest = {
        ...deletionVersionBySessionIdRef.current,
      };
      startTransition(() => {
        setSessionsLoading(true);
      });

      try {
        const existing = await apiListSessions();
        if (cancelled) return;
        const existingStillCurrent = existing.filter(
          (session) =>
            deletionVersionOf(
              deletionVersionBySessionIdRef.current,
              session.id,
            ) === deletionVersionOf(deletionVersionsAtRequest, session.id),
        );
        rememberMaterialized(
          ...existingStillCurrent.map((session) => session.id),
        );
        startTransition(() => {
          setSessions((current) => {
            const currentIds = new Set(current.map((session) => session.id));
            return [
              ...current,
              ...existingStillCurrent.filter(
                (session) =>
                  !currentIds.has(session.id) &&
                  deletionVersionOf(
                    deletionVersionBySessionIdRef.current,
                    session.id,
                  ) === deletionVersionOf(deletionVersionsAtRequest, session.id),
              ),
            ];
          });
          setSessionsError(null);
        });
      } catch (error) {
        if (cancelled) return;
        startTransition(() => {
          setSessionsError(error instanceof Error ? error.message : String(error));
        });
      } finally {
        if (!cancelled) {
          startTransition(() => {
            setSessionsLoading(false);
          });
        }
      }
    }

    void loadExistingSessions();
    return () => {
      cancelled = true;
    };
  }, [rememberMaterialized]);

  /**
   * Make the selected draft durable, or report that it already is.
   *
   * Deduplicated per draft id, so a file drop racing a send produces one
   * create. A failure clears the attempt and leaves the draft exactly as it
   * was — its id, its composer text, and anything already keyed by it — so the
   * next trigger can try again. A conflict is surfaced, never worked around by
   * minting a different id: state already keyed by this one would be stranded.
   */
  const ensureSession = useCallback(async (): Promise<string> => {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId) throw new Error("No session is selected");
    // Already durable, whether this hook created it or the server had it all
    // along. Checked before the draft comparison so a second trigger after a
    // successful create is a no-op rather than a second create.
    if (materializedIdsRef.current.has(sessionId)) return sessionId;
    const currentDraft = draftRef.current;
    if (sessionId !== currentDraft.id) return sessionId;

    const inFlight = creationAttemptsRef.current.get(sessionId);
    if (inFlight) {
      await inFlight;
      return sessionId;
    }

    const attempt = apiCreateSession({
      id: currentDraft.id,
      creationToken: currentDraft.creationToken,
    });
    creationAttemptsRef.current.set(sessionId, attempt);
    markCreating(sessionId, true);
    try {
      const session = await attempt;
      rememberMaterialized(session.id);
      setSessions((current) => [
        session,
        ...current.filter((item) => item.id !== session.id),
      ]);
      clearCreationError(sessionId);
      // Announced only while this is still the conversation on screen. The
      // parent turns the notification into a selection request, so telling it
      // about a draft the user has already left would drag them back into it
      // and discard whatever they had started writing in its replacement. The
      // session stays in the list either way: it is real, and openable.
      if (selectedSessionIdRef.current === sessionId) {
        onSessionCreated?.(session.id);
      }
      return session.id;
    } catch (error) {
      setCreationErrorBySessionId((current) => ({
        ...current,
        [sessionId]: error instanceof Error ? error.message : String(error),
      }));
      // A draft the user left, whose create then failed, names no session
      // anywhere. New could not release its state at the time, because the
      // create was still in flight and might yet have produced something; this
      // is the moment that question is settled.
      if (
        draftRef.current.id !== sessionId &&
        !materializedIdsRef.current.has(sessionId)
      ) {
        clearCreationError(sessionId);
        onSessionDeleted?.(sessionId);
      }
      throw error;
    } finally {
      // Dropped either way. A settled attempt is not a promise anyone should
      // await again, and the materialized set is what makes a repeat call
      // idempotent from here on.
      creationAttemptsRef.current.delete(sessionId);
      markCreating(sessionId, false);
    }
  }, [
    clearCreationError,
    markCreating,
    onSessionCreated,
    onSessionDeleted,
    rememberMaterialized,
  ]);

  /**
   * Open a conversation.
   *
   * The ref is written first, synchronously. A create resolving in the same
   * tick reads it to decide whether to announce itself, and React's own state
   * is a commit away — long enough for the guard to still see the conversation
   * the user has just left, and announce that one instead.
   */
  const selectSession = useCallback((sessionId: string) => {
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
  }, []);

  const isDraftSession = useCallback(
    (sessionId: string) => !materializedIds.has(sessionId),
    [materializedIds],
  );

  /**
   * New starts a fresh draft rather than persisting an empty session. A draft
   * it replaces that was never created leaves an id nothing will name again,
   * so the per-session state keyed by it is pruned with it.
   */
  const handleCreateSession = useCallback(() => {
    const replaced = draftRef.current;
    const next = newDraftSession(sourcesRef.current);
    draftRef.current = next;
    selectedSessionIdRef.current = next.id;
    setDraft(next);
    setSelectedSessionId(next.id);
    clearCreationError(replaced.id);
    const abandoned =
      !materializedIdsRef.current.has(replaced.id) &&
      !creationAttemptsRef.current.has(replaced.id);
    if (abandoned) onSessionDeleted?.(replaced.id);
  }, [clearCreationError, onSessionDeleted]);

  useEffect(() => {
    onCreateSessionActionChange?.(() => {
      handleCreateSession();
    });
    return () => onCreateSessionActionChange?.(null);
  }, [handleCreateSession, onCreateSessionActionChange]);

  useEffect(() => {
    if (!sessionSelectionRequest) return;
    const sessionId = sessionSelectionRequest.id;
    const deletionVersionAtRequest = deletionVersionOf(
      deletionVersionBySessionIdRef.current,
      sessionId,
    );
    let cancelled = false;
    const requestIsStale = () =>
      cancelled ||
      deletionVersionOf(
        deletionVersionBySessionIdRef.current,
        sessionId,
      ) !== deletionVersionAtRequest;

    selectSession(sessionId);
    void apiFetchSession(sessionId)
      .then((session) => {
        if (requestIsStale()) return;
        // A session the server answered for is not a draft, whatever this hook
        // has minted locally.
        rememberMaterialized(session.id);
        setSessions((current) => [
          session,
          ...current.filter((item) => item.id !== session.id),
        ]);
        setSessionsError(null);
      })
      .catch((error: unknown) => {
        if (requestIsStale()) return;
        setSessionsError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [rememberMaterialized, selectSession, sessionSelectionRequest]);

  useEffect(() => {
    if (!sessionDeletionRequest) return;
    recordSessionDeletion(sessionDeletionRequest.id);
    setSessions((current) =>
      current.filter((session) => session.id !== sessionDeletionRequest.id),
    );
    setSelectedSessionId((current) => {
      const next = current === sessionDeletionRequest.id ? null : current;
      selectedSessionIdRef.current = next;
      return next;
    });
  }, [recordSessionDeletion, sessionDeletionRequest]);

  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await apiDeleteSession(id);
      recordSessionDeletion(id);
      setSessions((current) => current.filter((session) => session.id !== id));
      onSessionDeleted?.(id);
      setSelectedSessionId((current) => {
        if (current !== id) return current;
        const remaining = sessions.filter((session) => session.id !== id);
        const next = remaining[0]?.id ?? null;
        selectedSessionIdRef.current = next;
        return next;
      });
    } catch (error) {
      setSessionsError(error instanceof Error ? error.message : String(error));
    }
  }, [onSessionDeleted, recordSessionDeletion, sessions]);

  const handleSessionUpdated = useCallback((updated: SessionSummary) => {
    rememberMaterialized(updated.id);
    setSessions((current) => {
      const exists = current.some((session) => session.id === updated.id);
      const next = exists
        ? current.map((session) => (session.id === updated.id ? updated : session))
        : [updated, ...current];
      return [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }, [rememberMaterialized]);

  // ── cmd-K: start a new draft ──────────────────────────────────────────────
  // Scoped to the Run tab via natural lifecycle (cleaned up when RunPanel
  // unmounts / tab becomes hidden). Guarded against inputs so it doesn't
  // interfere with browser built-ins or user text entry.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key === 'k')) return;
      const active = document.activeElement;
      if (
        active?.tagName === 'INPUT' ||
        active?.tagName === 'TEXTAREA' ||
        (active as HTMLElement | null)?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      handleCreateSession();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handleCreateSession]);

  const selectedSession = useMemo(() => {
    if (!selectedSessionId) return null;
    const known = sessions.find((session) => session.id === selectedSessionId);
    if (known) return known;
    return selectedSessionId === draft.id ? draft.session : null;
  }, [draft, selectedSessionId, sessions]);

  const selectedCreationError = selectedSessionId
    ? creationErrorBySessionId[selectedSessionId] ?? null
    : null;

  return {
    // Scoped to what is on screen. Loading and fetching failures are about the
    // workspace and stay global; a create belongs to one conversation.
    creatingSession: selectedSessionId
      ? creatingSessionIds.has(selectedSessionId)
      : false,
    ensureSession,
    handleCreateSession,
    handleDeleteSession,
    handleSessionUpdated,
    isDraftSession,
    selectSession,
    selectedSession,
    selectedSessionId,
    sessions,
    sessionsError: selectedCreationError ?? sessionsError,
    sessionsLoading,
  };
}
