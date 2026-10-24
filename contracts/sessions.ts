import { z } from 'zod'
import { workflowModelSelectionSchema, type WorkflowModelSelection } from './workflow-model-selection.js'
import { documentReviewCoverageSchema } from './document-reference.js'

import type { ModelSelectionRecord } from './agent-model-selection.js'
import {
  sessionTitleAttemptsSchema,
  type SessionTitleAttempt,
  type SessionTitleOperation,
} from './schemas/session-title-attempts.js'
import type { WorkspaceProjectContextSelection } from './projects.js'
import type { McpWorkflowPreflightDiagnostic } from './mcp.js'
import type { RunPlan } from './run-plan.js'

export const SESSION_STATUSES = ['idle', 'active', 'done'] as const
export const SESSION_ACTIVITY_TYPES = ['chat', 'workflow'] as const

const sessionStatusSchema = z.enum(SESSION_STATUSES)
const sessionActivityTypeSchema = z.enum(SESSION_ACTIVITY_TYPES)

export type SessionStatus = z.infer<typeof sessionStatusSchema>
export type SessionActivityType = z.infer<typeof sessionActivityTypeSchema>

const batchSessionOriginSchema = z.object({
  kind: z.literal('batch'),
  batchId: z.string().regex(/^batch_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  executionId: z.string().regex(/^exec_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  itemId: z.string().regex(/^item_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
}).strict()

const scheduledSessionOriginSchema = z.object({
  kind: z.literal('scheduled'),
  scheduleId: z.string().regex(/^sch_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
}).strict()

const sessionOriginSchema = z.discriminatedUnion('kind', [
  batchSessionOriginSchema,
  scheduledSessionOriginSchema,
])

export type BatchSessionOrigin = z.infer<typeof batchSessionOriginSchema>
export type ScheduledSessionOrigin = z.infer<typeof scheduledSessionOriginSchema>
export type SessionOrigin = z.infer<typeof sessionOriginSchema>

export function isSessionOrigin(value: unknown): value is SessionOrigin {
  return sessionOriginSchema.safeParse(value).success
}

/**
 * One attempt to name something, and the model it was about to use.
 *
 * Titling runs on the one application default and owns no Agent, so without
 * this a session could be named by a model nothing on the page ever mentions.
 *
 * Appended, never rewritten. A later attempt on a changed default is a second
 * entry beside the first, because replacing the first would erase the account
 * of a model that really was used. Written immediately before the send, so an
 * attempt that fails or returns nothing usable is still on the record; only a
 * skipped attempt records nothing at all.
 *
 * Derived from the schema that validates it (`schemas/session-title-attempts.ts`)
 * so the two cannot drift: a value the type admits but the validator refuses
 * would make a session unreadable on its next reload.
 */
export type { SessionTitleAttempt, SessionTitleOperation }

/**
 * A session as the API sends it: the list, the detail read, a create, and a
 * rename all return this shape.
 *
 * The type is derived from the schema so the browser's reader and the type it
 * promises cannot drift apart. Unknown fields are dropped, and a missing
 * optional field stays missing rather than becoming `undefined`.
 */
export const sessionSummarySchema = z.object({
  id: z.string(),
  projectId: z.string().exactOptional(),
  title: z.string(),
  status: sessionStatusSchema,
  activityType: sessionActivityTypeSchema,
  origin: sessionOriginSchema.exactOptional(),
  /**
   * Every title attempt this session has made, oldest first.
   *
   * Absent on a session written before this existed, which is not the same as
   * corrupt: absent means nothing is known, and is preserved untouched.
   */
  titleAttempts: sessionTitleAttemptsSchema.readonly().exactOptional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type SessionSummary = z.infer<typeof sessionSummarySchema>

export interface SessionDetails extends SessionSummary {
  // Future phases will add: chatMessageCount, fileCount, taskCount, etc.
}

export type ChatMessageRole = 'user' | 'assistant' | 'system'

export type ChatMessageSpeakerType = 'assistant' | 'agent'

export interface ChatMessageSpeaker {
  type: ChatMessageSpeakerType
  id: string
  name: string
  /**
   * Settings this reply's pair does not apply, by name.
   *
   * Present only where a person approved running one attempt on a substitute
   * pair, which is the one case where the model that answered is not the model
   * the Agent's settings were written for. Recorded with the reply because that
   * is the only place the fact belongs: a reply that came out differently
   * because a setting stopped applying is otherwise unexplainable.
   */
  droppedProviderOptions?: readonly string[]
}

export type ChatDeliveryArtifactRole = 'final' | 'secondary'

export interface ChatDeliveryArtifact {
  /** Run id that owns the file (the publishing child run). */
  runId: string
  path: string
  title?: string
  mediaType?: string
  role: ChatDeliveryArtifactRole
  /**
   * The published artifact's own SHA-256, when the publication recorded one.
   *
   * The digest of this file, not of the root result wrapper around it. It is
   * what lets a later reader prove the bytes it just read are the bytes that
   * were published, rather than whatever now sits at that path.
   */
  digest?: string
}

/** Reference to a completed task's published delivery, shown as a card in chat. */
export interface ChatMessageDelivery {
  taskId: string
  executionAttemptId?: string
  /** Primary (final) artifact first, then secondaries. */
  artifacts: ChatDeliveryArtifact[]
}

/** How a task ended, for the two terminal statuses that deliver nothing. */
export type ChatOutcomeStatus = 'failed' | 'blocked'

/**
 * Reference to a task that stopped without delivering, shown as a line in chat.
 *
 * The counterpart of `ChatMessageDelivery`, recognised and deduplicated the
 * same way: one line per task execution attempt, so a publication repaired
 * twice does not report the same failure twice. The workflow, step and reason
 * are structured rather than left only in the sentence, because a later reader
 * has to find the run this refers to without parsing prose.
 */
export interface ChatMessageOutcome {
  taskId: string
  executionAttemptId?: string
  status: ChatOutcomeStatus
  workflowId: string
  /** The step that ended the run, when the durable journal names one. */
  stepId?: string
  /**
   * Why it stopped, sanitized for a durable and shareable transcript:
   * whitespace collapsed, length capped, and absolute filesystem paths reduced
   * to the file name. It carries the workflow's own summary, never raw child
   * output.
   */
  reason?: string
}

/**
 * The request a turn was created for, recorded on its user message.
 *
 * `turnId` is a client-minted idempotency key, so a replay must be checked
 * against what was actually asked. Without this, a duplicate carrying the same
 * id but different text would receive an unrelated prior answer, and
 * completeness would be judged against the incoming roster rather than the one
 * the turn was started with.
 */
export interface ChatTurnRequest {
  readonly fingerprint: string
  readonly expectedReplies: number
  /**
   * The model selection admitted for each speaker of this turn, keyed by that
   * speaker's stable identity.
   *
   * Server-authored and written with the user's message, before the barrier
   * and before any provider call, so a turn that fails or is still running can
   * still name the pair each speaker was admitted on. This is the immutable
   * record: a later change to Settings or to an agent's own file must not
   * relabel it, and a duplicate turn reuses what was admitted the first time
   * rather than resolving again. Never accepted from a caller.
   */
  readonly admittedSelections?: Readonly<Record<string, ModelSelectionRecord>>
  /**
   * The model-choice offer this attempt was authorized by, when one was.
   *
   * Written with the user's message, so an offer's consumption is durable
   * before anything runs and survives a restart.
   *
   * It names the offer and nothing else on purpose. The attempt's turn id is
   * derived from the offer alone, so two approvals of one offer write the same
   * message and the second is recognised as a replay rather than as a
   * different message under a used identity. Recording the approver's
   * idempotency key here would make those two messages differ and turn the
   * replay into a conflict.
   *
   * Server-authored. A caller cannot claim to hold an approval.
   */
  readonly approvedOffer?: {
    readonly offerId: string
  }
  /**
   * The project context this turn was sent with.
   *
   * Recorded because a user-approved retry is a second attempt at *this*
   * request, not a new one. Rebuilding the retry from the text and the agent
   * alone would drop the context, and the model that finally answered would be
   * answering a different question from the one that failed.
   *
   * The selection, not the materialized content: the content is rebuilt from
   * the project as it stands, exactly as the first attempt built it.
   */
  readonly projectContext?: WorkspaceProjectContextSelection
  /**
   * The responder that admitted the turn, and therefore how it was hashed.
   *
   * Recorded rather than re-derived. Which responder owns an untargeted turn
   * depends on the Workflow selection at the time it was sent, so a selection
   * made between the first send and a retry would otherwise change the scheme
   * the retry is checked against and turn an ordinary replay into a reused-id
   * conflict. Absent on every line written before responders were recorded;
   * those were all Coordinator turns.
   */
  readonly responder?: ChatTurnResponder
}

/**
 * The two request-fingerprinting schemes a turn can be admitted under.
 *
 * Named after the path rather than after the speaker: the General Agent and a
 * roster of selected Agents are both `agents`, because both hash the same
 * inputs, and telling them apart on replay is what the roster itself does.
 */
export type ChatTurnResponder = 'agents' | 'coordinator'

/**
 * Where a reply's execution evidence lives.
 *
 * A pointer, not a copy. The assignment's execution journal stays the
 * authority for what the turn did; the transcript only has to be able to find
 * it, which it cannot do from a message id alone.
 */
export interface ChatMessageExecutionReference {
  /** The chat run the turn belonged to; the client-minted turn id. */
  readonly runId: string
  /** The assignment whose journal holds this reply's `agent.turn` stream. */
  readonly assignmentId: string
}

/**
 * Where a message's conversation lifecycle evidence lives.
 *
 * The sibling of `ChatMessageExecutionReference`, for publications that have no
 * assignment. An ordinary Receptionist turn runs no assignment at all, so its
 * evidence is a conversation activity journal instead. Added alongside rather
 * than folded into the existing pointer: a selected-agent reply legitimately
 * has both, one naming the aggregate publication and one naming that reply's
 * own execution.
 *
 * Present only where the journal is. A reply published by a build with
 * journalling switched off carries its turn identity and no pointer, because a
 * pointer is followed: one naming an activity nobody recorded is a durable
 * claim about evidence that does not exist.
 */
export interface ChatMessageConversationReference {
  /** The logical conversation that owns the activity. */
  readonly conversationId: string
  /** The bounded activity journal holding this turn's lifecycle. */
  readonly activityId: string
  /** The idempotency key the turn was published under. */
  readonly turnId: string
}

/**
 * What a transcript line is, as distinct from who wrote it.
 *
 * `role` says user or assistant; it does not say whether a line is
 * conversation the model should see or a status note shown to a person. Every
 * current model-context builder selects by role alone, so introducing a kind
 * that is not `chat` without also teaching those builders would silently change
 * prompts and task briefs. Phase 1 therefore persists only `chat`, and later
 * kinds land together with the per-surface context policy that admits them.
 */
export type ConversationMessageKind = 'chat'

/** What produced a transcript line, for lines that have a producer. */
export const conversationMessageSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation-turn'), turnId: z.string().min(1) }),
  z.object({ kind: z.literal('agent-dialogue'), dialogueId: z.string().uuid(), slot: z.number().int().nonnegative() }),
])
export type ConversationMessageSource = z.infer<typeof conversationMessageSourceSchema>
export const chatMessageCutOffSchema = z.object({ heardChars: z.number().int().nonnegative() })
export type ChatMessageCutOff = z.infer<typeof chatMessageCutOffSchema>

/**
 * The id a turn's own lines are published under.
 *
 * Derived from the client-minted `turnId` rather than allocated when the line
 * is written, so the identity of a turn's user message is known to both sides
 * before the request is sent. The client needs that to recognise its own
 * question coming back from the server; the server needs it to make the write
 * idempotent across a replay.
 */
export function conversationTurnMessageId(
  turnId: string,
  role: 'user' | 'assistant',
  ordinal = 0,
): string {
  return role === 'user'
    ? `${turnId}:user`
    : `${turnId}:assistant:${ordinal}`
}

export interface ChatMessage {
  id: string
  role: ChatMessageRole
  text: string
  createdAt: string
  /**
   * Absent on every line written before conversations existed, and the reader
   * treats absence as version 1. A version is only added when a line carries
   * something a v1 reader could not have understood.
   */
  schemaVersion?: 2
  /** The conversation that owns a conversation-turn line. */
  conversationId?: string
  kind?: ConversationMessageKind
  source?: ConversationMessageSource
  speaker?: ChatMessageSpeaker
  turnId?: string
  turnRequest?: ChatTurnRequest
  delivery?: ChatMessageDelivery
  outcome?: ChatMessageOutcome
  execution?: ChatMessageExecutionReference
  conversation?: ChatMessageConversationReference
  cutOff?: ChatMessageCutOff
}

/**
 * The transcript a turn's own prompt should quote, without quoting itself.
 *
 * A turn persists its user message before the speaker loop re-reads the
 * transcript, so the question the prompt already renders under its own heading
 * comes back as the last line of the quoted history too. The model then reads
 * it twice.
 *
 * Addressed by message id rather than by `turnId`, and the distinction is the
 * whole point: every assistant reply in a multi-speaker turn carries the same
 * `turnId`, and each later speaker is meant to see the earlier ones. Filtering
 * the turn would silently delete exactly that.
 *
 * Takes more than one turn because an approved retry re-asks the original
 * question under a fresh turn id. Excluding only the new turn leaves the failed
 * attempt's identical copy in the transcript, and the model reads the question
 * twice again — the duplication this exists to remove, reintroduced by the one
 * path that re-asks.
 */
export function excludeTurnUserMessage(
  messages: readonly ChatMessage[],
  turnIds: string | readonly string[],
): ChatMessage[] {
  const excluded = new Set(
    (typeof turnIds === 'string' ? [turnIds] : turnIds).map((turnId) =>
      conversationTurnMessageId(turnId, 'user'),
    ),
  )
  return messages.filter((message) => !excluded.has(message.id))
}

export type FileParseStatus = 'pending' | 'parsing' | 'parsed' | 'error'

export type DocumentAnalysisStatus =
  | 'not_needed'
  | 'required'
  | 'reading'
  | 'ready'
  | 'failed'

export interface DocumentAnalysisSummary {
  status: DocumentAnalysisStatus
  provider?: string
  model?: string
  error?: string
}

export const sessionFileSchema = z.object({
  name: z.string(), size: z.number().nonnegative(), uploadedAt: z.string(),
  /** First turn that locked this original revision; this does not establish review. */
  usedAt: z.string().exactOptional(),
  parseStatus: z.enum(['pending', 'parsing', 'parsed', 'error']),
  parsedAt: z.string().exactOptional(), parserError: z.string().exactOptional(),
  outputs: z.record(z.string(), z.string()).exactOptional(),
  documentAnalysis: z.object({ status: z.enum(['not_needed', 'required', 'reading', 'ready', 'failed']), provider: z.string().exactOptional(), model: z.string().exactOptional(), error: z.string().exactOptional() }).exactOptional(),
  source: z.object({ kind: z.literal('mcp-resource'), snapshotId: z.string(), serverId: z.string(), serverName: z.string(), resourceId: z.string(), resourceName: z.string(), resourceUri: z.string(), contentId: z.string(), contentUri: z.string(), mimeType: z.string(), capturedAt: z.string(), sha256: z.string() }).exactOptional(),
  documentReview: documentReviewCoverageSchema.exactOptional(),
})
export type SessionFile = z.infer<typeof sessionFileSchema>
export const sessionFilesPayloadSchema = z.object({ files: z.array(sessionFileSchema) })

export interface McpResourceSessionFileSource {
  kind: 'mcp-resource'
  snapshotId: string
  serverId: string
  serverName: string
  resourceId: string
  resourceName: string
  resourceUri: string
  contentId: string
  contentUri: string
  mimeType: string
  capturedAt: string
  sha256: string
}

export type SessionFileSource = McpResourceSessionFileSource

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'awaiting_input'
  /**
   * An Agent's explicit model failed in a way a user may authorize a retry
   * for, and this execution is unattended.
   *
   * Active, not terminal: the work already done is kept, the worker slot is
   * released, and the owning run says what decision it is waiting for.
   * Separate from `awaiting_input` because that waits for content a person
   * writes and this waits for a decision about how to run.
   */
  | 'awaiting_model_choice'
  | 'interrupted'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'cancelled'

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  'queued',
  'running',
  'awaiting_input',
  'awaiting_model_choice',
  'interrupted',
]
export const EXECUTING_TASK_STATUSES: readonly TaskStatus[] = ['queued', 'running']
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'done',
  'failed',
  'blocked',
  'cancelled',
]

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status)
}

export function isExecutingTaskStatus(status: TaskStatus): boolean {
  return EXECUTING_TASK_STATUSES.includes(status)
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status)
}

export type TaskAdmissionSource =
  | 'apply'
  | 'startup_repair'
  | 'automatic_recovery'
  | 'manual_resume'
  | 'human_input'
  | 'agent_question'
  /** A continuation the user authorized by approving one model-choice offer. */
  | 'model_choice'
  | 'scheduled'
  | 'batch'

export interface TaskAdmissionBase {
  version: 1
  requestId: string
  order: string
  requestedAt: string
  executionKind: 'initial' | 'recovery' | 'continuation'
  source: TaskAdmissionSource
  expectedExecutionAttemptId: string | null
  runPlanId?: string
  applyClaimId?: string
}

export type TaskAdmission =
  | (TaskAdmissionBase & { phase: 'staged' })
  | (TaskAdmissionBase & { phase: 'pending' })
  | (TaskAdmissionBase & {
      phase: 'granted'
      grantId: string
      ownerEpoch: string
      grantedAt: string
      executionAttemptId: string
    })

export const TASK_ADMISSION_ORDER_PATTERN = /^[1-9][0-9]*$/

export function isTaskAdmission(value: unknown): value is TaskAdmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const admission = value as Partial<TaskAdmission>
  if (
    admission.version !== 1 ||
    typeof admission.requestId !== 'string' ||
    !admission.requestId ||
    typeof admission.order !== 'string' ||
    !TASK_ADMISSION_ORDER_PATTERN.test(admission.order) ||
    typeof admission.requestedAt !== 'string' ||
    !Number.isFinite(Date.parse(admission.requestedAt)) ||
    (admission.executionKind !== 'initial' &&
      admission.executionKind !== 'recovery' &&
      admission.executionKind !== 'continuation') ||
    (admission.source !== 'apply' &&
      admission.source !== 'startup_repair' &&
      admission.source !== 'automatic_recovery' &&
      admission.source !== 'manual_resume' &&
      admission.source !== 'human_input' &&
      admission.source !== 'agent_question' &&
      admission.source !== 'model_choice' &&
      admission.source !== 'scheduled' &&
      admission.source !== 'batch') ||
    (admission.expectedExecutionAttemptId !== null &&
      typeof admission.expectedExecutionAttemptId !== 'string') ||
    (admission.runPlanId !== undefined && typeof admission.runPlanId !== 'string') ||
    (admission.applyClaimId !== undefined && typeof admission.applyClaimId !== 'string')
  ) {
    return false
  }
  if (admission.phase === 'staged' || admission.phase === 'pending') return true
  return Boolean(
    admission.phase === 'granted' &&
      typeof admission.grantId === 'string' &&
      admission.grantId &&
      typeof admission.ownerEpoch === 'string' &&
      admission.ownerEpoch &&
      typeof admission.grantedAt === 'string' &&
      Number.isFinite(Date.parse(admission.grantedAt)) &&
      typeof admission.executionAttemptId === 'string' &&
      admission.executionAttemptId,
  )
}

/**
 * The conversational turn that started a task.
 *
 * Task admission alone cannot tell a retry from a new request: its status gates
 * reopen the moment a run finishes, so a resend after completion would start a
 * second task. This is the durable identity that survives that, committed with
 * the task record itself rather than inferred from the transcript.
 */
export interface SessionTaskSourceTurn {
  turnId: string
  /** The request digest, so a reused id carrying a different ask is refused. */
  fingerprint: string
}

/**
 * Why a task's slot is held: its attempt's descendants may still run.
 * `owned_processes_unverified`: the attempt has a scope, but a member could
 * not be verified gone (or the scope itself is missing or unreadable).
 * `descendants_unverified_without_scope`: an earlier version launched the
 * attempt without a scope, so its descendants cannot be known.
 */
export type ProcessCleanupHoldReason =
  | 'owned_processes_unverified'
  | 'descendants_unverified_without_scope'

export interface ProcessCleanupHold {
  reason: ProcessCleanupHoldReason
  detail?: string
  since: string
}

export interface SessionTask {
  id: string
  sessionId: string
  runId: string
  assignmentId?: string
  workflowId: string
  targetKind?: 'team-chat'
  /** Stable source Team identity for direct Team-chat turns. */
  teamId?: string
  brief: string
  status: TaskStatus
  createdAt: string
  updatedAt?: string
  startedAt?: string
  workerStartedAt?: string
  cwd: string
  runPath?: string
  assignmentPath?: string
  inputSnapshotPath?: string
  workflowSnapshotPath?: string
  mcpResolutionPath?: string
  mcpWarnings?: readonly McpWorkflowPreflightDiagnostic[]
  completedAt?: string
  pid?: number
  processGroupId?: number
  processIdentity?: string
  executionAttemptId?: string
  executionAttemptNumber?: number
  executionKind?: 'initial' | 'recovery' | 'continuation'
  /**
   * Set (always to 1) when this attempt's ownership scope was published
   * before its number was recorded; absent on attempts an earlier version
   * admitted and on Windows. See
   * docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md.
   */
  ownedProcessScope?: 1
  /**
   * Present while this attempt's descendants cannot be verified gone: the
   * task keeps its admission and slot, no resume is admitted, and nothing is
   * signalled. Cleared once the scope is closed.
   */
  processCleanupHold?: ProcessCleanupHold
  attemptStartedAt?: string
  configuredProviderBrokerIdentity?: string
  recoveryCount?: number
  recoveryDisposition?: 'automatic' | 'manual' | 'not_resumable'
  recoveryReason?: string
  interruptedAt?: string
  lastRecoveryAt?: string
  ownerInstanceId?: string
  runPlanId?: string
  admission?: TaskAdmission
  /** Concrete chat selection, retained by every worker and recovery attempt. */
  workerModel?: WorkflowModelSelection
  /** Absent on tasks written before turn-scoped idempotency existed. */
  sourceTurn?: SessionTaskSourceTurn
  error?: string
}

/**
 * What became of a turn, told separately from what was said in it.
 *
 * Deliberately not a `ChatMessage`. An interruption is not something anybody
 * said, and writing one as assistant prose would put words the model never
 * produced into the transcript — and, worse, into the context of every later
 * turn. The transcript keeps what was said; this says what happened.
 */
export const CONVERSATION_TURN_OUTCOME_STATES = [
  /** Still running, or waiting for a recovery pass to reach it. */
  'pending',
  /** Nobody knows how the provider call ended. The user may retry. */
  'interrupted',
  /** The turn failed for a reason the runtime could name. */
  'failed',
  /** Withdrawn by the user or by their client going away. */
  'cancelled',
  /** A reply was produced and never reached the transcript. */
  'reply-lost',
] as const
export type ConversationTurnOutcomeState =
  (typeof CONVERSATION_TURN_OUTCOME_STATES)[number]

/**
 * The reasons a turn is allowed to give for its outcome.
 *
 * An allowlist, not a shape. This value crosses the API to a renderer, and a
 * pattern would let a provider message, a file path, or an exception string
 * ride out under the name of a diagnostic code.
 */
export const CONVERSATION_TURN_OUTCOME_CODES = [
  'provider_interrupted',
  'provider_failed',
  'preparation_failed',
  'plan_conflict',
  'reply_not_published',
  'cancelled',
  /** The durable record could not be read, so no outcome can be claimed. */
  'evidence_unreadable',
] as const
export type ConversationTurnOutcomeCode =
  (typeof CONVERSATION_TURN_OUTCOME_CODES)[number]

/**
 * A name this build will accept as an agent's.
 *
 * Structural, and deliberately narrow. This value is read off a durable record
 * and sent straight back as a routing instruction, so anything that is not a
 * plain agent name is a name this build refuses to route to.
 */
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/i

export type ConversationTurnOutcome =
  | { readonly turnId: string; readonly state: 'pending' }
  | {
      readonly turnId: string
      readonly state: Exclude<ConversationTurnOutcomeState, 'pending'>
      readonly code: ConversationTurnOutcomeCode
      readonly retryable: boolean
      /**
       * Who the turn was addressed to, when the record still says.
       *
       * A retry has to reach the agent the user originally asked. Recomputing
       * that from the screen sends it to whoever happens to be selected now,
       * which by the time an interruption is visible is usually nobody and
       * sometimes somebody else.
       */
      readonly agentNames?: readonly string[]
    }

export function isConversationTurnOutcomeState(
  value: unknown,
): value is ConversationTurnOutcomeState {
  return (
    typeof value === 'string' &&
    (CONVERSATION_TURN_OUTCOME_STATES as readonly string[]).includes(value)
  )
}

export function isConversationTurnOutcomeCode(
  value: unknown,
): value is ConversationTurnOutcomeCode {
  return (
    typeof value === 'string' &&
    (CONVERSATION_TURN_OUTCOME_CODES as readonly string[]).includes(value)
  )
}

/**
 * Validate one outcome from `unknown`.
 *
 * Shared by the server's own response assembly and by anything reading a
 * response back, so a value that would not survive the round trip cannot be
 * built in the first place.
 */
export function isConversationTurnOutcome(
  value: unknown,
): value is ConversationTurnOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const candidate: Record<string, unknown> = { ...value }
  if (typeof candidate.turnId !== 'string' || candidate.turnId.length === 0) {
    return false
  }
  if (!isConversationTurnOutcomeState(candidate.state)) return false
  // Exactly these keys and no others. A guard that checked only the fields it
  // knew about would pass the object through with everything else still
  // attached — which is how a `providerText` or a `rawError` reaches a
  // renderer that trusts this shape, under a contract whose entire purpose is
  // that provider prose has nowhere to travel.
  const allowed =
    candidate.state === 'pending'
      ? PENDING_OUTCOME_KEYS
      : SETTLED_OUTCOME_KEYS
  const keys = Object.keys(candidate)
  if (!keys.every((key) => allowed.includes(key))) return false
  if (candidate.state === 'pending') return keys.length === PENDING_OUTCOME_KEYS.length
  if (
    !isConversationTurnOutcomeCode(candidate.code) ||
    typeof candidate.retryable !== 'boolean'
  ) {
    return false
  }
  // Optional, so absence is legitimate — a turn whose addressee the record no
  // longer names is still an outcome worth showing.
  if (candidate.agentNames === undefined) return true
  return (
    Array.isArray(candidate.agentNames) &&
    candidate.agentNames.length > 0 &&
    candidate.agentNames.length <= MAX_OUTCOME_AGENT_NAMES &&
    candidate.agentNames.every(
      (name: unknown) => typeof name === 'string' && AGENT_NAME_PATTERN.test(name),
    )
  )
}

/** The roster cap a turn can have; a longer list is not one this build wrote. */
const MAX_OUTCOME_AGENT_NAMES = 8

const PENDING_OUTCOME_KEYS: readonly string[] = ['turnId', 'state']
const SETTLED_OUTCOME_KEYS: readonly string[] = [
  'turnId',
  'state',
  'code',
  'retryable',
  'agentNames',
]

export interface PostChatMessageResponseMeta {
  model: string
  fallback: boolean
  reason?: string
  titleModel?: string
  titleFallback?: boolean
  titleReason?: string
}

export interface PostChatMessageResponse {
  user: ChatMessage
  assistant: ChatMessage
  session?: SessionSummary
  plan: RunPlan
  task?: SessionTask
  meta?: PostChatMessageResponseMeta
}

export interface PostAgentChatMessageResponseMeta {
  replies: Array<{
    speakerId: string
    speakerName: string
    model: string
    fallback: boolean
    reason?: string
    /**
     * The turn had folders attached and this reply ran without tools, so the
     * model saw the folder map but could not open a file.
     */
    folderToolsUnavailable?: boolean
  }>
  titleModel?: string
  titleFallback?: boolean
  titleReason?: string
}

export interface PostAgentChatMessageResponse {
  user: ChatMessage
  replies: ChatMessage[]
  session?: SessionSummary
  meta?: PostAgentChatMessageResponseMeta
}

/** Who the server decided answered a turn, echoed back to the client. */
export type SessionDispatchOutcome =
  | { kind: 'coordinator'; selectedWorkflowId?: string }
  | { kind: 'agents'; agentNames: string[] }
  | { kind: 'team'; teamId: string }
  | { kind: 'workflow'; workflowId: string }

/**
 * The one envelope `POST /sessions/:id/messages` answers with.
 *
 * Discriminated rather than flattened with everything optional: a Coordinator
 * turn always revises a plan and a Team dispatch always yields a task, so
 * making either optional would hand the renderer a response it must re-check
 * at every use. `replayed` is always present so a caller never has to read the
 * status code to know whether the turn ran.
 */
export type SessionMessageDispatchResponse =
  | {
      dispatch: { kind: 'coordinator'; selectedWorkflowId?: string }
      user: ChatMessage
      messages: ChatMessage[]
      plan: RunPlan
      /** The task this turn's chat confirmation launched, when it did. */
      task?: SessionTask
      meta: PostChatMessageResponseMeta
      session?: SessionSummary
      replayed: boolean
    }
  | {
      dispatch: { kind: 'agents'; agentNames: string[] }
      user: ChatMessage
      messages: ChatMessage[]
      meta: PostAgentChatMessageResponseMeta
      session?: SessionSummary
      replayed: boolean
      /**
       * The task a chat-confirmed Workflow launch started during this turn,
       * with the plan it launched from. Present only when the front door's
       * `start_workflow` tool confirmed a launch.
       */
      task?: SessionTask
      plan?: RunPlan
      /**
       * True when a replayed turn is missing replies it was recorded as owing.
       *
       * Only a replay can be incomplete, and only this branch can produce more
       * than one reply, so the fact lives here rather than on every branch.
       */
      incomplete?: boolean
    }
  | {
      dispatch: { kind: 'team'; teamId: string }
      user: ChatMessage
      messages: ChatMessage[]
      plan: RunPlan
      task: SessionTask
      session?: SessionSummary
      replayed: boolean
    }
  | {
      dispatch: { kind: 'workflow'; workflowId: string }
      user: ChatMessage
      messages: ChatMessage[]
      plan: RunPlan
      /** The task this turn's chat confirmation launched, when it did. */
      task?: SessionTask
      meta: PostChatMessageResponseMeta
      session?: SessionSummary
      replayed: boolean
    }

/**
 * Narrow the dispatch envelope to one branch.
 *
 * Helpers rather than inline checks: the discriminant sits one level down, on
 * `dispatch.kind`, which TypeScript will not use to narrow the outer union.
 */
export function isTeamDispatch(
  response: SessionMessageDispatchResponse,
): response is Extract<
  SessionMessageDispatchResponse,
  { dispatch: { kind: 'team' } }
> {
  return response.dispatch.kind === 'team'
}

export function isAgentsDispatch(
  response: SessionMessageDispatchResponse,
): response is Extract<
  SessionMessageDispatchResponse,
  { dispatch: { kind: 'agents' } }
> {
  return response.dispatch.kind === 'agents'
}

export function isPlanBearingDispatch(
  response: SessionMessageDispatchResponse,
): response is Extract<
  SessionMessageDispatchResponse,
  { dispatch: { kind: 'coordinator' } | { kind: 'workflow' } }
> {
  return (
    response.dispatch.kind === 'coordinator' ||
    response.dispatch.kind === 'workflow'
  )
}

const TASK_STATUSES = new Set<string>([
  'queued',
  'running',
  'awaiting_input',
  'awaiting_model_choice',
  'interrupted',
  'done',
  'failed',
  'blocked',
  'cancelled',
])
const EXECUTION_KINDS = new Set<string>(['initial', 'recovery', 'continuation'])
const RECOVERY_DISPOSITIONS = new Set<string>([
  'automatic',
  'manual',
  'not_resumable',
])

export function isSessionTask(value: unknown): value is SessionTask {
  if (!isRecord(value)) return false
  if (
    !isString(value.id) ||
    !isString(value.sessionId) ||
    !isString(value.runId) ||
    !isString(value.workflowId) ||
    (value.targetKind !== undefined && value.targetKind !== 'team-chat') ||
    (value.teamId !== undefined && !isString(value.teamId)) ||
    !isString(value.brief) ||
    typeof value.status !== 'string' ||
    !TASK_STATUSES.has(value.status) ||
    !isString(value.createdAt) ||
    !isString(value.cwd)
  ) {
    return false
  }

  const optionalStrings = [
    value.assignmentId,
    value.updatedAt,
    value.startedAt,
    value.workerStartedAt,
    value.runPath,
    value.assignmentPath,
    value.inputSnapshotPath,
    value.workflowSnapshotPath,
    value.mcpResolutionPath,
    value.completedAt,
    value.processIdentity,
    value.executionAttemptId,
    value.attemptStartedAt,
    value.configuredProviderBrokerIdentity,
    value.recoveryReason,
    value.interruptedAt,
    value.lastRecoveryAt,
    value.ownerInstanceId,
    value.runPlanId,
    value.error,
  ]
  if (!optionalStrings.every(isOptionalString)) return false

  const optionalNumbers = [
    value.pid,
    value.processGroupId,
    value.executionAttemptNumber,
    value.recoveryCount,
  ]
  if (!optionalNumbers.every(isOptionalFiniteNumber)) return false
  if (
    value.executionKind !== undefined &&
    (typeof value.executionKind !== 'string' ||
      !EXECUTION_KINDS.has(value.executionKind))
  ) {
    return false
  }
  if (
    value.recoveryDisposition !== undefined &&
    (typeof value.recoveryDisposition !== 'string' ||
      !RECOVERY_DISPOSITIONS.has(value.recoveryDisposition))
  ) {
    return false
  }
  if (value.ownedProcessScope !== undefined && value.ownedProcessScope !== 1) {
    return false
  }
  if (value.processCleanupHold !== undefined && !isProcessCleanupHold(value.processCleanupHold)) {
    return false
  }
  if (
    value.admission !== undefined &&
    !isTaskAdmission(value.admission)
  ) {
    return false
  }
  if (value.workerModel !== undefined && !workflowModelSelectionSchema.safeParse(value.workerModel).success) {
    return false
  }
  if (value.sourceTurn !== undefined && !isSessionTaskSourceTurn(value.sourceTurn)) {
    return false
  }
  return (
    value.mcpWarnings === undefined ||
    (Array.isArray(value.mcpWarnings) &&
      value.mcpWarnings.every(isMcpWorkflowPreflightDiagnostic))
  )
}

function isProcessCleanupHold(value: unknown): value is ProcessCleanupHold {
  return (
    isRecord(value) &&
    (value.reason === 'owned_processes_unverified' ||
      value.reason === 'descendants_unverified_without_scope') &&
    isOptionalString(value.detail) &&
    isString(value.since)
  )
}

function isSessionTaskSourceTurn(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.turnId) &&
    value.turnId.length > 0 &&
    isString(value.fingerprint) &&
    value.fingerprint.length > 0
  )
}

function isMcpWorkflowPreflightDiagnostic(value: unknown): boolean {
  if (!isRecord(value) || value.retryable !== true || !isString(value.message)) {
    return false
  }
  if (value.code === 'mcp_requirement_unmet') {
    return (
      isString(value.stepId) &&
      isString(value.capability) &&
      isStringArray(value.access) &&
      (value.necessity === 'required' || value.necessity === 'optional') &&
      isStringArray(value.eligibleAgentPaths)
    )
  }
  return (
    value.code === 'provider_tool_bridge_unavailable' &&
    isString(value.stepId) &&
    isString(value.agentPath) &&
    isString(value.provider) &&
    isString(value.model) &&
    isString(value.tool) &&
    isOptionalString(value.reasonCode)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value)
}
