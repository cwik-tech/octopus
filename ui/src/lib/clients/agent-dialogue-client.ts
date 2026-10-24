import { z } from "zod/v4";
import {
  agentDialogueEventSchema,
  agentDialogueListSchema,
  agentDialogueRecordSchema,
  interjectAgentDialogueRequestSchema,
  startAgentDialogueRequestSchema,
  type AgentDialogueEvent,
  type AgentDialogueRecord,
  type InterjectAgentDialogueRequest,
  type StartAgentDialogueRequest,
} from "@contracts/agent-dialogue";
import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();
const REQUEST_TIMEOUT_MS = 15_000;
const STREAM_CONNECTION_TIMEOUT_MS = 60_000;
const MAX_STREAM_RECONNECTS = 5;
const errorPayloadSchema = z.object({ error: z.string().optional() });

function dialoguePath(sessionId: string, dialogueId?: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/dialogues${dialogueId ? `/${encodeURIComponent(dialogueId)}` : ""}`;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

async function expectOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const fallback = `Dialogue request failed (${response.status})`;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(fallback, { cause: error });
  }
  const parsed = errorPayloadSchema.safeParse(payload);
  throw new Error(parsed.success ? parsed.data.error ?? fallback : fallback);
}

async function readJson(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  const response = await expectOk(await fetch(`${API_BASE}${path}`, {
    ...init,
    signal: requestSignal(signal, REQUEST_TIMEOUT_MS),
  }));
  return response.json();
}

function requireDialogue(value: unknown, sessionId: string, dialogueId?: string): AgentDialogueRecord {
  const parsed = agentDialogueRecordSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid API response: expected AgentDialogueRecord");
  const record = parsed.data;
  if (record.sessionId !== sessionId) throw new Error("Dialogue response belongs to another session");
  if (dialogueId !== undefined && record.dialogueId !== dialogueId) throw new Error("Dialogue response belongs to another dialogue");
  return record;
}

export async function startAgentDialogue(sessionId: string, request: StartAgentDialogueRequest, signal?: AbortSignal): Promise<AgentDialogueRecord> {
  const body = startAgentDialogueRequestSchema.parse(request);
  return requireDialogue(await readJson(dialoguePath(sessionId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, signal), sessionId);
}

export async function listAgentDialogues(sessionId: string, signal?: AbortSignal): Promise<AgentDialogueRecord[]> {
  const parsed = agentDialogueListSchema.safeParse(await readJson(dialoguePath(sessionId), {}, signal));
  if (!parsed.success) throw new Error("Invalid API response: expected AgentDialogueRecord list");
  return parsed.data.dialogues.map((record) => requireDialogue(record, sessionId));
}

export async function getAgentDialogue(sessionId: string, dialogueId: string, signal?: AbortSignal): Promise<AgentDialogueRecord> {
  return requireDialogue(await readJson(dialoguePath(sessionId, dialogueId), {}, signal), sessionId, dialogueId);
}

async function postDialogueControl(sessionId: string, dialogueId: string, action: "stop" | "pause" | "resume", signal?: AbortSignal): Promise<AgentDialogueRecord> {
  return requireDialogue(await readJson(`${dialoguePath(sessionId, dialogueId)}/${action}`, { method: "POST" }, signal), sessionId, dialogueId);
}

export async function stopAgentDialogue(sessionId: string, dialogueId: string, signal?: AbortSignal): Promise<AgentDialogueRecord> {
  return postDialogueControl(sessionId, dialogueId, "stop", signal);
}

export async function pauseAgentDialogue(sessionId: string, dialogueId: string, signal?: AbortSignal): Promise<AgentDialogueRecord> {
  return postDialogueControl(sessionId, dialogueId, "pause", signal);
}

export async function resumeAgentDialogue(sessionId: string, dialogueId: string, signal?: AbortSignal): Promise<AgentDialogueRecord> {
  return postDialogueControl(sessionId, dialogueId, "resume", signal);
}

export async function interjectAgentDialogue(sessionId: string, dialogueId: string, request: InterjectAgentDialogueRequest, signal?: AbortSignal): Promise<AgentDialogueRecord> {
  const body = interjectAgentDialogueRequestSchema.parse(request);
  return requireDialogue(await readJson(`${dialoguePath(sessionId, dialogueId)}/interjections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, signal), sessionId, dialogueId);
}

function readEventBlock(block: string): AgentDialogueEvent | undefined {
  const data = block.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim()).join("\n");
  if (data.length === 0) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch (error) {
    throw new Error("Invalid API response: expected AgentDialogueEvent", { cause: error });
  }
  const parsed = agentDialogueEventSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Invalid API response: expected AgentDialogueEvent");
  return parsed.data;
}

class DialogueStreamTransportError extends Error {
  readonly connectionExpired: boolean;
  constructor(cause: unknown, connectionExpired: boolean) {
    super("Dialogue event stream disconnected", { cause });
    this.connectionExpired = connectionExpired;
  }
}

async function readStreamTransport<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const connectionExpired = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    if (connectionExpired || error instanceof TypeError) {
      throw new DialogueStreamTransportError(error, connectionExpired);
    }
    throw error;
  }
}

export async function openAgentDialogueEvents(params: {
  sessionId: string;
  dialogueId: string;
  signal: AbortSignal;
  onEvent: (event: AgentDialogueEvent) => void;
  fromSequence?: number;
}): Promise<void> {
  let nextSequence = params.fromSequence ?? 0;
  for (let attempt = 0; attempt <= MAX_STREAM_RECONNECTS && !params.signal.aborted; attempt += 1) {
    const connectionSignal = requestSignal(params.signal, STREAM_CONNECTION_TIMEOUT_MS);
    try {
      const response = await expectOk(await readStreamTransport(() => fetch(`${API_BASE}${dialoguePath(params.sessionId, params.dialogueId)}/events?from=${nextSequence}`, {
        headers: { accept: "text/event-stream" }, signal: connectionSignal,
      })));
      if (!response.body) throw new Error("Dialogue event stream has no response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!params.signal.aborted) {
          const chunk = await readStreamTransport(() => reader.read());
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const event = readEventBlock(block);
            if (!event) continue;
            if (event.sequence < nextSequence) continue;
            nextSequence = event.sequence + 1;
            params.onEvent(event);
            if (event.type === "ended") return;
          }
        }
      } finally {
        // Ending on the final event closes our reader even if the server has
        // not closed the connection yet. Cancellation must not replace an error.
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch (error) {
      if (params.signal.aborted) return;
      if (!(error instanceof DialogueStreamTransportError)) throw error;
      // Our connection deadline rotates a healthy, potentially paused stream.
      // It is not a failed attempt; genuine transport drops remain bounded.
      if (error.connectionExpired) attempt -= 1;
    }
  }
  if (!params.signal.aborted) throw new Error("Dialogue event stream disconnected. Reopen the session to reconnect.");
}
