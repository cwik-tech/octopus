import { whenDefined } from '../core/optional-properties.js'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type {
  DeepResearchPlanFinding,
  DeepResearchPlanningAttemptSnapshot,
  DeepResearchPlanningAttemptStatus,
  DeepResearchPlanningErrorCategory,
  DeepResearchPlanningEvent,
  DeepResearchPlanningPhase,
  DeepResearchPlanningRoute,
} from '../contracts/deep-research-planning.js'
import {
  isDeepResearchPlanningAttemptSnapshot,
  isDeepResearchPlanningEvent,
  isTerminalDeepResearchPlanningStatus,
} from '../contracts/deep-research-planning.js'
import {
  withFileMutationLock,
  writeFileAtomic,
} from '../core/file-mutation.js'
import {
  isSafePathSegment,
  resolveRelativePathInside,
} from '../core/path-safety.js'
import type { ThinkingLevel } from '../core/types.js'
import type { SessionStore } from '../domains/sessions/session-store.js'

export type DeepResearchPlanningStage =
  | 'queue'
  | 'terra'
  | 'draft_validation'
  | 'sol'
  | 'final_validation'
  | 'persistence'

type CandidateStage = 'terra' | 'sol'
type TerminalAttemptStatus = Exclude<
  DeepResearchPlanningAttemptStatus,
  'queued' | 'running' | 'cancelling'
>

interface StoredAttemptState extends DeepResearchPlanningAttemptSnapshot {
  events: DeepResearchPlanningEvent[]
  diagnosticError?: string
}

interface AttemptLocation {
  sessionId: string
  sessionStore: SessionStore
  attemptId: string
}

interface TerminalAttemptDetails {
  error?: string
  diagnosticError?: string
  errorCategory?: DeepResearchPlanningErrorCategory
  finalProposalHash?: string
  finalRunPlanId?: string
  complexityClass?: 'simple' | 'standard' | 'complex'
  reviewOutcome?: 'not_run' | 'affirmed' | 'changed' | 'replaced'
  retryable?: boolean
}

export interface DeepResearchPlanAttemptEventPage {
  events: DeepResearchPlanningEvent[]
  snapshot: DeepResearchPlanningAttemptSnapshot
}

export interface DeepResearchPlanAttemptRecorder {
  readonly attemptId: string
  readonly relativePath: string
  outputPath(stage: CandidateStage): string
  snapshot(): DeepResearchPlanningAttemptSnapshot
  setRoute(route: DeepResearchPlanningRoute): Promise<void>
  requestCancellation(): Promise<DeepResearchPlanningAttemptSnapshot>
  beginStage(
    stage: DeepResearchPlanningStage,
    phase: DeepResearchPlanningPhase,
    model?: {
      provider: string
      model: string
      thinking: ThinkingLevel
    },
  ): Promise<void>
  completeStage(stage: DeepResearchPlanningStage): Promise<void>
  recordCandidate(stage: CandidateStage, text: string): Promise<void>
  recordFindings(findings: readonly DeepResearchPlanFinding[]): Promise<void>
  complete(
    status: TerminalAttemptStatus,
    details?: TerminalAttemptDetails,
  ): Promise<DeepResearchPlanningAttemptSnapshot>
}

const MAXIMUM_CANDIDATE_CHARACTERS = 100_000

export async function createDeepResearchPlanAttemptRecorder(params: {
  readonly sessionId: string
  readonly sessionStore: SessionStore
  readonly expectedPlanId: string
  readonly planningRevisionId: string
  readonly sourceProposalHash?: string
  readonly retryCount: number
}): Promise<DeepResearchPlanAttemptRecorder> {
  const attemptId = `attempt-${randomUUID()}`
  const location = { ...params, attemptId }
  const attemptPath = requireAttemptPath(location)
  const relativePath = `research-planning/attempts/${attemptId}`
  const createdAt = new Date().toISOString()
  const initialState: StoredAttemptState = {
    schemaVersion: 3,
    attemptId,
    planningRevisionId: params.planningRevisionId,
    expectedPlanId: params.expectedPlanId,
    revision: 0,
    retryCount: params.retryCount,
    status: 'queued',
    phase: 'accepted',
    route: 'terra_only',
    createdAt,
    updatedAt: createdAt,
    stages: {
      queue: { startedAt: createdAt },
    },
    candidates: {},
    findings: [],
    ...(params.sourceProposalHash
      ? { sourceProposalHash: params.sourceProposalHash }
      : {}),
    events: [],
  }
  initialState.events.push(createStatusEvent(initialState))
  await persistStoredAttemptPath(attemptPath, initialState)
  let latestState = initialState

  const mutateRecorder = async (
    operation: (state: StoredAttemptState) => boolean | Promise<boolean>,
  ): Promise<StoredAttemptState> => {
    const next = await mutateStoredAttempt(location, operation)
    if (!next) throw new Error('Research planning attempt is unavailable')
    latestState = next
    return next
  }

  return {
    attemptId,
    relativePath,
    outputPath: (stage) => path.join(attemptPath, stage),
    snapshot: () => publicSnapshot(latestState),
    async setRoute(route) {
      await mutateRecorder((state) => {
        if (
          state.route === route ||
          isTerminalDeepResearchPlanningStatus(state.status)
        ) {
          return false
        }
        state.route = route
        return true
      })
    },
    async requestCancellation() {
      const state = await mutateRecorder(requestCancellationTransition)
      return publicSnapshot(state)
    },
    async beginStage(stage, phase, model) {
      await mutateRecorder((state) => {
        if (
          state.status === 'cancelling' ||
          isTerminalDeepResearchPlanningStatus(state.status)
        ) {
          return false
        }
        const now = new Date().toISOString()
        if (stage !== 'queue') completeStageTiming(state, 'queue', now)
        state.status = 'running'
        state.phase = phase
        state.stages[stage] = {
          startedAt: now,
          ...(model ?? {}),
        }
        return true
      })
    },
    async completeStage(stage) {
      await mutateRecorder((state) => {
        if (isTerminalDeepResearchPlanningStatus(state.status)) return false
        return completeStageTiming(state, stage, new Date().toISOString())
      })
    },
    async recordCandidate(stage, text) {
      await mutateRecorder(async (state) => {
        if (isTerminalDeepResearchPlanningStatus(state.status)) return false
        const bounded = text.slice(0, MAXIMUM_CANDIDATE_CHARACTERS)
        await writeFileAtomic(
          path.join(attemptPath, stage, 'candidate.txt'),
          bounded,
        )
        state.candidates[stage] = {
          characters: text.length,
          sha256: createHash('sha256').update(text).digest('hex'),
          truncated: bounded.length !== text.length,
        }
        return true
      })
    },
    async recordFindings(findings) {
      await mutateRecorder((state) => appendFindings(state, findings))
    },
    async complete(status, details = {}) {
      const state = await mutateRecorder((candidate) =>
        applyTerminalTransition(candidate, status, details)
      )
      return publicSnapshot(state)
    },
  }
}

export async function readDeepResearchPlanAttempt(
  params: AttemptLocation,
): Promise<DeepResearchPlanningAttemptSnapshot | null> {
  const state = await readStoredAttempt(params)
  return state ? publicSnapshot(state) : null
}

export async function readDeepResearchPlanAttemptEventPage(
  params: AttemptLocation & { fromSequence?: number },
): Promise<DeepResearchPlanAttemptEventPage | null> {
  const state = await readStoredAttempt(params)
  if (!state) return null
  const fromSequence = Math.max(0, params.fromSequence ?? 0)
  return {
    events: structuredClone(
      state.events.filter((event) => event.sequence >= fromSequence),
    ),
    snapshot: publicSnapshot(state),
  }
}

export async function requestDeepResearchPlanAttemptCancellation(
  params: AttemptLocation,
): Promise<DeepResearchPlanningAttemptSnapshot | null> {
  const state = await mutateStoredAttempt(params, requestCancellationTransition)
  return state ? publicSnapshot(state) : null
}

export async function markCancelledDeepResearchPlanAttempt(
  params: AttemptLocation,
): Promise<DeepResearchPlanningAttemptSnapshot | null> {
  const state = await mutateStoredAttempt(params, (candidate) =>
    applyTerminalTransition(candidate, 'cancelled', {
      error: 'Planning was cancelled.',
      errorCategory: 'cancelled',
      retryable: true,
    })
  )
  return state ? publicSnapshot(state) : null
}

export async function markSucceededDeepResearchPlanAttempt(
  params: AttemptLocation & {
    finalProposalHash: string
    finalRunPlanId: string
    complexityClass?: 'simple' | 'standard' | 'complex'
  },
): Promise<DeepResearchPlanningAttemptSnapshot | null> {
  const state = await mutateStoredAttempt(params, (candidate) =>
    applyTerminalTransition(candidate, 'succeeded', {
      finalProposalHash: params.finalProposalHash,
      finalRunPlanId: params.finalRunPlanId,
      ...whenDefined(params.complexityClass, (definedValue) => ({ complexityClass: definedValue })),
      retryable: false,
    })
  )
  return state ? publicSnapshot(state) : null
}

export async function markInterruptedDeepResearchPlanAttempt(
  params: AttemptLocation,
): Promise<DeepResearchPlanningAttemptSnapshot | null> {
  const state = await mutateStoredAttempt(params, (candidate) => {
    if (candidate.status === 'cancelling') {
      return applyTerminalTransition(candidate, 'cancelled', {
        error: 'Planning was cancelled.',
        errorCategory: 'cancelled',
        retryable: true,
      })
    }
    if (candidate.status !== 'queued' && candidate.status !== 'running') {
      return false
    }
    return applyTerminalTransition(candidate, 'failed', {
      error:
        'Planning was interrupted by an application restart. Retry the current revision.',
      errorCategory: 'unknown',
      retryable: true,
    })
  })
  return state ? publicSnapshot(state) : null
}

async function mutateStoredAttempt(
  params: AttemptLocation,
  operation: (state: StoredAttemptState) => boolean | Promise<boolean>,
): Promise<StoredAttemptState | null> {
  const attemptPath = attemptPathFor(params)
  if (!attemptPath) return null
  const filePath = path.join(attemptPath, 'attempt.json')
  return withFileMutationLock(filePath, async () => {
    const state = await readStoredAttemptPath(filePath)
    if (!state) return null
    const changed = await operation(state)
    if (!changed) return state
    state.revision += 1
    state.updatedAt = new Date().toISOString()
    state.events.push(createStatusEvent(state))
    await persistStoredAttemptPath(attemptPath, state)
    return state
  })
}

async function readStoredAttempt(
  params: AttemptLocation,
): Promise<StoredAttemptState | null> {
  const attemptPath = attemptPathFor(params)
  if (!attemptPath) return null
  return readStoredAttemptPath(path.join(attemptPath, 'attempt.json'))
}

async function readStoredAttemptPath(
  filePath: string,
): Promise<StoredAttemptState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
    const migrated = migrateStoredAttempt(parsed)
    if (
      !migrated ||
      !isDeepResearchPlanningAttemptSnapshot(migrated) ||
      !Array.isArray(migrated.events) ||
      !migrated.events.every(isDeepResearchPlanningEvent)
    ) {
      return null
    }
    return migrated
  } catch {
    return null
  }
}

function migrateStoredAttempt(value: unknown): StoredAttemptState | null {
  if (!isRecord(value)) return null
  const migratedEvents = Array.isArray(value.events)
    ? value.events.map(migratePlanningEvent)
    : []
  const events = migratedEvents.filter((event) => event !== null)
  if (events.length !== migratedEvents.length) return null
  const revision = events.length > 0
    ? Math.max(...events.map((event) => event.sequence))
    : 0
  const migrated = migratePlanningSnapshot(value, revision)
  if (!migrated) return null
  return {
    ...migrated,
    events,
    ...(typeof value.diagnosticError === 'string'
      ? { diagnosticError: value.diagnosticError }
      : {}),
  }
}

function migratePlanningEvent(value: unknown): DeepResearchPlanningEvent | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.sequence)) return null
  const sequence = Number(value.sequence)
  const snapshot = migratePlanningSnapshot(value.snapshot, sequence)
  if (
    sequence < 0 ||
    value.type !== 'planning.status' ||
    typeof value.timestamp !== 'string' ||
    !snapshot
  ) {
    return null
  }
  return {
    sequence,
    type: 'planning.status',
    timestamp: value.timestamp,
    snapshot,
  }
}

function migratePlanningSnapshot(
  value: unknown,
  revision: number,
): DeepResearchPlanningAttemptSnapshot | null {
  if (!isRecord(value)) return null
  const candidate = value.schemaVersion === 2
    ? { ...value, schemaVersion: 3, revision }
    : value
  return isDeepResearchPlanningAttemptSnapshot(candidate)
    ? structuredClone(candidate)
    : null
}

async function persistStoredAttemptPath(
  attemptPath: string,
  state: StoredAttemptState,
): Promise<void> {
  await writeFileAtomic(
    path.join(attemptPath, 'attempt.json'),
    `${JSON.stringify(state, null, 2)}\n`,
  )
}

function requestCancellationTransition(state: StoredAttemptState): boolean {
  if (
    state.status === 'cancelling' ||
    isTerminalDeepResearchPlanningStatus(state.status)
  ) {
    return false
  }
  state.status = 'cancelling'
  state.cancellationRequestedAt = new Date().toISOString()
  return true
}

function applyTerminalTransition(
  state: StoredAttemptState,
  status: TerminalAttemptStatus,
  details: TerminalAttemptDetails,
): boolean {
  if (isTerminalDeepResearchPlanningStatus(state.status)) return false
  const completedAt = new Date().toISOString()
  for (const stage of Object.keys(state.stages) as DeepResearchPlanningStage[]) {
    completeStageTiming(state, stage, completedAt)
  }
  state.status = status
  state.completedAt = completedAt
  delete state.retryable
  delete state.errorCategory
  delete state.error
  delete state.diagnosticError
  delete state.finalProposalHash
  delete state.finalRunPlanId
  delete state.complexityClass
  delete state.reviewOutcome
  Object.assign(
    state,
    whenDefined(details.retryable, (retryable) => ({ retryable })),
    whenDefined(details.errorCategory, (errorCategory) => ({ errorCategory })),
    whenDefined(details.error, (error) => ({ error })),
    whenDefined(details.diagnosticError, (diagnosticError) => ({ diagnosticError })),
    whenDefined(details.finalProposalHash, (finalProposalHash) => ({ finalProposalHash })),
    whenDefined(details.finalRunPlanId, (finalRunPlanId) => ({ finalRunPlanId })),
    whenDefined(details.complexityClass, (complexityClass) => ({ complexityClass })),
    whenDefined(details.reviewOutcome, (reviewOutcome) => ({ reviewOutcome })),
  )
  const created = Date.parse(state.createdAt)
  const completed = Date.parse(completedAt)
  const totalDurationMs =
    Number.isFinite(created) && Number.isFinite(completed)
      ? Math.max(0, completed - created)
      : undefined
  delete state.totalDurationMs
  Object.assign(
    state,
    whenDefined(totalDurationMs, (presentTotalDurationMs) => ({
      totalDurationMs: presentTotalDurationMs,
    })),
  )
  if (status === 'succeeded') state.phase = 'ready'
  return true
}

function appendFindings(
  state: StoredAttemptState,
  findings: readonly DeepResearchPlanFinding[],
): boolean {
  if (isTerminalDeepResearchPlanningStatus(state.status)) return false
  const known = new Set(
    state.findings.map((finding) =>
      `${finding.code}\u0000${finding.field}\u0000${finding.diagnostic ?? finding.summary}`
    ),
  )
  let changed = false
  for (const finding of findings) {
    const key =
      `${finding.code}\u0000${finding.field}\u0000${finding.diagnostic ?? finding.summary}`
    if (known.has(key)) continue
    known.add(key)
    state.findings.push({ ...finding })
    changed = true
  }
  return changed
}

function createStatusEvent(
  state: StoredAttemptState,
): DeepResearchPlanningEvent {
  return {
    sequence: state.revision,
    type: 'planning.status',
    timestamp: state.updatedAt,
    snapshot: publicSnapshot(state),
  }
}

function attemptPathFor(params: AttemptLocation): string | null {
  if (!isSafePathSegment(params.attemptId)) return null
  return resolveRelativePathInside(
    sessionRoot(params.sessionStore, params.sessionId),
    `research-planning/attempts/${params.attemptId}`,
  )
}

function requireAttemptPath(params: AttemptLocation): string {
  const attemptPath = attemptPathFor(params)
  if (!attemptPath) {
    throw new Error('Research planner attempt path must stay inside the session')
  }
  return attemptPath
}

function sessionRoot(sessionStore: SessionStore, sessionId: string): string {
  return path.dirname(sessionStore.inputsDir(sessionId))
}

function publicSnapshot(
  state: StoredAttemptState,
): DeepResearchPlanningAttemptSnapshot {
  const {
    diagnosticError: _diagnosticError,
    events: _events,
    findings,
    ...snapshot
  } = state
  return structuredClone({
    ...snapshot,
    findings: findings.map(({ diagnostic: _diagnostic, ...finding }) =>
      finding
    ),
  })
}

function completeStageTiming(
  state: StoredAttemptState,
  stage: DeepResearchPlanningStage,
  completedAt: string,
): boolean {
  const timing = state.stages[stage]
  if (!timing || timing.completedAt) return false
  const started = Date.parse(timing.startedAt)
  const completed = Date.parse(completedAt)
  const durationMs = Number.isFinite(started) && Number.isFinite(completed)
    ? Math.max(0, completed - started)
    : undefined
  state.stages[stage] = {
    ...timing,
    completedAt,
    ...whenDefined(durationMs, (presentDurationMs) => ({ durationMs: presentDurationMs })),
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
