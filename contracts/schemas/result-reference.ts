import { z } from 'zod'

/**
 * A pointer to a completed unit of work, for a later responder to read.
 *
 * Derived from this schema rather than declared beside it, so the wire form
 * and the type cannot drift. Deliberately small: it names where the output
 * already lives and never carries a copy of it, because a copy is a second
 * authority that can disagree with the first.
 *
 * See `docs/adr/2026-09-09-Continuation-Context-Result-References.md`.
 */

const trimmed = z.string().trim().min(1)

/** What produced the result. `label` is display only and never an identity. */
export const resultProducerSchema = z.object({
  kind: z.enum(['agent', 'team', 'workflow']),
  id: trimmed.max(200),
  label: trimmed.max(200),
})

/**
 * Where the content is, as a pointer.
 *
 * Three kinds because three things produce results and they store them
 * differently. A chat-only Team has no artifact at all — the runner publishes
 * none in team-chat mode — so pointing at one would mean manufacturing a file
 * the Team did not produce.
 */
export const resultSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat-message'), messageId: trimmed.max(200) }),
  z.object({ kind: z.literal('run-summary'), runId: trimmed.max(200) }),
  z.object({
    kind: z.literal('artifact'),
    runId: trimmed.max(200),
    path: trimmed.max(1024),
    /** The published SHA-256 of this file, when the publication recorded one. */
    digest: trimmed.max(200).optional(),
  }),
])

/** One published file, named so a shortened excerpt still cites its source. */
export const resultArtifactSchema = z.object({
  runId: trimmed.max(200),
  path: trimmed.max(1024),
  mediaType: trimmed.max(200).optional(),
  digest: trimmed.max(200).optional(),
})

/**
 * How many results one turn may carry.
 *
 * In `contracts/` because three layers enforce it and they must agree: the
 * request schema refuses a fourth, the selection core refuses a fourth, and
 * the composer must stop offering one. A picker that let the user build a turn
 * the endpoint then refused made every Send fail with no way to see why.
 */
export const MAX_CONTEXT_RESULTS_PER_TURN = 3

export const RESULT_REFERENCE_SCHEMA_VERSION = 1 as const

export const resultReferenceSchema = z.object({
  schemaVersion: z.literal(RESULT_REFERENCE_SCHEMA_VERSION),
  /** Stable across replays: derived from the producer and execution attempt. */
  id: trimmed.max(400),
  sessionId: trimmed.max(200),
  producer: resultProducerSchema,
  /** The terminal state reached. Only `done` is offered as continuation. */
  status: z.enum(['done', 'failed', 'cancelled', 'blocked']),
  completedAt: trimmed.max(64),
  /** What was asked, for a reader choosing between several results. */
  brief: z.string().max(2000).optional(),
  /**
   * The opening of the result itself, for the same reason.
   *
   * A picker showing several results from one producer needs something that
   * differs between them. Two replies a minute apart had identical labels,
   * and the user had to guess which one they were attaching.
   */
  excerpt: z.string().max(300).optional(),
  /**
   * The task this came from, when a task produced it.
   *
   * Kept so the source can be re-verified at use time rather than trusted
   * because it was once true: a reference is a pointer, and a pointer that is
   * followed has to be checked against the state it points into.
   */
  producerTaskId: trimmed.max(200).optional(),
  /** The execution attempt that produced it, for the same reason. */
  executionAttemptId: trimmed.max(200).optional(),
  source: resultSourceSchema,
  artifacts: z.array(resultArtifactSchema).max(20).optional(),
})

export type ResultProducer = z.infer<typeof resultProducerSchema>
export type ResultSource = z.infer<typeof resultSourceSchema>
export type ResultArtifact = z.infer<typeof resultArtifactSchema>
export type ResultReference = z.infer<typeof resultReferenceSchema>

/**
 * Read one persisted record, or `undefined` when it cannot be read.
 *
 * Undefined rather than a throw: a session written by a later build, or a line
 * corrupted by a partial write, must not make the whole session unopenable.
 * The cost of skipping one reference is a continuation that is not offered.
 */
export function parseResultReference(value: unknown): ResultReference | undefined {
  const parsed = resultReferenceSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * The id a producer and attempt always yield.
 *
 * Publication is idempotent by this pair, so a recovery sweep that revisits a
 * finished run writes nothing new and a replay cannot create a second
 * reference to one result.
 */
export function resultReferenceId(input: {
  producerKind: ResultProducer['kind']
  producerId: string
  executionAttemptId?: string
}): string {
  const attempt = input.executionAttemptId?.trim()
  return attempt
    ? `${input.producerKind}:${input.producerId}:${attempt}`
    : `${input.producerKind}:${input.producerId}`
}
