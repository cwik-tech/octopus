import { isProviderAbortSource, type ProviderAbortSource } from '../../contracts/provider-abort.js';
import { isProviderErrorKind, type ProviderErrorKind } from '../../contracts/provider.js';

/**
 * A content-free account of one provider turn's process.
 *
 * Ordinary selected-agent chat used to persist nothing about the subprocess
 * behind it, so a turn whose provider went away left `agent.turn.started` and
 * silence. This is the record that answers "how far did it get, and how did it
 * end" without becoming a second copy of the conversation.
 *
 * The shape is a closed union, not a bag. Every field here is either an
 * enumerated kind, a number the runtime observed, or a diagnostic code from an
 * allowlist — there is no free-text field for a message to escape through.
 * That is deliberate and load-bearing: the existing transcript writer redacts
 * credentials but still records assistant text, so it is not a boundary this
 * can reuse. A record that quietly accumulated prompts and answers under a
 * diagnostics filename would be a worse problem than the one it solves.
 */
/**
 * The one shape a stated code may take: short, and machine-made.
 *
 * `/` and `:` are admitted because real identifiers carry them —
 * `openai/gpt-4o-mini`, `connection:local` — and dropping the model an
 * operator needs to reproduce a turn would make the record less useful without
 * making it safer. Whitespace is what is refused, and prose is whitespace.
 */
const DIAGNOSTIC_CODE_PATTERN = /^[a-z0-9][a-z0-9_./:-]{0,95}$/i
export const CLI_DIAGNOSTIC_MAX_ATTEMPT = 10_000
export const CLI_DIAGNOSTIC_MAX_RETRY_DELAY_MS = 86_400_000

export type ProviderTurnDiagnosticRecord =
  | { readonly kind: 'cli-diagnostics-truncated'; readonly at: string; readonly limit: number }
  | {
      readonly kind: 'provider-cancellation'
      readonly at: string
      readonly source: ProviderAbortSource
      readonly phase: 'turn' | 'process'
    }
  | {
      readonly kind: 'provider-cli-diagnostic'
      readonly at: string
      readonly channel: 'stdout' | 'stderr'
      readonly category: ProviderErrorKind | 'retry'
      readonly statusCode?: number
      readonly attempt?: number
      readonly retryDelayMs?: number
    }
  | {
      readonly kind: 'provider-process-started'
      readonly at: string
      readonly provider: string
      readonly model?: string
    }
  | {
      readonly kind: 'provider-protocol-event'
      readonly at: string
      /** The event's own type, never its payload. */
      readonly eventType: string
      /** One-based position in this turn's stream. */
      readonly sequence: number
    }
  | {
      readonly kind: 'provider-stalled'
      readonly at: string
      readonly idleMs: number
      /** Whether the silence ended the turn or was only reported. */
      readonly aborted: boolean
    }
  | {
      readonly kind: 'provider-process-exited'
      readonly at: string
      readonly exitCode?: number
      readonly signal?: string
      /** The last protocol event the stream produced, if any. */
      readonly lastEventType?: string
    }
  | {
      readonly kind: 'bridge-cleanup'
      readonly at: string
      readonly outcome: 'started' | 'closed' | 'failed'
    }
  | {
      /**
       * The stream half of the record stopped here.
       *
       * Written once, so a reader can tell a turn that emitted six events from
       * one that emitted six thousand. Without it a capped record and a short
       * turn are indistinguishable, and an operator would draw the wrong
       * conclusion from the same file.
       */
      readonly kind: 'protocol-events-truncated'
      readonly at: string
      readonly limit: number
    }
  | {
      readonly kind: 'provider-failure'
      readonly at: string
      /** The normalized failure kind, when one was recognized. */
      readonly failureKind?: string
      /** The provider's own code, when it stated one. */
      readonly failureCode?: string
      readonly retryable: boolean
    }

/**
 * Where a turn's record is written.
 *
 * `undefined` where a caller has no assignment to write under, which is the
 * normal state for every turn that does not want this — the recorder is
 * created only for the routes that ask for one.
 */
export interface ProviderTurnDiagnosticsRecorder {
  record(entry: ProviderTurnDiagnosticEntry): void
}

/**
 * A record as its author writes it: everything except when it happened.
 *
 * The timestamp is the store's to stamp, from one clock, at the moment the line
 * is written. Asking callers for it invited them to supply a value that was
 * then silently discarded — a field that looks required, is ignored, and would
 * quietly disagree with every other line if anyone took it seriously.
 *
 * Distributed over the union rather than applied to it, so each member keeps
 * its own discriminated shape.
 */
export type ProviderTurnDiagnosticEntry =
  ProviderTurnDiagnosticRecord extends infer Member
    ? Member extends ProviderTurnDiagnosticRecord
      ? Omit<Member, 'at'>
      : never
    : never

/**
 * Rebuild each record from its own fields.
 *
 * Never a spread of the caller's object. A spread would carry whatever else
 * happened to be attached, which is exactly how a "diagnostics only" record
 * ends up holding a prompt.
 */
export function sanitizeProviderTurnDiagnosticRecord(
  entry: ProviderTurnDiagnosticEntry,
  at: string,
): ProviderTurnDiagnosticRecord | undefined {
  switch (entry.kind) {
    case 'provider-cancellation':
      return readProviderTurnDiagnosticRecord({ kind: entry.kind, at, source: entry.source, phase: entry.phase })
    case 'provider-cli-diagnostic':
      return readProviderTurnDiagnosticRecord({ kind: entry.kind, at, channel: entry.channel, category: entry.category,
        statusCode: entry.statusCode, attempt: entry.attempt, retryDelayMs: entry.retryDelayMs })
    case 'provider-process-started':
      return {
        kind: entry.kind,
        at,
        provider: code(entry.provider) ?? 'unknown',
        ...(code(entry.model) === undefined ? {} : { model: entry.model }),
      }
    case 'provider-protocol-event':
      return {
        kind: entry.kind,
        at,
        eventType: code(entry.eventType) ?? 'unknown',
        sequence: ordinal(entry.sequence) ?? 0,
      }
    case 'provider-stalled':
      return {
        kind: entry.kind,
        at,
        idleMs: ordinal(entry.idleMs) ?? 0,
        aborted: entry.aborted === true,
      }
    case 'provider-process-exited':
      return {
        kind: entry.kind,
        at,
        ...(typeof entry.exitCode === 'number' && Number.isInteger(entry.exitCode)
          ? { exitCode: entry.exitCode }
          : {}),
        ...(code(entry.signal) === undefined ? {} : { signal: entry.signal }),
        ...(code(entry.lastEventType) === undefined
          ? {}
          : { lastEventType: entry.lastEventType }),
      }
    case 'bridge-cleanup':
      return { kind: entry.kind, at, outcome: entry.outcome }
    case 'protocol-events-truncated':
      return { kind: entry.kind, at, limit: ordinal(entry.limit) ?? 0 }
    case 'cli-diagnostics-truncated':
      return { kind: entry.kind, at, limit: ordinal(entry.limit) ?? 0 }
    case 'provider-failure':
      return {
        kind: entry.kind,
        at,
        ...(code(entry.failureKind) === undefined
          ? {}
          : { failureKind: entry.failureKind }),
        ...(code(entry.failureCode) === undefined
          ? {}
          : { failureCode: entry.failureCode }),
        retryable: entry.retryable === true,
      }
    default:
      return undefined
  }
}

/** A stated identifier, or nothing. Prose does not match this. */
function code(value: unknown): string | undefined {
  return typeof value === 'string' && DIAGNOSTIC_CODE_PATTERN.test(value)
    ? value
    : undefined
}

/**
 * The instant a value names, in the single form this module writes.
 *
 * Round-tripped rather than pattern-matched: a string that parses to a real
 * time comes back as that time's canonical ISO text, and anything else — prose,
 * a secret, an impossible date — comes back as nothing.
 */
function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return undefined
  return new Date(parsed).toISOString()
}

function ordinal(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined
}

function boundedInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined
}

export function readProviderTurnDiagnosticRecord(
  value: unknown,
): ProviderTurnDiagnosticRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const record: Record<string, unknown> = { ...value }
  // Rebuilt from the instant it names, never passed through. This is the one
  // field that is not an enumeration, so it is the one place prose in a corrupt
  // or hostile file could ride out under a contract that promises none.
  const at = canonicalTimestamp(record.at)
  if (at === undefined) return undefined
  switch (record.kind) {
    case 'provider-cancellation':
      return isProviderAbortSource(record.source) && (record.phase === 'turn' || record.phase === 'process')
        ? { kind: record.kind, at, source: record.source, phase: record.phase }
        : undefined
    case 'provider-cli-diagnostic': {
      if ((record.channel !== 'stdout' && record.channel !== 'stderr') ||
          (record.category !== 'retry' && !isProviderErrorKind(record.category))) return undefined
      const statusCode = boundedInteger(record.statusCode, 599)
      const attempt = boundedInteger(record.attempt, CLI_DIAGNOSTIC_MAX_ATTEMPT)
      const retryDelayMs = boundedInteger(record.retryDelayMs, CLI_DIAGNOSTIC_MAX_RETRY_DELAY_MS)
      return { kind: record.kind, at, channel: record.channel, category: record.category,
        ...(statusCode === undefined || statusCode < 100 || statusCode > 599 ? {} : { statusCode }),
        ...(attempt === undefined ? {} : { attempt }),
        ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
      }
    }
    case 'provider-process-started':
      return code(record.provider)
        ? {
            kind: 'provider-process-started',
            at,
            provider: String(record.provider),
            ...(code(record.model) === undefined
              ? {}
              : { model: String(record.model) }),
          }
        : undefined
    case 'provider-protocol-event':
      return code(record.eventType) && ordinal(record.sequence) !== undefined
        ? {
            kind: 'provider-protocol-event',
            at,
            eventType: String(record.eventType),
            sequence: ordinal(record.sequence) ?? 0,
          }
        : undefined
    case 'provider-stalled': {
      // Required, so absent or malformed is a refusal rather than a default.
      // Reading `0` for an idle span the file never stated would have this
      // record assert something nobody observed.
      const idleMs = ordinal(record.idleMs)
      if (idleMs === undefined || typeof record.aborted !== 'boolean') {
        return undefined
      }
      return { kind: 'provider-stalled', at, idleMs, aborted: record.aborted }
    }
    case 'provider-process-exited':
      return {
        kind: 'provider-process-exited',
        at,
        ...(typeof record.exitCode === 'number' &&
        Number.isInteger(record.exitCode)
          ? { exitCode: record.exitCode }
          : {}),
        ...(code(record.signal) === undefined
          ? {}
          : { signal: String(record.signal) }),
        ...(code(record.lastEventType) === undefined
          ? {}
          : { lastEventType: String(record.lastEventType) }),
      }
    case 'protocol-events-truncated':
      return ordinal(record.limit) === undefined
        ? undefined
        : {
            kind: 'protocol-events-truncated',
            at,
            limit: ordinal(record.limit) ?? 0,
          }
    case 'cli-diagnostics-truncated':
      return ordinal(record.limit) === undefined ? undefined : { kind: record.kind, at, limit: ordinal(record.limit) ?? 0 }
    case 'bridge-cleanup':
      return record.outcome === 'started' ||
        record.outcome === 'closed' ||
        record.outcome === 'failed'
        ? { kind: 'bridge-cleanup', at, outcome: record.outcome }
        : undefined
    case 'provider-failure':
      // `retryable` is the field an operator acts on, so a file that does not
      // state it may not have one inferred.
      if (typeof record.retryable !== 'boolean') return undefined
      return {
        kind: 'provider-failure',
        at,
        ...(code(record.failureKind) === undefined
          ? {}
          : { failureKind: String(record.failureKind) }),
        ...(code(record.failureCode) === undefined
          ? {}
          : { failureCode: String(record.failureCode) }),
        retryable: record.retryable,
      }
    default:
      return undefined
  }
}

/**
 * Read a whole record file's worth of lines.
 *
 * Pure over the text, so the rule that every line is re-validated is stated
 * once and can be checked without a filesystem. A line this build cannot read
 * is skipped rather than failing the read: a damaged tail must not hide the
 * records before it.
 */
export function parseProviderTurnDiagnosticRecords(
  text: string,
): readonly ProviderTurnDiagnosticRecord[] {
  const records: ProviderTurnDiagnosticRecord[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const record = readProviderTurnDiagnosticRecord(parsed)
    if (record) records.push(record)
  }
  return records
}
