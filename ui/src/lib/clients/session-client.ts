import {
  readModelSelectionRecord,
  type ModelSelectionRecord,
} from "@contracts/agent-model-selection";
import type { ModelChoiceOffer } from "@contracts/model-choice";
import type {
  ChatMessage,
  PostAgentChatMessageResponse,
  PostAgentChatMessageResponseMeta,
  PostChatMessageResponse,
  PostChatMessageResponseMeta,
  SessionMessageDispatchResponse,
  DeepResearchPlanningAttemptSnapshot,
  DeepResearchPlanningEvent,
  RunPlan,
  SessionDetails,
  SessionFile,
  SessionSummary,
  SessionTask,
  WorkflowStageInfo,
  WorkflowSummary,
  WorkspaceProjectContextSelection,
} from "@/lib/models/session-model";
import { isRunPlan } from "@contracts/run-plan";
import { sessionFilesPayloadSchema } from '@contracts/sessions';
import type { AgentTextStreamDelivery } from "@contracts/agent-text-stream";
import { openAgentTextStreamAt } from "@/lib/clients/agent-text-stream-client";
import {
  isDeepResearchPlanningEvent,
  isDeepResearchPlanningAttemptSnapshot,
  isTerminalDeepResearchPlanningStatus,
} from "@contracts/deep-research-planning";
import {
  isConversationTurnOutcome,
  isSessionTask,
  sessionSummarySchema,
  conversationMessageSourceSchema,
  chatMessageCutOffSchema,
} from "@contracts/sessions";
import type { ConversationTurnOutcome } from "@contracts/sessions";
import type { SessionMessageTarget } from "@contracts/schemas/session-requests";
import {
  parseResultReference,
  type ResultReference,
} from "@contracts/schemas/result-reference";
import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();
const researchPlanGenerationRequests = new Map<
  string,
  Promise<DeepResearchPlanningAttemptSnapshot>
>();

class ApiContractError extends Error {
  constructor(contract: string) {
    super(`Invalid API response: expected ${contract}`);
    this.name = "ApiContractError";
  }
}

function toUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export class SessionTaskStartError extends Error {
  assistant?: ChatMessage | undefined;
  detail?: string | undefined;
  plan?: RunPlan | undefined;

  constructor(
    message: string,
    assistant?: ChatMessage,
    detail?: string,
    plan?: RunPlan,
  ) {
    super(message);
    this.name = "SessionTaskStartError";
    this.assistant = assistant;
    this.detail = detail;
    this.plan = plan;
  }
}

export interface HumanInputInteractionSnapshot {
  interactionId: string;
  status: "pending" | "submitted" | "consumed" | "cancelled";
  sourceArtifact: { sha256: string };
  eligibleRecipients: Array<{
    id: string;
    mentionToken: string;
    displayName: string;
  }>;
}

export interface HumanInputSubmissionRequest {
  submissionId: string;
  expectedWorkflowRevision: number;
  expectedSourceArtifactSha256: string;
  mode: "feedback" | "continue_without_feedback";
  messages: Array<{
    id: string;
    text: string;
    recipients: "all" | string[];
  }>;
}

async function expectOk(response: Response): Promise<Response> {
  if (response.ok) return response;

  const fallbackMessage = httpStatusMessage(response);
  try {
    const payload = (await response.json()) as {
      error?: string;
      detail?: string;
      attemptPath?: string;
    };
    const message = payload.error || fallbackMessage;
    const context = [
      payload.detail && !message.includes(payload.detail)
        ? `Validation: ${payload.detail}`
        : null,
      payload.attemptPath
        ? `Diagnostics: ${payload.attemptPath}/attempt.json`
        : null,
    ].filter((value): value is string => Boolean(value));
    throw new Error([message, ...context].join("\n"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(fallbackMessage, { cause: error });
    }
    throw error;
  }
}

function httpStatusMessage(response: Response): string {
  const statusText =
    response.statusText || DEFAULT_STATUS_TEXT[response.status] || "Error";
  return `${response.status} ${statusText}`;
}

const DEFAULT_STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  500: "Internal Server Error",
  501: "Not Implemented",
};

async function readErrorPayload(response: Response): Promise<{
  error?: string;
  assistant?: ChatMessage;
  detail?: string;
  plan?: RunPlan;
}> {
  try {
    const payload = (await response.json()) as {
      error?: string;
      assistant?: ChatMessage;
      detail?: string;
      plan?: unknown;
    };
    if (payload.plan !== undefined && !isRunPlan(payload.plan)) {
      throw new ApiContractError("RunPlan");
    }
    return payload as {
      error?: string;
      assistant?: ChatMessage;
      detail?: string;
      plan?: RunPlan;
    };
  } catch (error) {
    if (error instanceof ApiContractError) throw error;
    return {};
  }
}

export async function listSessions(): Promise<SessionSummary[]> {
  const response = await expectOk(await fetch(toUrl("/sessions")));
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
    throw new ApiContractError("SessionSummary list");
  }
  return payload.sessions.map(requireSessionSummary);
}

export interface CreateSessionOptions {
  title?: string;
  projectId?: string;
  /**
   * An id the caller has already committed to, with the token that proves who
   * minted it. Sent as a pair or not at all — the server refuses one without
   * the other, because an id with no proof of authorship is an id a retry could
   * use to adopt somebody else's conversation.
   */
  id?: string;
  creationToken?: string;
  signal?: AbortSignal;
}

/**
 * How long a create may run before it is abandoned as unanswered. A draft the
 * user is looking at cannot wait on a request nobody will answer: the trigger
 * that started it has to be able to fail and be retried.
 */
export const CREATE_SESSION_TIMEOUT_MS = 15_000;

export async function createSession(
  options: CreateSessionOptions = {},
): Promise<SessionSummary> {
  const trimmedTitle = options.title?.trim();
  const trimmedProjectId = options.projectId?.trim();
  const body = {
    ...(trimmedTitle ? { title: trimmedTitle } : {}),
    ...(trimmedProjectId ? { projectId: trimmedProjectId } : {}),
    ...(options.id ? { id: options.id } : {}),
    ...(options.creationToken ? { creationToken: options.creationToken } : {}),
  };
  // The caller's signal still cancels; the deadline only bounds a request that
  // would otherwise never settle either way. Built from a timer rather than
  // `AbortSignal.timeout`, whose clock is the platform's and cannot be driven
  // by a test.
  const deadline = new AbortController();
  const abortForCaller = () => deadline.abort(options.signal?.reason);
  if (options.signal?.aborted) abortForCaller();
  options.signal?.addEventListener("abort", abortForCaller);
  const timer = setTimeout(() => {
    deadline.abort(new DOMException("Session creation timed out", "TimeoutError"));
  }, CREATE_SESSION_TIMEOUT_MS);

  try {
    const response = await expectOk(
      await fetch(toUrl("/sessions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: deadline.signal,
      }),
    );
    // The body is another process's output, and its id becomes the key every
    // per-session map and file owner uses. It is parsed, not asserted.
    const payload: unknown = await response.json();
    return requireSessionSummary(payload);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortForCaller);
  }
}

export async function fetchSession(id: string): Promise<SessionDetails> {
  const response = await expectOk(
    await fetch(toUrl(`/sessions/${encodeURIComponent(id)}`)),
  );
  // The title history is part of this. It is what the page uses to say which
  // model named this session, and a record it cannot read is refused rather
  // than half-shown — a partly-read history would name a model for one attempt
  // and stay silent about another.
  return requireSessionSummary(await response.json());
}

export async function updateSessionTitle(
  id: string,
  title: string,
): Promise<SessionSummary> {
  const response = await expectOk(
    await fetch(toUrl(`/sessions/${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title.trim() }),
    }),
  );
  return requireSessionSummary(await response.json());
}

export async function deleteSession(id: string): Promise<void> {
  await expectOk(
    await fetch(toUrl(`/sessions/${encodeURIComponent(id)}`), {
      method: "DELETE",
    }),
  );
  try {
    const prefix = `agent-question:${id}:`;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    // Browser storage can be unavailable; the server deletion already succeeded.
  }
}

/**
 * A session's transcript and what became of the turns it cannot explain.
 *
 * Two lists rather than one, because an interruption is not a message. Folding
 * it into the transcript as assistant prose would put words the model never
 * said in front of the user, and — worse — into the history every later turn
 * is built from.
 */
export interface SessionTranscript {
  messages: ChatMessage[];
  outcomes: ConversationTurnOutcome[];
  /** Open preview channels owned by this session, absent on older servers. */
  activeTurnIds?: string[];
  /**
   * Offers of one new attempt on the application default, for failed turns
   * where a repeat is provably safe. Computed by the server on every read, so
   * an offer here is current rather than remembered.
   */
  modelChoices: ModelChoiceOffer[];
}

/** Stop a live turn even when this window did not start its request. */
export async function cancelAgentChatTurn(sessionId: string, turnId: string): Promise<void> {
  await expectOk(await fetch(toUrl(`/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`), {
    method: 'POST', signal: AbortSignal.timeout(10_000),
  }));
}

export async function listChatMessages(
  id: string,
): Promise<SessionTranscript> {
  const response = await expectOk(
    await fetch(toUrl(`/sessions/${encodeURIComponent(id)}/messages`)),
  );
  // Parsed, not asserted. A cast here promised the whole transcript's shape on
  // behalf of bytes nobody had checked, and it is the same transcript the store
  // refuses to read half of — a reply whose conversation pointer was silently
  // dropped on the way to the renderer looks exactly like one that never had
  // any evidence behind it.
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.messages)) {
    throw new ApiContractError("{ messages: ChatMessage[] }");
  }
  // Absent is none, not invalid: a server that predates outcomes still returns
  // a transcript this renderer can show. A present-but-unreadable list is a
  // different matter, and fails closed like every other half-read payload.
  const outcomes = payload.outcomes;
  if (outcomes !== undefined && !Array.isArray(outcomes)) {
    throw new ApiContractError("{ outcomes: ConversationTurnOutcome[] }");
  }
  // Absent is none, for the same reason as the outcomes above.
  const modelChoices = payload.modelChoices;
  if (modelChoices !== undefined && !Array.isArray(modelChoices)) {
    throw new ApiContractError("{ modelChoices: ModelChoiceOffer[] }");
  }
  const activeTurnIds = payload.activeTurnIds;
  if (activeTurnIds !== undefined &&
    (!Array.isArray(activeTurnIds) || !activeTurnIds.every(isNonEmptyString))) {
    throw new ApiContractError("{ activeTurnIds: string[] }");
  }
  return {
    ...(activeTurnIds === undefined ? {} : { activeTurnIds }),
    messages: payload.messages.map((message) => requireChatMessage(message)),
    modelChoices: (modelChoices ?? []) as ModelChoiceOffer[],
    outcomes: (outcomes ?? []).map((outcome: unknown) => {
      // The one validator, shared with the server that built it, so a value
      // that would not survive the round trip cannot be produced either side.
      if (!isConversationTurnOutcome(outcome)) {
        throw new ApiContractError("ConversationTurnOutcome");
      }
      return outcome;
    }),
  };
}

/**
 * Approves one offer, once.
 *
 * The body carries the offer identity and an idempotency key and nothing else:
 * the pair that will run is the one the offer already named, and re-sending
 * the same approval addresses the attempt it already started.
 */
export async function approveModelChoice(
  sessionId: string,
  turnId: string,
  acceptance: { offerId: string; idempotencyKey: string },
): Promise<{ turnId: string }> {
  const response = await expectOk(
    await fetch(
      toUrl(
        `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(
          turnId,
        )}/model-choice`,
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          offerId: acceptance.offerId,
          idempotencyKey: acceptance.idempotencyKey,
        }),
      },
    ),
  );
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.turnId !== "string") {
    throw new ApiContractError("{ turnId: string }");
  }
  return { turnId: payload.turnId };
}

export async function postChatMessage(
  id: string,
  text: string,
  modelOverride?: {
    provider?: string;
    model?: string;
    projectContext?: WorkspaceProjectContextSelection;
    /** Client-minted so the stream can be opened before the turn exists. */
    turnId?: string;
  },
): Promise<PostChatMessageResponse> {
  const response = await expectOk(
    await fetch(toUrl(`/sessions/${encodeURIComponent(id)}/messages`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...modelOverride }),
    }),
  );
  return requirePostChatMessageResponse(await response.json());
}

/**
 * Send one turn to the session's single conversational endpoint.
 *
 * The target, when present, is what makes an order explicit. It is structured
 * and travels beside the text rather than inside it, so no model reading the
 * prose can talk the server out of it.
 */
export async function postSessionMessage(
  id: string,
  text: string,
  input?: {
    provider?: string;
    model?: string;
    projectContext?: WorkspaceProjectContextSelection;
    target?: SessionMessageTarget;
    /**
     * Completed results this turn carries forward.
     *
     * Beside the target and independent of it: choosing an addressee never
     * changes what a turn carries, and carrying a result never changes who
     * answers it.
     */
    contextResultIds?: readonly string[];
    /** Client-minted so the stream can be opened before the turn exists. */
    turnId?: string;
    /**
     * Stops the turn. The server treats a dropped request as a cancellation,
     * not a failure.
     */
    signal?: AbortSignal;
  },
): Promise<SessionMessageDispatchResponse> {
  // The signal belongs to the request, not the turn, so it stays out of the body.
  const { signal, ...body } = input ?? {};
  const response = await expectOk(
    await fetch(toUrl(`/sessions/${encodeURIComponent(id)}/messages`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...body }),
      ...(signal ? { signal } : {}),
    }),
  );
  return requireSessionMessageDispatchResponse(await response.json());
}

export async function getSessionRunPlan(id: string): Promise<RunPlan | null> {
  const response = await expectOk(
    await fetch(toUrl(`/sessions/${encodeURIComponent(id)}/run-plan`)),
  );
  return requireRunPlanEnvelope(await response.json(), true);
}

export async function selectSessionWorkflow(
  id: string,
  workflowId: string,
  expectedPlanId: string,
): Promise<RunPlan> {
  const response = await expectOk(
    await fetch(
      toUrl(`/sessions/${encodeURIComponent(id)}/run-plan/workflow`),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowId, expectedPlanId }),
      },
    ),
  );
  return requireRunPlanEnvelope(await response.json(), false);
}

export function generateSessionResearchPlan(
  id: string,
  expectedPlanId: string,
): Promise<DeepResearchPlanningAttemptSnapshot> {
  const requestKey = `${id}\u0000${expectedPlanId}`;
  const existing = researchPlanGenerationRequests.get(requestKey);
  if (existing) return existing;

  const request = fetch(
    toUrl(`/sessions/${encodeURIComponent(id)}/run-plan/research-plan`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedPlanId }),
    },
  )
    .then(expectOk)
    .then(async (response) => {
      return requirePlanningAttemptEnvelope(await response.json());
    });
  researchPlanGenerationRequests.set(requestKey, request);
  void request.then(
    () => researchPlanGenerationRequests.delete(requestKey),
    () => researchPlanGenerationRequests.delete(requestKey),
  );
  return request;
}

export async function getSessionResearchPlanAttempt(
  id: string,
  attemptId: string,
): Promise<DeepResearchPlanningAttemptSnapshot> {
  const response = await expectOk(
    await fetch(
      toUrl(
        `/sessions/${encodeURIComponent(id)}/run-plan/research-plan/attempts/${encodeURIComponent(attemptId)}`,
      ),
    ),
  );
  return requirePlanningAttemptEnvelope(await response.json());
}

export async function cancelSessionResearchPlanAttempt(
  id: string,
  attemptId: string,
): Promise<DeepResearchPlanningAttemptSnapshot> {
  const response = await expectOk(
    await fetch(
      toUrl(
        `/sessions/${encodeURIComponent(id)}/run-plan/research-plan/attempts/${encodeURIComponent(attemptId)}`,
      ),
      { method: "DELETE" },
    ),
  );
  return requirePlanningAttemptEnvelope(await response.json());
}

export async function openSessionResearchPlanAttemptStream(params: {
  sessionId: string;
  attemptId: string;
  signal: AbortSignal;
  onSnapshot: (attempt: DeepResearchPlanningAttemptSnapshot) => void;
}): Promise<void> {
  let nextSequence = 0;
  while (!params.signal.aborted) {
    const suffix = nextSequence > 0 ? `?from=${nextSequence}` : "";
    let terminal = false;
    try {
      const response = await fetch(
        toUrl(
          `/sessions/${encodeURIComponent(params.sessionId)}/run-plan/research-plan/attempts/${encodeURIComponent(params.attemptId)}/events${suffix}`,
        ),
        {
          headers: { accept: "text/event-stream" },
          signal: params.signal,
        },
      );
      await expectOk(response);
      if (!response.body) {
        throw new Error("Planning event stream is unavailable");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!params.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          while (buffer.includes("\n\n")) {
            const separator = buffer.indexOf("\n\n");
            const block = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const parsed = parsePlanningSseEvent(block);
            if (!parsed) continue;
            nextSequence = Math.max(nextSequence, parsed.sequence + 1);
            params.onSnapshot(parsed.snapshot);
            terminal = isTerminalDeepResearchPlanningStatus(
              parsed.snapshot.status,
            );
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (params.signal.aborted) throw error;
      if (!(error instanceof TypeError)) throw error;
      await planningReconnectDelay(params.signal);
      continue;
    }
    if (params.signal.aborted || terminal) return;
    const recovered = await getSessionResearchPlanAttempt(
      params.sessionId,
      params.attemptId,
    );
    params.onSnapshot(recovered);
    if (isTerminalDeepResearchPlanningStatus(recovered.status)) return;
    await planningReconnectDelay(params.signal);
  }
}

export async function approveSessionResearchPlan(
  id: string,
  expectedPlanId: string,
  expectedResearchPlanHash: string,
): Promise<RunPlan> {
  const response = await expectOk(
    await fetch(
      toUrl(
        `/sessions/${encodeURIComponent(id)}/run-plan/research-plan/approve`,
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedPlanId, expectedResearchPlanHash }),
      },
    ),
  );
  return requireRunPlanEnvelope(await response.json(), false);
}

export async function postAgentChatMessage(
  id: string,
  text: string,
  input: {
    agentNames: string[];
    provider?: string;
    model?: string;
    projectContext?: WorkspaceProjectContextSelection;
    /** Client-minted so the stream can be opened before the turn exists. */
    turnId?: string;
  },
): Promise<PostAgentChatMessageResponse> {
  const response = await expectOk(
    await fetch(
      toUrl(`/sessions/${encodeURIComponent(id)}/agent-chat/messages`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, ...input }),
      },
    ),
  );
  return (await response.json()) as PostAgentChatMessageResponse;
}

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  const response = await expectOk(await fetch(toUrl("/workflows")));
  const payload = (await response.json()) as { workflows: WorkflowSummary[] };
  return payload.workflows;
}

export async function getWorkflowYaml(id: string): Promise<string> {
  const response = await expectOk(
    await fetch(toUrl(`/workflows/${encodeURIComponent(id)}`)),
  );
  const payload = (await response.json()) as { yaml: string };
  return payload.yaml;
}

export async function getWorkflowStages(
  id: string,
): Promise<WorkflowStageInfo[]> {
  const response = await expectOk(
    await fetch(toUrl(`/workflows/${encodeURIComponent(id)}`)),
  );
  const payload = (await response.json()) as { stages?: WorkflowStageInfo[] };
  return payload.stages ?? [];
}

export async function updateWorkflowYaml(
  id: string,
  yaml: string,
): Promise<{
  workflowId: string;
  yaml: string;
  yamlPath: string;
  registryPath: string;
  filename: string;
  warnings: string[];
}> {
  const response = await expectOk(
    await fetch(toUrl(`/workflows/${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ yaml }),
    }),
  );
  return (await response.json()) as {
    workflowId: string;
    yaml: string;
    yamlPath: string;
    registryPath: string;
    filename: string;
    warnings: string[];
  };
}

export async function deleteWorkflow(id: string): Promise<void> {
  await expectOk(
    await fetch(toUrl(`/workflows/${encodeURIComponent(id)}`), {
      method: "DELETE",
    }),
  );
}

export async function listSessionFiles(id: string): Promise<SessionFile[]> {
  const response = await expectOk(
    await fetch(toUrl(`/sessions/${encodeURIComponent(id)}/files`)),
  );
  const payload = sessionFilesPayloadSchema.parse(await response.json());
  return payload.files;
}

export async function uploadSessionFile(
  id: string,
  file: File,
): Promise<SessionFile> {
  const buffer = await file.arrayBuffer();
  const response = await expectOk(
    await fetch(toUrl(`/sessions/${encodeURIComponent(id)}/files`), {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-filename": encodeURIComponent(file.name),
      },
      body: buffer,
    }),
  );
  return (await response.json()) as SessionFile;
}

export async function deleteSessionFile(
  id: string,
  filename: string,
): Promise<void> {
  await expectOk(
    await fetch(
      toUrl(
        `/sessions/${encodeURIComponent(id)}/files/${encodeURIComponent(filename)}`,
      ),
      {
        method: "DELETE",
      },
    ),
  );
}

export async function cancelSessionTask(
  id: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<SessionTask> {
  const response = await expectOk(
    await fetch(
      toUrl(
        `/sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`,
      ),
      {
        method: "DELETE",
        ...(signal ? { signal } : {}),
      },
    ),
  );
  return requireSessionTask(await response.json());
}

export async function resumeSessionTask(
  id: string,
  taskId: string,
): Promise<SessionTask> {
  const response = await expectOk(
    await fetch(
      toUrl(
        `/sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/resume`,
      ),
      {
        method: "POST",
      },
    ),
  );
  return requireSessionTask(await response.json());
}

/** Exactly one of these names the thing to run. */
export type SessionTaskTarget =
  | { workflowId: string }
  | { teamId: string };

export async function startSessionTask(
  id: string,
  target: SessionTaskTarget,
  brief?: string,
  projectContext?: WorkspaceProjectContextSelection,
  /** Completed results this run carries forward, chosen in the composer. */
  contextResultIds?: readonly string[],
): Promise<SessionTask> {
  const response = await fetch(
    toUrl(`/sessions/${encodeURIComponent(id)}/tasks`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...target,
        ...(brief !== undefined ? { brief } : {}),
        ...(projectContext ? { projectContext } : {}),
        ...(contextResultIds && contextResultIds.length > 0
          ? { contextResultIds: [...contextResultIds] }
          : {}),
      }),
    },
  );
  if (!response.ok) {
    const fallbackMessage = httpStatusMessage(response);
    const payload = await readErrorPayload(response);
    throw new SessionTaskStartError(
      payload.error || fallbackMessage,
      payload.assistant,
      payload.detail,
      payload.plan,
    );
  }
  return requireSessionTask(await response.json());
}

/**
 * The completed results this session can carry into a turn.
 *
 * Validated at the boundary like every other response: a reference that this
 * build cannot read is dropped rather than offered, because offering one the
 * server would then refuse is worse than not offering it.
 */
export async function listSessionResults(
  id: string,
): Promise<ResultReference[]> {
  const response = await expectOk(
    await fetch(toUrl(`/sessions/${encodeURIComponent(id)}/results`)),
  );
  const payload = (await response.json()) as { results?: unknown };
  if (!Array.isArray(payload.results)) {
    throw new ApiContractError("SessionResults.results");
  }
  return payload.results.flatMap((entry) => {
    const parsed = parseResultReference(entry);
    return parsed ? [parsed] : [];
  });
}

export async function listSessionTasks(id: string): Promise<SessionTask[]> {
  const response = await expectOk(
    await fetch(toUrl(`/sessions/${encodeURIComponent(id)}/tasks`)),
  );
  return requireSessionTasksEnvelope(await response.json());
}

export async function getHumanInputInteraction(
  sessionId: string,
  taskId: string,
): Promise<{
  workflowRevision: number;
  interaction: HumanInputInteractionSnapshot;
  sourceText: string;
  sourceTruncated: boolean;
  sourceByteLength: number;
}> {
  const response = await expectOk(
    await fetch(
      toUrl(
        `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/human-in-the-loop`,
      ),
    ),
  );
  const payload = (await response.json()) as unknown;
  if (
    !isRecord(payload) ||
    typeof payload.workflowRevision !== "number" ||
    typeof payload.sourceText !== "string" ||
    typeof payload.sourceTruncated !== "boolean" ||
    typeof payload.sourceByteLength !== "number" ||
    !isHumanInputInteractionSnapshot(payload.interaction)
  ) {
    throw new ApiContractError("{ workflowRevision, interaction }");
  }
  return {
    workflowRevision: payload.workflowRevision,
    interaction: payload.interaction,
    sourceText: payload.sourceText,
    sourceTruncated: payload.sourceTruncated,
    sourceByteLength: payload.sourceByteLength,
  };
}

/**
 * The model choice a suspended task is waiting on, if it is waiting on one.
 *
 * `null` for a task with nothing pending, so a caller can tell "no decision"
 * apart from a request that failed.
 */
export async function getTaskModelChoice(
  sessionId: string,
  taskId: string,
  options: ModelChoiceRequestOptions = {},
): Promise<{ workflowRevision: number; stepId: string; offer: ModelChoiceOffer } | null> {
  const response = await fetch(toUrl(taskModelChoicePath(sessionId, taskId)), {
    signal: modelChoiceRequestSignal(options),
  });
  if (response.status === 404) return null;
  await expectOk(response);
  const payload = (await response.json()) as unknown;
  if (
    !isRecord(payload) ||
    !isWorkflowRevision(payload.workflowRevision) ||
    !isNamedIdentifier(payload.stepId) ||
    !isTaskModelChoiceOffer(payload.offer, sessionId, taskId)
  ) {
    throw new ApiContractError("{ workflowRevision, stepId, offer }");
  }
  return {
    workflowRevision: payload.workflowRevision,
    stepId: payload.stepId,
    offer: payload.offer,
  };
}

/**
 * Approves one offer, and says nothing else.
 *
 * The body carries the offer identity and an idempotency key only. Letting it
 * name a pair would turn consent into an arbitrary model-override API, which is
 * exactly what the server refuses.
 *
 * Returns the admitted task the response already carries, so the caller
 * refreshes from what the approval produced rather than guessing when to
 * re-read.
 */
export async function approveTaskModelChoice(
  sessionId: string,
  taskId: string,
  acceptance: { offerId: string; idempotencyKey: string },
  options: ModelChoiceRequestOptions = {},
): Promise<{ task: SessionTask; stepId: string }> {
  const response = await expectOk(
    await fetch(toUrl(taskModelChoicePath(sessionId, taskId)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offerId: acceptance.offerId,
        idempotencyKey: acceptance.idempotencyKey,
      }),
      signal: modelChoiceRequestSignal(options),
    }),
  );
  const payload = (await response.json()) as unknown;
  if (!isRecord(payload) || !isNamedIdentifier(payload.stepId)) {
    throw new ApiContractError("{ task, stepId }");
  }
  const task = requireSessionTask(payload.task);
  // The request named one task. A response about another is not an answer to
  // it, and adopting that task would move the pane to a run nobody approved.
  if (task.id !== taskId || task.sessionId !== sessionId) {
    throw new ApiContractError(
      `an approval for ${sessionId}/${taskId}, not ${task.sessionId}/${task.id}`,
    );
  }
  return { task, stepId: payload.stepId };
}

/**
 * How long a model-choice request may go unanswered.
 *
 * A decision surface that waits forever is worse than one that says it could
 * not read the offer: the person is shown neither a question nor a reason.
 */
export const MODEL_CHOICE_REQUEST_TIMEOUT_MS = 15_000;

export interface ModelChoiceRequestOptions {
  /** Lets a caller abandon the request, typically when its pane unmounts. */
  signal?: AbortSignal;
  /** Overrides the deadline; the default is the constant above. */
  timeoutMs?: number;
}

/**
 * The caller's own cancellation, plus a deadline of our own.
 *
 * `AbortSignal.any` keeps the caller able to abandon a request when its pane
 * unmounts, without giving up the timeout that stops a silent hang.
 */
function modelChoiceRequestSignal(
  options: ModelChoiceRequestOptions,
): AbortSignal {
  const deadline = AbortSignal.timeout(
    options.timeoutMs ?? MODEL_CHOICE_REQUEST_TIMEOUT_MS,
  );
  return options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
}

function taskModelChoicePath(sessionId: string, taskId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/model-choice`;
}

/** A revision is a whole count of writes, so nothing else can be one. */
function isWorkflowRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A name someone could act on.
 *
 * A string of spaces is not an identifier: it names nothing a person can be
 * shown and nothing a server can be asked about, and passing it on turns a
 * corrupt response into a request nobody can trace.
 */
function isNamedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isProviderModelPair(
  value: unknown,
): value is { provider: string; model: string } {
  return (
    isRecord(value) &&
    isNamedIdentifier(value.provider) &&
    isNamedIdentifier(value.model)
  );
}

/**
 * A task-scoped offer names the exact task it belongs to.
 *
 * The identifiers are compared against the ones that were asked for, not merely
 * checked for presence. A well-formed offer for some other task is still not
 * this task's offer, and approving it would send consent down this path.
 */
function isTaskModelChoiceScope(
  value: unknown,
  sessionId: string,
  taskId: string,
): boolean {
  return (
    isRecord(value) &&
    value.kind === "task" &&
    value.sessionId === sessionId &&
    value.taskId === taskId
  );
}

/**
 * Proven whole before it is called an offer.
 *
 * Every required field, both pairs complete, the scope's own discriminant and
 * identifiers, the reason from the allowlist, and the optional invocation id
 * only when it is a string. A partly checked record returned under this type
 * would put a pair on screen that nobody chose.
 */
function isTaskModelChoiceOffer(
  value: unknown,
  sessionId: string,
  taskId: string,
): value is ModelChoiceOffer {
  if (!isRecord(value)) return false;
  const reason = value.reason;
  const invocation = value.logicalInvocationId;
  return (
    isNamedIdentifier(value.offerId) &&
    isNamedIdentifier(value.agentName) &&
    isNamedIdentifier(value.expectedRevision) &&
    isTaskModelChoiceScope(value.scope, sessionId, taskId) &&
    isProviderModelPair(value.failedChoice) &&
    isProviderModelPair(value.proposedDefault) &&
    (invocation === undefined || isNamedIdentifier(invocation)) &&
    (reason === "missing-credential" ||
      reason === "unknown-model" ||
      reason === "provider-rejected")
  );
}

export async function submitHumanInput(
  sessionId: string,
  taskId: string,
  interactionId: string,
  request: HumanInputSubmissionRequest,
): Promise<void> {
  await expectOk(
    await fetch(
      toUrl(
        `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/human-in-the-loop/${encodeURIComponent(interactionId)}/submit`,
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    ),
  );
}

function requirePostChatMessageResponse(
  value: unknown,
): PostChatMessageResponse {
  if (!isRecord(value) || !isRunPlan(value.plan)) {
    throw new ApiContractError("PostChatMessageResponse");
  }
  const response: PostChatMessageResponse = {
    user: requireChatMessage(value.user),
    assistant: requireChatMessage(value.assistant),
    plan: value.plan,
  };
  if (value.session !== undefined)
    response.session = requireSessionSummary(value.session);
  if (value.task !== undefined) {
    if (!isSessionTask(value.task))
      throw new ApiContractError("PostChatMessageResponse.task");
    response.task = value.task;
  }
  if (value.meta !== undefined)
    response.meta = requirePostChatMessageResponseMeta(value.meta);
  return response;
}

/**
 * The one envelope the unified message endpoint answers with, or a refusal.
 *
 * Parsed by branch rather than field by field. A Coordinator turn without its
 * plan and a Team dispatch without its task are not responses with a field
 * missing; they are responses the renderer cannot act on, and accepting either
 * would move the failure to whichever component read it first.
 */
function requireSessionMessageDispatchResponse(
  value: unknown,
): SessionMessageDispatchResponse {
  if (!isRecord(value) || !isRecord(value.dispatch)) {
    throw new ApiContractError("SessionMessageDispatchResponse");
  }
  if (typeof value.replayed !== "boolean") {
    throw new ApiContractError("SessionMessageDispatchResponse.replayed");
  }
  const user = requireChatMessage(value.user);
  if (!Array.isArray(value.messages)) {
    throw new ApiContractError("SessionMessageDispatchResponse.messages");
  }
  const messages = value.messages.map((message) => requireChatMessage(message));
  const session =
    value.session === undefined
      ? undefined
      : requireSessionSummary(value.session);
  const common = {
    user,
    messages,
    replayed: value.replayed,
    ...(session ? { session } : {}),
  };

  const { dispatch } = value;
  if (dispatch.kind === "coordinator" || dispatch.kind === "workflow") {
    if (!isRunPlan(value.plan)) {
      throw new ApiContractError("SessionMessageDispatchResponse.plan");
    }
    const meta: PostChatMessageResponseMeta = requirePostChatMessageResponseMeta(
      value.meta,
    );
    if (dispatch.kind === "workflow") {
      if (!isNonEmptyString(dispatch.workflowId)) {
        throw new ApiContractError("SessionMessageDispatchResponse.dispatch");
      }
      return {
        ...common,
        dispatch: { kind: "workflow", workflowId: dispatch.workflowId },
        plan: value.plan,
        meta,
      };
    }
    if (
      dispatch.selectedWorkflowId !== undefined &&
      !isNonEmptyString(dispatch.selectedWorkflowId)
    ) {
      throw new ApiContractError("SessionMessageDispatchResponse.dispatch");
    }
    return {
      ...common,
      dispatch: {
        kind: "coordinator",
        ...(dispatch.selectedWorkflowId === undefined
          ? {}
          : { selectedWorkflowId: dispatch.selectedWorkflowId }),
      },
      plan: value.plan,
      meta,
    };
  }

  if (dispatch.kind === "agents") {
    if (
      !Array.isArray(dispatch.agentNames) ||
      !dispatch.agentNames.every(isNonEmptyString)
    ) {
      throw new ApiContractError("SessionMessageDispatchResponse.dispatch");
    }
    const meta: PostAgentChatMessageResponseMeta =
      requirePostAgentChatMessageResponseMeta(value.meta);
    return {
      ...common,
      dispatch: { kind: "agents", agentNames: dispatch.agentNames },
      meta,
    };
  }

  if (dispatch.kind === "team") {
    if (!isNonEmptyString(dispatch.teamId)) {
      throw new ApiContractError("SessionMessageDispatchResponse.dispatch");
    }
    if (!isRunPlan(value.plan)) {
      throw new ApiContractError("SessionMessageDispatchResponse.plan");
    }
    if (!isSessionTask(value.task)) {
      throw new ApiContractError("SessionMessageDispatchResponse.task");
    }
    return {
      ...common,
      dispatch: { kind: "team", teamId: dispatch.teamId },
      plan: value.plan,
      task: value.task,
    };
  }

  throw new ApiContractError("SessionMessageDispatchResponse.dispatch");
}

function requirePostAgentChatMessageResponseMeta(
  value: unknown,
): PostAgentChatMessageResponseMeta {
  if (!isRecord(value) || !Array.isArray(value.replies)) {
    throw new ApiContractError("PostAgentChatMessageResponse.meta");
  }
  const replies = value.replies.map((reply) => {
    if (
      !isRecord(reply) ||
      !isNonEmptyString(reply.speakerId) ||
      typeof reply.speakerName !== "string" ||
      typeof reply.model !== "string" ||
      typeof reply.fallback !== "boolean" ||
      (reply.reason !== undefined && typeof reply.reason !== "string") ||
      (reply.folderToolsUnavailable !== undefined &&
        typeof reply.folderToolsUnavailable !== "boolean")
    ) {
      throw new ApiContractError("PostAgentChatMessageResponse.meta.replies");
    }
    return {
      speakerId: reply.speakerId,
      speakerName: reply.speakerName,
      model: reply.model,
      fallback: reply.fallback,
      ...(reply.reason === undefined ? {} : { reason: reply.reason }),
      ...(reply.folderToolsUnavailable === undefined
        ? {}
        : { folderToolsUnavailable: reply.folderToolsUnavailable }),
    };
  });
  const meta: PostAgentChatMessageResponseMeta = { replies };
  if (value.titleModel !== undefined) {
    if (typeof value.titleModel !== "string") {
      throw new ApiContractError("PostAgentChatMessageResponse.meta.titleModel");
    }
    meta.titleModel = value.titleModel;
  }
  if (value.titleFallback !== undefined) {
    if (typeof value.titleFallback !== "boolean") {
      throw new ApiContractError(
        "PostAgentChatMessageResponse.meta.titleFallback",
      );
    }
    meta.titleFallback = value.titleFallback;
  }
  if (value.titleReason !== undefined) {
    if (typeof value.titleReason !== "string") {
      throw new ApiContractError("PostAgentChatMessageResponse.meta.titleReason");
    }
    meta.titleReason = value.titleReason;
  }
  return meta;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * One transcript line, or a refusal.
 *
 * This mirrors the rules the durable transcript is read by
 * (`readTranscriptMessage` in `domains/sessions/session-store.ts`). It is a
 * second implementation, in a package that cannot import the first, so the two
 * are kept honest by tests on both sides rather than by sharing code — a
 * divergence here is a renderer that shows something the store would refuse.
 *
 * Two rules carry the weight: a version-1 line may not carry a version-2
 * field, because an older build ignores what this one would follow; and a
 * version-2 line is all-or-nothing, because dropping the one field that failed
 * to validate hands on a message silently missing exactly the part nobody
 * could check.
 */
function requireChatMessage(value: unknown): ChatMessage {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    (value.role !== "user" &&
      value.role !== "assistant" &&
      value.role !== "system") ||
    typeof value.text !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    throw new ApiContractError("ChatMessage");
  }
  const message: ChatMessage = {
    id: value.id,
    role: value.role,
    text: value.text,
    createdAt: value.createdAt,
  };
  if (value.turnId !== undefined) {
    if (typeof value.turnId !== "string")
      throw new ApiContractError("ChatMessage.turnId");
    message.turnId = value.turnId;
  }
  if (value.speaker !== undefined) {
    if (
      !isRecord(value.speaker) ||
      (value.speaker.type !== "assistant" && value.speaker.type !== "agent") ||
      typeof value.speaker.id !== "string" ||
      typeof value.speaker.name !== "string"
    ) {
      throw new ApiContractError("ChatMessage.speaker");
    }
    message.speaker = {
      type: value.speaker.type,
      id: value.speaker.id,
      name: value.speaker.name,
    };
  }
  if (value.delivery !== undefined)
    message.delivery = requireChatMessageDelivery(value.delivery);
  if (value.outcome !== undefined)
    message.outcome = requireChatMessageOutcome(value.outcome);
  if (value.turnRequest !== undefined) {
    const request = value.turnRequest;
    if (
      !isRecord(request) ||
      !isNonEmptyString(request.fingerprint) ||
      typeof request.expectedReplies !== "number" ||
      !Number.isSafeInteger(request.expectedReplies) ||
      request.expectedReplies < 0
    ) {
      throw new ApiContractError("ChatMessage.turnRequest");
    }
    // Rebuilt field by field rather than passed through, so an unknown key
    // cannot reach the renderer. That means every field a reader needs has to
    // be named here: dropping `admittedSelections` left the default-use notice
    // alive only while its live stream frame was on screen, so it vanished on
    // reload and as soon as a newer turn started, taking every past reply's
    // model label with it.
    const admittedSelections = readAdmittedSelections(request.admittedSelections);
    if (request.admittedSelections !== undefined && !admittedSelections) {
      throw new ApiContractError("ChatMessage.turnRequest.admittedSelections");
    }
    message.turnRequest = {
      fingerprint: request.fingerprint,
      expectedReplies: request.expectedReplies,
      ...(admittedSelections ? { admittedSelections } : {}),
    };
  }
  if (value.execution !== undefined) {
    const execution = value.execution;
    if (
      !isRecord(execution) ||
      !isNonEmptyString(execution.runId) ||
      !isNonEmptyString(execution.assignmentId)
    ) {
      throw new ApiContractError("ChatMessage.execution");
    }
    message.execution = {
      runId: execution.runId,
      assignmentId: execution.assignmentId,
    };
  }
  if (value.conversation !== undefined) {
    const pointer = value.conversation;
    if (
      !isRecord(pointer) ||
      !isNonEmptyString(pointer.conversationId) ||
      !isNonEmptyString(pointer.activityId) ||
      !isNonEmptyString(pointer.turnId)
    ) {
      throw new ApiContractError("ChatMessage.conversation");
    }
    message.conversation = {
      conversationId: pointer.conversationId,
      activityId: pointer.activityId,
      turnId: pointer.turnId,
    };
  }

  // Fields a version-1 reader could not have understood. Carrying one without
  // declaring the version is not a version-1 line.
  const claimsConversation =
    value.conversationId !== undefined ||
    value.kind !== undefined ||
    value.source !== undefined ||
    value.conversation !== undefined ||
    value.cutOff !== undefined;
  if (value.schemaVersion === undefined) {
    if (claimsConversation) throw new ApiContractError("ChatMessage.schemaVersion");
    return message;
  }
  if (value.schemaVersion !== 2)
    throw new ApiContractError("ChatMessage.schemaVersion");

  if (value.kind !== "chat") throw new ApiContractError("ChatMessage.kind");
  const parsedSource = conversationMessageSourceSchema.safeParse(value.source);
  if (!parsedSource.success) throw new ApiContractError("ChatMessage.source");
  const source = parsedSource.data;
  if (source.kind === "agent-dialogue") {
    if (value.conversationId !== undefined || message.conversation !== undefined) {
      throw new ApiContractError("ChatMessage.conversation");
    }
    if (message.role === "system" || (message.role === "assistant" && (!message.speaker || !isNonEmptyString(message.turnId)))) {
      throw new ApiContractError("ChatMessage.source");
    }
    if (value.cutOff !== undefined) {
      message.cutOff = requireChatMessageCutOff(value.cutOff, message.role);
    }
    message.schemaVersion = 2;
    message.kind = "chat";
    message.source = source;
    return message;
  }
  if (value.cutOff !== undefined) throw new ApiContractError("ChatMessage.cutOff");
  if (!isNonEmptyString(value.conversationId))
    throw new ApiContractError("ChatMessage.conversationId");
  // The line, its source and its turn have to agree. A source naming a
  // different turn than the line claims describes two turns at once.
  if (
    message.turnId === undefined ||
    source.turnId !== message.turnId
  ) {
    throw new ApiContractError("ChatMessage.source");
  }
  // A pointer that disagrees with the line it sits on is worse than none: it
  // leads somewhere, and somewhere is the wrong turn.
  if (
    message.conversation &&
    (message.conversation.conversationId !== value.conversationId ||
      message.conversation.activityId !== message.turnId ||
      message.conversation.turnId !== message.turnId)
  ) {
    throw new ApiContractError("ChatMessage.conversation");
  }

  message.schemaVersion = 2;
  message.conversationId = value.conversationId;
  message.kind = "chat";
  message.source = { kind: "conversation-turn", turnId: source.turnId };
  return message;
}

function requireChatMessageCutOff(value: unknown, role: ChatMessage["role"]): NonNullable<ChatMessage["cutOff"]> {
  const parsed = chatMessageCutOffSchema.safeParse(value);
  if (role !== "assistant" || !parsed.success) throw new ApiContractError("ChatMessage.cutOff");
  return parsed.data;
}

function requireChatMessageDelivery(
  value: unknown,
): NonNullable<ChatMessage["delivery"]> {
  if (
    !isRecord(value) ||
    typeof value.taskId !== "string" ||
    !Array.isArray(value.artifacts)
  ) {
    throw new ApiContractError("ChatMessage.delivery");
  }
  const delivery: NonNullable<ChatMessage["delivery"]> = {
    taskId: value.taskId,
    artifacts: value.artifacts.map((artifact) => {
      if (
        !isRecord(artifact) ||
        typeof artifact.runId !== "string" ||
        typeof artifact.path !== "string" ||
        (artifact.role !== "final" && artifact.role !== "secondary")
      ) {
        throw new ApiContractError("ChatMessage.delivery.artifact");
      }
      const parsed: NonNullable<ChatMessage["delivery"]>["artifacts"][number] = {
        runId: artifact.runId,
        path: artifact.path,
        role: artifact.role,
      };
      if (artifact.title !== undefined) {
        if (typeof artifact.title !== "string")
          throw new ApiContractError("ChatMessage.delivery.artifact.title");
        parsed.title = artifact.title;
      }
      if (artifact.mediaType !== undefined) {
        if (typeof artifact.mediaType !== "string")
          throw new ApiContractError("ChatMessage.delivery.artifact.mediaType");
        parsed.mediaType = artifact.mediaType;
      }
      return parsed;
    }),
  };
  if (value.executionAttemptId !== undefined) {
    if (typeof value.executionAttemptId !== "string")
      throw new ApiContractError("ChatMessage.delivery.executionAttemptId");
    delivery.executionAttemptId = value.executionAttemptId;
  }
  return delivery;
}

/**
 * The reference a stopped run leaves on its chat line.
 *
 * Mirrors `isChatMessageOutcome` in `domains/sessions/session-normalizers.ts`,
 * for the same reason the delivery is mirrored: a renderer that showed an
 * outcome the store would refuse is a renderer showing something no reader
 * could check.
 */
function requireChatMessageOutcome(
  value: unknown,
): NonNullable<ChatMessage["outcome"]> {
  if (
    !isRecord(value) ||
    typeof value.taskId !== "string" ||
    (value.status !== "failed" && value.status !== "blocked") ||
    typeof value.workflowId !== "string"
  ) {
    throw new ApiContractError("ChatMessage.outcome");
  }
  const outcome: NonNullable<ChatMessage["outcome"]> = {
    taskId: value.taskId,
    status: value.status,
    workflowId: value.workflowId,
  };
  if (value.executionAttemptId !== undefined) {
    if (typeof value.executionAttemptId !== "string")
      throw new ApiContractError("ChatMessage.outcome.executionAttemptId");
    outcome.executionAttemptId = value.executionAttemptId;
  }
  if (value.stepId !== undefined) {
    if (typeof value.stepId !== "string")
      throw new ApiContractError("ChatMessage.outcome.stepId");
    outcome.stepId = value.stepId;
  }
  if (value.reason !== undefined) {
    if (typeof value.reason !== "string")
      throw new ApiContractError("ChatMessage.outcome.reason");
    outcome.reason = value.reason;
  }
  return outcome;
}

/**
 * A session read against the schema the contract derives its type from.
 *
 * The error names the first field that failed, so a refusal says what was
 * wrong rather than only that something was.
 */
function requireSessionSummary(value: unknown): SessionSummary {
  const read = sessionSummarySchema.safeParse(value);
  if (read.success) return read.data;
  const [field] = read.error.issues[0]?.path ?? [];
  throw new ApiContractError(
    typeof field === "string" ? `SessionSummary.${field}` : "SessionSummary",
  );
}

function requirePostChatMessageResponseMeta(
  value: unknown,
): NonNullable<PostChatMessageResponse["meta"]> {
  if (
    !isRecord(value) ||
    typeof value.model !== "string" ||
    typeof value.fallback !== "boolean"
  ) {
    throw new ApiContractError("PostChatMessageResponse.meta");
  }
  const meta: NonNullable<PostChatMessageResponse["meta"]> = {
    model: value.model,
    fallback: value.fallback,
  };
  for (const key of ["reason", "titleModel", "titleReason"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string")
        throw new ApiContractError(`PostChatMessageResponse.meta.${key}`);
      meta[key] = value[key];
    }
  }
  if (value.titleFallback !== undefined) {
    if (typeof value.titleFallback !== "boolean")
      throw new ApiContractError("PostChatMessageResponse.meta.titleFallback");
    meta.titleFallback = value.titleFallback;
  }
  return meta;
}

function requireRunPlanEnvelope(
  value: unknown,
  allowNull: true,
): RunPlan | null;
function requireRunPlanEnvelope(value: unknown, allowNull: false): RunPlan;
function requireRunPlanEnvelope(
  value: unknown,
  allowNull: boolean,
): RunPlan | null {
  if (!isRecord(value) || !("plan" in value)) {
    throw new ApiContractError("{ plan: RunPlan }");
  }
  if (allowNull && value.plan === null) return null;
  if (!isRunPlan(value.plan)) {
    throw new ApiContractError("RunPlan");
  }
  return value.plan;
}

function requirePlanningAttemptEnvelope(
  value: unknown,
): DeepResearchPlanningAttemptSnapshot {
  if (
    !isRecord(value) ||
    !isDeepResearchPlanningAttemptSnapshot(value.attempt)
  ) {
    throw new ApiContractError(
      "{ attempt: DeepResearchPlanningAttemptSnapshot }",
    );
  }
  return value.attempt;
}

function parsePlanningSseEvent(
  block: string,
): DeepResearchPlanningEvent | null {
  const dataLines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) return null;
  const value: unknown = JSON.parse(dataLines.join("\n"));
  if (!isDeepResearchPlanningEvent(value)) {
    throw new ApiContractError("DeepResearchPlanningEvent");
  }
  return value;
}

function planningReconnectDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 250);
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requireSessionTask(value: unknown): SessionTask {
  if (!isSessionTask(value)) {
    throw new ApiContractError("SessionTask");
  }
  return value;
}

function isHumanInputInteractionSnapshot(
  value: unknown,
): value is HumanInputInteractionSnapshot {
  if (
    !isRecord(value) ||
    !isRecord(value.sourceArtifact) ||
    !Array.isArray(value.eligibleRecipients)
  ) {
    return false;
  }
  return (
    typeof value.interactionId === "string" &&
    (value.status === "pending" ||
      value.status === "submitted" ||
      value.status === "consumed" ||
      value.status === "cancelled") &&
    typeof value.sourceArtifact.sha256 === "string" &&
    value.eligibleRecipients.every(
      (recipient) =>
        isRecord(recipient) &&
        typeof recipient.id === "string" &&
        typeof recipient.mentionToken === "string" &&
        typeof recipient.displayName === "string",
    )
  );
}

function requireSessionTasksEnvelope(value: unknown): SessionTask[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.tasks) ||
    !value.tasks.every(isSessionTask)
  ) {
    throw new ApiContractError("{ tasks: SessionTask[] }");
  }
  return value.tasks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Subscribe to a session turn's display-only text stream.
 *
 * The session owns every text channel opened for it, whichever kind of turn
 * opened it, so one endpoint serves them all.
 */
export function openAgentTextStream(params: {
  sessionId: string;
  channelId: string;
  signal: AbortSignal;
  onDelivery: (delivery: AgentTextStreamDelivery) => void;
}): Promise<void> {
  return openAgentTextStreamAt({
    path: `/sessions/${encodeURIComponent(params.sessionId)}/agent-chat/stream`,
    channelId: params.channelId,
    signal: params.signal,
    onDelivery: params.onDelivery,
  });
}

/**
 * The model each speaker of a turn was admitted on, read back from the API.
 *
 * Validated rather than trusted, and refused whole rather than in part: a
 * notice built from half a record would state something no execution recorded.
 */
function readAdmittedSelections(
  value: unknown,
): Record<string, ModelSelectionRecord> | undefined {
  if (!isRecord(value)) return undefined;
  const selections: Record<string, ModelSelectionRecord> = {};
  for (const [speaker, entry] of Object.entries(value)) {
    const selection = readModelSelectionRecord(entry);
    if (!speaker || !selection) return undefined;
    selections[speaker] = selection;
  }
  return selections;
}
