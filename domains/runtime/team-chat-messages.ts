/**
 * The one place a Team chat run records an accepted answer.
 *
 * Every engine decides for itself when an agent's output is accepted — a chain
 * only after canonicalization and its BLOCKED check, a review only after its
 * verdict parses — but none of them should own what durable means. That split
 * is the point of this module: engines decide *whether*, this decides *what is
 * written* and *what is announced*, so a reader sees the same kind of message
 * whichever engine produced it.
 *
 * Three rules are enforced here rather than at each call site.
 *
 * - **Identity, not repetition, decides duplication.** A reconnect, a replay,
 *   and a recovery process all re-walk work that already happened. The
 *   attempt's identity is what makes the second pass recognisable as the same
 *   message, so it is read back from disk rather than held only in memory.
 * - **Two logs, reconciled, not assumed.** The prose lives in this run's own
 *   transcript file; the reader's copy is the `team.message` event in the
 *   assignment journal. Writing both is not atomic, so a process that died
 *   between them leaves a record with no event — and a dedupe that trusted the
 *   record alone would make that reader's message permanently missing. Both
 *   are therefore checked, and whichever is absent is written.
 * - **Only the accepted text is persisted.** The record carries the contract's
 *   fields and nothing else, so hidden reasoning, provider payloads, prompts,
 *   and credentials have nowhere to land even if a caller passes more.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  TEAM_CHAT_MESSAGE_EVENT_TYPE,
  isTeamChatMessagePayload,
  teamChatMessageId,
  type TeamChatMessagePayload,
} from '../../contracts/team-chat-messages.js'
import { whenDefined } from '../../core/optional-properties.js'
import {
  publishEngineEvent,
  readAnnouncedEventPayloads,
} from './runtime-events.js'

const TEAM_CHAT_MESSAGE_LOG_FILENAME = 'team-chat-messages.jsonl'

/** The default category for an ordinary agent contribution. */
const DEFAULT_MESSAGE_TYPE = 'position'

/**
 * What became of one attempted publication.
 *
 * Spelled out rather than reduced to a boolean because callers act on the
 * difference. `disabled` is the only value that means "Team chat does not own
 * this message"; every other value means it does, whether or not this
 * particular call wrote anything. A caller that read a bare `false` as
 * permission to publish its own legacy event would emit a duplicate on exactly
 * the replay this module exists to survive.
 */
export type TeamChatMessageOutcome =
  /** This run does not record Team chat messages. */
  | 'disabled'
  /** Recorded and announced for the first time. */
  | 'published'
  /** The record existed but its event did not; the event was written. */
  | 'reconciled'
  /** Already recorded and already announced. */
  | 'duplicate'
  /** A Team chat run, but this contribution had no identity or no text. */
  | 'unrecordable'

export interface TeamChatMessagePublication {
  readonly agentName: string
  readonly assignmentPath: string
  /**
   * The attempt that produced this text.
   *
   * Required: without it two runs of the same agent are indistinguishable, and
   * a replay would either duplicate the message or hide a genuine retry.
   */
  readonly dispatchId: string
  readonly runId: string
  readonly stageId: string
  readonly stageType: string
  readonly text: string
  readonly messageType?: string
  readonly parentRunId?: string
  readonly rootRunId?: string
  readonly team?: string
  readonly timestamp?: string
}

export function teamChatMessageLogPath(assignmentPath: string): string {
  return path.join(assignmentPath, 'logs', TEAM_CHAT_MESSAGE_LOG_FILENAME)
}

/**
 * The messages this run has already recorded.
 *
 * A line that does not parse, or that does not carry the whole contract, is
 * skipped rather than thrown: a damaged tail must not hide the messages before
 * it, and it must certainly not end the run that is still writing them.
 */
export function readTeamChatMessages(
  assignmentPath: string,
): TeamChatMessagePayload[] {
  const logPath = teamChatMessageLogPath(assignmentPath)
  if (!fs.existsSync(logPath)) return []
  return readJsonlLines(logPath).flatMap((parsed) =>
    isTeamChatMessagePayload(parsed) ? [parsed] : [],
  )
}

/**
 * The message the reader's transcript already carries, if any.
 *
 * Read from the assignment journal rather than from the transcript file,
 * because this is the log the run store replays into the UI: a message the
 * journal never received is one the reader never saw, whatever the transcript
 * says. The payload comes back whole, not just its identity, so a lost
 * transcript record can be restored to what was actually shown.
 */
function readAnnouncedMessage(
  assignmentPath: string,
  messageId: string,
): TeamChatMessagePayload | undefined {
  for (const payload of readAnnouncedEventPayloads(
    assignmentPath,
    TEAM_CHAT_MESSAGE_EVENT_TYPE,
  )) {
    if (isTeamChatMessagePayload(payload) && payload.message_id === messageId) {
      return payload
    }
  }
  return undefined
}

/**
 * Record one accepted contribution, and say what became of it.
 *
 * An attempt with no visible text is `unrecordable`: a step that said nothing
 * has no message, and inventing an empty one would put a nameless bubble in
 * the transcript.
 */
export function publishTeamChatMessage(
  publication: TeamChatMessagePublication,
): TeamChatMessageOutcome {
  const text = publication.text.trim()
  if (!text) return 'unrecordable'

  const messageId = teamChatMessageId({
    runId: publication.runId,
    dispatchId: publication.dispatchId,
  })
  const payload: TeamChatMessagePayload = {
    agent_name: publication.agentName,
    dispatch_id: publication.dispatchId,
    message_id: messageId,
    message_type: publication.messageType ?? DEFAULT_MESSAGE_TYPE,
    run_id: publication.runId,
    stage_id: publication.stageId,
    text,
    timestamp: publication.timestamp ?? new Date().toISOString(),
  }
  if (!isTeamChatMessagePayload(payload)) return 'unrecordable'

  const recorded = readTeamChatMessages(publication.assignmentPath).find(
    (record) => record.message_id === messageId,
  )
  const announced = readAnnouncedMessage(publication.assignmentPath, messageId)
  if (recorded && announced) return 'duplicate'

  // Whichever log still holds this message is the answer of record. A replay
  // reaching either gap with drifted text or a new clock must not write a
  // different answer under an identity that is already settled — in either
  // direction, or the two logs end up disagreeing about what the agent said.
  const canonical = recorded ?? announced ?? payload

  if (!recorded) {
    const logPath = teamChatMessageLogPath(publication.assignmentPath)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, `${JSON.stringify(canonical)}\n`)
  }

  if (!announced) {
    publishEngineEvent(publication.assignmentPath, {
      timestamp: canonical.timestamp,
      category: 'stage',
      type: TEAM_CHAT_MESSAGE_EVENT_TYPE,
      run_id: canonical.run_id,
      ...whenDefined(publication.rootRunId, (root_run_id) => ({ root_run_id })),
      ...whenDefined(publication.parentRunId, (parent_run_id) => ({
        parent_run_id,
      })),
      assignment_path: publication.assignmentPath,
      team: publication.team ?? null,
      level_id: canonical.stage_id,
      stage_type: publication.stageType,
      payload: canonical,
    })
  }

  return recorded || announced ? 'reconciled' : 'published'
}

/**
 * The Team-chat facts an engine already holds.
 *
 * Structural on purpose: the engine contexts differ, and none of them should
 * have to be imported here for the runtime foundation to record a message.
 * `chatMode` arrives on the context from the runtime shell, so no engine reads
 * process-global state to decide whether it is running in chat.
 */
export interface TeamChatMessageScope {
  readonly chatMode?: boolean
  readonly levelId: string
  readonly outputPath: string
  readonly teamName?: string
  readonly state: {
    readonly sessionId: string
    readonly parentSessionId?: string
    readonly rootSessionId?: string
  }
}

export interface TeamChatContribution {
  readonly agentName: string
  /** Absent only when the engine had no attempt identity to name. */
  readonly dispatchId?: string
  readonly stageType: string
  readonly text: string
  readonly messageType?: string
}

/**
 * Record a contribution an engine has already accepted.
 *
 * Two refusals live here rather than at six call sites. A Team running outside
 * chat keeps its existing output contract untouched, and a contribution with
 * no attempt identity is left to the live preview: recording it would create a
 * message that no replay could recognise as one it had already seen. The two
 * are distinguishable in the result, because only the first means the caller
 * still owns the message.
 */
export function publishAcceptedTeamChatMessage(
  scope: TeamChatMessageScope,
  contribution: TeamChatContribution,
): TeamChatMessageOutcome {
  if (!scope.chatMode) return 'disabled'
  if (!contribution.dispatchId) return 'unrecordable'

  return publishTeamChatMessage({
    agentName: contribution.agentName,
    assignmentPath: scope.outputPath,
    dispatchId: contribution.dispatchId,
    runId: scope.state.sessionId,
    stageId: scope.levelId,
    stageType: contribution.stageType,
    text: contribution.text,
    ...whenDefined(contribution.messageType, (messageType) => ({ messageType })),
    ...whenDefined(scope.state.parentSessionId, (parentRunId) => ({
      parentRunId,
    })),
    ...whenDefined(scope.state.rootSessionId, (rootRunId) => ({ rootRunId })),
    ...whenDefined(scope.teamName, (team) => ({ team })),
  })
}

function readJsonlLines(filePath: string): unknown[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const trimmed = line.trim()
      if (!trimmed) return []
      try {
        const parsed: unknown = JSON.parse(trimmed)
        return [parsed]
      } catch {
        return []
      }
    })
}
