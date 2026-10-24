import { OFFICE_MAX_REVISIONS, OFFICE_RECEIPT_LIMIT, type OfficeDocument, type OfficeDocumentResult, type OfficeProposalCompletion, type OfficeProposalDisposition, type OfficeProposalInput } from '../contracts/office-documents.js'

export function admitOfficeProposal(document: OfficeDocument, request: OfficeProposalInput, proposalId: string): OfficeDocumentResult {
  const prior = document.receipts.find((receipt) => receipt.requestSequence === request.requestSequence || receipt.requestId === request.requestId)
  const active = document.proposal
  const matching = prior ?? (active && (active.requestSequence === request.requestSequence || active.requestId === request.requestId) ? active : undefined)
  if (matching) return matching.requestSequence === request.requestSequence && matching.requestId === request.requestId && matching.fingerprint === request.fingerprint ? { ok: true, document } : { ok: false, code: 'request_conflict' }
  if (request.requestSequence <= document.highestRequestSequence) return { ok: false, code: 'request_expired' }
  if (request.requestSequence !== document.highestRequestSequence + 1) return { ok: false, code: 'request_conflict' }
  if (active && (active.status === 'generating' || active.status === 'ready')) return { ok: false, code: 'proposal_busy' }
  const baseDigest = document.revisions.at(-1)?.digest
  if (!baseDigest || request.baseRevision !== document.revision) return { ok: false, code: 'revision_conflict' }
  return { ok: true, document: { ...document, highestRequestSequence: request.requestSequence, proposal: { ...request, id: proposalId, generation: request.requestSequence, baseDigest, status: 'generating', candidateDigest: null, summary: '' } } }
}

export function completeOfficeProposal(document: OfficeDocument, completion: OfficeProposalCompletion): OfficeDocumentResult {
  const proposal = document.proposal
  if (!proposal || proposal.status !== 'generating' || proposal.id !== completion.proposalId || proposal.generation !== completion.generation || proposal.baseRevision !== completion.baseRevision || proposal.baseDigest !== completion.baseDigest || document.revision !== completion.baseRevision || document.revisions.at(-1)?.digest !== completion.baseDigest) return { ok: false, code: 'revision_conflict' }
  return { ok: true, document: { ...document, proposal: { ...proposal, status: 'ready', candidateDigest: completion.candidateDigest, summary: completion.summary } } }
}

export function disposeOfficeProposal(document: OfficeDocument, disposition: OfficeProposalDisposition): OfficeDocumentResult {
  const receipt = document.receipts.find((candidate) => candidate.proposalId === disposition.proposalId)
  if (receipt) return receipt.outcome === (disposition.kind === 'accept' ? 'accepted' : 'discarded') ? { ok: true, document } : { ok: false, code: 'revision_conflict' }
  const proposal = document.proposal
  if (!proposal || proposal.id !== disposition.proposalId) return { ok: false, code: 'document_not_found' }
  let next = document
  if (disposition.kind === 'accept') {
    if (proposal.status !== 'ready' || !proposal.candidateDigest || disposition.expectedRevision !== document.revision || proposal.baseRevision !== document.revision || proposal.baseDigest !== document.revisions.at(-1)?.digest) return { ok: false, code: 'revision_conflict' }
    if (document.revisions.length >= OFFICE_MAX_REVISIONS) return { ok: false, code: 'storage_limit' }
    const revision = document.revision + 1
    const provenance = document.source ? { source: { ...document.source, forked: true } } : {}
    next = { ...document, ...provenance, revision, revisions: [...document.revisions, { revision, digest: proposal.candidateDigest, ...provenance }] }
  }
  const receipts: OfficeDocument['receipts'] = [...document.receipts, { proposalId: proposal.id, requestId: proposal.requestId, requestSequence: proposal.requestSequence, fingerprint: proposal.fingerprint, outcome: disposition.kind === 'accept' ? 'accepted' : 'discarded', revision: next.revision }]
  return { ok: true, document: { ...next, proposal: null, receipts: receipts.slice(-OFFICE_RECEIPT_LIMIT) } }
}

export function failOfficeProposal(document: OfficeDocument, proposalId: string, generation: number, status: 'failed' | 'interrupted', summary: string): OfficeDocumentResult {
  const proposal = document.proposal
  if (!proposal || proposal.id !== proposalId || proposal.generation !== generation || proposal.status !== 'generating' || proposal.baseRevision !== document.revision || proposal.baseDigest !== document.revisions.at(-1)?.digest) return { ok: false, code: 'revision_conflict' }
  const receipts: OfficeDocument['receipts'] = [...document.receipts, { proposalId, requestId: proposal.requestId, requestSequence: proposal.requestSequence, fingerprint: proposal.fingerprint, outcome: status, revision: document.revision }]
  return { ok: true, document: { ...document, proposal: { ...proposal, status, summary, candidateDigest: null }, receipts: receipts.slice(-OFFICE_RECEIPT_LIMIT) } }
}
