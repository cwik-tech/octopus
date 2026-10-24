import { useObservedTurns } from "./use-observed-turns";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import type { ModelChoiceOffer } from "@contracts/model-choice";
import { invalidateAgentProviderHealth } from "@/lib/clients/agent-provider-health-signal";
import { turnReportedProviderFailure } from "@/components/run/chat/turn-provider-failure";
import { folderToolsNoticeAfter } from "@/components/run/chat/folder-tools-notice";
import type { ModelChoice } from "@/lib/utils/model-catalog";
import {
  listChatMessages as apiListChatMessages,
  cancelAgentChatTurn,
  postSessionMessage as apiPostSessionMessage,
  openAgentTextStream as apiOpenAgentTextStream,
} from "@/lib/clients/session-client";
import type {
  ChatMessage,
  RunPlan,
  SessionSummary,
  SessionTask,
  WorkspaceProjectContextSelection,
} from "@/lib/models/session-model";
import type { SessionMessageTarget } from "@contracts/schemas/session-requests";
import {
  conversationTurnMessageId,
  isAgentsDispatch,
  isPlanBearingDispatch,
  isTeamDispatch,
} from "@contracts/sessions";
import type { ConversationTurnOutcome } from "@contracts/sessions";
import {
  applyStreamDelivery,
  EMPTY_STREAMED_TURN,
  type StreamedTurn,
} from "@/lib/chat/streamed-turn";

export interface PendingChatResponse {
  sessionId: string;
  /**
   * The client-minted turn id for the in-flight request. It is the
   * same id its research steps journal as their run id, so the research group
   * it belongs to can be told apart from older, unclaimed groups.
   */
  turnId?: string;
  /** Who the turn was addressed to, read from the target that was sent. */
  agentNames: string[];
  teamId: string | null;
}

/**
 * Who the bubble should say is answering.
 *
 * Read from the target the request actually carried rather than from a
 * standing selection beside it. The two can disagree — a mention overrides the
 * picker for one turn, and a Team may be on screen as history — and announcing
 * the selection would name work that was never dispatched.
 */
function addressedIdentity(
  turnTarget: SessionMessageTarget | undefined,
): Pick<PendingChatResponse, "agentNames" | "teamId"> {
  if (turnTarget?.kind === "team") {
    return { agentNames: [], teamId: turnTarget.teamId };
  }
  if (turnTarget?.kind === "agents") {
    return { agentNames: [...turnTarget.agentNames], teamId: null };
  }
  return { agentNames: [], teamId: null };
}

/**
 * What the conversation hook reads from its panel.
 *
 * Every key is required, so a call site that leaves one out fails the type
 * check.
 */
export interface ConversationStreamInput {
  sessionId: string | null;
  /** When true, the transcript is never read. */
  isDraft: boolean;
  onUserMessagePresenceChange: ((sessionId: string, hasUserMessage: boolean) => void) | undefined;
  onPendingResponseChange: ((sessionId: string, pending: boolean) => void) | undefined;
  onSessionActivityStarted: ((sessionId: string) => void) | undefined;
  onSessionUpdated: ((session: SessionSummary) => void) | undefined;
  onRunPlanUpdated: ((sessionId: string, plan: RunPlan) => void) | undefined;
  onTaskStarted: ((sessionId: string, task: SessionTask) => void) | undefined;
  /** Called when a reply lands while its session is still the one shown. */
  onReplyLanded: () => void;
  /** Called in the send's `finally`, after the send abort is released. */
  onSendSettled: () => void;
}

/** The identity of a message the server has stored. */
export type StoredChatLine = Pick<ChatMessage, "id" | "createdAt">;

/** A line the app adds to the conversation from outside a send. */
export interface InjectedMessage {
  role: "user" | "assistant" | "system";
  text: string;
  /**
   * The stored message's id and time, when the server already holds this
   * line. A transcript read then recognises it as the same line instead of
   * showing it twice. Left out for a note that exists only here.
   */
  id?: string | undefined;
  createdAt?: string | undefined;
}

/** One turn for `sendTurn`. */
export interface TurnRequest {
  /** Sent as the question and shown at once as the local line. */
  text: string;
  target: SessionMessageTarget | undefined;
  /** The pair to send, or null to send none. */
  model: ModelChoice | null;
  projectContext: WorkspaceProjectContextSelection | undefined;
  /** Called when the send fails, was not stopped, and its session is still the one shown. */
  restoreDraft: () => void;
}

export interface ConversationStream {
  messages: ChatMessage[];
  turnOutcomes: ConversationTurnOutcome[];
  modelChoices: ModelChoiceOffer[];
  loading: boolean;
  /** One message, written by the load, the send, `reportError` and `clearError`. */
  error: string | null;
  streamedTurn: StreamedTurn;
  /** True during a local send or an observed active turn in the shown session. */
  submitting: boolean;
  /**
   * True while the latest answered turn of the session on screen had a reply
   * that ran without tools while folders were attached.
   */
  folderToolsUnavailable: boolean;
  pendingResponse: PendingChatResponse | null;
  /**
   * Appends a line to `messages`, unless it repeats the last one or is already
   * shown. A note that exists only here keeps its place through later
   * transcript reads until the session changes; a line carrying a stored
   * message's id is replaced by the stored copy when a read brings it.
   */
  injectMessage: (message: InjectedMessage) => void;
  /** Reads the transcript again; a read that lands after a session switch is dropped. */
  reload: () => void;
  reportError: (message: string) => void;
  clearError: () => void;
  /** Aborts the request of the send in flight, if any. */
  abortReply: () => void;
  /** Sends one turn and resolves once it has settled. */
  sendTurn: (turn: TurnRequest) => Promise<void>;
}

/**
 * The conversation on screen: its transcript, the reply preview and the turn
 * in flight.
 */
export function useConversationStream({
  sessionId,
  isDraft,
  onUserMessagePresenceChange,
  onPendingResponseChange,
  onSessionActivityStarted,
  onSessionUpdated,
  onRunPlanUpdated,
  onTaskStarted,
  onReplyLanded,
  onSendSettled,
}: ConversationStreamInput): ConversationStream {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /**
   * What became of the turns the transcript cannot explain.
   *
   * Kept beside the messages rather than merged into them: an interruption is
   * not something anybody said, and a renderer that could not tell the two
   * apart would eventually put one in front of a model as history.
   */
  const [turnOutcomes, setTurnOutcomes] = useState<ConversationTurnOutcome[]>(
    [],
  );
  /**
   * Offers of one new attempt on the application default.
   *
   * Recomputed by the server on every transcript read, so an offer that has
   * stopped being safe or current simply stops arriving.
   */
  const [modelChoices, setModelChoices] = useState<ModelChoiceOffer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTurnIds, setActiveTurnIds] = useState<readonly string[]>([]);
  /**
   * The session whose replies last ran without the folder tools, if any.
   * Keyed by session so the notice never shows in another chat.
   */
  const [folderToolsNoticeSessionId, setFolderToolsNoticeSessionId] = useState<
    string | null
  >(null);
  const pendingLocalMessagesRef = useRef<ChatMessage[]>([]);
  /**
   * Ids of the local lines `injectMessage` added for the session on screen.
   * They are never stored, so every transcript read puts them back after the
   * line they followed.
   */
  const localNoteIdsRef = useRef<Set<string>>(new Set());
  /**
   * The in-flight preview: text accumulated per `replyId` for the turn that is
   * generating right now.
   *
   * Display-only — the persisted `ChatMessage` from the POST replaces it.
   * Reset during render when the session changes — React's supported
   * adjust-state-on-prop-change pattern — so the new conversation starts empty
   * on its very first render and an abandoned preview cannot come back if the
   * user returns. An effect would be a frame too late and would write state
   * during cleanup, including on unmount.
   */
  const [streamedTurn, setStreamedTurn] = useState<StreamedTurn>(
    EMPTY_STREAMED_TURN,
  );
  const [renderedSessionId, setRenderedSessionId] = useState(sessionId);
  if (renderedSessionId !== sessionId) {
    setRenderedSessionId(sessionId);
    setStreamedTurn(EMPTY_STREAMED_TURN);
    setActiveTurnIds([]);
  }
  /** Identifies the live subscription, so a stale callback writes nothing. */
  const streamTokenRef = useRef<object | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const activeSessionIdRef = useRef<string | null>(sessionId);
  const previousSessionIdRef = useRef<string | null>(sessionId);

  const loadMessages = useCallback(
    (isStale: () => boolean = () => false) => {
      if (!sessionId || isDraft) return;
      const readSessionId = sessionId;
      // A read for a session that is no longer the one shown would replace
      // another conversation with this one.
      const dropped = () =>
        isStale() || activeSessionIdRef.current !== readSessionId;

      void apiListChatMessages(sessionId)
        .then((next) => {
          if (dropped()) return;
          const pendingMessages = pendingLocalMessagesRef.current;
          const localNoteIds = new Set(localNoteIdsRef.current);
          startTransition(() => {
            setMessages((shown) =>
              keepLocalNotes(
                mergePendingMessages(next.messages, pendingMessages),
                shown,
                localNoteIds,
              ),
            );
            setTurnOutcomes(next.outcomes);
            setModelChoices(next.modelChoices);
            setActiveTurnIds(next.activeTurnIds ?? []);
            setLoading(false);
          });
          onUserMessagePresenceChange?.(
            sessionId,
            next.messages.some((message) => message.role === "user" && message.text.trim().length > 0),
          );
        })
        .catch((err) => {
          if (dropped()) return;
          startTransition(() => {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
          });
        });
    },
    [isDraft, onUserMessagePresenceChange, sessionId],
  );

  const injectMessage = useCallback(
    ({ role, text, id, createdAt }: InjectedMessage) => {
      const local = buildLocalMessage(role, text, id);
      const note = createdAt ? { ...local, createdAt } : local;
      localNoteIdsRef.current.add(note.id);
      startTransition(() => {
        setMessages((prev) => {
          const last = prev.at(-1);
          if (last?.role === role && last.text === text) return prev;
          if (prev.some((message) => message.id === note.id)) return prev;
          return [...prev, note];
        });
      });
    },
    [],
  );
  const reload = useCallback(() => loadMessages(), [loadMessages]);
  const [submitting, setSubmitting] = useState(false);
  const [pendingResponse, setPendingResponse] =
    useState<PendingChatResponse | null>(null);
  // Aborted only by Stop. Switching sessions leaves an agent's turn running,
  // as it always has.
  const sendAbortRef = useRef<AbortController | null>(null);
  const requestedStopsRef = useRef(new Set<string>());
  const observed = useObservedTurns({ sessionId: isDraft ? null : sessionId, activeTurnIds,
    ownTurnId: pendingResponse?.turnId ?? null, onSettled: loadMessages });
  // Switching session or unmounting stops the subscription. No state is
  // written here: the preview is already scoped by session above, and writing
  // on unmount would touch a component that no longer exists.
  useEffect(
    () => () => {
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      // Cleanup only tears down. The preview itself is reset during render.
      streamTokenRef.current = null;
    },
    [sessionId],
  );

  useEffect(() => {
    activeSessionIdRef.current = sessionId;
    if (previousSessionIdRef.current !== sessionId) {
      pendingLocalMessagesRef.current = [];
      localNoteIdsRef.current = new Set();
      previousSessionIdRef.current = sessionId;
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || isDraft) {
      startTransition(() => {
        setMessages([]);
        setTurnOutcomes([]);
        setModelChoices([]);
        setError(null);
        setLoading(false);
      });
      return;
    }

    let cancelled = false;
    startTransition(() => {
      setLoading(true);
      setError(null);
    });

    loadMessages(() => cancelled);

    return () => {
      cancelled = true;
    };
  }, [isDraft, loadMessages, sessionId]);

  // The desktop remounts this panel for each session, so a turn sent here
  // before a switch settles in a panel that is gone. Read the transcript again
  // once any such send for this session settles, or its reply stays missing
  // until the session is reopened.
  useEffect(() => {
    if (!sessionId || isDraft) return;
    const sends = sendsInFlight.get(sessionId);
    if (!sends || sends.size === 0) return;
    let cancelled = false;
    void Promise.all([...sends]).then(() => {
      if (!cancelled) loadMessages(() => cancelled);
    });
    return () => {
      cancelled = true;
    };
  }, [isDraft, loadMessages, sessionId]);

  const reportError = useCallback((message: string) => setError(message), []);
  const clearError = useCallback(() => setError(null), []);
  const abortReply = useCallback(() => {
    const localAbort = pendingResponse?.sessionId === sessionId ? sendAbortRef.current : null;
    const turnId = localAbort ? pendingResponse?.turnId : observed.pendingTurnId;
    if (!sessionId || !turnId) { localAbort?.abort(); return; }
    requestedStopsRef.current.add(turnId);
    // Keep the POST until the server finishes; acceptance is not a terminal outcome.
    void cancelAgentChatTurn(sessionId, turnId)
      .then(() => loadMessages())
      .catch((error: unknown) => {
        if (localAbort) localAbort.abort();
        else if (activeSessionIdRef.current === sessionId) {
          setError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!localAbort) { requestedStopsRef.current.delete(turnId); onSendSettled(); }
      });
  }, [sessionId, pendingResponse, observed.pendingTurnId, loadMessages, onSendSettled]);

  const sendTurn = useCallback(
    async (turn: TurnRequest) => {
      if (!sessionId || submitting || observed.pendingTurnId !== null) return;
      const { text, target: turnTarget, model, projectContext, restoreDraft } = turn;
      // Minted before the optimistic bubble because it decides the id the
      // server stores this question under. The two are one line, and a
      // transcript read landing mid-turn — the draft's first turn always
      // triggers one, because publishing the session re-reads it — must be
      // able to recognise that rather than showing the question twice.
      const turnId = crypto.randomUUID();
      const localUserMessage = buildLocalMessage(
        "user",
        text,
        conversationTurnMessageId(turnId, "user"),
      );

      onSessionActivityStarted?.(sessionId);
      const settleSendInFlight = trackSendInFlight(sessionId);

      setSubmitting(true);
      onPendingResponseChange?.(sessionId, true);
      setPendingResponse({
        sessionId,
        ...addressedIdentity(turnTarget),
      });
      setError(null);
      setLoading(false);
      pendingLocalMessagesRef.current = [
        ...pendingLocalMessagesRef.current,
        localUserMessage,
      ];
      setMessages((current) => [...current, localUserMessage]);
      onUserMessagePresenceChange?.(sessionId, true);
      // Outside the `try` so the `catch` can tell a stop from a failure.
      let announced = false;
      const sendAbort = new AbortController();
      sendAbortRef.current = sendAbort;

      try {
        // One request, whoever answers. Subscribe under the minted id, then
        // post: the stream endpoint waits for the turn to open its channel, so
        // arrival order is a contract rather than a race the client has to win.
        const streamAbort = new AbortController();
        streamAbortRef.current?.abort();
        streamAbortRef.current = streamAbort;
        const streamToken = {};
        streamTokenRef.current = streamToken;
        setStreamedTurn(EMPTY_STREAMED_TURN);
        setPendingResponse((current) =>
          current?.sessionId === sessionId ? { ...current, turnId } : current,
        );

        void apiOpenAgentTextStream({
          sessionId,
          channelId: turnId,
          signal: streamAbort.signal,
          onDelivery: (delivery) => {
            if (!announced && (delivery.type === 'selection' || delivery.type === 'delta')) {
              announced = true;
              window.pipeline?.announceSessionChanged?.(sessionId);
            }
            if (activeSessionIdRef.current !== sessionId) return;
            // A callback from an abandoned subscription writes nothing.
            if (streamTokenRef.current !== streamToken) return;
            setStreamedTurn((current) => applyStreamDelivery(current, delivery));
          },
        }).catch(() => {
          // The preview is optional; the persisted turn still arrives.
        });

        let response;
        try {
          response = await apiPostSessionMessage(sessionId, text, {
            // Only a pair somebody chose, and only while it can run. Without
            // one the server resolves the application default itself and
            // records it as that, which is what actually happened. A choice
            // that has stopped being offered is not sent to be tried anyway:
            // the composer says so instead, unless this turn was addressed to
            // somebody running on their own model, in which case it was never
            // this pair's turn to carry.
            ...(model
              ? {
                  provider: model.provider,
                  model: model.model,
                }
              : {}),
            turnId,
            ...(turnTarget ? { target: turnTarget } : {}),
            // ...(contextResultIds.length > 0 ? { contextResultIds } : {}),
            ...(projectContext ? { projectContext } : {}),
            signal: sendAbort.signal,
          });
        } finally {
          streamAbort.abort();
          if (streamAbortRef.current === streamAbort) {
            streamAbortRef.current = null;
          }
          // Cleared here rather than when the reply is appended: the preview
          // and the saved reply must not both be on screen for a frame.
          if (streamTokenRef.current === streamToken) {
            streamTokenRef.current = null;
            setStreamedTurn(EMPTY_STREAMED_TURN);
          }
        }
        if (activeSessionIdRef.current !== sessionId) return;

        // A reply that just landed is itself a result the next turn may carry,
        // and a Team turn just started work that will become one. Without this
        // nothing became selectable while the conversation stayed open.
        onReplyLanded();

        pendingLocalMessagesRef.current = pendingLocalMessagesRef.current.filter(
          (pending) => pending.id !== localUserMessage.id,
        );
        if (isTeamDispatch(response)) {
          // A Team publishes nothing into this conversation beyond the brief;
          // its replies arrive as the task's own workflow messages. Take the
          // authoritative transcript so the prompt survives a reload.
          loadMessages();
          onRunPlanUpdated?.(sessionId, response.plan);
          onTaskStarted?.(sessionId, response.task);
        } else {
          setMessages((current) =>
            replaceLocalMessage(current, localUserMessage.id, [
              response.user,
              ...response.messages,
            ]),
          );
          if (isPlanBearingDispatch(response)) {
            onRunPlanUpdated?.(sessionId, response.plan);
            // The planning chat's chat-confirmed launch carries its task too.
            if (response.task) onTaskStarted?.(sessionId, response.task);
          }
          // A front-door turn whose start_workflow tool confirmed a launch
          // carries the plan and the task it started, exactly like a Team
          // dispatch.
          if (isAgentsDispatch(response)) {
            if (response.plan) onRunPlanUpdated?.(sessionId, response.plan);
            if (response.task) onTaskStarted?.(sessionId, response.task);
          }
        }
        if (response.session) onSessionUpdated?.(response.session);
        // A reply that is itself the provider's refusal has just changed what
        // is true about that account, and every badge showing it is now wrong.
        // Only on a refusal: re-asking after every healthy turn would ping each
        // provider again for an answer nothing had changed.
        if (turnReportedProviderFailure(response)) {
          invalidateAgentProviderHealth();
        }
        const folderToolsNotice = folderToolsNoticeAfter(response);
        if (folderToolsNotice !== undefined) {
          setFolderToolsNoticeSessionId(folderToolsNotice ? sessionId : null);
        }
      } catch (err) {
        if (activeSessionIdRef.current !== sessionId) return;
        pendingLocalMessagesRef.current = pendingLocalMessagesRef.current.filter(
          (pending) => pending.id !== localUserMessage.id,
        );
        setMessages((current) =>
          current.filter((candidate) => candidate.id !== localUserMessage.id),
        );
        // A stop is the user's own ending, not a failure. The server treats the
        // dropped request as a cancellation and the read below shows what it
        // kept, so the draft is not handed back and nothing is reported.
        if (!sendAbort.signal.aborted && !requestedStopsRef.current.has(turnId)) {
          restoreDraft();
          setError(err instanceof Error ? err.message : String(err));
        }
        // The optimistic message is gone, but the durable one may not be: a
        // turn that got as far as storing the question and then lost its
        // provider is exactly the case this whole path exists for. Re-reading
        // brings back what was really stored along with the outcome explaining
        // it, instead of leaving the user with a banner and no question.
        loadMessages();
      } finally {
        requestedStopsRef.current.delete(turnId);
        if (sendAbortRef.current === sendAbort) sendAbortRef.current = null;
        onSendSettled();
        setSubmitting(false);
        setActiveTurnIds((current) => current.filter((id) => id !== turnId));
        window.pipeline?.announceSessionChanged?.(sessionId);
        onPendingResponseChange?.(sessionId, false);
        setPendingResponse((current) =>
          current?.sessionId === sessionId ? null : current,
        );
        settleSendInFlight();
      }
    },
    [
      loadMessages,
      onPendingResponseChange,
      onReplyLanded,
      onRunPlanUpdated,
      onSendSettled,
      onSessionActivityStarted,
      onSessionUpdated,
      onTaskStarted,
      onUserMessagePresenceChange,
      sessionId,
      submitting,
      observed.pendingTurnId,
    ],
  );

  return {
    messages,
    turnOutcomes,
    modelChoices,
    loading,
    error,
    streamedTurn: {
      progress: [...(streamedTurn.progress ?? []), ...(observed.stream.progress ?? [])],
      replies: [...streamedTurn.replies, ...observed.stream.replies],
      selections: [...streamedTurn.selections, ...observed.stream.selections],
      partialView: streamedTurn.partialView || observed.stream.partialView,
      channelLost: streamedTurn.channelLost || observed.stream.channelLost,
    },
    submitting: submitting || observed.pendingTurnId !== null,
    folderToolsUnavailable:
      sessionId !== null && folderToolsNoticeSessionId === sessionId,
    pendingResponse: pendingResponse ?? (sessionId && observed.pendingTurnId ? {
      sessionId,
      turnId: observed.pendingTurnId,
      agentNames: observed.stream.selections.map((selection) => selection.speaker),
      teamId: null,
    } : null),
    injectMessage,
    reload,
    reportError,
    clearError,
    abortReply,
    sendTurn,
  };
}

/**
 * Sends still in flight, by session.
 *
 * Module state rather than component state: the panel that sent a turn is
 * unmounted when the person switches session, and the panel mounted when they
 * come back has to know the turn is still settling.
 */
const sendsInFlight = new Map<string, Set<Promise<void>>>();

/** Records a send for `sessionId`; the returned function marks it settled. */
function trackSendInFlight(sessionId: string): () => void {
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const sends = sendsInFlight.get(sessionId) ?? new Set<Promise<void>>();
  sends.add(settled);
  sendsInFlight.set(sessionId, sends);
  return () => {
    sends.delete(settled);
    if (sends.size === 0 && sendsInFlight.get(sessionId) === sends) {
      sendsInFlight.delete(sessionId);
    }
    settle();
  };
}

/**
 * Keeps the local notes that were on screen in a freshly read transcript.
 *
 * Where each appears is decided by the panel's timeline, which orders every
 * line by its time, so the notes only have to survive the read.
 */
function keepLocalNotes(
  next: ChatMessage[],
  shown: ChatMessage[],
  localNoteIds: ReadonlySet<string>,
): ChatMessage[] {
  if (localNoteIds.size === 0) return next;
  return appendMissingMessages(
    next,
    shown.filter((message) => localNoteIds.has(message.id)),
  );
}

function buildLocalMessage(
  role: ChatMessage["role"],
  text: string,
  /**
   * The id the durable copy will carry, when the caller already knows it.
   * Sharing it is what lets the two copies be recognised as one line; the
   * timestamps never match, because only the server's clock writes the
   * durable one.
   */
  id = `local-${crypto.randomUUID()}`,
): ChatMessage {
  return {
    id,
    role,
    text,
    createdAt: new Date().toISOString(),
  };
}

function mergePendingMessages(
  serverMessages: ChatMessage[],
  pendingMessages: ChatMessage[],
): ChatMessage[] {
  if (pendingMessages.length === 0) return serverMessages;
  const next = [...serverMessages];
  for (const pending of pendingMessages) {
    if (!next.some((message) => isSameMessage(message, pending))) {
      next.push(pending);
    }
  }
  return next;
}

function replaceLocalMessage(
  current: ChatMessage[],
  localMessageId: string,
  replacements: ChatMessage[],
): ChatMessage[] {
  const localIndex = current.findIndex((message) => message.id === localMessageId);
  if (localIndex >= 0) {
    return [
      ...current.slice(0, localIndex),
      ...replacements,
      ...current.slice(localIndex + 1),
    ];
  }

  return appendMissingMessages(current, replacements);
}

function appendMissingMessages(
  current: ChatMessage[],
  messagesToAppend: ChatMessage[],
): ChatMessage[] {
  const next = [...current];
  for (const message of messagesToAppend) {
    if (!next.some((existing) => isSameMessage(existing, message))) {
      next.push(message);
    }
  }
  return next;
}

function isSameMessage(first: ChatMessage, second: ChatMessage): boolean {
  return (
    first.id === second.id ||
    (first.role === second.role &&
      first.text === second.text &&
      first.createdAt === second.createdAt)
  );
}
