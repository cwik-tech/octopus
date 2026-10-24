import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { z } from 'zod'
import type { ExecutionJournalEvent } from '../contracts/execution-journal.js'
import type { RunAssignmentLocation } from '../core/run-assignment-location.js'
import { hashCanonicalJson } from '../core/canonical-json-hash.js'
import { DURABLE_DISPATCH_STREAM_KIND, reduceDurableDispatchState } from '../core/durable-dispatch.js'
import { isDurableStreamEvent, toStreamEvent } from '../core/durable-dispatch-journal.js'
import { EXECUTION_JOURNAL_DIRECTORY_NAME, readExecutionJournal } from '../core/execution-journal.js'
import { createAssignmentCapabilityResultStore } from './capability-result-content-store.js'
import { canvasDigest, canvasDocumentError } from './canvas-document-store.js'

const CANVAS_ORIGIN_JOURNAL_MAX_BYTES = 16 * 1024 * 1024
const CANVAS_ORIGIN_JOURNAL_MAX_EVENTS = 20_000
const CANVAS_ORIGIN_RESULT_MAX_BYTES = 64 * 1024
const CANVAS_ORIGIN_MAX_RECEIPTS = 256
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const creationIdentitySchema = z.object({
  contractVersion: z.literal(1), dispatchId: z.string().min(1), attemptId: z.string().min(1),
  requestId: z.string().min(1), agentPath: z.string().min(1), authorityKind: z.literal('mcp-lease'),
  sessionId: z.string(), runId: z.string(), assignmentId: z.string(),
  capabilityId: z.literal('file.create'), sourceKind: z.literal('builtin'),
  sourceId: z.literal('pipeline-files'), sourceVersion: z.literal('1'),
  argumentNames: z.tuple([z.literal('content'), z.literal('filename')]), argumentDigest: sha256,
}).passthrough()
const receiptSchema = z.strictObject({
  contentId: sha256, contentSha256: sha256, byteLength: z.number().int().nonnegative().max(CANVAS_ORIGIN_RESULT_MAX_BYTES),
  mediaType: z.literal('application/json'), resultSchemaVersion: z.literal(2),
}).refine((receipt) => receipt.contentId === receipt.contentSha256)
const acceptedSchema = z.object({
  attemptId: z.string().min(1), dispatchId: z.string().min(1), status: z.literal('completed'),
  resultKind: z.literal('content'), resultContent: receiptSchema, identity: creationIdentitySchema,
})
const createdFileSchema = z.strictObject({
  ok: z.literal(true), sizeBytes: z.number().int().nonnegative(),
  artifact: z.strictObject({ path: z.string(), title: z.string(), mediaType: z.literal('text/markdown'), role: z.literal('final'), digest: sha256.optional() }),
})
const preparedSchema = z.object({ attemptId: z.string().min(1), argumentDigest: sha256, capabilityId: z.literal('file.create'), identity: creationIdentitySchema })
const fileCreationSchema = z.object({ capabilityId: z.literal('file.create') })

function unverifiable(): never {
  throw canvasDocumentError('origin_unverifiable', 'The original has no verifiable publication or accepted creation receipt. It remains read-only.')
}

function lastEvent(stream: readonly ExecutionJournalEvent[], type: string, attemptId?: string): ExecutionJournalEvent | undefined {
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const event = stream[index]
    if (event?.type === type && (attemptId === undefined || event.payload['attemptId'] === attemptId)) return event
  }
  return undefined
}

async function exactDirectory(directory: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(directory)
    return stat.isDirectory() && !stat.isSymbolicLink() && await fs.realpath(directory) === directory
  } catch {
    // Missing or unreadable retained authority cannot authorize an editable copy.
    return false
  }
}

/** Recover only a host-sealed creation input; the current file is a candidate,
 * never the authority. The caller retains this same byte buffer after proof. */
export async function verifyCanvasCreationOrigin(input: {
  location: RunAssignmentLocation
  sessionId: string
  artifactPath: string
  bytes: Buffer
  content: string
  signal: AbortSignal
}): Promise<string> {
  input.signal.throwIfAborted()
  const runtime = path.join(input.location.assignmentPath, '.runtime')
  if (!await exactDirectory(input.location.assignmentPath) || !await exactDirectory(runtime) || !await exactDirectory(path.join(runtime, EXECUTION_JOURNAL_DIRECTORY_NAME))) unverifiable()
  const read = await readExecutionJournal(input.location.assignmentPath, { maxBytes: CANVAS_ORIGIN_JOURNAL_MAX_BYTES, maxEvents: CANVAS_ORIGIN_JOURNAL_MAX_EVENTS })
  if (read.kind !== 'ok' || read.truncatedTail) unverifiable()
  const owner = read.manifest
  if (owner.scopeKind !== 'assignment' || owner.scopeId !== input.location.assignmentId || owner.sessionId !== input.sessionId || owner.runId !== input.location.runId || owner.assignmentId !== input.location.assignmentId) unverifiable()
  const streams = new Map<string, ExecutionJournalEvent[]>()
  for (const event of read.events) {
    if (event.streamKind !== DURABLE_DISPATCH_STREAM_KIND) continue
    const stream = streams.get(event.streamId) ?? []
    stream.push(event)
    streams.set(event.streamId, stream)
  }
  const store = createAssignmentCapabilityResultStore({ assignmentPath: input.location.assignmentPath, maxByteLength: CANVAS_ORIGIN_RESULT_MAX_BYTES })
  const proofs = new Map<string, { argumentDigest: string; sizeBytes: number; digest?: string }>()
  let receipts = 0
  for (const [dispatchId, stream] of streams) {
    input.signal.throwIfAborted()
    const accepted = lastEvent(stream, 'capability.dispatch.accepted')
    if (!accepted) continue
    const rawIdentity = accepted.payload['identity']
    if (!fileCreationSchema.safeParse(rawIdentity).success) continue
    receipts += 1
    if (receipts > CANVAS_ORIGIN_MAX_RECEIPTS) unverifiable()
    const payload = acceptedSchema.safeParse(accepted.payload)
    const stateEvents = stream.map((event) => {
      const mapped = toStreamEvent(event)
      const approval = event.type === 'capability.dispatch.approval_requested' || event.type === 'capability.dispatch.approval_resolved'
      if ((!mapped && !approval) || event.payloadSchemaVersion !== (event.type === 'capability.dispatch.accepted' ? 2 : 1)) unverifiable()
      return mapped
    }).filter(isDurableStreamEvent)
    const reduction = reduceDurableDispatchState(stateEvents)
    if (!payload.success || accepted.payloadSchemaVersion !== 2 || reduction.kind !== 'valid' || reduction.state !== 'accepted') unverifiable()
    const identity = payload.data.identity
    if (identity.dispatchId !== dispatchId || payload.data.dispatchId !== dispatchId || identity.attemptId !== payload.data.attemptId || identity.sessionId !== input.sessionId || identity.runId !== input.location.runId || identity.assignmentId !== input.location.assignmentId) unverifiable()
    const preparedEvent = lastEvent(stream, 'capability.dispatch.prepared', identity.attemptId)
    const prepared = preparedSchema.safeParse(preparedEvent?.payload)
    if (!prepared.success || preparedEvent?.payloadSchemaVersion !== 1 || prepared.data.argumentDigest !== identity.argumentDigest || hashCanonicalJson(prepared.data.identity).value !== hashCanonicalJson(identity).value) unverifiable()
    const retained = await store.read(payload.data.resultContent)
    if (retained.kind !== 'content') unverifiable()
    const rawResult: unknown = JSON.parse(retained.canonical)
    const result = createdFileSchema.safeParse(rawResult)
    if (!result.success) unverifiable()
    if (result.data.artifact.path !== input.artifactPath) continue
    if (result.data.artifact.title !== path.posix.basename(input.artifactPath) || input.artifactPath !== `files/${result.data.artifact.title}`) unverifiable()
    // A replay retains this dispatch stream. A different accepted dispatch
    // for this path proves another creation, even when its bytes are identical.
    proofs.set(dispatchId, { argumentDigest: identity.argumentDigest, sizeBytes: result.data.sizeBytes, ...(result.data.artifact.digest ? { digest: result.data.artifact.digest } : {}) })
  }
  if (proofs.size !== 1) unverifiable()
  const proof = [...proofs.values()][0]
  if (!proof) unverifiable()
  const digest = canvasDigest(input.bytes)
  if (proof.argumentDigest !== hashCanonicalJson({ filename: path.posix.basename(input.artifactPath), content: input.content }).value || proof.sizeBytes !== input.bytes.byteLength || proof.digest !== undefined && proof.digest !== digest) throw canvasDocumentError('origin_changed', 'The original bytes changed after creation. It remains read-only.')
  input.signal.throwIfAborted()
  return digest
}
