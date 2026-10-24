/**
 * Tells the voice layer when a task needs attention
 * (docs/feature-voice-control-mcp.md, "How Octopus pushes status").
 *
 * It watches task records directly, the fallback the plan named: workers write
 * task status through their own store, and reading the records covers every
 * task, admitted or not. Each pass:
 *
 * 1. records a pending outbox entry for every task change worth announcing,
 *    before any call is made;
 * 2. sends `set_status` for tasks that started or stopped working, and for all
 *    working tasks again whenever the voice layer has newly connected;
 * 3. rechecks each pending entry against the task as it is now, discarding it
 *    when the question was answered or the task moved on, and sends the rest.
 */
import type { SessionTask } from '../../contracts/sessions.js'
import {
  voiceNotifyInputSchema,
  type VoiceNotifyInput,
  type VoiceSetStatusInput,
  type VoiceState,
} from '../../contracts/voice-control.js'
import type { RunStore } from '../../domains/run/run-store.js'
import { logProcessWarning } from '../../domains/runtime/logger.js'
import type { SessionStore } from '../../domains/sessions/session-store.js'
import {
  NotificationOutbox,
  OUTBOX_RETENTION_MS,
  type OutboxEntry,
} from '../../domains/voice-control/notification-outbox.js'
import type { LoopbackRestClient } from './loopback-rest-client.js'
import { findPendingQuestion, pendingQuestionSentence } from './pending-questions.js'
import { clip } from './tool-support.js'
import type { VoiceLayerLink } from './voice-layer-link.js'

const SOURCE = { appId: 'octopus', name: 'Octopus' } as const
const FAILED_STATUSES = new Set(['failed', 'blocked', 'interrupted'])
const STATUS_LABELS: Readonly<Record<string, string>> = {
  queued: 'Waiting to start',
  running: 'Running',
  cancelled: 'Cancelled',
}

/**
 * What a running task is doing, named by its latest run event of these kinds
 * (domains/sessions/run-event-types.ts). Events of other kinds, such as single
 * provider requests, change nothing a person needs to hear.
 */
const RUN_EVENT_LABELS: Readonly<Record<string, string>> = {
  'session_task.workflow_started': 'Workflow started',
  'workflow.step.started': 'Working on the next step',
  'agent.start': 'Dispatching agents',
  'discussion.message': 'The team is discussing',
  'team.message': 'The team is discussing',
  'gate.transition': 'Moving to the next stage',
}

export interface VoiceAttentionService {
  /**
   * Opens the outbox and records what needs announcing, then starts the
   * regular passes. Awaited at server start, so a change that happened while
   * Octopus was down is on record before anything else runs.
   */
  start(): Promise<void>
  stop(): Promise<void>
}

export function createVoiceAttentionService(input: {
  readonly sessionStore: Pick<SessionStore, 'getTaskRecord' | 'listTaskRecordsStrict'>
  /** Where a running task's events are read, for its status label. Optional. */
  readonly runStore?: Pick<RunStore, 'listRunEvents'>
  readonly rest: LoopbackRestClient
  readonly link: VoiceLayerLink
  readonly outboxFile: string
  readonly intervalMs: number
  readonly now?: () => Date
}): VoiceAttentionService {
  const now = input.now ?? (() => new Date())
  /** The state and label last told to the voice layer, per task, on this connection. */
  const toldStatus = new Map<string, string>()
  let outbox: NotificationOutbox | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  let stopped = false
  const lifetime = new AbortController()

  const listTasks = async (): Promise<readonly SessionTask[]> => {
    try {
      return (await input.sessionStore.listTaskRecordsStrict?.()) ?? []
    } catch {
      return []
    }
  }

  /** Records an entry for every announcable change since the outbox began. */
  const recordChanges = async (box: NotificationOutbox, tasks: readonly SessionTask[]): Promise<void> => {
    const since = Date.parse(box.since)
    const oldest = now().getTime() - OUTBOX_RETENTION_MS
    for (const task of tasks) {
      if (lifetime.signal.aborted) return
      const changedAt = taskChangedAt(task)
      const changed = Date.parse(changedAt)
      if (Number.isNaN(changed) || changed < since || changed < oldest) continue
      const announcement = await announcementFor(task)
      if (announcement === undefined || box.has(announcement.key)) continue
      // Checked against the contract before it is recorded, so one task that
      // cannot be announced never stops the others from being recorded.
      const notify = voiceNotifyInputSchema.safeParse(announcement.notify)
      if (!notify.success) {
        logProcessWarning('voice-control', JSON.stringify({ event: 'announcement.invalid', sessionId: task.sessionId, taskId: task.id }))
        continue
      }
      try {
        await box.record({
          key: announcement.key,
          sessionId: task.sessionId,
          taskId: task.id,
          taskStatus: task.status,
          ...(announcement.questionId === undefined ? {} : { questionId: announcement.questionId }),
          notify: notify.data,
          createdAt: now().toISOString(),
          taskChangedAt: changedAt,
        })
      } catch (error) {
        logProcessWarning('voice-control', JSON.stringify({ event: 'announcement.record_failed', sessionId: task.sessionId, taskId: task.id, errorName: error instanceof Error ? error.name : 'UnknownError' }))
      }
    }
  }

  const announcementFor = async (
    task: SessionTask,
  ): Promise<{ key: string; questionId?: string; notify: VoiceNotifyInput } | undefined> => {
    const label = clip(task.teamId ?? task.workflowId, MAX_LABEL)
    const subject = { type: 'task', id: task.id, label }
    const taskArguments = { sessionId: task.sessionId, taskId: task.id }
    const base = `octopus:task:${task.id}`
    const terminalKey = terminalAnnouncementKey(task)
    if (task.status === 'done' && terminalKey !== undefined) {
      return {
        key: terminalKey,
        notify: {
          source: { ...SOURCE },
          subject,
          kind: 'needs_review',
          title: `${label} is done`,
          speech: `${label} is finished. Want me to read the summary?`,
          priority: 'normal',
          actions: [
            { id: 'read', label: 'Read the summary', tool: { appId: SOURCE.appId, name: 'read_result', arguments: taskArguments } },
            { id: 'show', label: 'Open it in Octopus', tool: { appId: SOURCE.appId, name: 'show', arguments: taskArguments } },
          ],
          dedupeKey: terminalKey,
        },
      }
    }
    if (FAILED_STATUSES.has(task.status) && terminalKey !== undefined) {
      const key = terminalKey
      return {
        key,
        notify: {
          source: { ...SOURCE },
          subject,
          kind: 'failed',
          title: `${label} ${task.status === 'failed' ? 'failed' : `is ${task.status}`}`,
          speech: task.status === 'failed'
            ? `${label} failed.`
            : `${label} stopped: it is ${task.status}.`,
          priority: 'normal',
          actions: [
            { id: 'show', label: 'Open it in Octopus', tool: { appId: SOURCE.appId, name: 'show', arguments: taskArguments } },
          ],
          dedupeKey: key,
        },
      }
    }
    if (task.status !== 'awaiting_input' && task.status !== 'awaiting_model_choice') return undefined
    const found = await findPendingQuestion(input.rest, task.sessionId, task.id, lifetime.signal).catch(() => undefined)
    if (found === undefined || 'failure' in found) return undefined
    const pending = found.pending
    if (pending.kind === 'none') return undefined
    if (pending.kind === 'model_choice') {
      const key = `${base}:needs_approval:${pending.offerId}`
      return {
        key,
        questionId: pending.offerId,
        notify: {
          source: { ...SOURCE },
          subject,
          kind: 'needs_approval',
          title: `${label} needs a model choice`,
          speech: pendingQuestionSentence(pending),
          priority: 'urgent',
          actions: [
            { id: 'retry', label: 'Retry on the default model', tool: { appId: SOURCE.appId, name: 'choose_model', arguments: taskArguments } },
          ],
          dedupeKey: key,
        },
      }
    }
    const key = `${base}:needs_input:${pending.interactionId}`
    return {
      key,
      questionId: pending.interactionId,
      notify: {
        source: { ...SOURCE },
        subject,
        kind: 'needs_input',
        title: `${label} needs your input`,
        speech: pendingQuestionSentence(pending),
        priority: 'urgent',
        actions: [
          { id: 'question', label: 'Read the question', tool: { appId: SOURCE.appId, name: 'get_question', arguments: taskArguments } },
        ],
        dedupeKey: key,
      },
    }
  }

  /**
   * Whether an entry still describes the task as it is now. `unknown` means it
   * could not be checked this time, a route failing or the store unreadable,
   * and is not evidence that the entry is obsolete: it stays pending.
   */
  const entryState = async (entry: OutboxEntry): Promise<'current' | 'obsolete' | 'unknown'> => {
    let task: SessionTask | null
    try {
      task = await input.sessionStore.getTaskRecord(entry.sessionId, entry.taskId)
    } catch {
      return 'unknown'
    }
    if (!task) return 'obsolete'
    // A task's ending is current only for the attempt that ended that way.
    if (entry.questionId === undefined) {
      return terminalAnnouncementKey(task) === entry.key ? 'current' : 'obsolete'
    }
    if (task.status !== entry.taskStatus) return 'obsolete'
    let found: Awaited<ReturnType<typeof findPendingQuestion>>
    try {
      found = await findPendingQuestion(input.rest, task.sessionId, task.id, lifetime.signal)
    } catch {
      return 'unknown'
    }
    if ('failure' in found) return 'unknown'
    const pending = found.pending
    const matches = (pending.kind === 'feedback' || pending.kind === 'questions')
      ? pending.interactionId === entry.questionId
      : pending.kind === 'model_choice' && pending.offerId === entry.questionId
    return matches ? 'current' : 'obsolete'
  }

  /** A running task is named by what its run last did; anything else by its status. */
  const statusLabel = async (task: SessionTask): Promise<string> => {
    const fallback = STATUS_LABELS[task.status] ?? task.status
    if (task.status !== 'running' || input.runStore === undefined) return fallback
    let events: readonly { readonly type?: string }[]
    try {
      events = await input.runStore.listRunEvents(task.runId)
    } catch {
      return fallback
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const type = events[index]?.type
      const label = type === undefined ? undefined : RUN_EVENT_LABELS[type]
      if (label !== undefined) return label
    }
    return fallback
  }

  const tellStatuses = async (tasks: readonly SessionTask[], resend: boolean): Promise<void> => {
    if (resend) toldStatus.clear()
    for (const task of tasks) {
      if (!input.link.connected || lifetime.signal.aborted) return
      const state = workingStateOf(task.status)
      if (state === undefined) continue
      // A cancelled task is told once, when it stops. One already idle when
      // the link opened has nothing to say.
      if (state === 'idle' && !toldStatus.has(task.id)) continue
      const label = await statusLabel(task)
      const told = `${state}:${label}`
      if (toldStatus.get(task.id) === told) continue
      const status: VoiceSetStatusInput = {
        source: { ...SOURCE },
        subject: { type: 'task', id: task.id, label: clip(task.teamId ?? task.workflowId, MAX_LABEL) },
        state,
        label,
      }
      if (await input.link.setStatus(status) === 'delivered') toldStatus.set(task.id, told)
    }
  }

  const deliver = async (box: NotificationOutbox): Promise<void> => {
    for (const entry of box.pending()) {
      if (lifetime.signal.aborted) return
      if (Date.parse(entry.taskChangedAt) < now().getTime() - OUTBOX_RETENTION_MS) {
        await box.settle(entry.key, 'discarded', now())
        continue
      }
      const state = await entryState(entry)
      if (state === 'unknown') continue
      if (state === 'obsolete') {
        await box.settle(entry.key, 'discarded', now())
        continue
      }
      if (!input.link.connected) return
      const outcome = await input.link.notify(entry.notify)
      if (outcome === 'delivered') await box.settle(entry.key, 'delivered', now())
      // The voice layer received it and refused it; sending it again would be refused too.
      else if (outcome === 'refused') await box.settle(entry.key, 'discarded', now())
      else return
    }
  }

  const pass = async (): Promise<void> => {
    const box = outbox
    if (!box) return
    const tasks = await listTasks()
    await recordChanges(box, tasks)
    const reconnected = await input.link.refresh()
    await tellStatuses(tasks, reconnected)
    await deliver(box)
    await box.prune(now())
  }

  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(() => {
      running = pass()
        .catch((error: unknown) => {
          logProcessWarning('voice-control', JSON.stringify({ event: 'attention.pass_failed', errorName: error instanceof Error ? error.name : 'UnknownError' }))
        })
        .finally(() => {
          running = undefined
          schedule()
        })
    }, input.intervalMs)
    timer.unref?.()
  }

  return {
    async start() {
      outbox = await NotificationOutbox.open(input.outboxFile, now())
      await recordChanges(outbox, await listTasks())
      schedule()
    },
    async stop() {
      stopped = true
      lifetime.abort()
      if (timer !== undefined) clearTimeout(timer)
      await running
      await input.link.close()
    },
  }
}

/** The longest task name used in a title or subject; the contract allows 256. */
const MAX_LABEL = 200

/**
 * The key a finished, failed, blocked or interrupted task is announced under.
 * It names the attempt, so an earlier attempt's ending never stands in for a
 * later one that ended the same way.
 */
function terminalAnnouncementKey(task: SessionTask): string | undefined {
  const attempt = task.executionAttemptNumber ?? 1
  if (task.status === 'done') return `octopus:task:${task.id}:done:${attempt}`
  if (FAILED_STATUSES.has(task.status)) return `octopus:task:${task.id}:${task.status}:${attempt}`
  return undefined
}

function workingStateOf(status: SessionTask['status']): VoiceState | undefined {
  if (status === 'queued' || status === 'running') return 'working'
  if (status === 'cancelled') return 'idle'
  return undefined
}

/** When the task reached its current state, normalized to the outbox's ISO form. */
function taskChangedAt(task: SessionTask): string {
  const value = Date.parse(task.completedAt ?? task.updatedAt ?? task.createdAt)
  return Number.isNaN(value) ? '' : new Date(value).toISOString()
}
