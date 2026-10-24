/**
 * Reading and answering the human-in-the-loop wait of one workflow task.
 *
 * The HTTP route calls this in two phases so it keeps its check order. Phase
 * one opens the task's open interaction: the task lookup, the journal
 * recorder, the durable state load and the pending-or-submitted selection.
 * The route then applies its method and path checks, and only after those
 * calls `readHumanInputSource` or `submitHumanInputFeedback`.
 *
 * Errors from the journal registry, the workflow state store and the task
 * queue are thrown unchanged. Where the route catches them decides their
 * status code, so this module does not wrap or translate them.
 */

import * as path from 'node:path'

import {
  resolveHumanInputMentions,
  type HumanInputMentionCandidate,
} from '../contracts/human-input.js'
import type { HumanInputSubmissionRequest } from '../contracts/schemas/human-input-requests.js'
import type { SessionTask } from '../contracts/sessions.js'
import { logRuntimeEvent } from '../domains/runtime/logger.js'
import type { SessionStore } from '../domains/sessions/session-store.js'
import type { HumanInputInteraction, HumanInputMessage } from '../workflows/types.js'
import {
  FileSystemWorkflowStateStore,
  hashHumanInputSubmission,
  readVerifiedWorkflowArtifactPreview,
  verifyWorkflowArtifactReference,
} from '../workflows/workflow-state-store.js'
import type { TaskQueue } from './task-queue.js'
import { resolveWorkflowJournalRecorder } from './workflow-journal-recorder.js'
import type { WorkspaceExecutionJournalRegistry } from './workspace-execution-journal-registry.js'

export interface WorkflowHumanInputServiceDeps {
  readonly sessionStore: Pick<SessionStore, 'getTaskRecord'>
  readonly executionJournalRegistry?: WorkspaceExecutionJournalRegistry | undefined
  readonly taskQueue?: Pick<TaskQueue, 'isReady' | 'enqueueContinuation'> | undefined
  /** Supplies the submission's submittedAt and the runtime event timestamp. */
  readonly now: () => Date
}

/** One task's open human-input interaction, as loaded by `openHumanInputInteraction`. */
export interface OpenHumanInputInteraction {
  /** The session and task ids the caller asked for. */
  readonly sessionId: string
  readonly taskId: string
  readonly task: SessionTask
  readonly assignmentPath: string
  readonly store: FileSystemWorkflowStateStore
  readonly workflowRevision: number
  readonly interaction: HumanInputInteraction
}

export type OpenHumanInputResult =
  | { readonly kind: 'task_not_found' }
  | { readonly kind: 'no_assignment' }
  | { readonly kind: 'interaction_not_found' }
  | { readonly kind: 'open'; readonly open: OpenHumanInputInteraction }

/**
 * Finds the task's human-input interaction that is pending or submitted.
 *
 * The task lookup is scoped to `sessionId`. The store is built through the
 * workflow journal recorder, so in authoritative mode this opens and enrols
 * the assignment's journal, and the load may rebuild the state projection.
 */
export async function openHumanInputInteraction(
  deps: Pick<WorkflowHumanInputServiceDeps, 'sessionStore' | 'executionJournalRegistry'>,
  input: { readonly sessionId: string; readonly taskId: string },
): Promise<OpenHumanInputResult> {
  const task = await deps.sessionStore.getTaskRecord(input.sessionId, input.taskId)
  if (!task) return { kind: 'task_not_found' }
  const assignmentPath = task.assignmentPath
  if (!assignmentPath) return { kind: 'no_assignment' }
  const store = new FileSystemWorkflowStateStore(
    assignmentPath,
    await resolveWorkflowJournalRecorder({
      registry: deps.executionJournalRegistry,
      task,
      requestId: `human-input-${input.taskId}`,
      processIdentity: task.executionAttemptId ?? task.id,
    }),
  )
  const snapshot = await store.load()
  const interaction = snapshot?.state.steps
    .map((step) => step.humanInput)
    .find((candidate) => candidate?.status === 'pending' || candidate?.status === 'submitted')
  if (!snapshot || !interaction) return { kind: 'interaction_not_found' }
  return {
    kind: 'open',
    open: {
      sessionId: input.sessionId,
      taskId: input.taskId,
      task,
      assignmentPath,
      store,
      workflowRevision: snapshot.state.revision,
      interaction,
    },
  }
}

export interface HumanInputSourceView {
  readonly workflowRevision: number
  readonly interaction: HumanInputInteraction
  readonly sourceText: string
  readonly sourceTruncated: boolean
  readonly sourceByteLength: number
}

/** Verifies the interaction's source artifact and returns its bounded preview. */
export async function readHumanInputSource(
  open: OpenHumanInputInteraction,
): Promise<HumanInputSourceView> {
  const sourcePreview = await readVerifiedWorkflowArtifactPreview(
    sourceArtifactAssignmentPath(open),
    open.interaction.sourceArtifact,
  )
  return {
    workflowRevision: open.workflowRevision,
    interaction: open.interaction,
    sourceText: sourcePreview.text,
    sourceTruncated: sourcePreview.truncated,
    sourceByteLength: sourcePreview.byteLength,
  }
}

export type HumanInputRecipientViolation =
  | { readonly kind: 'unknown'; readonly mentionToken: string }
  | { readonly kind: 'ambiguous'; readonly mentionToken: string }
  | { readonly kind: 'mismatch' }

/**
 * Checks each message's literal @mentions against the frozen recipient list.
 *
 * A message that mentions anyone must be addressed to exactly the agents it
 * mentions. A message with no mentions passes here whatever its recipients;
 * the store checks those ids against the eligible list later. The first
 * message that breaks a rule decides the result.
 */
export function validateHumanInputRecipients(
  messages: readonly Pick<HumanInputMessage, 'text' | 'recipients'>[],
  eligibleRecipients: readonly HumanInputMentionCandidate[],
): HumanInputRecipientViolation | null {
  for (const message of messages) {
    const mentionResolution = resolveHumanInputMentions(message.text, eligibleRecipients)
    if (mentionResolution.kind === 'unknown' || mentionResolution.kind === 'ambiguous') {
      return { kind: mentionResolution.kind, mentionToken: mentionResolution.mentionToken }
    }
    if (mentionResolution.recipientIds.length === 0) continue
    if (
      message.recipients === 'all' ||
      !sameRecipientIds(message.recipients, mentionResolution.recipientIds)
    ) {
      return { kind: 'mismatch' }
    }
  }
  return null
}

export type SubmitHumanInputResult =
  | { readonly kind: 'admission_recovering' }
  | { readonly kind: 'recipient_rejected'; readonly violation: HumanInputRecipientViolation }
  | {
      readonly kind: 'submitted'
      readonly task: SessionTask
      readonly workflowRevision: number
      readonly interaction: HumanInputInteraction | undefined
    }

/**
 * Stores one human submission and re-admits the task.
 *
 * Order: queue readiness, then `readRequest`, then the recipient rules, then
 * the source artifact check, the durable submit, the runtime events and the
 * continuation. `readRequest` is a callback so the caller's body errors come
 * after the readiness check, exactly where they came before.
 *
 * The events are written only when this call moved the revision by one, and
 * before the continuation is queued. `logRuntimeEvent` appends to
 * runtime-events.jsonl and publishes to engine-events.jsonl and in-process
 * subscribers, which the UI's Run activity reads.
 */
export async function submitHumanInputFeedback(
  deps: Pick<WorkflowHumanInputServiceDeps, 'taskQueue' | 'now'>,
  open: OpenHumanInputInteraction,
  input: { readonly readRequest: () => Promise<HumanInputSubmissionRequest> },
): Promise<SubmitHumanInputResult> {
  const taskQueue = deps.taskQueue
  if (!taskQueue?.isReady()) return { kind: 'admission_recovering' }
  const payload = await input.readRequest()
  const { task, assignmentPath, interaction } = open
  const violation = validateHumanInputRecipients(payload.messages, interaction.eligibleRecipients)
  if (violation) return { kind: 'recipient_rejected', violation }
  const submission = {
    submissionId: payload.submissionId,
    mode: payload.mode,
    messages: payload.messages,
    submittedAt: deps.now().toISOString(),
    canonicalHash: hashHumanInputSubmission(payload),
  }
  await verifyWorkflowArtifactReference(
    sourceArtifactAssignmentPath(open),
    interaction.sourceArtifact,
  )
  const submitted = await open.store.submitHumanInput({
    expectedRevision: payload.expectedWorkflowRevision,
    interactionId: interaction.interactionId,
    expectedSourceArtifactSha256: payload.expectedSourceArtifactSha256,
    submission,
  })
  if (submitted.revision === payload.expectedWorkflowRevision + 1) {
    const eventBase = {
      timestamp: deps.now().toISOString(),
      session_id: task.runId,
      root_session_id: task.runId,
      assignment_path: assignmentPath,
      team: `workflow:${task.workflowId}`,
      workflow_id: task.workflowId,
      product_session_id: task.sessionId,
      task_id: task.id,
      interaction_id: interaction.interactionId,
      step_id: interaction.stepId,
      submission_id: submission.submissionId,
    }
    for (const message of submission.messages) {
      logRuntimeEvent(assignmentPath, {
        ...eventBase,
        event: 'workflow.human_input.message',
        message_id: message.id,
        text: message.text,
        recipients: message.recipients,
      })
    }
    logRuntimeEvent(assignmentPath, {
      ...eventBase,
      event: 'workflow.human_input.submitted',
      mode: submission.mode,
      message_count: submission.messages.length,
    })
  }
  const continued = await taskQueue.enqueueContinuation({
    sessionId: open.sessionId,
    taskId: open.taskId,
  })
  return {
    kind: 'submitted',
    task: continued,
    workflowRevision: submitted.revision,
    interaction: submitted.steps.find(
      (step) => step.humanInput?.interactionId === interaction.interactionId,
    )?.humanInput,
  }
}

/** The child assignment directory that owns the interaction's source artifact. */
function sourceArtifactAssignmentPath(open: OpenHumanInputInteraction): string {
  return path.join(path.dirname(open.assignmentPath), open.interaction.sourceArtifact.childRunId)
}

function sameRecipientIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((recipientId) => right.includes(recipientId)) &&
    right.every((recipientId) => left.includes(recipientId))
}
