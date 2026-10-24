/**
 * Ephemeral agent text stream — display-only frame contract.
 *
 * ADR: `docs/adr/2026-08-22-Ephemeral-Agent-Text-Stream.md`.
 *
 * These frames are a preview of text that the durable record will carry a
 * moment later. They are deliberately NOT `EngineEventEnvelope`s: that envelope
 * requires `tenant_id` and a category from a closed set, and the run-event
 * client kills its connection on anything failing that guard. Keeping this
 * vocabulary separate is what lets a frame be lossy without touching the frozen
 * engine-event contract.
 *
 * Three shapes live here:
 *   - `AgentTextStreamInput`    what a producer submits (no cursor yet)
 *   - `AgentTextStreamFrame`    what the ring holds (cursor assigned)
 *   - `AgentTextStreamDelivery` what an SSE client must be able to parse
 *
 * Near-leaf module: the only import is a sibling contract, per the
 * contracts-leaf architecture rule. Nothing outside `contracts/` is reachable
 * from here.
 */

import {
  readModelSelectionRecord,
  type ModelSelectionRecord,
} from './agent-model-selection.js'
import { agentProgressSnapshotSchema, type AgentProgressSnapshot } from './agent-progress.js'

export type AgentTextChannel = 'text' | 'reasoning'

export type AgentTextFinalReason = 'completed' | 'truncated' | 'awaiting_input'

/** Fields every producer-submitted frame carries. */
export interface AgentTextStreamInputBase {
  /** `replyId` for chat (`${speakerId}:${ordinal}`) or `dispatchId` for runs. */
  readonly replyId: string
  /**
   * Producer-local, per-`replyId` sequence used ONLY for cross-process dedupe.
   * Never used for delivery or resume — that is the hub-assigned cursor.
   * Omitted entirely on the in-process chat path, where nothing can duplicate.
   */
  readonly producerSequence?: number
}

export interface AgentTextDeltaInput extends AgentTextStreamInputBase {
  readonly type: 'delta'
  readonly channel: AgentTextChannel
  /** The new suffix only, never the running total. */
  readonly text: string
}

export interface AgentTextFinalInput extends AgentTextStreamInputBase {
  readonly type: 'final'
  readonly reason: AgentTextFinalReason
}

/**
 * The provider and model this reply was admitted on, and how they were decided.
 *
 * Published once, before the provider is called, so the reply in progress can
 * name the pair it was admitted on without waiting for the first token. The
 * selection's own `source` tells default use from an explicit choice. The
 * authority is the durable record written on the turn; this frame is a preview
 * like every other frame in this contract, and losing it costs the live label
 * and nothing else.
 */
export interface AgentTextSelectionInput extends AgentTextStreamInputBase {
  readonly type: 'selection'
  /**
   * Durable id of the speaker this selection belongs to, such as
   * `general-agent`, not its display label. Readers match a selection to its
   * reply by `replyId`.
   */
  readonly speaker: string
  readonly selection: ModelSelectionRecord
}

export interface AgentTextErrorInput extends AgentTextStreamInputBase {
  readonly type: 'error'
  /** Display-safe text. Never a raw provider payload. */
  readonly message: string
}

export interface AgentTextProgressInput extends AgentTextStreamInputBase {
  readonly type: 'progress'
  readonly progress: AgentProgressSnapshot
}

export type AgentTextStreamInput =
  | AgentTextProgressInput
  | AgentTextDeltaInput
  | AgentTextFinalInput
  | AgentTextErrorInput
  | AgentTextSelectionInput

/** Fields the hub stamps onto every accepted input. */
export interface AgentTextStreamFrameIdentity {
  readonly channelId: string
  /** Channel-global, strictly monotonic from 0. Assigned by the hub. */
  readonly cursor: number
}

/**
 * A hole discovered inside the sequence, at publication time.
 *
 * Hub-originated. Occupies a real ring position, because the loss is found
 * while the sequence is still being extended. Its range is in `producerSequence`
 * space, not cursor space: the missing frames never received cursors.
 */
export interface AgentTextGapFrame {
  readonly type: 'gap'
  readonly channelId: string
  readonly cursor: number
  /** Absent means the whole channel is affected. */
  readonly replyId?: string
  readonly missingProducerFrom: number
  readonly missingProducerTo: number
}

export type AgentTextStreamFrame =
  | (AgentTextProgressInput & AgentTextStreamFrameIdentity)
  | (AgentTextDeltaInput & AgentTextStreamFrameIdentity)
  | (AgentTextFinalInput & AgentTextStreamFrameIdentity)
  | (AgentTextErrorInput & AgentTextStreamFrameIdentity)
  | (AgentTextSelectionInput & AgentTextStreamFrameIdentity)
  | AgentTextGapFrame

/**
 * The subscriber's position has aged out of the ring, discovered at replay time.
 *
 * Route-originated and never a ring member, so it carries no cursor. It is sent
 * as a prelude with no SSE `id:`, which leaves the client's last-event-id
 * untouched and keeps ids strictly monotonic. A ring-member frame could not do
 * this: it would need a cursor greater than the range it warns about, yet must
 * be delivered before the retained frames.
 */
export interface AgentTextResetControl {
  readonly type: 'reset'
  readonly channelId: string
  readonly requestedFromCursor: number
  readonly retainedFromCursor: number
  readonly reason: 'evicted'
}

export type AgentTextStreamDelivery =
  | AgentTextStreamFrame
  | AgentTextResetControl
  | AgentProgressSnapshotControl

/** Replay metadata has no SSE cursor and cannot conceal missing answer text. */
export interface AgentProgressSnapshotControl {
  readonly type: 'progress-snapshot'
  readonly channelId: string
  readonly replyId: string
  readonly progress: AgentProgressSnapshot
}

// ─── Guards ─────────────────────────────────────────────────────────────────
//
// Exact-shape guards. An unexpected key is a rejection, not an ignored extra:
// a `final` carrying `text` and a `reset` carrying `cursor` are exactly the
// cross-shaped frames this contract exists to make impossible.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** True when `value` has no key outside `allowed`. */
function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return false
  }
  return true
}

function hasValidProducerSequence(value: Record<string, unknown>): boolean {
  return value.producerSequence === undefined || isCursor(value.producerSequence)
}

const DELTA_INPUT_KEYS = ['type', 'replyId', 'producerSequence', 'channel', 'text'] as const
const FINAL_INPUT_KEYS = ['type', 'replyId', 'producerSequence', 'reason'] as const
const ERROR_INPUT_KEYS = ['type', 'replyId', 'producerSequence', 'message'] as const
const SELECTION_INPUT_KEYS = [
  'type',
  'replyId',
  'producerSequence',
  'speaker',
  'selection',
] as const
const IDENTITY_KEYS = ['channelId', 'cursor'] as const
const GAP_KEYS = [
  'type',
  'channelId',
  'cursor',
  'replyId',
  'missingProducerFrom',
  'missingProducerTo',
] as const
const RESET_KEYS = [
  'type',
  'channelId',
  'requestedFromCursor',
  'retainedFromCursor',
  'reason',
] as const

function isInputBody(
  value: Record<string, unknown>,
  extraAllowedKeys: readonly string[],
): boolean {
  if (!isString(value.replyId) || value.replyId.length === 0) return false
  if (!hasValidProducerSequence(value)) return false

  if (value.type === 'delta') {
    return (
      hasOnlyKeys(value, [...DELTA_INPUT_KEYS, ...extraAllowedKeys]) &&
      (value.channel === 'text' || value.channel === 'reasoning') &&
      isString(value.text)
    )
  }
  if (value.type === 'progress') {
    return hasOnlyKeys(value, ['type', 'replyId', 'producerSequence', 'progress', ...extraAllowedKeys]) &&
      agentProgressSnapshotSchema.safeParse(value.progress).success
  }
  if (value.type === 'final') {
    return (
      hasOnlyKeys(value, [...FINAL_INPUT_KEYS, ...extraAllowedKeys]) &&
      (value.reason === 'completed' || value.reason === 'truncated' || value.reason === 'awaiting_input')
    )
  }
  if (value.type === 'error') {
    return (
      hasOnlyKeys(value, [...ERROR_INPUT_KEYS, ...extraAllowedKeys]) &&
      isString(value.message)
    )
  }
  if (value.type === 'selection') {
    return (
      hasOnlyKeys(value, [...SELECTION_INPUT_KEYS, ...extraAllowedKeys]) &&
      isString(value.speaker) &&
      value.speaker.length > 0 &&
      // Validated by the record's own reader rather than shape-checked here,
      // so there is one definition of a readable record and a partial one is
      // refused in both places.
      readModelSelectionRecord(value.selection) !== undefined
    )
  }
  return false
}

export function isAgentTextStreamInput(
  value: unknown,
): value is AgentTextStreamInput {
  if (!isRecord(value)) return false
  return isInputBody(value, [])
}

export function isAgentTextGapFrame(value: unknown): value is AgentTextGapFrame {
  if (!isRecord(value)) return false
  if (value.type !== 'gap') return false
  if (!hasOnlyKeys(value, GAP_KEYS)) return false
  if (!isString(value.channelId) || !isCursor(value.cursor)) return false
  if (value.replyId !== undefined && !isString(value.replyId)) return false
  if (
    !isCursor(value.missingProducerFrom) ||
    !isCursor(value.missingProducerTo)
  ) {
    return false
  }
  // A range that runs backwards describes nothing; treating it as valid would
  // let a malformed producer silently blank a bubble.
  return value.missingProducerFrom <= value.missingProducerTo
}

export function isAgentTextResetControl(
  value: unknown,
): value is AgentTextResetControl {
  if (!isRecord(value)) return false
  if (value.type !== 'reset') return false
  if (!hasOnlyKeys(value, RESET_KEYS)) return false
  return (
    isString(value.channelId) &&
    isCursor(value.requestedFromCursor) &&
    isCursor(value.retainedFromCursor) &&
    value.reason === 'evicted'
  )
}

export function isAgentTextStreamFrame(
  value: unknown,
): value is AgentTextStreamFrame {
  if (!isRecord(value)) return false
  if (value.type === 'gap') return isAgentTextGapFrame(value)
  if (!isString(value.channelId) || !isCursor(value.cursor)) return false
  return isInputBody(value, IDENTITY_KEYS)
}

export function isAgentTextStreamDelivery(
  value: unknown,
): value is AgentTextStreamDelivery {
  if (!isRecord(value)) return false
  if (value.type === 'progress-snapshot') {
    return hasOnlyKeys(value, ['type', 'channelId', 'replyId', 'progress']) &&
      isString(value.channelId) && isString(value.replyId) && value.replyId.length > 0 &&
      agentProgressSnapshotSchema.safeParse(value.progress).success
  }
  if (value.type === 'reset') return isAgentTextResetControl(value)
  return isAgentTextStreamFrame(value)
}
