import {
  toCanonicalJsonObject,
  type CanonicalJsonObject,
} from '../../contracts/canonical-json.js'
import type { ExecutionJournalEvent } from '../../contracts/execution-journal.js'
import { WEB_EVIDENCE_PROVIDER_ROUTES } from './web-evidence-rollout.js'

/**
 * The `web.evidence.validation` domain stream on the canonical execution
 * journal (plan §6.3, ADR
 * `2026-08-26-Web-Evidence-Rollout-And-Validation-Telemetry`).
 *
 * Shadow rollout needs rates, not provider prose. Every field on this stream
 * is content-free by construction: closed unions, counts, booleans, and one
 * duration. The question, answer, URLs, titles, source content, excerpts,
 * receipt IDs, prompts, model output, headers, and credentials are not
 * representable here, and the builder picks only its declared keys so even a
 * caller that smuggles them past the type boundary cannot record them.
 *
 * The module is deliberately pure — no filesystem, no registry, no journal
 * handle. `services/` owns those.
 */

export const WEB_EVIDENCE_VALIDATION_STREAM_KIND = 'web.evidence.validation'
export const WEB_EVIDENCE_VALIDATION_PAYLOAD_SCHEMA_VERSION = 1
export const WEB_EVIDENCE_VALIDATION_RECORDED_EVENT_TYPE =
  'web.evidence.validation.recorded'

/**
 * `claims` is reserved for Capability B and rejected on write until that ADR
 * exists: a stage nobody implements must not be recordable, or shadow
 * telemetry could claim coverage it never measured.
 */
export const WEB_EVIDENCE_VALIDATION_STAGES = ['links'] as const
export type WebEvidenceValidationStage =
  (typeof WEB_EVIDENCE_VALIDATION_STAGES)[number]

export const WEB_EVIDENCE_VALIDATION_MODES = ['shadow', 'enforce'] as const
export type WebEvidenceValidationMode =
  (typeof WEB_EVIDENCE_VALIDATION_MODES)[number]

export const WEB_EVIDENCE_LEGACY_DECISIONS = ['accepted', 'insufficient'] as const
export type WebEvidenceLegacyDecision =
  (typeof WEB_EVIDENCE_LEGACY_DECISIONS)[number]

export const WEB_EVIDENCE_VALIDATION_DECISIONS = [
  'accepted',
  'answer_empty',
  'answer_declared_insufficient',
  'unobserved_url',
  'not_enough_relevant_sources',
] as const
export type WebEvidenceValidationDecision =
  (typeof WEB_EVIDENCE_VALIDATION_DECISIONS)[number]

export interface WebEvidenceValidationInput {
  readonly stage: WebEvidenceValidationStage
  /** The effective rollout mode this validation ran under. */
  readonly mode: WebEvidenceValidationMode
  readonly providerKind: string
  readonly providerRoute: (typeof WEB_EVIDENCE_PROVIDER_ROUTES)[number]
  readonly observedUrlCount: number
  readonly citedUrlCount: number
  readonly unobservedUrlCount: number
  /** What the current guard decided for the same candidate. */
  readonly legacyDecision: WebEvidenceLegacyDecision
  /** The Capability A outcome code. */
  readonly decision: WebEvidenceValidationDecision
  /**
   * What the display stream actually showed differs from the candidate. On
   * the native shadow route that is the candidate itself (published by the
   * adapter before validation), so this stays false even when persistence
   * rewrote the answer — the §8.2 display-stream metric must be about the
   * display stream. Routes with no observer publication report the persisted
   * text, whose one final publication is what the user sees.
   */
  readonly displayedDiffersFromCandidate: boolean
  /** The text returned for persistence differs from the candidate. */
  readonly persistedDiffersFromCandidate: boolean
  /** The enforced outcome differs from the legacy guard's answer. */
  readonly enforcementWouldDiffer: boolean
  readonly durationMs: number
}

export class WebEvidenceValidationPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebEvidenceValidationPayloadError'
  }
}

/**
 * One event per validated turn. Identity is derived, not minted, so a retry
 * of the same validation is `already-accepted` and a changed one fails closed.
 */
export function webEvidenceValidationEventId(
  assignmentId: string,
  turnId: string,
): string {
  return `${assignmentId}:web-evidence-validation:${turnId}`
}

export function buildWebEvidenceValidationPayload(
  input: WebEvidenceValidationInput,
): CanonicalJsonObject {
  requireMember(input.stage, WEB_EVIDENCE_VALIDATION_STAGES, 'stage')
  requireMember(input.mode, WEB_EVIDENCE_VALIDATION_MODES, 'mode')
  requireIdentity(input.providerKind, 'providerKind')
  requireMember(input.providerRoute, WEB_EVIDENCE_PROVIDER_ROUTES, 'providerRoute')
  requireCount(input.observedUrlCount, 'observedUrlCount')
  requireCount(input.citedUrlCount, 'citedUrlCount')
  requireCount(input.unobservedUrlCount, 'unobservedUrlCount')
  requireMember(input.legacyDecision, WEB_EVIDENCE_LEGACY_DECISIONS, 'legacyDecision')
  requireMember(input.decision, WEB_EVIDENCE_VALIDATION_DECISIONS, 'decision')
  requireCount(input.durationMs, 'durationMs')
  return toCanonicalJsonObject({
    stage: input.stage,
    mode: input.mode,
    providerKind: input.providerKind,
    providerRoute: input.providerRoute,
    observedUrlCount: input.observedUrlCount,
    citedUrlCount: input.citedUrlCount,
    unobservedUrlCount: input.unobservedUrlCount,
    legacyDecision: input.legacyDecision,
    decision: input.decision,
    displayedDiffersFromCandidate: input.displayedDiffersFromCandidate,
    persistedDiffersFromCandidate: input.persistedDiffersFromCandidate,
    enforcementWouldDiffer: input.enforcementWouldDiffer,
    durationMs: input.durationMs,
  })
}

/**
 * Strict on every field this domain writes; tolerant of keys it does not, so
 * a later schema version's extra counters do not read as corruption. Required
 * fields that fail validation make the whole payload unreadable rather than
 * partially trusted.
 */
export function readWebEvidenceValidationPayload(
  value: unknown,
): WebEvidenceValidationInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const stage = member(record.stage, WEB_EVIDENCE_VALIDATION_STAGES)
  const mode = member(record.mode, WEB_EVIDENCE_VALIDATION_MODES)
  const providerKind = identity(record.providerKind)
  const providerRoute = member(record.providerRoute, WEB_EVIDENCE_PROVIDER_ROUTES)
  const observedUrlCount = count(record.observedUrlCount)
  const citedUrlCount = count(record.citedUrlCount)
  const unobservedUrlCount = count(record.unobservedUrlCount)
  const legacyDecision = member(record.legacyDecision, WEB_EVIDENCE_LEGACY_DECISIONS)
  const decision = member(record.decision, WEB_EVIDENCE_VALIDATION_DECISIONS)
  const durationMs = count(record.durationMs)
  if (
    !stage ||
    !mode ||
    !providerKind ||
    !providerRoute ||
    observedUrlCount === undefined ||
    citedUrlCount === undefined ||
    unobservedUrlCount === undefined ||
    !legacyDecision ||
    !decision ||
    durationMs === undefined ||
    typeof record.displayedDiffersFromCandidate !== 'boolean' ||
    typeof record.persistedDiffersFromCandidate !== 'boolean' ||
    typeof record.enforcementWouldDiffer !== 'boolean'
  ) {
    return null
  }
  return {
    stage,
    mode,
    providerKind,
    providerRoute,
    observedUrlCount,
    citedUrlCount,
    unobservedUrlCount,
    legacyDecision,
    decision,
    displayedDiffersFromCandidate: record.displayedDiffersFromCandidate,
    persistedDiffersFromCandidate: record.persistedDiffersFromCandidate,
    enforcementWouldDiffer: record.enforcementWouldDiffer,
    durationMs,
  }
}

/**
 * The rollout-evidence view of one assignment's validations. Rows that fail
 * the reader are counted, never silently dropped: a cohort with unreadable
 * telemetry is incomplete evidence, and promotion decisions need to see that.
 */
export interface WebEvidenceValidationSummary {
  readonly recordedCount: number
  readonly acceptedCount: number
  readonly insufficientCount: number
  readonly wouldDifferCount: number
  readonly invalidCount: number
  readonly byDecision: Readonly<Record<string, number>>
}

export function reduceWebEvidenceValidationEvents(
  events: readonly ExecutionJournalEvent[],
): WebEvidenceValidationSummary {
  let acceptedCount = 0
  let insufficientCount = 0
  let wouldDifferCount = 0
  let invalidCount = 0
  const byDecision: Record<string, number> = {}
  for (const event of events) {
    if (event.streamKind !== WEB_EVIDENCE_VALIDATION_STREAM_KIND) continue
    if (event.type !== WEB_EVIDENCE_VALIDATION_RECORDED_EVENT_TYPE) {
      invalidCount += 1
      continue
    }
    const payload = readWebEvidenceValidationPayload(event.payload)
    if (!payload) {
      invalidCount += 1
      continue
    }
    if (payload.decision === 'accepted') acceptedCount += 1
    else insufficientCount += 1
    if (payload.enforcementWouldDiffer) wouldDifferCount += 1
    byDecision[payload.decision] = (byDecision[payload.decision] ?? 0) + 1
  }
  return {
    recordedCount: acceptedCount + insufficientCount,
    acceptedCount,
    insufficientCount,
    wouldDifferCount,
    invalidCount,
    byDecision,
  }
}

/**
 * One rollout cohort's evidence: a provider kind, provider route, and rollout
 * mode. These are the dimensions the §8.2 shadow review rates — `unobserved_url`
 * frequency and would-change rate mean nothing aggregated across providers that
 * fail in different ways.
 */
export interface WebEvidenceValidationCohort {
  readonly providerKind: string
  readonly providerRoute: string
  readonly mode: WebEvidenceValidationMode
  readonly recordedCount: number
  readonly acceptedCount: number
  readonly insufficientCount: number
  readonly wouldDifferCount: number
  readonly byDecision: Readonly<Record<string, number>>
}

/**
 * The operator reading of one assignment's validation events, aggregated by
 * cohort. Sorted so the report is a pure function of the journal, and carrying
 * `invalidCount` separately because unreadable rows are incomplete evidence,
 * never silent zeros.
 */
export interface WebEvidenceValidationCohortSummary {
  readonly recordedCount: number
  readonly invalidCount: number
  readonly cohorts: readonly WebEvidenceValidationCohort[]
}

export function summarizeWebEvidenceValidationCohorts(
  events: readonly ExecutionJournalEvent[],
): WebEvidenceValidationCohortSummary {
  interface MutableCohort {
    recordedCount: number
    acceptedCount: number
    insufficientCount: number
    wouldDifferCount: number
    byDecision: Record<string, number>
  }
  const cohortsByKey = new Map<string, MutableCohort & {
    readonly providerKind: string
    readonly providerRoute: string
    readonly mode: WebEvidenceValidationMode
  }>()
  let recordedCount = 0
  let invalidCount = 0
  for (const event of events) {
    if (event.streamKind !== WEB_EVIDENCE_VALIDATION_STREAM_KIND) continue
    if (event.type !== WEB_EVIDENCE_VALIDATION_RECORDED_EVENT_TYPE) {
      invalidCount += 1
      continue
    }
    const payload = readWebEvidenceValidationPayload(event.payload)
    if (!payload) {
      invalidCount += 1
      continue
    }
    recordedCount += 1
    const key = `${payload.providerKind}${payload.providerRoute}${payload.mode}`
    let cohort = cohortsByKey.get(key)
    if (!cohort) {
      cohort = {
        providerKind: payload.providerKind,
        providerRoute: payload.providerRoute,
        mode: payload.mode,
        recordedCount: 0,
        acceptedCount: 0,
        insufficientCount: 0,
        wouldDifferCount: 0,
        byDecision: {},
      }
      cohortsByKey.set(key, cohort)
    }
    cohort.recordedCount += 1
    if (payload.decision === 'accepted') cohort.acceptedCount += 1
    else cohort.insufficientCount += 1
    if (payload.enforcementWouldDiffer) cohort.wouldDifferCount += 1
    cohort.byDecision[payload.decision] =
      (cohort.byDecision[payload.decision] ?? 0) + 1
  }
  const cohorts = [...cohortsByKey.values()].sort((left, right) =>
    left.providerKind !== right.providerKind
      ? left.providerKind < right.providerKind ? -1 : 1
      : left.providerRoute !== right.providerRoute
        ? left.providerRoute < right.providerRoute ? -1 : 1
        : left.mode < right.mode ? -1 : left.mode > right.mode ? 1 : 0,
  )
  return { recordedCount, invalidCount, cohorts }
}

function requireMember<T extends string>(
  value: T,
  allowed: readonly T[],
  field: string,
): void {
  if (!allowed.includes(value)) {
    throw new WebEvidenceValidationPayloadError(
      `${field} must be one of ${allowed.map((member) => `'${member}'`).join(', ')}`,
    )
  }
}

function requireIdentity(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WebEvidenceValidationPayloadError(`${field} must be a non-empty string`)
  }
}

function requireCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WebEvidenceValidationPayloadError(
      `${field} must be a non-negative integer`,
    )
  }
}

function member<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

function identity(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}
