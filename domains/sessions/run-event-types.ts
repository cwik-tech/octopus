/**
 * Run Event Types and Task Run State
 *
 * Shared types consumed by the Run UI (T3/T4/T6) and any server-side
 * introspection tools (T7/T8). Types are derived from the actual
 * EngineEventEnvelope structure emitted by the `/runs/:id/events` SSE
 * endpoint in `server/api-server.ts`:
 *
 *   tailRunEvents(runId, (event, index) => writeSseEvent(res, event.type, event, index))
 *
 * Each SSE message has `event: <type>` equal to `EngineEventEnvelope.type`
 * and `data: <JSON-serialised EngineEventEnvelope>`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RUNTIME CLIENT SSE INTERFACE  (reference for T4 — read before writing SSE code)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * File: `ui/src/lib/clients/runtime-client.ts`
 *
 * The SSE interface is CALLBACK-BASED, not a React hook.  You manage the
 * lifecycle yourself with an AbortController.
 *
 * ## Key function
 *
 *   import { openRunEventStream } from '@/lib/clients/runtime-client'
 *
 *   async function openRunEventStream(args: {
 *     runId: string                                        // required
 *     onEvent: (id: string, event: EngineEventEnvelope) => void  // called per event
 *     onStatus: (status: 'connecting' | 'live') => void   // lifecycle callback
 *     signal: AbortSignal                                 // cancellation token
 *     fromIndex?: number                                  // optional resume index
 *   }): Promise<void>
 *
 * ## Status sequence
 *   onStatus('connecting')  →  fetch begins
 *   onStatus('live')        →  HTTP 200 received, streaming starts
 *   (Promise resolves)      →  stream closed (signal aborted or server ended)
 *
 * ## Cancellation pattern (use inside a React component)
 *
 *   const controller = new AbortController()
 *   // Start streaming (do NOT await — run in background)
 *   void openRunEventStream({
 *     runId,
 *     signal: controller.signal,
 *     onStatus: (s) => setIsConnecting(s === 'connecting'),
 *     onEvent:  (id, event) => dispatch({ type: 'ADD_EVENT', id, event }),
 *   }).catch((err) => {
 *     if (err instanceof DOMException && err.name === 'AbortError') return  // normal cancel
 *     console.error('SSE error', err)
 *   })
 *
 *   // To cancel (e.g., on unmount, tab cancel, or task completion):
 *   const unsubscribe = () => controller.abort()
 *
 * ## Snapshot (for replaying past events)
 *
 *   import { fetchRunEventsSnapshot } from '@/lib/clients/runtime-client'
 *   const { events } = await fetchRunEventsSnapshot(runId)
 *   // Returns RunEventsSnapshotResponse { events: EngineEventEnvelope[] }
 *   // Use fromIndex to resume streaming after the snapshot.
 *
 * ## Event type — EngineEventEnvelope (from `@/lib/runtime-model`)
 *
 *   interface EngineEventEnvelope {
 *     schema_version: number
 *     timestamp: string        // ISO-8601 string
 *     tenant_id: string
 *     category: EngineEventCategory  // 'run'|'stage'|'agent'|'tool'|'gate'|'artifact'|'runtime'|'delegation'
 *     type: string             // specific event type — see RunEventType below
 *     run_id?: string
 *     root_run_id?: string
 *     parent_run_id?: string
 *     assignment_path?: string
 *     team?: string | null
 *     level_id?: string | null   // current stage/level identifier (→ stageName)
 *     stage_type?: string | null // 'discussion' | 'pipeline' | etc. (→ stageType)
 *     payload: Record<string, unknown>
 *   }
 *
 * ## Field mapping: EngineEventEnvelope → RunEvent
 *
 *   RunEvent.id          ← SSE `id:` field (first arg to onEvent)
 *   RunEvent.ts          ← Date.parse(envelope.timestamp)
 *   RunEvent.type        ← envelope.type          (see RunEventType)
 *   RunEvent.runId       ← envelope.run_id
 *   RunEvent.stageType   ← envelope.stage_type
 *   RunEvent.stageName   ← envelope.level_id
 *   RunEvent.agentId     ← envelope.run_id
 *   RunEvent.agentName   ← envelope.payload.agent_display_name or
 *                          envelope.payload.agent_name  (string)
 *   RunEvent.content     ← envelope.payload.text or envelope.payload.content  (string)
 *   RunEvent.stepIndex   ← envelope.payload.step_index  (number)
 *   RunEvent.artifactIn  ← envelope.payload.input_artifact  (string)
 *   RunEvent.artifactOut ← envelope.payload.output_artifact  (string)
 *   RunEvent.artifactPath← envelope.payload.path  (string) — for artifact.written events
 *   RunEvent.artifactRunId← envelope.payload.artifact_run_id or envelope.run_id
 *   RunEvent.artifactRole← envelope.payload.artifact_role
 *   RunEvent.errorMessage← envelope.payload.error  (string) — for run.failed / agent.fail
 *
 * ## Semantic event mapping (Contract A → actual engine types)
 *
 *   Contract A name   Real engine type(s)
 *   ─────────────     ──────────────────────────────────────────────
 *   task:done      →  'run.completed'
 *   task:error     →  'run.failed'
 *   stage:start    →  'gate.transition'  (payload.to = next level id)
 *   stage:end      →  'gate.transition'  (payload.from = closing level id)
 *   agent:message  →  'agent.start' / 'agent.end' / 'tool.execution_logged'
 *   log            →  'run.session_started' / 'session_task.workflow_started'
 *   step           →  pipeline step via 'agent.start' on a pipeline stage
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// RunEventType — actual engine event type strings emitted by the SSE endpoint
// ---------------------------------------------------------------------------

/**
 * Union of known engine event type strings emitted via the
 * `/runs/:id/events` SSE endpoint.  Sourced from:
 *   - domains/run/run-store.ts  (types checked for status derivation)
 *   - domains/runtime/logger.ts     (publishEngineEvent call sites)
 *   - domains/runtime/artifacts.ts  (artifact.written)
 *   - domains/sessions/session-task-runner.ts  (task lifecycle events)
 *
 * The trailing `(string & {})` preserves type-safety for unknown future
 * event types while still allowing string literal auto-complete for the
 * known set.
 */
export type RunEventType =
  // ── Run lifecycle ────────────────────────────────────────────────────────
  /** Emitted by logSessionStart() when a run session is initialised */
  | 'run.session_started'
  /** Task completed successfully (session-task-runner success path) */
  | 'run.completed'
  /** Task failed (session-task-runner error path, or engine halt) */
  | 'run.failed'
  /** Task stopped because it requires input or approval */
  | 'run.blocked'
  /** Task process exited after an accepted cancellation request */
  | 'run.cancelled'
  /** Run ended without a clean completed/failed signal */
  | 'run.incomplete'

  // ── Workflow / session task events ───────────────────────────────────────
  /** Emitted by session-task-runner.ts right before runWorkflow() is called */
  | 'session_task.workflow_started'
  | 'workflow.step.started'
  | 'workflow.step.completed'
  | 'workflow.step.failed'
  | 'discussion.message'
  /** One accepted Team contribution, whatever engine produced it. */
  | 'team.message'

  // ── Agent lifecycle ──────────────────────────────────────────────────────
  /** Agent begins its turn (logAgentRun with event:'start') */
  | 'agent.start'
  /** Agent turn completed successfully */
  | 'agent.end'
  /** Agent turn failed */
  | 'agent.fail'
  /** Agent was skipped (gate/policy) */
  | 'agent.skip'

  // ── Host (agentic loop) lifecycle ────────────────────────────────────────
  | 'host.agent_start'
  | 'host.agent_end'

  // ── Provider / model call lifecycle ─────────────────────────────────────
  | 'provider.request.start'
  | 'provider.request.end'

  // ── Tool execution ───────────────────────────────────────────────────────
  | 'tool.execution_logged'
  | 'tool.execution_failed'
  /** One durable, privacy-safe summary for a source acquisition attempt */
  | 'research.acquisition.completed'

  // ── Gate / level / stage transitions ────────────────────────────────────
  /** Fired by logLevelTransition(); payload: { from, to, gate_type, gate } */
  | 'gate.transition'

  // ── Artifact events ──────────────────────────────────────────────────────
  /** Fired by writeMarkdownArtifact(); payload: { path, artifact_type } */
  | 'artifact.written'
  /** Fired when a workflow chooses the user-facing final artifact */
  | 'artifact.delivery_selected'

  // ── Catch-all for runtime/stage/delegation events ────────────────────────
  | (string & {})

// ---------------------------------------------------------------------------
// RunEvent — UI-facing normalised view of an EngineEventEnvelope
// ---------------------------------------------------------------------------

/**
 * Simplified, UI-facing representation of an engine event.
 *
 * Construct this from an EngineEventEnvelope received via openRunEventStream:
 *
 *   function toRunEvent(id: string, env: EngineEventEnvelope): RunEvent {
 *     const payload = env.payload as Record<string, unknown>
 *     return {
 *       id,
 *       type: env.type as RunEventType,
 *       ts: Date.parse(env.timestamp),
 *       stageType:    env.stage_type   ?? undefined,
 *       stageName:    env.level_id     ?? undefined,
 *       agentId:      env.run_id       ?? undefined,
 *       agentName:    typeof payload.agent_display_name === 'string'
 *                     ? payload.agent_display_name
 *                     : typeof payload.agent_name === 'string'
 *                       ? payload.agent_name
 *                       : undefined,
 *       content:      typeof payload.text        === 'string' ? payload.text
 *                     : typeof payload.content   === 'string' ? payload.content     : undefined,
 *       stepIndex:    typeof payload.step_index  === 'number' ? payload.step_index  : undefined,
 *       artifactIn:   typeof payload.input_artifact  === 'string' ? payload.input_artifact  : undefined,
 *       artifactOut:  typeof payload.output_artifact === 'string' ? payload.output_artifact : undefined,
 *       artifactPath: typeof payload.path        === 'string' ? payload.path        : undefined,
 *       errorMessage: typeof payload.error       === 'string' ? payload.error       : undefined,
 *     }
 *   }
 *
 * Per Contract A (plan.md § Integration Contracts).
 */
export interface RunEvent {
  /** SSE event `id:` field (passed as first arg to onEvent callback) */
  id: string
  /** Engine event type string — use RunEventType constants for comparisons */
  type: RunEventType
  /** Unix timestamp in milliseconds — use Date.parse(envelope.timestamp) */
  ts: number
  /** Source run id from EngineEventEnvelope.run_id */
  runId?: string

  // Stage context (from EngineEventEnvelope.stage_type / level_id)
  /** e.g. 'discussion' | 'pipeline' — present when engine is inside a stage */
  stageType?: 'discussion' | 'pipeline' | string
  /** Level/stage identifier (EngineEventEnvelope.level_id) */
  stageName?: string

  // Agent context (from payload and envelope fields)
  /** Agent run_id (EngineEventEnvelope.run_id) */
  agentId?: string
  /** Human-readable agent name (payload.agent_name) */
  agentName?: string
  /** Complete coordinator-selected roster for a discussion. */
  participants?: string[]
  /**
   * The concrete attempt that emitted this event (payload.dispatch_id).
   *
   * One live bubble belongs to one dispatch, so this is what binds streamed
   * text to a speaker and lets a retry supersede the attempt before it.
   */
  dispatchId?: string
  /** The logical step this attempt belongs to (payload.logical_invocation_id). */
  logicalInvocationId?: string
  /**
   * The run's display-only text channel (payload.text_channel_id).
   *
   * Not a credential: reading it still requires the session that owns it. It
   * is here so the UI can find the stream from the run it is already watching.
   */
  textChannelId?: string

  // Content
  /** Spoken/written content (payload.text or payload.content) */
  content?: string
  /** Stable identity of a durable Team message (payload.message_id). */
  messageId?: string

  // Pipeline step info
  /** Step index within a pipeline stage (payload.step_index) */
  stepIndex?: number

  // Artifact info
  /** Input artifact path for a pipeline step (payload.input_artifact) */
  artifactIn?: string
  /** Output artifact path for a pipeline step (payload.output_artifact) */
  artifactOut?: string
  /** Path of artifact that was written (payload.path, for artifact.written) */
  artifactPath?: string
  /** Run id that owns artifactPath. Used when the final delivery came from a child run. */
  artifactRunId?: string
  /** Artifact display/selection role, for example final, intermediate, wrapper, or input. */
  artifactRole?: 'input' | 'intermediate' | 'final' | 'wrapper' | string

  // Error info
  /** Error message from run.failed / agent.fail events (payload.error) */
  errorMessage?: string
  /** Execution attempt that emitted a task lifecycle event. */
  executionAttemptId?: string
}

// ---------------------------------------------------------------------------
// TaskMode — lifecycle modes for the Run UI right pane (Contract C)
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a single task run in the UI.
 *
 * State machine:
 *   setup ──→ queued ──→ running ──→ done
 *                           └────→ error
 *                           └────→ cancelled  (backend confirms worker process exit)
 *
 * Per Contract C (plan.md § Integration Contracts).
 */
export type TaskMode = 'setup' | 'queued' | 'running' | 'done' | 'error' | 'cancelled'

// ---------------------------------------------------------------------------
// TaskRunEntry — one entry in the task history tab strip (Contract C)
// ---------------------------------------------------------------------------

/**
 * Represents a single task run in the session's history tab strip.
 *
 * Created when the user clicks "Run" and a task is started via
 * apiStartSessionTask(). Updated as SSE events arrive.
 *
 * Per Contract C (plan.md § Integration Contracts).
 */
export interface TaskRunEntry {
  /** Task record ID (from the session store) */
  taskId: string
  /** Engine run ID — used to subscribe to /runs/:runId/events */
  runId: string
  /** Display label shown in the tab strip (e.g., workflow name) */
  label: string
  /** Current lifecycle mode of this task */
  mode: TaskMode
  /** Unix timestamp (ms) when SSE streaming started */
  startedAt?: number
  /** Unix timestamp (ms) when task reached done/error/cancelled */
  completedAt?: number
  /**
   * Path of the primary output artifact (set from artifact.written or
   * run.completed events; used by DoneView to fetch markdown content).
   */
  artifactPath?: string
  /** Error message from run.failed event (set when mode === 'error') */
  errorMessage?: string
}
