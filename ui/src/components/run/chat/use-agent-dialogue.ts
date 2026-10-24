import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_DIALOGUE_DEFAULT_TURN_LIMIT, type AgentDialogueParticipant, type AgentDialogueRecord, type StartAgentDialogueRequest } from "@contracts/agent-dialogue";
import { getAgentDialogue, interjectAgentDialogue, listAgentDialogues, openAgentDialogueEvents, pauseAgentDialogue, resumeAgentDialogue, startAgentDialogue, stopAgentDialogue } from "@/lib/clients/agent-dialogue-client";
import { openAgentTextStreamAt } from "@/lib/clients/agent-text-stream-client";
import { applyStreamDelivery, EMPTY_STREAMED_TURN, type StreamedTurn } from "@/lib/chat/streamed-turn";

interface AgentDialogueInput {
  sessionId: string | null;
  isDraft: boolean;
  onMessagesChanged: () => void;
  onActiveChange?: ((sessionId: string, agents: string[] | null) => void) | undefined;
  onActivityStarted?: ((sessionId: string) => void) | undefined;
}

interface DialogueTurnPreview {
  channelId: string;
  replyId: string;
  speaker: AgentDialogueParticipant;
  slot: number;
  messageId?: string;
}

interface DialogueView {
  sessionId: string | null;
  record: AgentDialogueRecord | null;
  currentTurn: DialogueTurnPreview | null;
  error: string | null;
}

function dialogueIsActive(record: AgentDialogueRecord | null): boolean {
  return record?.status === "running" || record?.status === "paused";
}

function activeAgentIds(record: AgentDialogueRecord | null): string[] | null {
  return record && dialogueIsActive(record) ? record.participants.map((agent) => agent.id) : null;
}

function dialogueError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAgentDialogue(input: AgentDialogueInput) {
  const { sessionId, isDraft } = input;
  const callbacksRef = useRef(input);
  useEffect(() => { callbacksRef.current = input; });
  const [view, setView] = useState<DialogueView>({ sessionId, record: null, currentTurn: null, error: null });
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const pendingStartsRef = useRef(new Set<string>());
  const pendingStopsRef = useRef(new Set<string>());
  const pendingStateChangesRef = useRef(new Set<string>());
  const [changingStateDialogueId, setChangingStateDialogueId] = useState<string | null>(null);
  const pendingInterjectionsRef = useRef(new Set<string>());
  const retryInterjectionsRef = useRef(new Map<string, { text: string; messageId: string }>());
  const [stoppingDialogueId, setStoppingDialogueId] = useState<string | null>(null);
  const [interjectingDialogueId, setInterjectingDialogueId] = useState<string | null>(null);
  const viewTokenRef = useRef<object | null>(null);
  const viewToken = useMemo(() => ({ sessionId }), [sessionId]);
  const loadVersionRef = useRef(0);
  const [discoveryVersion, setDiscoveryVersion] = useState(0);
  const record = view.sessionId === sessionId ? view.record : null;
  const active = dialogueIsActive(record);
  const currentTurn = view.sessionId === sessionId && active ? view.currentTurn : null;
  const recordRef = useRef<AgentDialogueRecord | null>(null);
  useEffect(() => { recordRef.current = record; }, [record]);

  const applyDialogueRecord = useCallback((next: AgentDialogueRecord, token: object | null, refreshMessages: boolean) => {
    if (viewTokenRef.current !== token) return;
    const current = recordRef.current;
    if (!current || current.sessionId !== next.sessionId || current.dialogueId !== next.dialogueId) return;
    // The append-only event sequence is also the record revision. HTTP control
    // responses and lifecycle reads can arrive after a newer terminal event.
    const accepted = next.events.length >= current.events.length ? next : current;
    recordRef.current = accepted;
    setView((previous) => previous.sessionId === next.sessionId && previous.record?.dialogueId === next.dialogueId
      ? { ...previous, record: accepted, error: null } : previous);
    if (refreshMessages) callbacksRef.current.onMessagesChanged();
    callbacksRef.current.onActiveChange?.(next.sessionId, activeAgentIds(accepted));
  }, []);

  useEffect(() => {
    viewTokenRef.current = viewToken;
    return () => { if (viewTokenRef.current === viewToken) viewTokenRef.current = null; };
  }, [viewToken]);

  useEffect(() => {
    if (!sessionId || isDraft) return;
    const token = viewTokenRef.current;
    const controller = new AbortController();
    const loadVersion = loadVersionRef.current;
    void listAgentDialogues(sessionId, controller.signal).then((records) => {
      if (viewTokenRef.current !== token || loadVersionRef.current !== loadVersion) return;
      const candidate = records.find((item) => item.status === "running" || item.status === "paused") ?? records.at(-1) ?? null;
      const current = recordRef.current;
      const latest = current?.sessionId === sessionId && candidate?.dialogueId === current.dialogueId && candidate.events.length < current.events.length
        ? current : candidate;
      recordRef.current = latest;
      setView((previous) => ({ sessionId, record: latest, error: null,
        currentTurn: previous.sessionId === sessionId && previous.record?.dialogueId === latest?.dialogueId && dialogueIsActive(latest)
          ? previous.currentTurn : null,
      }));
      callbacksRef.current.onActiveChange?.(sessionId, activeAgentIds(latest));
      if (discoveryVersion > 0) callbacksRef.current.onMessagesChanged();
    }).catch((error: unknown) => {
      if (viewTokenRef.current !== token || controller.signal.aborted) return;
      setView({ sessionId, record: null, currentTurn: null, error: dialogueError(error) });
    });
    return () => controller.abort();
  }, [discoveryVersion, isDraft, sessionId]);

  const dialogueId = record?.dialogueId;
  useEffect(() => {
    if (!sessionId || !dialogueId || !active) return;
    const controller = new AbortController();
    const token = viewTokenRef.current;
    let stale = false;
    // Record reads stay in event order. A slow earlier status response cannot
    // replace the newer end state; every read is also fenced by this view.
    let refreshes: Promise<void> = Promise.resolve();
    void openAgentDialogueEvents({ sessionId, dialogueId, signal: controller.signal, onEvent: (event) => {
      if (stale) return;
      if (event.type === 'ended') window.pipeline?.announceSessionChanged?.(sessionId);
      if (event.type === "turn_started" && event.channelId && event.replyId && event.speaker && event.slot !== undefined) {
        const nextTurn: DialogueTurnPreview = { channelId: event.channelId, replyId: event.replyId, speaker: event.speaker, slot: event.slot };
        setView((current) => current.sessionId === sessionId ? { ...current, currentTurn: nextTurn } : current);
      }
      if (event.type === "turn_saved") {
        setView((current) => {
          const turn = current.currentTurn;
          if (current.sessionId !== sessionId || !turn || turn.slot !== event.slot || !event.messageId) return current;
          return { ...current, currentTurn: { ...turn, messageId: event.messageId } };
        });
      }
      if (event.type === "turn_discarded") {
        setView((current) => current.sessionId === sessionId && current.currentTurn?.slot === event.slot
          ? { ...current, currentTurn: null } : current);
      }
      if (event.type === "turn_started" || event.type === "started") return;
      refreshes = refreshes.then(async () => {
        if (stale) return;
        const next = await getAgentDialogue(sessionId, dialogueId, controller.signal);
        if (stale) return;
        applyDialogueRecord(next, token, event.type === "turn_saved" || event.type === "interjected" || event.type === "ended");
      }).catch((error: unknown) => {
        if (stale) return;
        setView((current) => current.sessionId === sessionId ? { ...current, error: dialogueError(error) } : current);
      });
    } }).catch((error: unknown) => {
      if (stale) return;
      setView((current) => current.sessionId === sessionId ? { ...current, error: dialogueError(error) } : current);
    });
    return () => { stale = true; controller.abort(); };
  }, [applyDialogueRecord, active, dialogueId, sessionId]);

  const channelId = currentTurn?.channelId;
  const [preview, setPreview] = useState<{ channelId: string | undefined; turn: StreamedTurn }>({ channelId: undefined, turn: EMPTY_STREAMED_TURN });
  useEffect(() => {
    if (!sessionId || !channelId) return;
    const controller = new AbortController();
    let stale = false;
    void openAgentTextStreamAt({
      path: `/sessions/${encodeURIComponent(sessionId)}/agent-chat/stream`,
      channelId,
      signal: controller.signal,
      onDelivery: (delivery) => {
        if (stale) return;
        setPreview((current) => ({ channelId, turn: applyStreamDelivery(current.channelId === channelId ? current.turn : EMPTY_STREAMED_TURN, delivery) }));
      },
    }).catch(() => {
      // Text is a preview. Lifecycle events still load the durable reply.
    });
    return () => { stale = true; controller.abort(); };
  }, [channelId, sessionId]);

  const start = useCallback(async (agents: string[], topic: string, options: Pick<StartAgentDialogueRequest, "projectContext" | "contextResultIds" | "continues"> = {}): Promise<boolean> => {
    if (!sessionId || viewTokenRef.current !== viewToken || active || pendingStartsRef.current.has(sessionId)) return false;
    const token = viewToken;
    loadVersionRef.current += 1;
    pendingStartsRef.current.add(sessionId);
    setPendingSessionId(sessionId);
    try {
      const next = await startAgentDialogue(sessionId, { agents, topic, delivery: "text", maxTurns: AGENT_DIALOGUE_DEFAULT_TURN_LIMIT, ...options });
      window.pipeline?.announceSessionChanged?.(sessionId);
      loadVersionRef.current += 1;
      callbacksRef.current.onActivityStarted?.(sessionId);
      if (viewTokenRef.current === token) {
        recordRef.current = next;
        setView({ sessionId, record: next, currentTurn: null, error: null });
        callbacksRef.current.onMessagesChanged();
        callbacksRef.current.onActiveChange?.(sessionId, activeAgentIds(next));
      }
      return true;
    } catch (error) {
      if (viewTokenRef.current === token) setView((current) => ({ ...current, sessionId, error: dialogueError(error) }));
      return false;
    } finally {
      pendingStartsRef.current.delete(sessionId);
      setPendingSessionId((current) => current === sessionId ? null : current);
    }
  }, [active, sessionId, viewToken]);

  const stop = useCallback(async (): Promise<boolean> => {
    if (!sessionId || viewTokenRef.current !== viewToken || !record || !active || pendingStopsRef.current.has(record.dialogueId)) return false;
    const token = viewToken;
    const id = record.dialogueId;
    pendingStopsRef.current.add(id);
    setStoppingDialogueId(id);
    try {
      const next = await stopAgentDialogue(sessionId, id);
      window.pipeline?.announceSessionChanged?.(sessionId);
      applyDialogueRecord(next, token, true);
      return true;
    } catch (error) {
      if (viewTokenRef.current === token) setView((current) => current.record?.dialogueId === id ? { ...current, error: dialogueError(error) } : current);
      return false;
    } finally {
      pendingStopsRef.current.delete(id);
      setStoppingDialogueId((current) => current === id ? null : current);
    }
  }, [applyDialogueRecord, active, record, sessionId, viewToken]);

  const interject = useCallback(async (text: string): Promise<boolean> => {
    if (!sessionId || viewTokenRef.current !== viewToken || !record || !active || pendingInterjectionsRef.current.has(record.dialogueId)) return false;
    const token = viewToken;
    const id = record.dialogueId;
    const previousAttempt = retryInterjectionsRef.current.get(id);
    const request = previousAttempt?.text === text ? previousAttempt : { text, messageId: crypto.randomUUID() };
    retryInterjectionsRef.current.set(id, request);
    pendingInterjectionsRef.current.add(id);
    setInterjectingDialogueId(id);
    try {
      const next = await interjectAgentDialogue(sessionId, id, request);
      retryInterjectionsRef.current.delete(id);
      applyDialogueRecord(next, token, true);
      return true;
    } catch (error) {
      if (viewTokenRef.current === token) setView((current) => current.record?.dialogueId === id ? { ...current, error: dialogueError(error) } : current);
      return false;
    } finally {
      pendingInterjectionsRef.current.delete(id);
      setInterjectingDialogueId((current) => current === id ? null : current);
    }
  }, [applyDialogueRecord, active, record, sessionId, viewToken]);

  const changeRunningState = useCallback(async (action: "pause" | "resume"): Promise<boolean> => {
    if (!sessionId || viewTokenRef.current !== viewToken || !record || !active || pendingStateChangesRef.current.has(record.dialogueId)) return false;
    const token = viewToken;
    const id = record.dialogueId;
    pendingStateChangesRef.current.add(id);
    setChangingStateDialogueId(id);
    try {
      const next = action === "pause" ? await pauseAgentDialogue(sessionId, id) : await resumeAgentDialogue(sessionId, id);
      applyDialogueRecord(next, token, false);
      return true;
    } catch (error) {
      if (viewTokenRef.current === token) setView((current) => current.record?.dialogueId === id ? { ...current, error: dialogueError(error) } : current);
      return false;
    } finally {
      pendingStateChangesRef.current.delete(id);
      setChangingStateDialogueId((current) => current === id ? null : current);
    }
  }, [applyDialogueRecord, active, record, sessionId, viewToken]);
  const pause = useCallback(() => changeRunningState("pause"), [changeRunningState]);
  const resume = useCallback(() => changeRunningState("resume"), [changeRunningState]);

  const keepGoing = useCallback(async (): Promise<boolean> => {
    if (!record || active) return false;
    return start(record.participants.map((agent) => agent.id), "Keep going.", {
      continues: record.dialogueId,
      ...(record.projectContext ? { projectContext: record.projectContext } : {}),
      ...(record.contextResultIds ? { contextResultIds: record.contextResultIds } : {}),
    });
  }, [active, record, start]);

  const refresh = useCallback(() => {
    if (!sessionId || viewTokenRef.current !== viewToken) return;
    setDiscoveryVersion((current) => current + 1);
  }, [sessionId, viewToken]);

  return {
    record,
    active,
    pending: pendingSessionId === sessionId && sessionId !== null,
    error: view.sessionId === sessionId ? view.error : null,
    currentTurn,
    streamedTurn: channelId && preview.channelId === channelId ? preview.turn : EMPTY_STREAMED_TURN,
    start,
    stop,
    interject,
    pause,
    resume,
    keepGoing,
    refresh,
    changingState: changingStateDialogueId === dialogueId && dialogueId !== undefined,
    stopping: stoppingDialogueId === dialogueId && dialogueId !== undefined,
    interjecting: interjectingDialogueId === dialogueId && dialogueId !== undefined,
  };
}
