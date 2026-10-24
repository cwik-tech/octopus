/**
 * Team Runtime — JSONL Event Logger
 *
 * Structured event logging for discussions, tool usage, and level transitions.
 * All logs are JSONL (one JSON object per line) for easy parsing and analysis.
 *
 * Extracted from CMO-crew's appendJsonl pattern.
 */

import { whenDefined } from "../../core/optional-properties.js"
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ConversationMessage,
  GateCondition,
  AgentErrorEvent,
  AgentRunEvent,
  ProviderEvent,
} from "../../core/types.js";
import { publishEngineEvent } from "./runtime-events.js";

const ASSIGNMENT_LOG_DIRNAME = "logs";

/**
 * A process-level diagnostic, for facts that belong to the process rather than
 * to any assignment.
 *
 * Everything else in this module is assignment-scoped and writes into that
 * assignment's log directory. Startup configuration has no assignment yet, so
 * it needs somewhere to go that is still one named place rather than a
 * `console.warn` at each call site.
 */
export function logProcessWarning(scope: string, message: string): void {
  process.stderr.write(`[${scope}] ${message}\n`)
}

export function getLogsDir(outputDir: string): string {
  return path.join(outputDir, ASSIGNMENT_LOG_DIRNAME);
}

export function getAssignmentLogPath(
  outputDir: string,
  filename: string,
): string {
  return path.join(getLogsDir(outputDir), filename);
}

/**
 * The run a log directory belongs to. Every event already written to this log
 * carries the assignment id as its `run_id`, so an event that cannot name its
 * own session can still be attributed to the right run instead of being
 * absorbed by the root — which would render it under the wrong team, at the
 * wrong depth, in the root's colour.
 */
function owningRunId(outputDir: string): string | undefined {
  return path.basename(path.resolve(outputDir)) || undefined;
}

/**
 * Append a JSON object as a single line to a JSONL file.
 */
export function appendJsonl(
  filePath: string,
  obj: unknown,
  options: { readonly mode?: number } = {},
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, "a", options.mode ?? 0o666);
  try {
    if (options.mode !== undefined) fs.fchmodSync(descriptor, options.mode);
    fs.writeFileSync(descriptor, JSON.stringify(obj) + "\n");
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Log a conversation message to the discussion JSONL file.
 *
 * `publishContentEvent` exists for one case: a Team chat run records the same
 * answer as a mode-neutral `team.message`, and announcing it twice would put
 * the reply in the transcript twice. The conversation file is still written,
 * because it is the discussion's own record and the engine reads it back.
 */
export function logConversationMessage(
  outputDir: string,
  message: ConversationMessage,
  rootSessionId?: string,
  context: {
    sessionId?: string;
    parentSessionId?: string;
    team?: string;
    levelId?: string;
    stageType?: string;
    publishContentEvent?: boolean;
  } = {},
): void {
  const entry: Record<string, unknown> = { ...message };
  if (rootSessionId) entry.root_session_id = rootSessionId;
  appendJsonl(getAssignmentLogPath(outputDir, "conversation.jsonl"), entry);
  if (context.publishContentEvent === false) return;
  publishEngineEvent(outputDir, {
    timestamp: message.timestamp,
    category: "stage",
    type: "discussion.message",
    ...whenDefined(context.sessionId, (definedValue) => ({ run_id: definedValue })),
    ...whenDefined(rootSessionId, (definedValue) => ({ root_run_id: definedValue })),
    ...whenDefined(context.parentSessionId, (definedValue) => ({ parent_run_id: definedValue })),
    assignment_path: outputDir,
    team: context.team ?? null,
    level_id: context.levelId ?? null,
    stage_type: context.stageType ?? "discussion",
    payload: {
      ...entry,
      agent_name: message.from,
      text: message.message,
      round: message.round,
      message_type: message.type,
      ...whenDefined(message.dispatchId, (dispatch_id) => ({ dispatch_id })),
    },
  });
}

/**
 * Log a tool usage event.
 */
export function logToolUse(
  outputDir: string,
  toolName: string,
  toolCallId: string,
  isError: boolean,
  rootSessionId?: string,
  extra: Record<string, unknown> = {},
): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    tool_name: toolName,
    tool_call_id: toolCallId,
    is_error: isError,
    ...extra,
  };
  if (rootSessionId) entry.root_session_id = rootSessionId;
  appendJsonl(getAssignmentLogPath(outputDir, "tool-use.jsonl"), entry);
  publishEngineEvent(outputDir, {
    timestamp: String(entry.timestamp),
    category: "tool",
    type: isError ? "tool.execution_failed" : "tool.execution_logged",
    ...whenDefined(typeof extra.session_id === "string"
        ? extra.session_id
        : owningRunId(outputDir), (definedValue) => ({ run_id: definedValue })),
    ...whenDefined(rootSessionId, (definedValue) => ({ root_run_id: definedValue })),
    ...whenDefined(typeof extra.parent_session_id === "string"
        ? extra.parent_session_id
        : undefined, (definedValue) => ({ parent_run_id: definedValue })),
    assignment_path: outputDir,
    team: typeof extra.team === "string" ? extra.team : null,
    level_id: typeof extra.level_id === "string" ? extra.level_id : null,
    stage_type: typeof extra.stage_type === "string" ? extra.stage_type : null,
    payload: entry,
  });
}

/**
 * Log a level transition event.
 */
export function logLevelTransition(
  outputDir: string,
  fromLevel: string,
  toLevel: string,
  gate: GateCondition,
  rootSessionId?: string,
): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    from: fromLevel,
    to: toLevel,
    gate_type: gate.type,
    gate: gate,
  };
  if (rootSessionId) entry.root_session_id = rootSessionId;
  appendJsonl(
    getAssignmentLogPath(outputDir, "level-transitions.jsonl"),
    entry,
  );
  publishEngineEvent(outputDir, {
    timestamp: String(entry.timestamp),
    category: "gate",
    type: "gate.transition",
    ...whenDefined(owningRunId(outputDir), (definedValue) => ({ run_id: definedValue })),
    ...whenDefined(rootSessionId, (definedValue) => ({ root_run_id: definedValue })),
    assignment_path: outputDir,
    level_id: fromLevel,
    payload: entry,
  });
}

/**
 * Log a session start event.
 */
export function logSessionStart(
  outputDir: string,
  sessionId: string,
  teamName: string,
  agents: string[],
  rootSessionId?: string,
): void {
  const entry: Record<string, unknown> = {
    session_start: "1",
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    team: teamName,
    agents,
  };
  if (rootSessionId) entry.root_session_id = rootSessionId;
  appendJsonl(getAssignmentLogPath(outputDir, "conversation.jsonl"), entry);
  // Initialize structured logs used by runtime observability.
  fs.mkdirSync(getLogsDir(outputDir), { recursive: true });
  for (const filename of [
    "tool-use.jsonl",
    "agent-runs.jsonl",
    "delegations.jsonl",
    "delegation-lifecycle.jsonl",
    "delegation-state.json",
    "team-spawns.jsonl",
    "agent-dispatch.jsonl",
    "provider-events.jsonl",
    "transcript-raw.jsonl",
    "transcript-events.jsonl",
    "host-events.jsonl",
    "review-events.jsonl",
    "runtime-events.jsonl",
    "engine-events.jsonl",
  ]) {
    const filePath = getAssignmentLogPath(outputDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "");
    }
  }
  publishEngineEvent(outputDir, {
    timestamp: String(entry.timestamp),
    category: "run",
    type: "run.session_started",
    run_id: sessionId,
    ...whenDefined(rootSessionId, (definedValue) => ({ root_run_id: definedValue })),
    assignment_path: outputDir,
    team: teamName,
    payload: entry,
  });
}

/**
 * Log an agent dispatch event (for pipeline engine).
 */
export function logAgentDispatch(
  outputDir: string,
  agentName: string,
  taskId: string,
  taskTitle: string,
  rootSessionId?: string,
): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    agent: agentName,
    task_id: taskId,
    task_title: taskTitle,
  };
  if (rootSessionId) entry.root_session_id = rootSessionId;
  appendJsonl(getAssignmentLogPath(outputDir, "agent-dispatch.jsonl"), entry);
}

/**
 * Log a team spawn event (for team-of-teams).
 */
export function logTeamSpawn(
  outputDir: string,
  parentTeam: string,
  parentLevel: string,
  parentAgent: string,
  childTeam: string,
  brief: string,
  spawnDepth: number,
  childSessionId: string,
  childAssignmentPath: string,
  briefArtifactPath: string,
  resultArtifactPath: string,
  rootSessionId?: string,
): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    from: parentTeam,
    to: childTeam,
    parent_team: parentTeam,
    parent_level: parentLevel,
    parent_agent: parentAgent,
    child_team: childTeam,
    child_session_id: childSessionId,
    child_assignment_path: childAssignmentPath,
    brief_artifact: briefArtifactPath,
    result_artifact: resultArtifactPath,
    brief_preview: brief.slice(0, 200),
    spawn_depth: spawnDepth,
  };
  if (rootSessionId) entry.root_session_id = rootSessionId;
  appendJsonl(getAssignmentLogPath(outputDir, "team-spawns.jsonl"), entry);
}

/**
 * Log a normalized delegation event for parent/child lineage tracking.
 */
export function logDelegationEvent(
  outputDir: string,
  event: Record<string, unknown>,
): void {
  appendJsonl(getAssignmentLogPath(outputDir, "delegations.jsonl"), event);
  publishEngineEvent(outputDir, {
    timestamp:
      typeof event.timestamp === "string"
        ? event.timestamp
        : new Date().toISOString(),
    category: "delegation",
    type: typeof event.event === "string" ? event.event : "delegation.event",
    ...whenDefined(typeof event.session_id === "string" ? event.session_id : undefined, (definedValue) => ({ run_id: definedValue })),
    ...whenDefined(typeof event.root_session_id === "string"
        ? event.root_session_id
        : undefined, (definedValue) => ({ root_run_id: definedValue })),
    ...whenDefined(typeof event.parent_session_id === "string"
        ? event.parent_session_id
        : undefined, (definedValue) => ({ parent_run_id: definedValue })),
    assignment_path: outputDir,
    team: typeof event.team === "string" ? event.team : null,
    level_id: typeof event.level_id === "string" ? event.level_id : null,
    stage_type: typeof event.stage_type === "string" ? event.stage_type : null,
    payload: { ...event },
  });
}

/**
 * Log explicit agent/team execution lifecycle events.
 */
export function logAgentRun(outputDir: string, event: AgentRunEvent): void {
  appendJsonl(getAssignmentLogPath(outputDir, "agent-runs.jsonl"), event);
  publishEngineEvent(outputDir, {
    timestamp: event.timestamp,
    category: "agent",
    type: `agent.${event.event}`,
    run_id: event.session_id,
    ...whenDefined(event.root_session_id, (definedValue) => ({ root_run_id: definedValue })),
    assignment_path: event.assignment_path,
    team: event.team,
    level_id: event.level_id ?? null,
    stage_type: event.stage_type ?? null,
    payload: { ...event },
  });
}

/**
 * Log provider-level lifecycle events (for LM Studio / API transport visibility).
 */
export function logProviderEvent(
  outputDir: string,
  event: ProviderEvent,
): void {
  appendJsonl(getAssignmentLogPath(outputDir, "provider-events.jsonl"), event);
  publishEngineEvent(outputDir, {
    timestamp: event.timestamp,
    category: "runtime",
    type: `provider.${event.event}`,
    ...whenDefined(event.session_id, (definedValue) => ({ run_id: definedValue })),
    ...whenDefined(event.root_session_id, (definedValue) => ({ root_run_id: definedValue })),
    ...whenDefined(event.assignment_path, (definedValue) => ({ assignment_path: definedValue })),
    payload: { ...event },
  });
}

export function logHostEvent(
  outputDir: string,
  event: Record<string, unknown>,
): void {
  appendJsonl(getAssignmentLogPath(outputDir, "host-events.jsonl"), event);
  publishEngineEvent(outputDir, {
    timestamp:
      typeof event.timestamp === "string"
        ? event.timestamp
        : new Date().toISOString(),
    category: "runtime",
    type: typeof event.event === "string" ? event.event : "host.event",
    ...whenDefined(typeof event.session_id === "string" ? event.session_id : undefined, (definedValue) => ({ run_id: definedValue })),
    ...whenDefined(typeof event.root_session_id === "string"
        ? event.root_session_id
        : undefined, (definedValue) => ({ root_run_id: definedValue })),
    assignment_path:
      typeof event.assignment_path === "string"
        ? event.assignment_path
        : outputDir,
    team: typeof event.team === "string" ? event.team : null,
    level_id: typeof event.level_id === "string" ? event.level_id : null,
    stage_type: typeof event.stage_type === "string" ? event.stage_type : null,
    payload: event,
  });
}

/**
 * Log an agent error event to workspace/agent-errors.jsonl.
 * Used by the failure policy module to record retry/fallback/skip/halt events.
 */
export function logAgentError(
  workspacePath: string,
  event: AgentErrorEvent,
): void {
  const logPath = path.join(workspacePath, "agent-errors.jsonl");
  appendJsonl(logPath, event);
}

/**
 * Log fine-grained review-engine events for bootstrap/dispatch tracing.
 */
export function logReviewEvent(
  outputDir: string,
  event: Record<string, unknown>,
): void {
  appendJsonl(getAssignmentLogPath(outputDir, "review-events.jsonl"), event);
  publishEngineEvent(outputDir, {
    timestamp:
      typeof event.timestamp === "string"
        ? event.timestamp
        : new Date().toISOString(),
    category: "stage",
    type: typeof event.event === "string" ? event.event : "review.event",
    ...whenDefined(typeof event.session_id === "string" ? event.session_id : undefined, (definedValue) => ({ run_id: definedValue })),
    ...whenDefined(typeof event.root_session_id === "string"
        ? event.root_session_id
        : undefined, (definedValue) => ({ root_run_id: definedValue })),
    assignment_path: outputDir,
    team: typeof event.team === "string" ? event.team : null,
    level_id: typeof event.level_id === "string" ? event.level_id : null,
    stage_type:
      typeof event.stage_type === "string" ? event.stage_type : "review",
    payload: event,
  });
}

/**
 * Log runtime boundary events such as tool registration and execution lifecycle.
 */
export function logRuntimeEvent(
  outputDir: string,
  event: Record<string, unknown>,
): void {
  appendJsonl(getAssignmentLogPath(outputDir, "runtime-events.jsonl"), event);
  publishEngineEvent(outputDir, {
    timestamp:
      typeof event.timestamp === "string"
        ? event.timestamp
        : new Date().toISOString(),
    category: "runtime",
    type: typeof event.event === "string" ? event.event : "runtime.event",
    ...whenDefined(typeof event.session_id === "string" ? event.session_id : undefined, (definedValue) => ({ run_id: definedValue })),
    ...whenDefined(typeof event.root_session_id === "string"
        ? event.root_session_id
        : undefined, (definedValue) => ({ root_run_id: definedValue })),
    assignment_path: outputDir,
    team: typeof event.team === "string" ? event.team : null,
    level_id: typeof event.level_id === "string" ? event.level_id : null,
    stage_type: typeof event.stage_type === "string" ? event.stage_type : null,
    payload: event,
  });
}
