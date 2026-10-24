import type { TaskRunEntry } from '@/components/run/tasks/task-strip';
import type { RunBlockedCause, RunEvent } from "@/components/run/stage-renderers";
import type { ChatMessage } from "@/lib/models/session-model";
import { PROVIDER_FAILURE_USER_MESSAGES } from "@contracts/provider";

export interface WorkflowTaskEventGroup {
  taskActive?: boolean | undefined;
  taskStatus?: TaskRunEntry['mode'];
  taskId: string;
  taskRunId: string;
  targetKind?: "team-chat";
  events: RunEvent[];
}

export interface PendingWorkflowAgent {
  activity?: "selecting-team-members" | "finalizing-workflow";
  startedAt?: number;
  id: string;
  model?: string | undefined;
  name: string;
  provider?: string | undefined;
  speakerId: string;
  taskId: string;
}

export interface WorkflowChatMessage extends ChatMessage {
  agentQuestion?: import('@contracts/agent-questions').AgentQuestionView;
  workflow: {
    messageType?: RunEvent["messageType"];
    model?: string | undefined;
    provider?: string | undefined;
    round?: number | undefined;
    runId?: string | undefined;
    taskId: string;
  };
}

interface OrderedWorkflowEvent {
  event: RunEvent;
  group: WorkflowTaskEventGroup;
  order: number;
}

const TERMINAL_TASK_EVENT_TYPES = new Set<RunEvent["type"]>([
  "run.completed",
  "run.failed",
  "run.blocked",
  "run.cancelled",
  "run.incomplete",
  "run.interrupted",
]);

/**
 * The two durable content families the transcript may hold.
 *
 * `team.message` is what every Team engine records now. `discussion.message`
 * is what sessions recorded before that contract existed, and dropping it
 * would empty their transcripts, so both are read and neither is rewritten.
 */
function isDurableChatContent(event: RunEvent): boolean {
  return event.type === "team.message" || event.type === "discussion.message";
}

export function buildWorkflowChatMessages(
  groups: WorkflowTaskEventGroup[],
): WorkflowChatMessage[] {
  const runtimeModelByAgent = buildRuntimeModelByAgent(groups);
  // A durable message arrives twice whenever a snapshot and the live stream
  // overlap. Its own identity makes the second copy recognisable.
  const seenMessageIds = new Set<string>();
  return orderedEvents(groups, isVisibleWorkflowChatEvent)
    .flatMap(({ event, group }) => {
      const runStatusMessage = buildTeamRunStatusMessage(group, event);
      if (runStatusMessage) return [runStatusMessage];
      if (!isDurableChatContent(event)) return [];
      if (event.messageId) {
        if (seenMessageIds.has(event.messageId)) return [];
        seenMessageIds.add(event.messageId);
      }

      const text = visibleWorkflowMessageContent(
        event.content ?? "",
        event.messageType,
        [event.runId, group.taskRunId],
      ).trim();
      if (!event.agentName || !text) {
        return [];
      }
      const runtimeModel = findRuntimeModel(
        runtimeModelByAgent,
        group.taskId,
        event,
      );

      return [{
        id: event.messageId
          ? `workflow:${group.taskId}:${event.messageId}`
          : `workflow:${group.taskId}:${event.id}`,
        role: "assistant" as const,
        text,
        createdAt: eventTimestamp(event.ts),
        speaker: {
          type: "agent" as const,
          id: event.agentId ?? event.agentName,
          name: event.agentName,
        },
        workflow: {
          messageType: event.messageType,
          model: event.model ?? runtimeModel?.model,
          provider: event.provider ?? runtimeModel?.provider,
          round: event.round,
          runId: event.runId,
          taskId: group.taskId,
        },
      }];
    });
}

function isVisibleWorkflowChatEvent(event: RunEvent): boolean {
  return isDurableChatContent(event) ||
    event.type === "run.failed" ||
    event.type === "run.blocked";
}

function buildTeamRunStatusMessage(
  group: WorkflowTaskEventGroup,
  event: RunEvent,
): WorkflowChatMessage | undefined {
  if (
    group.targetKind !== "team-chat" ||
    (event.type !== "run.failed" && event.type !== "run.blocked") ||
    (event.runId !== undefined && event.runId !== group.taskRunId)
  ) {
    return undefined;
  }

  return {
    id: `workflow:${group.taskId}:${event.id}`,
    role: "assistant",
    text: teamRunStatusText(group, event),
    createdAt: eventTimestamp(event.ts),
    speaker: {
      type: "assistant",
      id: "team-runtime",
      name: "Team runtime",
    },
    workflow: {
      messageType: "error",
      runId: event.runId,
      taskId: group.taskId,
    },
  };
}

/**
 * What each nameable blocked outcome means to the person reading the chat.
 *
 * A review that used up its rounds is terminal: nothing is waiting for a
 * reply, and only a new run moves it on. Saying "resolve the blocked run"
 * there described an action that does not exist.
 */
const BLOCKED_CAUSE_USER_MESSAGES: Record<RunBlockedCause, string> = {
  review_exhausted:
    "The reviewer did not approve this within the rounds the Team allows, " +
    "so nothing was published. Nothing is waiting for you — start a new run to try again.",
};

function teamRunStatusText(
  group: WorkflowTaskEventGroup,
  event: RunEvent,
): string {
  const terminalEventIndex = group.events.indexOf(event);
  const priorEvents = terminalEventIndex < 0
    ? group.events
    : group.events.slice(0, terminalEventIndex);
  const cause = providerFailureCause(priorEvents);

  if (event.type === "run.blocked") {
    // A blocked run the runtime could name reads as what happened, not as
    // something the user is expected to go and unblock. The sentence is this
    // build's own: the raw error can carry a child's stderr, a path or a token.
    const blockedCause = event.blockedCause
      ? BLOCKED_CAUSE_USER_MESSAGES[event.blockedCause]
      : undefined;
    return withCause(
      blockedCause ??
        "The Team is blocked and could not complete this response. Resolve the blocked run before you try again.",
      cause,
    );
  }

  const started = priorEvents.some(
    (candidate) =>
      candidate.type === "agent.start" ||
      isDurableChatContent(candidate),
  );
  return withCause(
    started
      ? "The Team stopped before it could complete this response. Check the run details before you try again."
      : "The Team could not start. Its configuration or provider setup needs attention before you try again.",
    cause,
  );
}

/**
 * The reason a run ended, when a provider gave one.
 *
 * Read from the last failed agent run rather than from the terminal event: the
 * terminal event says the run is over, and the agent that failed is what says
 * why. The raw error is never consulted — it can hold a child's stderr, a
 * token, or an absolute path — so this reads only the closed union, and the
 * sentence is this build's own.
 */
function providerFailureCause(priorEvents: RunEvent[]): string | undefined {
  for (let index = priorEvents.length - 1; index >= 0; index -= 1) {
    const kind = priorEvents[index]?.providerFailureKind;
    if (kind) return PROVIDER_FAILURE_USER_MESSAGES[kind];
  }
  return undefined;
}

function withCause(status: string, cause: string | undefined): string {
  return cause ? `${cause} ${status}` : status;
}

export function findPendingWorkflowAgents(
  groups: WorkflowTaskEventGroup[],
  options: { readonly retainUntilOutcome?: boolean } = {},
): PendingWorkflowAgent[] {
  const activeByLifecycleKey = new Map<string, PendingWorkflowAgent[]>();

  for (const { event, group } of orderedEvents(groups, isPendingLifecycleEvent)) {
    const retain = options.retainUntilOutcome === true && group.targetKind !== 'team-chat';
    if (TERMINAL_TASK_EVENT_TYPES.has(event.type)) {
      const awaitingOutcome = event.type === 'run.completed' || event.type === 'run.failed'
        || event.type === 'run.blocked' || event.type === 'run.incomplete';
      if (retain && awaitingOutcome) {
        finalizeWorkflowAgents(activeByLifecycleKey, group.taskId,
          event.runId === group.taskRunId ? undefined : event.runId);
      } else if (!event.runId || event.runId === group.taskRunId) {
        clearTaskAgents(activeByLifecycleKey, group.taskId);
      } else {
        clearRunAgents(activeByLifecycleKey, group.taskId, event.runId);
      }
      continue;
    }

    if (!event.agentName) continue;
    const lifecycleKey = agentLifecycleKey(group.taskId, event);
    if (event.type === "agent.start") {
      // A retry replaces this worker's previous finishing marker in this run.
      const runPrefix = `${group.taskId}\0${event.runId ?? 'run'}\0`;
      for (const [key, agents] of activeByLifecycleKey) {
        if (key.startsWith(runPrefix)) {
          activeByLifecycleKey.set(key, agents.filter((agent) =>
            agent.activity !== 'finalizing-workflow' || agent.name !== event.agentName));
        }
      }
      const active = activeByLifecycleKey.get(lifecycleKey) ?? [];
      active.push({
        ...(event.agentActivity ? { activity: event.agentActivity } : {}),
        id: `${group.taskId}:${event.id}`,
        ...(Number.isFinite(event.ts) ? { startedAt: event.ts } : {}),
        model: event.model,
        name: event.agentName,
        provider: event.provider,
        speakerId: event.agentId ?? event.agentName,
        taskId: group.taskId,
      });
      activeByLifecycleKey.set(lifecycleKey, active);
    } else if (
      event.type === "agent.end" ||
      event.type === "agent.fail" ||
      isDurableChatContent(event)
    ) {
      if (retain && !isDurableChatContent(event)) {
        const active = activeByLifecycleKey.get(lifecycleKey);
        if (active) activeByLifecycleKey.set(lifecycleKey, active.map((agent, index) =>
          index === active.length - 1 ? { ...agent, activity: 'finalizing-workflow' } : agent));
      } else {
        completeLatestAgent(activeByLifecycleKey, lifecycleKey);
      }
    }
  }

  for (const group of groups) {
    if (group.taskActive === false) {
      const awaitingOutcome = group.taskStatus === undefined || group.taskStatus === 'done'
        || group.taskStatus === 'error' || group.taskStatus === 'blocked';
      if (options.retainUntilOutcome && group.targetKind !== 'team-chat' && awaitingOutcome) {
        finalizeWorkflowAgents(activeByLifecycleKey, group.taskId);
      } else {
        clearTaskAgents(activeByLifecycleKey, group.taskId);
      }
    }
  }

  return [...activeByLifecycleKey.values()].flat();
}

interface RuntimeAgentModel {
  model?: string | undefined;
  provider?: string | undefined;
}

/**
 * The model each attempt ran on, keyed by the attempt itself.
 *
 * One Agent can speak more than once in a task on different models — a
 * user-approved retry on the app default is exactly that — so the dispatch is
 * the only key that cannot relabel an earlier reply with a later attempt's
 * model. The task-and-agent key is kept as a second map, used only for runs
 * recorded before dispatch ids existed; there the newest value is still the
 * best available answer, and the alternative is showing nothing.
 */
interface RuntimeModelIndex {
  byDispatch: Map<string, RuntimeAgentModel>;
  byTaskAgent: Map<string, RuntimeAgentModel>;
}

function buildRuntimeModelByAgent(
  groups: readonly WorkflowTaskEventGroup[],
): RuntimeModelIndex {
  const byDispatch = new Map<string, RuntimeAgentModel>();
  const byTaskAgent = new Map<string, RuntimeAgentModel>();
  for (const group of groups) {
    for (const event of group.events) {
      if (!event.model && !event.provider) continue;
      if (event.dispatchId) {
        const current = byDispatch.get(event.dispatchId);
        byDispatch.set(event.dispatchId, {
          model: event.model ?? current?.model,
          provider: event.provider ?? current?.provider,
        });
      }
      for (const key of agentIdentityKeys(event)) {
        const taskAgentKey = `${group.taskId}\0${key}`;
        const current = byTaskAgent.get(taskAgentKey);
        byTaskAgent.set(taskAgentKey, {
          model: event.model ?? current?.model,
          provider: event.provider ?? current?.provider,
        });
      }
    }
  }
  return { byDispatch, byTaskAgent };
}

function findRuntimeModel(
  index: RuntimeModelIndex,
  taskId: string,
  event: Pick<RunEvent, "agentId" | "agentName" | "dispatchId">,
): RuntimeAgentModel | undefined {
  // A message that names its dispatch is answered by that dispatch alone, and
  // by nothing when that dispatch recorded no model. Falling through to the
  // agent-wide value is exactly how a later attempt's model ends up on an
  // earlier attempt's reply; "not recorded" is the truthful answer.
  if (event.dispatchId) return index.byDispatch.get(event.dispatchId);
  for (const key of agentIdentityKeys(event)) {
    const model = index.byTaskAgent.get(`${taskId}\0${key}`);
    if (model) return model;
  }
  return undefined;
}

function agentIdentityKeys(
  event: Pick<RunEvent, "agentId" | "agentName">,
): string[] {
  return [event.agentId, event.agentName]
    .map((value) => value?.trim().toLocaleLowerCase())
    .filter((value): value is string => Boolean(value));
}

export function isWorkflowChatMessage(
  message: ChatMessage,
): message is WorkflowChatMessage {
  return "workflow" in message &&
    typeof (message as Partial<WorkflowChatMessage>).workflow?.taskId === "string";
}

export function stripArtifactFrontmatter(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return text;
  const closingMarker = normalized.indexOf("\n---", 3);
  if (closingMarker < 0) return text;
  const afterMarker = closingMarker + 4;
  if (
    afterMarker < normalized.length &&
    normalized[afterMarker] !== "\n"
  ) {
    return text;
  }
  return normalized.slice(afterMarker).replace(/^\n+/, "");
}

function visibleWorkflowMessageContent(
  text: string,
  messageType: RunEvent["messageType"],
  internalIdentifiers: ReadonlyArray<string | undefined>,
): string {
  const withoutInternalIdentifiers = removeInternalIdentifierLines(
    stripArtifactFrontmatter(text),
    internalIdentifiers,
  );
  if (messageType !== "framing") return withoutInternalIdentifiers;

  const normalized = withoutInternalIdentifiers.replaceAll("\r\n", "\n");
  const fileContextHeading = normalized.search(
    /^## Uploaded File Context[ \t]*$/m,
  );
  return fileContextHeading < 0
    ? withoutInternalIdentifiers
    : normalized.slice(0, fileContextHeading).trimEnd();
}

function removeInternalIdentifierLines(
  text: string,
  identifiers: ReadonlyArray<string | undefined>,
): string {
  const sensitiveIdentifiers = identifiers.filter(
    (identifier): identifier is string =>
      typeof identifier === "string" && identifier.length >= 8,
  );
  if (sensitiveIdentifiers.length === 0) return text;

  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter(
      (line) =>
        !sensitiveIdentifiers.some((identifier) => line.includes(identifier)),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function orderedEvents(
  groups: WorkflowTaskEventGroup[],
  include: (event: RunEvent) => boolean,
): OrderedWorkflowEvent[] {
  let order = 0;
  return groups
    .flatMap((group) => group.events.flatMap((event) => {
      const eventOrder = order++;
      return include(event) ? [{ event, group, order: eventOrder }] : [];
    }))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.event.ts) ? left.event.ts : 0;
      const rightTime = Number.isFinite(right.event.ts) ? right.event.ts : 0;
      return leftTime - rightTime || left.order - right.order;
    });
}

function isPendingLifecycleEvent(event: RunEvent): boolean {
  return TERMINAL_TASK_EVENT_TYPES.has(event.type) ||
    event.type === "agent.start" ||
    event.type === "agent.end" ||
    event.type === "agent.fail" ||
    isDurableChatContent(event);
}

function agentLifecycleKey(taskId: string, event: RunEvent): string {
  // A paused agent's end event can omit the stage fields carried by its start.
  // The dispatch identifies that attempt across both records and across resume.
  if (event.dispatchId) {
    return [taskId, event.runId ?? "run", "dispatch", event.dispatchId].join("\0");
  }
  return [
    taskId,
    event.runId ?? "run",
    event.stageName ?? event.stageType ?? "stage",
    event.agentId ?? event.agentName ?? "agent",
  ].join("\0");
}

function completeLatestAgent(
  activeByLifecycleKey: Map<string, PendingWorkflowAgent[]>,
  lifecycleKey: string,
): void {
  const active = activeByLifecycleKey.get(lifecycleKey);
  if (!active?.length) return;
  active.pop();
  if (active.length === 0) activeByLifecycleKey.delete(lifecycleKey);
}

function finalizeWorkflowAgents(
  activeByLifecycleKey: Map<string, PendingWorkflowAgent[]>,
  taskId: string,
  runId?: string,
): void {
  const prefix = runId ? `${taskId}\0${runId}\0` : `${taskId}\0`;
  for (const [key, agents] of activeByLifecycleKey) {
    if (key.startsWith(prefix)) activeByLifecycleKey.set(key,
      agents.map((agent) => ({ ...agent, activity: 'finalizing-workflow' })));
  }
}

function clearTaskAgents(
  activeByLifecycleKey: Map<string, PendingWorkflowAgent[]>,
  taskId: string,
): void {
  const prefix = `${taskId}\0`;
  for (const key of activeByLifecycleKey.keys()) {
    if (key.startsWith(prefix)) activeByLifecycleKey.delete(key);
  }
}

function clearRunAgents(
  activeByLifecycleKey: Map<string, PendingWorkflowAgent[]>,
  taskId: string,
  runId: string,
): void {
  const prefix = `${taskId}\0${runId}\0`;
  for (const key of activeByLifecycleKey.keys()) {
    if (key.startsWith(prefix)) activeByLifecycleKey.delete(key);
  }
}

function eventTimestamp(timestamp: number): string {
  return new Date(Number.isFinite(timestamp) ? timestamp : 0).toISOString();
}
