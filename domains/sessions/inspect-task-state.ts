/**
 * inspect-task-state tool
 *
 * Read-only introspection of a running or completed session task.
 * Used by the receptionist agent to answer mid-run Q&A questions
 * (e.g. "What's happening?", "How far along are they?").
 *
 * Storage layout (all paths relative to workspacePath):
 *   sessions/{sessionId}/tasks/{taskId}/task.json   — task record
 *   sessions/{sessionId}/chat.jsonl                  — session chat log
 *   sessions/{sessionId}/runs/{runId}/assignments/{assignmentId}/logs/engine-events.jsonl
 *   assignments/{runId}/logs/engine-events.jsonl     — legacy fallback
 *
 * Note: in this codebase taskId === runId (created together in createTaskRecord).
 *
 * Workspace path resolution order:
 *   1. TEAM_RUNTIME_WORKSPACE_PATH (set by session-task-runner)
 *   2. API_WORKSPACE_PATH (set by api-server CLI)
 *   3. cwd()/workspace (fallback)
 */

import { whenDefined } from "../../core/optional-properties.js"
import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import * as path from "node:path";

import { FileSystemSessionStore } from "./session-store.js";
import type { SessionTask } from "./session-types.js";
import {
  buildSessionRunAssignmentLocation,
  resolveRunAssignmentLocation,
} from "../run/run-location.js";
import {
  isSafePathSegment,
  resolveExistingPathInside,
} from "../../core/path-safety.js";
import { resolveRuntimeAssignmentLocation } from "../runtime/runtime-paths.js";

// ─── Contract D types ─────────────────────────────────────────────────────────

export interface InspectTaskStateInput {
  taskId: string;
  sessionId?: string;
}

export interface InspectTaskStateOutput {
  taskId: string;
  status:
    | "queued"
    | "running"
    | "awaiting_input"
    | "awaiting_model_choice"
    | "interrupted"
    | "done"
    | "error"
    | "blocked"
    | "cancelled"
    | "not_found";
  stages: Array<{
    stageName: string;
    stageType: string;
    status: string;
    startedAt?: string;
    completedAt?: string;
  }>;
  transcriptSummary: string;
  artifactPath?: string;
  errorMessage?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveWorkspacePath(): string {
  return (
    process.env.TEAM_RUNTIME_WORKSPACE_PATH?.trim() ||
    process.env.API_WORKSPACE_PATH?.trim() ||
    path.resolve(process.cwd(), "workspace")
  );
}

function readJsonlObjects(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const results: Record<string, unknown>[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          results.push(parsed as Record<string, unknown>);
        }
      } catch {
        // skip malformed lines
      }
    }
    return results;
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Derive stage info from engine events.
 *
 * Each event has `level_id` (which stage it belongs to) and `stage_type`.
 * Stage starts are inferred from the first event with a new `level_id`.
 * Stage completions are detected via `gate.transition` events where
 * `payload.from === level_id`.
 */
function deriveStages(
  events: readonly Record<string, unknown>[],
): InspectTaskStateOutput["stages"] {
  interface StageEntry {
    stageName: string;
    stageType: string;
    startedAt?: string;
    completedAt?: string;
    status: string;
  }

  const stageMap = new Map<string, StageEntry>();

  for (const event of events) {
    const levelId = event.level_id;
    const stageType =
      typeof event.stage_type === "string" ? event.stage_type : "unknown";
    const timestamp =
      typeof event.timestamp === "string" ? event.timestamp : undefined;

    // Skip system-level pseudo-stages
    if (
      typeof levelId !== "string" ||
      !levelId ||
      levelId === "done" ||
      levelId === "root"
    )
      continue;

    const existing = stageMap.get(levelId);
    if (!existing) {
      stageMap.set(levelId, {
        stageName: levelId,
        stageType,
        ...whenDefined(timestamp, (definedValue) => ({ startedAt: definedValue })),
        status: "running",
      });
    } else {
      // Update stageType if we now have a more specific value
      if (existing.stageType === "unknown" && stageType !== "unknown") {
        stageMap.set(levelId, { ...existing, stageType });
      }
    }

    // Detect stage completion via gate transition
    if (event.type === "gate.transition") {
      const payload = isRecord(event.payload) ? event.payload : {};
      const from = typeof payload.from === "string" ? payload.from : null;
      const stage = from ? stageMap.get(from) : undefined;
      if (from && stage) {
        stageMap.set(from, {
          ...stage,
          ...whenDefined(timestamp, (definedValue) => ({ completedAt: definedValue })),
          status: "completed",
        });
      }
    }
  }

  // If the overall run is done/failed, close any still-running stages
  const isCompleted = events.some((e) => e.type === "run.completed");
  const isFailed = events.some((e) => e.type === "run.failed");

  if (isCompleted || isFailed) {
    const last = events.at(-1)?.timestamp;
    const lastTimestamp = typeof last === "string" ? last : undefined;
    for (const [key, stage] of stageMap.entries()) {
      if (stage.status === "running") {
        stageMap.set(key, {
          ...stage,
          ...whenDefined(lastTimestamp, (definedValue) => ({ completedAt: definedValue })),
          status: isFailed ? "error" : "completed",
        });
      }
    }
  }

  return Array.from(stageMap.values());
}

/**
 * Map the task record status + engine events to the output status.
 */
function resolveStatus(
  task: SessionTask,
  events: readonly Record<string, unknown>[],
): InspectTaskStateOutput["status"] {
  if (task.status === "done") return "done";
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "blocked") return "blocked";
  if (task.status === "failed") return "error";
  if (task.status === "awaiting_input") return "awaiting_input";
  if (task.status === "awaiting_model_choice") {
    return "awaiting_model_choice";
  }
  if (
    task.status === "interrupted" &&
    (task.admission?.phase === "pending" || task.admission?.phase === "granted")
  ) {
    return "queued";
  }
  if (task.status === "interrupted") return "interrupted";
  if (task.status === "running") {
    if (events.some((e) => e.type === "run.completed")) return "done";
    if (events.some((e) => e.type === "run.failed")) return "error";
    return "running";
  }
  if (task.status === "queued") {
    if (events.some((e) => e.type === "run.completed")) return "done";
    if (events.some((e) => e.type === "run.failed")) return "error";
    const matchingStart = Boolean(
      task.admission?.phase === "granted" &&
      task.executionAttemptId &&
      events.some(
        (event) =>
          event.type === "session_task.workflow_started" &&
          (event.payload as Record<string, unknown>).execution_attempt_id ===
            task.executionAttemptId,
      ),
    );
    return matchingStart ? "running" : "queued";
  }
  return "running";
}

/**
 * Find the most relevant artifact path from engine events.
 *
 * Prefers `artifact_type: result` artifacts; falls back to the last
 * `artifact.written` event. Returns a path relative to the assignment
 * directory, suitable for use with GET /runs/:runId/assignments/:artifactPath.
 */
function resolveArtifactPath(
  events: readonly Record<string, unknown>[],
): string | undefined {
  const written = events.filter((e) => e.type === "artifact.written");
  if (written.length === 0) return undefined;

  // Prefer result-type artifacts
  const resultArtifact = [...written]
    .reverse()
    .find(
      (e) => (e.payload as Record<string, unknown>).artifact_type === "result",
    );

  const chosen = resultArtifact ?? written.at(-1);
  const p = (chosen?.payload as Record<string, unknown>)?.path;
  return typeof p === "string" ? p : undefined;
}

/**
 * Try to find the task record, scanning all sessions if `sessionId` is absent.
 */
async function findTask(
  workspacePath: string,
  taskId: string,
  sessionId?: string,
): Promise<{ task: SessionTask; sessionId: string } | null> {
  const store = new FileSystemSessionStore(workspacePath);

  if (sessionId) {
    const task = await store.getTaskRecord(sessionId, taskId);
    return task ? { task, sessionId } : null;
  }

  // Scan sessions directory for the task
  const sessionsDir = path.join(workspacePath, "sessions");
  if (!fs.existsSync(sessionsDir)) return null;

  let sessionDirs: string[];
  try {
    sessionDirs = fs.readdirSync(sessionsDir);
  } catch {
    return null;
  }

  for (const sid of sessionDirs) {
    const task = await store.getTaskRecord(sid, taskId);
    if (task) return { task, sessionId: sid };
  }

  return null;
}

/**
 * Read the last 20 session chat messages, formatted and capped at 2000 chars.
 *
 * The session chat log (user ↔ receptionist) is the most relevant context
 * for mid-run Q&A. The per-agent transcript (transcript-events.jsonl) can be
 * much larger; that is deliberately excluded here.
 */
async function buildTranscriptSummary(
  workspacePath: string,
  sessionId: string,
): Promise<string> {
  const chatPath = path.join(
    workspacePath,
    "sessions",
    sessionId,
    "chat.jsonl",
  );

  let raw: string;
  try {
    raw = await fsAsync.readFile(chatPath, "utf8");
  } catch {
    return "";
  }

  const messages: Array<{ role: string; text: string }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { role?: unknown; text?: unknown };
      if (typeof parsed.role === "string" && typeof parsed.text === "string") {
        messages.push({ role: parsed.role, text: parsed.text });
      }
    } catch {
      // skip malformed lines
    }
  }

  const last20 = messages.slice(-20);
  let summary = last20.map((m) => `${m.role}: ${m.text}`).join("\n");

  // Cap at 2000 characters, trimming from the start so recent context is kept
  if (summary.length > 2000) {
    summary = summary.slice(summary.length - 2000);
  }

  return summary;
}

function resolveTaskAssignmentPath(
  workspacePath: string,
  task: SessionTask,
): string | null {
  const assignmentId = task.assignmentId ?? task.runId;
  const indexedLocation = resolveRunAssignmentLocation(
    workspacePath,
    assignmentId,
  );
  const expectedSessionLocation = buildSessionRunAssignmentLocation(
    workspacePath,
    {
      sessionId: task.sessionId,
      runId: task.runId,
      assignmentId,
    },
  );

  if (task.assignmentPath) {
    const candidatePath = resolveExistingPathInside(
      workspacePath,
      task.assignmentPath,
    );
    const matchesIndexedLocation =
      candidatePath &&
      indexedLocation &&
      pathsReferToSameLocation(candidatePath, indexedLocation.assignmentPath);
    const matchesExpectedSessionLocation =
      candidatePath &&
      expectedSessionLocation &&
      pathsReferToSameLocation(
        candidatePath,
        expectedSessionLocation.assignmentPath,
      );
    if (matchesIndexedLocation || matchesExpectedSessionLocation) {
      return candidatePath;
    }
  }

  try {
    const runtimeLocation = resolveRuntimeAssignmentLocation(workspacePath);
    if (
      runtimeLocation &&
      runtimeLocation.runId === task.runId &&
      runtimeLocation.assignmentId === assignmentId &&
      resolveExistingPathInside(workspacePath, runtimeLocation.assignmentPath)
    ) {
      return runtimeLocation.assignmentPath;
    }
  } catch {
    // A malformed inherited scope is never trusted as an inspection path.
  }

  if (indexedLocation) return indexedLocation.assignmentPath;
  if (!isSafePathSegment(task.runId)) return null;
  return path.join(workspacePath, "assignments", task.runId);
}

function pathsReferToSameLocation(
  leftPath: string,
  rightPath: string,
): boolean {
  try {
    return fs.realpathSync(leftPath) === fs.realpathSync(rightPath);
  } catch {
    return path.resolve(leftPath) === path.resolve(rightPath);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Inspect the state of a session task by taskId (and optional sessionId).
 *
 * Read-only — makes no mutations to task state, events, or chat log.
 * Returns `{ status: 'not_found' }` for unknown taskIds.
 */
export async function inspectTaskState(
  input: InspectTaskStateInput,
): Promise<InspectTaskStateOutput> {
  const workspacePath = resolveWorkspacePath();
  const { taskId, sessionId } = input;

  const found = await findTask(workspacePath, taskId, sessionId);

  if (!found) {
    return {
      taskId,
      status: "not_found",
      stages: [],
      transcriptSummary: "",
    };
  }

  const { task, sessionId: resolvedSessionId } = found;

  // Prefer the task's validated session-scoped assignment, then locator/env,
  // and use the legacy flat path only for unscoped records.
  const assignmentPath = resolveTaskAssignmentPath(workspacePath, task);
  const engineEventsPath = assignmentPath
    ? path.join(assignmentPath, "logs", "engine-events.jsonl")
    : "";
  const rawEvents = readJsonlObjects(engineEventsPath);

  const stages = deriveStages(rawEvents);
  const status = resolveStatus(task, rawEvents);
  const artifactPath = resolveArtifactPath(rawEvents);
  const transcriptSummary = await buildTranscriptSummary(
    workspacePath,
    resolvedSessionId,
  );

  return {
    taskId,
    status,
    stages,
    transcriptSummary,
    ...whenDefined(artifactPath, (presentArtifactPath) => ({ artifactPath: presentArtifactPath })),
    ...whenDefined(task.error, (errorMessage) => ({ errorMessage: errorMessage })),
  };
}
