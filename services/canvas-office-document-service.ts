import { beginSessionWork } from '../domains/sessions/session-work-lifecycle.js'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { officeProposalRequestSchema, type OfficeDocument, type OfficeDocumentResult, type OfficeFailure, type OfficeFormat, type OfficeProposalDisposition, type OfficeProposalRequest } from '../contracts/office-documents.js'
import { CANVAS_PROPOSAL_TIMEOUT_MS } from '../contracts/canvas-documents.js'
import { hashCanonicalJson } from '../core/canonical-json-hash.js'
import { admitOfficeProposal, completeOfficeProposal, disposeOfficeProposal, failOfficeProposal } from '../core/canvas-office-documents.js'
import { withOfficeDocument, readOfficeBlob, readOfficeRevision, retainOfficeBlob, type OfficeDocumentScope } from './canvas-office-document-store.js'
import { readOfficeTargets, applyOfficeOperations } from './office-document-capability-adapter.js'
import { generateOfficeOperations } from './office-proposal-generator.js'
export interface OfficeEditScope extends OfficeDocumentScope { readonly documentId: string; readonly repoRoot: string }
interface Generation { readonly proposalId: string; readonly controller: AbortController }
const generations = new Map<string, Generation>()
const generationKey = (input: OfficeEditScope): string => JSON.stringify([path.resolve(input.workspacePath), input.sessionId, input.documentId])

export async function proposeOfficeEdit(input: OfficeEditScope & { request: OfficeProposalRequest }): Promise<OfficeDocumentResult> {
  const work = beginSessionWork(input.workspacePath, input.sessionId, input.signal)
  if (!work) return { ok: false, code: 'cancelled' }
  try { return await proposeWithinLifetime({ ...input, signal: work.signal }) }
  finally { work.finish() }
}

async function proposeWithinLifetime(input: OfficeEditScope & { request: OfficeProposalRequest }): Promise<OfficeDocumentResult> {
  await getOfficeDocumentState(input)
  const parsed = officeProposalRequestSchema.safeParse(input.request)
  if (!parsed.success) return { ok: false, code: 'invalid_output' }
  const fingerprint = hashCanonicalJson({ documentId: input.documentId, ...parsed.data }).value
  const key = generationKey(input)
  const job: Generation = { proposalId: randomUUID(), controller: new AbortController() }
  let admittedNew = false
  const admitted = await withOfficeDocument<OfficeDocumentResult>(input, async (saved) => {
    if (!saved) return { next: null, result: { ok: false, code: 'document_not_found' } }
    const decision = admitOfficeProposal(saved, { ...parsed.data, fingerprint }, job.proposalId)
    if (decision.ok && decision.document !== saved) { admittedNew = true; generations.set(key, job) }
    return { next: decision.ok ? decision.document : saved, result: decision }
  })
  if (!admittedNew) return admitted
  if (!admitted.ok) { generations.delete(key); return admitted }
  const generation = admitted.document.proposal?.generation ?? 0
  const signal = AbortSignal.any([input.signal, job.controller.signal, AbortSignal.timeout(CANVAS_PROPOSAL_TIMEOUT_MS)])
  try {
    const result = await buildProposal({ ...input, signal }, admitted.document)
    if (result.ok) return result
    return await recordFailure()
  } catch { return await recordFailure() }
  finally { if (generations.get(key) === job) generations.delete(key) }
  async function recordFailure(): Promise<OfficeDocumentResult> {
    return await withOfficeDocument<OfficeDocumentResult>({ ...input, signal: AbortSignal.timeout(5000) }, async (saved) => {
      if (!saved) return { next: null, result: { ok: false, code: 'document_not_found' } }
      const result = failOfficeProposal(saved, job.proposalId, generation, signal.aborted ? 'interrupted' : 'failed', 'The agent revision could not be completed. The saved document is unchanged.')
      return { next: result.ok ? result.document : saved, result }
    })
  }
}

async function buildProposal(input: OfficeEditScope, document: OfficeDocument): Promise<OfficeDocumentResult> {
  const proposal = document.proposal
  if (!proposal || proposal.status !== 'generating') return { ok: false, code: 'revision_conflict' }
  const source = await readOfficeRevision({ ...input, revision: proposal.baseRevision })
  if (!source.ok) return source
  const lifetime = { workspacePath: input.workspacePath, sessionId: input.sessionId }
  const targets = await readOfficeTargets({ ...input, ...source, lifetime })
  if (!targets.ok) return targets
  const operations = await generateOfficeOperations({ instruction: proposal.instruction, targets: targets.targets, signal: input.signal })
  if (!operations.ok) return operations
  const candidate = await applyOfficeOperations({ ...input, ...source, lifetime, operations: operations.operations })
  if (!candidate.ok) return candidate
  return withOfficeDocument<OfficeDocumentResult>(input, async (saved, directory) => {
    if (!saved) return { next: null, result: { ok: false, code: 'document_not_found' } }
    const check = completeOfficeProposal(saved, { proposalId: proposal.id, generation: proposal.generation, baseRevision: proposal.baseRevision, baseDigest: proposal.baseDigest, candidateDigest: proposal.baseDigest, summary: operations.summary })
    if (!check.ok) return { next: saved, result: check }
    const retained = await retainOfficeBlob(directory, candidate.bytes, input.signal)
    if (!retained.ok) return { next: saved, result: retained }
    const result = completeOfficeProposal(saved, { proposalId: proposal.id, generation: proposal.generation, baseRevision: proposal.baseRevision, baseDigest: proposal.baseDigest, candidateDigest: retained.digest, summary: operations.summary })
    return { next: result.ok ? result.document : saved, result }
  })
}

export async function disposeOfficeEdit(input: OfficeEditScope & { disposition: OfficeProposalDisposition }): Promise<OfficeDocumentResult> {
  const result = await withOfficeDocument<OfficeDocumentResult>(input, async (saved, directory) => {
    if (!saved) return { next: null, result: { ok: false, code: 'document_not_found' } }
    if (input.disposition.kind === 'accept' && saved.proposal?.id === input.disposition.proposalId) {
      const original = await readOfficeBlob(directory, saved.originalDigest, input.signal)
      if (!original.ok) return { next: saved, result: original }
      const digest = saved.proposal.candidateDigest
      if (!digest) return { next: saved, result: { ok: false, code: 'revision_conflict' } }
      const candidate = await readOfficeBlob(directory, digest, input.signal)
      if (!candidate.ok) return { next: saved, result: candidate }
    }
    const decision = disposeOfficeProposal(saved, input.disposition)
    return { next: decision.ok ? decision.document : saved, result: decision }
  })
  if (result.ok && input.disposition.kind === 'discard') {
    const active = generations.get(generationKey(input))
    if (active?.proposalId === input.disposition.proposalId) active.controller.abort()
  }
  return result
}

export async function readOfficeCandidate(input: OfficeEditScope & { proposalId: string }): Promise<{ ok: true; bytes: Buffer; format: OfficeFormat; digest: string; name: string } | OfficeFailure> {
  return withOfficeDocument<{ ok: true; bytes: Buffer; format: OfficeFormat; digest: string; name: string } | OfficeFailure>(input, async (saved, directory) => {
    const proposal = saved?.proposal
    if (!saved || !proposal || proposal.id !== input.proposalId || proposal.status !== 'ready' || !proposal.candidateDigest) return { next: saved, result: { ok: false, code: 'document_not_found' } }
    const result = await readOfficeBlob(directory, proposal.candidateDigest, input.signal)
    return { next: saved, result: result.ok ? { ok: true, bytes: result.bytes, format: saved.format, digest: proposal.candidateDigest, name: path.basename(saved.origin.artifactPath) } : result }
  })
}

export async function getOfficeDocumentState(input: OfficeEditScope): Promise<OfficeDocumentResult> {
  return withOfficeDocument<OfficeDocumentResult>(input, async (saved) => {
    if (!saved) return { next: null, result: { ok: false, code: 'document_not_found' } }
    const proposal = saved.proposal
    if (proposal?.status === 'generating' && !generations.has(generationKey(input))) {
      const interrupted = failOfficeProposal(saved, proposal.id, proposal.generation, 'interrupted', 'The previous revision request was interrupted. Request a new revision.')
      return { next: interrupted.ok ? interrupted.document : saved, result: interrupted }
    }
    return { next: saved, result: { ok: true, document: saved } }
  })
}
