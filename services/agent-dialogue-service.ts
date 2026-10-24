import { randomUUID } from 'node:crypto'
import { agentDialogueRecordSchema, type AgentDialogueEvent, type AgentDialogueRecord, type AgentDialoguePauseReason, type InterjectAgentDialogueRequest, type StartAgentDialogueRequest } from '../contracts/agent-dialogue.js'
import type { ChatMessage } from '../contracts/sessions.js'
import type { VoiceSayInput, VoiceSayProgress, VoiceSayResult, VoiceSetStatusInput } from '../contracts/voice-control.js'
import { SessionActivityConflictError, releaseSessionActivityAfterFailure } from '../domains/sessions/session-activity-claims.js'
import { whenDefined } from '../core/optional-properties.js'
import { withFileMutationLock } from '../core/file-mutation.js'
import { FileSystemDialogueStore } from './agent-dialogue-store.js'
import { filterDialogueDelta, finishDialogueDelta, normalizeDialogueText, recoverDialogueRecord, settleDialogueTurn, type DialogueDeltaState } from '../domains/agent-dialogue/dialogue-policy.js'
import type { SessionStore } from '../domains/sessions/session-store.js'
import type { RunStore } from '../domains/run/run-store.js'
import type { WorkspaceProjectService } from '../domains/projects/workspace-project-service.js'
import type { WorkspaceProjectContextStore } from '../domains/projects/project-context-store.js'
import type { AgentTextStreamHub } from '../domains/runtime/agent-text-stream-hub.js'
import type { McpAgentToolService } from './mcp-agent-tool-service.js'
import type { WorkspaceExecutionJournalRegistry } from './workspace-execution-journal-registry.js'
import { resolveAgentTurnJournalRecorder, type AgentTurnJournalEventObserver } from './agent-turn-journal-recorder.js'
import { loadAgentReplySpeakers, runAgentReply, type AgentReplySpeaker } from './agent-reply-service.js'
import { AgentChatTurnCancelledError, runAgentReplyLifecycle } from './agent-reply-lifecycle.js'
import { buildSessionChatFileContext, lockSessionChatFiles } from './session-chat-file-context.js'
import { resolveChatFileBudget } from './agent-chat-history.js'
import { resolveContinuationContext } from './continuation-resolver.js'
import { buildWorkspaceProjectChatContext } from './project-context-service.js'
import { buildFolderMapContext } from './folder-map-context.js'
import { createFolderToolAdapters } from './folder-tool-adapters.js'
import type { SharedFolderService } from './shared-folder-service.js'
import type { SessionChatActivity } from './session-activity-service.js'
import { contextLimit } from '../core/context-limits.js'
import { ServiceError } from './service-errors.js'
import { logRuntimeEvent } from '../domains/runtime/logger.js'
import { heardDialoguePrefix } from '../domains/agent-dialogue/dialogue-speech-policy.js'

export interface AgentDialogueServiceOptions {
  clock?: AgentDialogueClock
  sessionStore: SessionStore
  workspacePath: string
  repoRootPath: string
  agentTextStreamHub: AgentTextStreamHub
  runStore?: RunStore
  workspaceProjectService?: WorkspaceProjectService
  workspaceProjectContextStore?: WorkspaceProjectContextStore
  sharedFolderService?: Pick<SharedFolderService, 'resolveTurnFolders' | 'toolPolicy'>
  mcpAgentToolService?: McpAgentToolService
  executionJournalRegistry?: WorkspaceExecutionJournalRegistry
  providerFailureHealth?: AgentTurnJournalEventObserver
  resolveConnectionKind?: (provider: string) => string | undefined
  voiceDelivery?: AgentDialogueVoiceDelivery
}

export interface AgentDialogueVoiceDelivery {
  say(input: VoiceSayInput, options: { signal: AbortSignal; onProgress: (progress: VoiceSayProgress) => void }): Promise<
    { kind: 'delivered'; result: VoiceSayResult } | { kind: 'unreachable' | 'refused' }>
  setStatus(input: VoiceSetStatusInput): Promise<'delivered' | 'refused' | 'unreachable'>
}

export interface AgentDialogueClock {
  now(): number
  schedule(callback: () => void, milliseconds: number): () => void
}

interface DialogueJob {
  record: AgentDialogueRecord
  speakers: AgentReplySpeaker[]
  controller: AbortController
  listeners: Set<() => void>
  done: Promise<void>
  stopRequested: boolean
  interjectionVersion: number
  wake: (() => void) | undefined
  runningSince: number | undefined
  cancelBudget: (() => void) | undefined
  projectContext: string
  continuation: string | undefined
  speech: DialogueSpeech | undefined
  reserve: DialogueVoiceAttempt | undefined
  ready: boolean
}

interface DialogueSpeech {
  utteranceId: string
  message: ChatMessage
  started: boolean
  heardChars: number
  withdrawnHeardChars: number | undefined
  controller: AbortController
}

interface DialogueVoiceAttempt {
  record: AgentDialogueRecord
  interjectionVersion: number
  controller: AbortController
  permit: () => void
  done: Promise<DialogueVoiceOutcome>
}

interface DialogueVoiceOutcome {
  disposition: TurnDisposition | 'discarded'
  pause: boolean
  pauseReason?: AgentDialoguePauseReason
}

type TurnDisposition = 'reply' | 'pass' | 'failure'
const MAX_TIMER_DELAY_MS = 2_147_483_647

export class AgentDialogueService {
  private readonly jobs = new Map<string, DialogueJob>()
  private readonly store: FileSystemDialogueStore
  private readonly launchId = randomUUID()
  private readonly clock: AgentDialogueClock
  private closing = false
  constructor(private readonly options: AgentDialogueServiceOptions) {
    this.store = new FileSystemDialogueStore(options.workspacePath, options.sessionStore)
    this.clock = options.clock ?? {
      now: () => Date.now(),
      schedule: (callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds)
        return () => clearTimeout(timer)
      },
    }
  }

  async start(sessionId: string, request: StartAgentDialogueRequest, handoff?: SessionChatActivity, initiatingAgentId?: string): Promise<AgentDialogueRecord> {
    this.requireOpen()
    const timestamp = new Date().toISOString()
    if (!await this.options.sessionStore.getSession(sessionId)) throw new ServiceError('not_found', 'Chat not found')
    this.requireOpen()
    let projectContextSelection = request.projectContext
    let contextResultIds = request.contextResultIds
    if (request.continues) {
      const previous = await this.get(sessionId, request.continues)
      if (!previous) throw new ServiceError('not_found', 'The earlier dialogue was not found')
      if (previous.status === 'running' || previous.status === 'paused') throw new ServiceError('conflict', 'The earlier dialogue is still active')
      if (previous.participants.map((participant) => participant.id).join('\0') !== request.agents.join('\0')) throw new ServiceError('bad_request', 'Continue must retain the earlier Agents in order')
      await this.jobs.get(request.continues)?.done
      projectContextSelection ??= previous.projectContext
      contextResultIds ??= previous.contextResultIds
    }
    if (request.delivery === 'voice' && !this.options.voiceDelivery) throw new ServiceError('not_configured', 'The voice layer is unavailable')
    const speakers = loadAgentReplySpeakers({
      repoRootPath: this.options.repoRootPath, agentNames: request.agents, dialogue: { participants: request.agents },
      ...whenDefined(this.options.resolveConnectionKind, (resolveConnectionKind) => ({ resolveConnectionKind })),
    })
    let projectContext = ''
    if (projectContextSelection) {
      const projectService = this.options.workspaceProjectService
      const contextStore = this.options.workspaceProjectContextStore
      if (!projectService || !contextStore) throw new ServiceError('bad_request', 'Project context is unavailable')
      try {
        projectContext = await buildWorkspaceProjectChatContext({ sessionId, selection: projectContextSelection, projectService, contextStore })
      } catch (cause) {
        const refusal = new ServiceError('bad_request', cause instanceof Error ? cause.message : 'Invalid project context selection')
        refusal.cause = cause
        throw refusal
      }
    }
    const continuation = await resolveContinuationContext({
      sessionId, selectedIds: contextResultIds ?? [], carryRecentWhenUnchosen: true, sessionStore: this.options.sessionStore,
      ...whenDefined(this.options.runStore, (runStore) => ({ runStore })),
    })
    if (continuation.rejected.length > 0) throw new ServiceError('bad_request', 'A selected prior result is unavailable', { code: 'context_result_rejected' })
    const record = agentDialogueRecordSchema.parse({
      schemaVersion: 1, dialogueId: randomUUID(), sessionId, topic: request.topic, delivery: request.delivery,
      participants: speakers.map((speaker) => ({ id: speaker.id, label: speaker.name, active: true, consecutiveFailures: 0 })),
      limits: { maxTurns: request.maxTurns, runningMs: 0, ...whenDefined(request.maxMinutes, (maxMinutes) => ({ maxMinutes })) }, status: 'running',
      nextSlot: 0, replyCount: 0, passStreak: 0, nextSpeaker: 0, epoch: 0, ownerLaunchId: this.launchId,
      createdAt: timestamp, updatedAt: timestamp, stopRequested: false,
      ...whenDefined(request.continues, (continues) => ({ continues })),
      ...whenDefined(projectContextSelection, (projectContext) => ({ projectContext })),
      ...whenDefined(contextResultIds, (contextResultIds) => ({ contextResultIds })),
      events: [{ sequence: 0, type: 'started', createdAt: timestamp, status: 'running' }],
    })
    // Reconcile prior-launch records before checking their durable claims.
    await this.list(sessionId)
    this.requireOpen()
    const claim = { kind: 'dialogue' as const, claimId: record.dialogueId, ownerLaunchId: this.launchId }
    const claimed = handoff
      ? await this.options.sessionStore.promoteSessionChatToDialogue(sessionId, handoff.claim, claim)
      : await this.options.sessionStore.claimSessionActivity(sessionId, claim)
    if (claimed === 'not_found') throw new ServiceError('not_found', 'Chat not found')
    if (claimed !== 'claimed') throw new SessionActivityConflictError(claimed)
    const interruptStart = () => {
      const interruptedAt = new Date().toISOString()
      return this.store.save({ ...record, status: 'interrupted', endReason: 'interrupted', epoch: record.epoch + 1, updatedAt: interruptedAt,
        events: [...record.events, { sequence: record.events.length, type: 'ended', createdAt: interruptedAt, status: 'interrupted', endReason: 'interrupted' }],
      })
    }
    let recordPersisted = false
    // Only the trusted native adapter identifies an Agent-authored topic.
    // REST and MCP starts retain the user's authored topic.
    const topicSpeaker = speakers.find((speaker) => speaker.id === initiatingAgentId)
    try {
      this.requireOpen()
      if (!await this.store.save(record)) throw new ServiceError('not_found', 'Chat not found')
      recordPersisted = true
      await this.append(record, {
        id: `${record.dialogueId}:user:topic`, role: topicSpeaker ? 'assistant' : 'user', text: record.topic, createdAt: timestamp,
        ...whenDefined(topicSpeaker, (speaker) => ({ turnId: record.dialogueId, speaker: { type: 'agent' as const, id: speaker.id, name: speaker.name } })),
        schemaVersion: 2, kind: 'chat', source: { kind: 'agent-dialogue', dialogueId: record.dialogueId, slot: 0 },
      })
      if (this.closing) {
        await interruptStart()
        this.requireOpen()
      }
    } catch (error) {
      if (recordPersisted) {
        try {
          await interruptStart()
        } catch (cleanupError) {
          logRuntimeEvent(this.options.workspacePath, { event: 'agent-dialogue-start-cleanup-failed', dialogueId: record.dialogueId, sessionId, errorType: cleanupError instanceof Error ? cleanupError.name : 'unknown' })
        }
      }
      await releaseSessionActivityAfterFailure({ sessionId, claimId: claim.claimId, cause: error, release: async () => {
        if (handoff) await this.options.sessionStore.restoreSessionChatFromDialogue(sessionId, claim, handoff.claim)
        else await this.options.sessionStore.releaseSessionActivity(sessionId, claim)
      } })
      throw error
    }
    const job: DialogueJob = { record, speakers, controller: new AbortController(), listeners: new Set(), done: Promise.resolve(), stopRequested: false, interjectionVersion: 0, wake: undefined, runningSince: undefined, cancelBudget: undefined, projectContext, continuation: continuation.context, speech: undefined, reserve: undefined, ready: !handoff }
    this.jobs.set(record.dialogueId, job)
    if (!handoff) this.startRunning(job)
    // Background ownership belongs to the service, beyond the HTTP request.
    const run = async () => {
      if (handoff) {
        const published = await handoff.completion
        if (job.stopRequested) return
        if (!published) {
          job.record = { ...job.record, status: 'interrupted', endReason: 'interrupted', epoch: job.record.epoch + 1 }
          await this.finish(job)
          return
        }
        job.ready = true
        if (job.record.status === 'running') this.startRunning(job)
      }
      await this.run(job)
    }
    job.done = run().catch(async (error: unknown) => {
      if (job.stopRequested) return
      if (job.record.endReason === 'time_limit' || job.record.status === 'interrupted') { await this.finish(job); return }
      logRuntimeEvent(this.options.workspacePath, { event: 'agent-dialogue-failed', dialogueId: record.dialogueId, sessionId, errorType: error instanceof Error ? error.name : 'unknown' })
      job.record = this.freezeRunning(job, { ...job.record, status: 'failed', endReason: 'interrupted' })
      await this.finish(job)
    }).finally(async () => {
      job.cancelBudget?.()
      try {
        await this.options.sessionStore.releaseSessionActivity(sessionId, claim)
      } finally {
        try {
          await this.clearVoiceStatus(job.record)
        } finally {
          // Terminal records remain on disk; retain only jobs whose loop or
          // cleanup still needs ownership, cancellation or listeners.
          if (this.jobs.get(record.dialogueId) === job) this.jobs.delete(record.dialogueId)
          job.listeners.clear()
        }
      }
    })
    // The service owns the job promise; report cleanup faults at this boundary.
    void job.done.catch((error: unknown) => {
      logRuntimeEvent(this.options.workspacePath, { event: 'agent-dialogue-cleanup-failed', dialogueId: record.dialogueId, sessionId, errorType: error instanceof Error ? error.name : 'unknown' })
    })
    return record
  }
  async get(sessionId: string, dialogueId: string): Promise<AgentDialogueRecord | undefined> {
    const job = this.jobs.get(dialogueId)
    if (job) return job.record.sessionId === sessionId ? job.record : undefined
    return withFileMutationLock(dialogueId, async () => {
      const record = await this.store.get(sessionId, dialogueId)
      if (!record || record.ownerLaunchId === this.launchId) return record
      const claim = { kind: 'dialogue' as const, claimId: dialogueId, ownerLaunchId: record.ownerLaunchId }
      if (await this.options.sessionStore.isSessionActivityOwnerAlive(sessionId, claim)) return record
      if (record.status !== 'running' && record.status !== 'paused') {
        await this.options.sessionStore.releaseSessionActivity(sessionId, claim)
        return record
      }
      const recovered = recoverDialogueRecord(record, await this.options.sessionStore.listChatMessages(sessionId), new Date().toISOString())
      const terminal = { ...recovered, events: [...recovered.events, {
        sequence: recovered.events.length, type: 'ended' as const, createdAt: recovered.updatedAt, status: recovered.status,
        ...whenDefined(recovered.endReason, (endReason) => ({ endReason })),
      }] }
      await this.store.save(terminal)
      await this.options.sessionStore.releaseSessionActivity(sessionId, claim)
      return terminal
    })
  }
  async list(sessionId: string): Promise<AgentDialogueRecord[]> {
    const records: AgentDialogueRecord[] = []
    const persisted = await this.store.list(sessionId)
    await this.options.sessionStore.reconcileOrphanedDialogueClaims(sessionId, persisted.map((record) => record.dialogueId))
    for (const record of persisted) {
      const current = await this.get(sessionId, record.dialogueId)
      if (current) records.push(current)
    }
    return records
  }
  async findSessionId(dialogueId: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    const job = this.jobs.get(dialogueId)
    if (job) return job.record.sessionId
    for (const session of await this.options.sessionStore.listSessions()) {
      signal?.throwIfAborted()
      if (await this.store.get(session.id, dialogueId)) return session.id
    }
    return undefined
  }
  subscribe(dialogueId: string, notify: () => void): () => void {
    const job = this.jobs.get(dialogueId)
    job?.listeners.add(notify)
    return () => { job?.listeners.delete(notify) }
  }

  async stop(sessionId: string, dialogueId: string): Promise<AgentDialogueRecord> {
    const job = this.ownedJob(sessionId, dialogueId)
    if (!job) return this.durableControlRecord(sessionId, dialogueId)
    if (job.record.status !== 'running' && job.record.status !== 'paused') return job.record
    job.stopRequested = true
    const speech = job.speech
    if (speech) speech.withdrawnHeardChars = speech.heardChars
    try {
      await this.event(job, { type: 'ended', status: 'stopped', endReason: 'stopped' }, (record) => this.freezeRunning(job, { ...record, status: 'stopped', endReason: 'stopped', stopRequested: true, epoch: record.epoch + 1 }))
    } finally {
      job.controller.abort()
      speech?.controller.abort()
      this.cancelVoiceReserve(job)
      job.wake?.()
    }
    if (speech?.started) {
      const text = heardDialoguePrefix(speech.message.text, speech.withdrawnHeardChars ?? 0)
      if (text) await this.append(job.record, { ...speech.message, text, cutOff: { heardChars: speech.withdrawnHeardChars ?? 0 } })
    }
    return job.record
  }

  async pause(sessionId: string, dialogueId: string): Promise<AgentDialogueRecord> {
    const job = this.ownedJob(sessionId, dialogueId)
    if (!job) return this.durableControlRecord(sessionId, dialogueId)
    if (job.record.status !== 'running') return job.record
    await this.event(job, { type: 'paused', status: 'paused' }, (record) => this.freezeRunning(job, { ...record, status: 'paused', epoch: record.epoch + 1 }))
    this.cancelVoiceReserve(job)
    return job.record
  }

  async resume(sessionId: string, dialogueId: string): Promise<AgentDialogueRecord> {
    const job = this.ownedJob(sessionId, dialogueId)
    if (!job) return this.durableControlRecord(sessionId, dialogueId)
    if (job.record.status !== 'paused') return job.record
    await this.event(job, { type: 'resumed', status: 'running' }, (record) => {
      this.startRunning(job)
      const resumed = { ...record, status: 'running' as const }
      delete resumed.pauseReason
      return resumed
    })
    job.wake?.()
    return job.record
  }

  async interject(sessionId: string, dialogueId: string, request: InterjectAgentDialogueRequest): Promise<AgentDialogueRecord> {
    const job = this.ownedJob(sessionId, dialogueId)
    if (!job) {
      const record = await this.durableControlRecord(sessionId, dialogueId)
      const messageId = `${dialogueId}:user:${request.messageId}`
      const existing = (await this.options.sessionStore.listChatMessages(sessionId)).find((message) => message.id === messageId)
      if (!existing) throw new ServiceError('conflict', 'This dialogue has ended')
      if (existing.role !== 'user' || existing.text !== request.text) throw new ServiceError('conflict', 'The interjection identity was already used for different text')
      return record
    }
    await withFileMutationLock(dialogueId, async () => {
      const messageId = `${dialogueId}:user:${request.messageId}`
      const existing = (await this.options.sessionStore.listChatMessages(sessionId)).find((message) => message.id === messageId)
      if (existing) {
        if (existing.role !== 'user' || existing.text !== request.text) throw new ServiceError('conflict', 'The interjection identity was already used for different text')
        return
      }
      if (job.stopRequested || (job.record.status !== 'running' && job.record.status !== 'paused')) throw new ServiceError('conflict', 'This dialogue has ended')
      await this.append(job.record, {
        id: messageId, role: 'user', text: request.text, createdAt: new Date().toISOString(), schemaVersion: 2, kind: 'chat',
        source: { kind: 'agent-dialogue', dialogueId, slot: job.record.nextSlot },
      })
      job.interjectionVersion += 1
      if (job.record.status === 'paused') this.startRunning(job)
      job.record = { ...job.record, passStreak: 0, epoch: job.record.epoch + 1, ...(job.record.status === 'paused' ? { status: 'running' as const } : {}) }
      delete job.record.pauseReason
      this.cancelVoiceReserve(job)
      await this.persistEvent(job, { type: 'interjected', messageId })
      job.wake?.()
    })
    return job.record
  }
  beginShutdown(): void {
    this.closing = true
    for (const job of this.jobs.values()) {
      if (job.record.status !== 'running' && job.record.status !== 'paused') continue
      job.record = this.freezeRunning(job, { ...job.record, status: 'interrupted', endReason: 'interrupted', epoch: job.record.epoch + 1 })
      if (job.speech) {
        job.speech.withdrawnHeardChars = job.speech.heardChars
        job.speech.controller.abort()
      }
      this.cancelVoiceReserve(job)
      job.controller.abort()
      job.wake?.()
    }
  }

  async close(): Promise<void> {
    this.beginShutdown()
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done))
  }

  async stopAndWait(sessionId: string): Promise<void> {
    await this.list(sessionId)
    for (const job of this.jobs.values()) {
      if (job.record.sessionId !== sessionId) continue
      await this.stop(sessionId, job.record.dialogueId)
      await job.done
    }
  }

  private async run(job: DialogueJob): Promise<void> {
    const files = await lockSessionChatFiles(this.options.sessionStore, job.record.sessionId)
    const attachmentBudget = resolveChatFileBudget(job.speakers)
    const fileContext = await buildSessionChatFileContext({ sessionId: job.record.sessionId, sessionStore: this.options.sessionStore, files, ...attachmentBudget })
    if (job.record.delivery === 'voice') { await this.runVoice(job, fileContext, attachmentBudget); return }
    while ((job.record.status === 'running' || job.record.status === 'paused') && !job.controller.signal.aborted && !job.stopRequested) {
      if (job.record.status === 'paused') {
        await new Promise<void>((resolve) => { job.wake = resolve })
        job.wake = undefined
        continue
      }
      const speaker = job.speakers[job.record.nextSpeaker]
      const participant = job.record.participants[job.record.nextSpeaker]
      if (!speaker || !participant) throw new Error('Dialogue speaker is missing')
      const slot = job.record.nextSlot
      const interjectionVersion = job.interjectionVersion
      const channelId = randomUUID()
      const replyId = `${speaker.id}:${slot}`
      const assignmentId = randomUUID()
      const location = await this.options.sessionStore.ensureAgentChatAssignment(job.record.sessionId, channelId, assignmentId)
      if (!location) throw new ServiceError('internal', 'Could not create the Agent reply assignment')
      const recorder = await resolveAgentTurnJournalRecorder({
        registry: this.options.executionJournalRegistry,
        scope: { sessionId: job.record.sessionId, runId: channelId, assignmentId },
        requestId: `${job.record.dialogueId}:slot:${slot}`, processIdentity: this.launchId, agentPath: `agents/${speaker.id}`,
        signal: job.controller.signal, observer: this.options.providerFailureHealth,
      })
      const hub = this.options.agentTextStreamHub
      hub.openChannel(channelId, job.record.sessionId)
      await this.event(job, { type: 'turn_started', channelId, replyId, speaker: participant, slot })
      if (speaker.selection) hub.publish(channelId, { type: 'selection', replyId, speaker: speaker.id, selection: speaker.selection })
      let deltaState: DialogueDeltaState = { pending: '', started: false }
      const messages = await this.options.sessionStore.listChatMessages(job.record.sessionId)
      const latestUser = [...messages].reverse().find((message) => message.role === 'user')
      const history = messages.filter((message) => message.id !== latestUser?.id)
      const folderService = this.options.sharedFolderService
      const folders = folderService ? await folderService.resolveTurnFolders(job.record.sessionId) : []
      const folderContext = folderService && folders.length > 0
        ? await buildFolderMapContext({ folders, policy: folderService.toolPolicy,
            maxTokens: Math.floor(attachmentBudget.totalMaxTokens * contextLimit('share.folderMap')), signal: job.controller.signal }) : ''
      const folderTools = folderService && folders.length > 0 ? createFolderToolAdapters({ folders, policy: folderService.toolPolicy }) : []
      let disposition: TurnDisposition
      try {
        disposition = await runAgentReplyLifecycle<TurnDisposition>({
          turnId: channelId, replyId, speakerOrdinal: job.record.nextSpeaker, agentPath: `agents/${speaker.id}`,
          requestedProvider: speaker.provider, requestedModel: speaker.model,
          ...whenDefined(recorder, (recorder) => ({ recorder })), signal: job.controller.signal,
          // The job's pause-aware budget aborts this signal; retain the separate
          // provider ceiling so paused time cannot consume the dialogue budget.
          generate: (signal) => runAgentReply({
            speaker, fileContext, projectContext: job.projectContext, folderContext, folderTools, history, latestUserText: latestUser?.text ?? job.record.topic,
            ...whenDefined(job.continuation, (continuation) => ({ continuation })),
            sessionId: job.record.sessionId, turnId: channelId, signal,
            ...whenDefined(this.options.mcpAgentToolService, (mcpAgentToolService) => ({ mcpAgentToolService, mcpAssignmentId: assignmentId, mcpAssignmentPath: location.assignmentPath })),
            onProtocolEvent: (event) => {
              if (job.stopRequested || job.controller.signal.aborted || event.kind !== 'text' || !event.text) return
              const filtered = filterDialogueDelta(deltaState, event.text)
              deltaState = filtered.state
              if (filtered.delta) hub.publish(channelId, { type: 'delta', replyId, channel: 'text', text: filtered.delta })
            },
          }),
          prepare: async (result) => {
            if (job.stopRequested) throw new AgentChatTurnCancelledError(channelId, replyId)
            if (result.journal.outcome !== 'success') return { kind: 'failed', failure: result.journal.failure, value: 'failure' }
            const cleaned = normalizeDialogueText(result.text)
            if (cleaned.kind === 'pass') return { kind: 'passed', value: 'pass' }
            if (cleaned.kind !== 'reply') return { kind: 'failed', failure: { layer: 'direct-provider', phase: 'provider-request', serviceCode: 'empty_reply', retryable: true }, value: 'failure' }
            const message: ChatMessage = {
              id: `${job.record.dialogueId}:reply:${slot}`, role: 'assistant', text: cleaned.text, createdAt: new Date().toISOString(),
              schemaVersion: 2, kind: 'chat', source: { kind: 'agent-dialogue', dialogueId: job.record.dialogueId, slot },
              turnId: channelId, speaker: { id: speaker.id, name: speaker.name, type: speaker.type,
                ...(result.droppedProviderOptions?.length ? { droppedProviderOptions: [...result.droppedProviderOptions] } : {}),
              },
              execution: { runId: channelId, assignmentId },
              ...(result.artifacts?.length ? { delivery: { taskId: assignmentId, artifacts: result.artifacts.map((artifact) => ({ runId: assignmentId, ...artifact })) } } : {}),
            }
            return { kind: 'publish', assistantMessageId: message.id, text: message.text, persist: async () => {
              if (job.stopRequested) throw new AgentChatTurnCancelledError(channelId, replyId)
              await this.append(job.record, message)
            }, value: 'reply' }
          },
        })
        if (disposition === 'reply') {
          const tail = finishDialogueDelta(deltaState)
          if (tail) hub.publish(channelId, { type: 'delta', replyId, channel: 'text', text: tail })
        }
        hub.publish(channelId, { type: 'final', replyId, reason: 'completed' })
      } finally { hub.closeChannel(channelId) }
      if (job.stopRequested || job.controller.signal.aborted) return
      await this.event(job, {
        type: disposition === 'reply' ? 'turn_saved' : disposition === 'pass' ? 'turn_passed' : 'speaker_failed',
        slot, speaker: participant,
        ...(disposition === 'reply' ? { messageId: `${job.record.dialogueId}:reply:${slot}` } : {}),
      }, (record) => {
        const settled = settleDialogueTurn(record, { kind: disposition }, new Date().toISOString())
        const next = job.interjectionVersion === interjectionVersion ? settled : { ...settled, passStreak: 0 }
        return next.status === 'running' || next.status === 'paused' ? next : this.freezeRunning(job, next)
      })
    }
    await this.finish(job)
  }

  private async runVoice(job: DialogueJob, fileContext: string, budget: ReturnType<typeof resolveChatFileBudget>): Promise<void> {
    let current: DialogueVoiceAttempt | undefined
    while ((job.record.status === 'running' || job.record.status === 'paused') && !job.stopRequested && !job.controller.signal.aborted) {
      if (job.record.status === 'paused') {
        await new Promise<void>((resolve) => { job.wake = resolve })
        job.wake = undefined
        continue
      }
      const attempt = current ?? this.createVoiceAttempt(job, job.record, fileContext, budget)
      attempt.permit()
      const outcome = await attempt.done
      const speaker = attempt.record.participants[attempt.record.nextSpeaker]
      if (!speaker) throw new Error('Dialogue voice speaker is missing')
      const slot = attempt.record.nextSlot
      const settledRecord = await this.event(job, { type: outcome.disposition === 'reply' ? 'turn_saved' : outcome.disposition === 'pass' ? 'turn_passed' : outcome.disposition === 'discarded' ? 'turn_discarded' : 'speaker_failed',
        slot, speaker, ...(outcome.disposition === 'reply' ? { messageId: `${job.record.dialogueId}:reply:${slot}` } : {}),
      }, (record) => {
        const settled = outcome.disposition === 'discarded'
          ? { ...record, nextSlot: slot + 1, passStreak: 0 }
          : settleDialogueTurn({ ...record, nextSpeaker: attempt.record.nextSpeaker }, { kind: outcome.disposition }, new Date().toISOString())
        const next = job.interjectionVersion === attempt.interjectionVersion ? settled : { ...settled, passStreak: 0 }
        if (record.status !== 'running' && record.status !== 'paused') return { ...next, status: record.status, ...whenDefined(record.endReason, (endReason) => ({ endReason })) }
        const shouldPause = outcome.pause && record.epoch === attempt.record.epoch && (next.status === 'running' || next.status === 'paused')
        return shouldPause ? this.freezeRunning(job, { ...next, status: 'paused', epoch: next.epoch + 1, ...whenDefined(outcome.pauseReason, (pauseReason) => ({ pauseReason })) })
          : next.status === 'running' || next.status === 'paused' ? next : this.freezeRunning(job, next)
      })
      const pauseApplied = outcome.pause && settledRecord.status === 'paused' && settledRecord.epoch === attempt.record.epoch + 1 && settledRecord.pauseReason === outcome.pauseReason
      if (pauseApplied) await this.event(job, { type: 'paused', status: 'paused', ...whenDefined(outcome.pauseReason, (pauseReason) => ({ pauseReason })) })
      if (settledRecord.status === 'paused') await this.clearVoiceStatus(settledRecord)
      const reserve = job.reserve
      job.reserve = undefined
      if (reserve && job.record.status === 'running' && !job.stopRequested && !job.controller.signal.aborted && !reserve.controller.signal.aborted && reserve.interjectionVersion === job.interjectionVersion) {
        current = reserve
      } else {
        if (reserve) {
          reserve.controller.abort()
          reserve.permit()
          await reserve.done
          await withFileMutationLock(job.record.dialogueId, async () => {
            job.record = { ...job.record, nextSlot: Math.max(job.record.nextSlot, reserve.record.nextSlot + 1) }
            if (!await this.store.save(job.record)) throw new ServiceError('not_found', 'Chat not found')
          })
        }
        current = undefined
      }
    }
    await this.finish(job)
  }

  private createVoiceAttempt(job: DialogueJob, record: AgentDialogueRecord, fileContext: string, budget: ReturnType<typeof resolveChatFileBudget>, predecessor?: ChatMessage): DialogueVoiceAttempt {
    const controller = new AbortController()
    let permit = () => {}
    const ready = new Promise<void>((resolve) => { permit = resolve })
    const attempt: DialogueVoiceAttempt = { record, interjectionVersion: job.interjectionVersion, controller, permit, done: Promise.resolve({ disposition: 'discarded', pause: false }) }
    attempt.done = this.voiceTurn(job, attempt, ready, fileContext, budget, predecessor).catch((error: unknown) => {
      if (controller.signal.aborted || job.stopRequested || job.controller.signal.aborted) return { disposition: 'discarded', pause: false }
      logRuntimeEvent(this.options.workspacePath, { event: 'agent-dialogue-voice-turn-failed', dialogueId: record.dialogueId, sessionId: record.sessionId, errorType: error instanceof Error ? error.name : 'unknown' })
      return { disposition: 'failure', pause: false }
    })
    return attempt
  }

  private cancelVoiceReserve(job: DialogueJob): void {
    job.reserve?.controller.abort()
    job.reserve?.permit()
  }

  private async clearVoiceStatus(record: AgentDialogueRecord): Promise<void> {
    const voice = this.options.voiceDelivery
    if (record.delivery !== 'voice' || !voice) return
    try {
      await voice.setStatus({ source: { appId: 'octopus', name: 'Octopus' },
        subject: { type: 'dialogue', id: record.dialogueId, label: record.topic.slice(0, 256) },
        state: 'idle', label: '' })
    } catch (error) {
      logRuntimeEvent(this.options.workspacePath, { event: 'agent-dialogue-status-clear-failed', dialogueId: record.dialogueId,
        sessionId: record.sessionId, errorType: error instanceof Error ? error.name : 'unknown' })
    }
  }

  private async voiceTurn(job: DialogueJob, attempt: DialogueVoiceAttempt, ready: Promise<void>, fileContext: string, budget: ReturnType<typeof resolveChatFileBudget>, predecessor?: ChatMessage): Promise<DialogueVoiceOutcome> {
    const voice = this.options.voiceDelivery
    const record = attempt.record
    const speaker = job.speakers[record.nextSpeaker]
    const participant = record.participants[record.nextSpeaker]
    if (!voice || !speaker || !participant) throw new Error('Dialogue speech is not configured')
    const controller = attempt.controller
    const onAbort = () => { controller.abort(); attempt.permit() }
    job.controller.signal.addEventListener('abort', onAbort, { once: true })
    if (job.controller.signal.aborted) onAbort()
    const channelId = randomUUID()
    const assignmentId = randomUUID()
    const replyId = `${speaker.id}:${record.nextSlot}`
    const utteranceId = `${record.dialogueId}:turn:${record.nextSlot}:${record.epoch}`
    const hub = this.options.agentTextStreamHub
    let channelOpened = false
    try {
      // MCP serializes calls per server. A reserve must not wait for a status
      // call queued behind the speech whose completion it is meant to hide.
      if (!job.speech?.started) await voice.setStatus({ source: { appId: 'octopus', name: 'Octopus' }, subject: { type: 'dialogue', id: record.dialogueId, label: record.topic.slice(0, 256) }, state: 'working', label: `${speaker.name} is thinking`.slice(0, 256) })
      const location = await this.options.sessionStore.ensureAgentChatAssignment(record.sessionId, channelId, assignmentId)
      if (!location) throw new ServiceError('internal', 'Could not create the Agent reply assignment')
      const messages = await this.options.sessionStore.listChatMessages(record.sessionId)
      if (predecessor && !messages.some((message) => message.id === predecessor.id)) messages.push(predecessor)
      const latestUser = [...messages].reverse().find((message) => message.role === 'user')
      const history = messages.filter((message) => message.id !== latestUser?.id)
      const folderService = this.options.sharedFolderService
      const folders = folderService ? await folderService.resolveTurnFolders(record.sessionId) : []
      const folderContext = folderService && folders.length > 0 ? await buildFolderMapContext({ folders, policy: folderService.toolPolicy, maxTokens: Math.floor(budget.totalMaxTokens * contextLimit('share.folderMap')), signal: controller.signal }) : ''
      const folderTools = folderService && folders.length > 0 ? createFolderToolAdapters({ folders, policy: folderService.toolPolicy }) : []
      const recorder = await resolveAgentTurnJournalRecorder({ registry: this.options.executionJournalRegistry,
        scope: { sessionId: record.sessionId, runId: channelId, assignmentId }, requestId: `${record.dialogueId}:slot:${record.nextSlot}`,
        processIdentity: this.launchId, agentPath: `agents/${speaker.id}`, signal: controller.signal, observer: this.options.providerFailureHealth })
      return await runAgentReplyLifecycle<DialogueVoiceOutcome>({ turnId: channelId, replyId, speakerOrdinal: record.nextSpeaker,
        agentPath: `agents/${speaker.id}`, requestedProvider: speaker.provider, requestedModel: speaker.model,
        ...whenDefined(recorder, (recorder) => ({ recorder })), signal: controller.signal,
        // Running-budget cancellation reaches this attempt through its signal;
        // the provider's independent ceiling remains unchanged during Pause.
        generate: (signal) => runAgentReply({ speaker, fileContext, projectContext: job.projectContext, folderContext, folderTools,
          history, latestUserText: latestUser?.text ?? record.topic, ...whenDefined(job.continuation, (continuation) => ({ continuation })),
          sessionId: record.sessionId, turnId: channelId, signal,
          ...whenDefined(this.options.mcpAgentToolService, (mcpAgentToolService) => ({ mcpAgentToolService, mcpAssignmentId: assignmentId, mcpAssignmentPath: location.assignmentPath })) }),
        prepare: async (result) => {
          await ready
          controller.signal.throwIfAborted()
          if (result.journal.outcome !== 'success') return { kind: 'failed', failure: result.journal.failure, value: { disposition: 'failure', pause: false } }
          const cleaned = normalizeDialogueText(result.text)
          if (cleaned.kind === 'pass') return { kind: 'passed', value: { disposition: 'pass', pause: false } }
          if (cleaned.kind !== 'reply') return { kind: 'failed', failure: { layer: 'direct-provider', phase: 'provider-request', serviceCode: 'empty_reply', retryable: true }, value: { disposition: 'failure', pause: false } }
          if (job.stopRequested || job.controller.signal.aborted) throw new AgentChatTurnCancelledError(channelId, replyId)
          // Generation is complete. Playback has its own cancellation so an
          // already heard prefix can still become durable after a silent Stop.
          job.controller.signal.removeEventListener('abort', onAbort)
          const speech: DialogueSpeech = { utteranceId, message: {
            id: `${record.dialogueId}:reply:${record.nextSlot}`, role: 'assistant', text: cleaned.text, createdAt: new Date().toISOString(),
            schemaVersion: 2, kind: 'chat', source: { kind: 'agent-dialogue', dialogueId: record.dialogueId, slot: record.nextSlot },
            turnId: channelId, speaker: { id: speaker.id, name: speaker.name, type: speaker.type,
              ...(result.droppedProviderOptions?.length ? { droppedProviderOptions: [...result.droppedProviderOptions] } : {}) },
            execution: { runId: channelId, assignmentId },
            ...(result.artifacts?.length ? { delivery: { taskId: assignmentId, artifacts: result.artifacts.map((artifact) => ({ runId: assignmentId, ...artifact })) } } : {}),
          }, started: false, heardChars: 0, withdrawnHeardChars: undefined, controller: new AbortController() }
          job.speech = speech
          let displayWork = Promise.resolve()
          let displayFailure: { cause: unknown } | undefined
          const response = await voice.say({ source: { appId: 'octopus', name: 'Octopus' }, subject: { type: 'dialogue', id: record.dialogueId, label: record.topic.slice(0, 256) }, speaker: { id: speaker.id, label: speaker.name }, utteranceId, text: cleaned.text }, {
            signal: speech.controller.signal,
            onProgress: (progress) => {
              if (job.speech !== speech || progress.utteranceId !== utteranceId || speech.controller.signal.aborted || job.stopRequested || job.record.status === 'interrupted') return
              speech.heardChars = Math.max(speech.heardChars, Math.min(cleaned.text.length, progress.heardChars))
              if (progress.state !== 'started' || speech.started) return
              speech.started = true
              hub.openChannel(channelId, record.sessionId)
              channelOpened = true
              if (speaker.selection) hub.publish(channelId, { type: 'selection', replyId, speaker: speaker.id, selection: speaker.selection })
              hub.publish(channelId, { type: 'delta', replyId, channel: 'text', text: cleaned.text })
              displayWork = this.event(job, { type: 'turn_started', channelId, replyId, speaker: participant, slot: record.nextSlot }).then(() => {
                if (job.record.status !== 'running' || job.stopRequested || job.controller.signal.aborted || attempt.interjectionVersion !== job.interjectionVersion) return
                const next = settleDialogueTurn(record, { kind: 'reply' }, new Date().toISOString())
                if (next.status === 'running') job.reserve = this.createVoiceAttempt(job, next, fileContext, budget, speech.message)
              }).catch((cause: unknown) => { displayFailure = { cause }; speech.controller.abort() })
            },
          })
          await displayWork
          if (displayFailure) throw displayFailure.cause
          const withdrawn = speech.withdrawnHeardChars !== undefined
          const receipt = response.kind === 'delivered' ? response.result : undefined
          const spoken = !withdrawn && receipt?.outcome === 'spoken' && speech.started
          const heardChars = withdrawn ? speech.withdrawnHeardChars ?? 0 : Math.min(cleaned.text.length, Math.max(speech.heardChars, receipt?.heardChars ?? 0))
          const text = spoken ? cleaned.text : speech.started ? heardDialoguePrefix(cleaned.text, heardChars) : ''
          job.speech = undefined
          const pause = !withdrawn && !spoken
          const pauseReason: AgentDialoguePauseReason = response.kind === 'unreachable' ? 'voice_unavailable'
            : response.kind === 'refused' ? 'voice_refused' : receipt?.outcome === 'interrupted' ? 'speech_interrupted' : 'speech_dropped'
          if (!text) return { kind: 'failed', failure: { layer: 'chat-delivery', phase: 'artifact-publication', serviceCode: 'voice_reply_not_heard', retryable: true }, value: { disposition: 'discarded', pause, ...(pause ? { pauseReason } : {}) } }
          const message: ChatMessage = { ...speech.message, text, ...(spoken ? {} : { cutOff: { heardChars } }) }
          return { kind: 'publish', assistantMessageId: message.id, text, persist: () => this.append(record, message), value: { disposition: 'reply', pause, ...(pause ? { pauseReason } : {}) } }
        },
      })
    } finally {
      job.controller.signal.removeEventListener('abort', onAbort)
      if (channelOpened) { hub.publish(channelId, { type: 'final', replyId, reason: 'completed' }); hub.closeChannel(channelId) }
    }
  }

  private remainingBudget(job: DialogueJob): number | undefined {
    const minutes = job.record.limits.maxMinutes
    if (minutes === undefined) return undefined
    const elapsed = job.runningSince === undefined ? 0 : Math.max(0, this.clock.now() - job.runningSince)
    return Math.max(0, minutes * 60_000 - job.record.limits.runningMs - elapsed)
  }

  private requireOpen(): void {
    if (this.closing) throw new ServiceError('conflict', 'The app is shutting down')
  }

  private startRunning(job: DialogueJob): void {
    if (!job.ready) return
    job.runningSince = this.clock.now()
    this.armRunningBudget(job)
  }

  private armRunningBudget(job: DialogueJob): void {
    const remaining = this.remainingBudget(job)
    if (remaining === undefined) return
    job.cancelBudget = this.clock.schedule(() => {
      if ((this.remainingBudget(job) ?? 0) > 0) {
        this.armRunningBudget(job)
        return
      }
      job.record = this.freezeRunning(job, { ...job.record, status: 'ended', endReason: 'time_limit', epoch: job.record.epoch + 1 })
      job.controller.abort()
      if (job.speech && !job.speech.started) {
        job.speech.withdrawnHeardChars = 0
        job.speech.controller.abort()
      }
      this.cancelVoiceReserve(job)
      job.wake?.()
    }, Math.min(remaining, MAX_TIMER_DELAY_MS))
  }

  private freezeRunning(job: DialogueJob, record: AgentDialogueRecord): AgentDialogueRecord {
    job.cancelBudget?.()
    job.cancelBudget = undefined
    const elapsed = job.runningSince === undefined ? 0 : Math.max(0, this.clock.now() - job.runningSince)
    job.runningSince = undefined
    const runningMs = record.limits.runningMs + elapsed
    return { ...record, limits: { ...record.limits, runningMs: record.limits.maxMinutes === undefined ? runningMs : Math.min(runningMs, record.limits.maxMinutes * 60_000) } }
  }

  private async finish(job: DialogueJob): Promise<void> {
    await withFileMutationLock(job.record.dialogueId, async () => {
      if (job.record.events.some((event) => event.type === 'ended')) return
      await this.persistEvent(job, { type: 'ended', status: job.record.status, ...whenDefined(job.record.endReason, (endReason) => ({ endReason })) })
    })
  }

  private async append(record: AgentDialogueRecord, message: ChatMessage): Promise<void> {
    const outcome = await this.options.sessionStore.appendChatMessageIfAbsent(record.sessionId, message)
    if (outcome !== 'appended' && outcome !== 'already-present') throw new ServiceError('internal', `Could not save dialogue message (${outcome})`)
  }

  private ownedJob(sessionId: string, dialogueId: string): DialogueJob | undefined {
    const job = this.jobs.get(dialogueId)
    if (job && job.record.sessionId !== sessionId) throw new ServiceError('not_found', 'Dialogue not found')
    return job
  }

  private async durableControlRecord(sessionId: string, dialogueId: string): Promise<AgentDialogueRecord & { status: Exclude<AgentDialogueRecord['status'], 'running' | 'paused'> }> {
    const record = await this.get(sessionId, dialogueId)
    if (!record) throw new ServiceError('not_found', 'Dialogue not found')
    if (record.status === 'running' || record.status === 'paused') throw new ServiceError('conflict', 'This dialogue has no running job')
    return { ...record, status: record.status }
  }

  private async event(job: DialogueJob, event: Omit<AgentDialogueEvent, 'sequence' | 'createdAt'>, update?: (record: AgentDialogueRecord) => AgentDialogueRecord): Promise<AgentDialogueRecord> {
    return withFileMutationLock(job.record.dialogueId, async () => {
      if (update) job.record = update(job.record)
      await this.persistEvent(job, event)
      return job.record
    })
  }

  private async persistEvent(job: DialogueJob, event: Omit<AgentDialogueEvent, 'sequence' | 'createdAt'>): Promise<void> {
    const createdAt = new Date().toISOString()
    job.record = { ...job.record, updatedAt: createdAt, events: [...job.record.events, { ...event, createdAt, sequence: job.record.events.length }] }
    if (!await this.store.save(job.record)) throw new ServiceError('not_found', 'Chat not found')
    for (const notify of job.listeners) notify()
  }
}
