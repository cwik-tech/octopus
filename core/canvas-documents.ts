import { CANVAS_MAX_PROPOSAL_HISTORY, type CanvasDocumentAction, type CanvasDocumentAggregate, type CanvasProposalCompletion } from '../contracts/canvas-documents.js'

export type CanvasDocumentFailure = 'revision_conflict' | 'selection_conflict' | 'proposal_not_found' | 'proposal_target_mismatch' | 'proposal_conflict' | 'proposal_discarded' | 'proposal_superseded' | 'unsaved_draft' | 'document_size_limit'
type Decision = { ok: true; aggregate: CanvasDocumentAggregate } | { ok: false; code: CanvasDocumentFailure }
const refused = (code: CanvasDocumentFailure): Decision => ({ ok: false, code })

function rememberProposalDisposition(aggregate: CanvasDocumentAggregate, disposition: 'applied' | 'discarded' | 'superseded'): CanvasDocumentAggregate['proposalHistory'] {
  const proposal = aggregate.document.proposal
  if (!proposal) return aggregate.proposalHistory
  return [...aggregate.proposalHistory.filter((item) => item.id !== proposal.id), { id: proposal.id, status: disposition, appliedRevision: proposal.appliedRevision }].slice(-CANVAS_MAX_PROPOSAL_HISTORY)
}

export function applyCanvasDocumentAction(aggregate: CanvasDocumentAggregate, action: Exclude<CanvasDocumentAction, { kind: 'create' }>, proposalId: string): Decision {
  const document = aggregate.document
  if (action.kind === 'save') {
    if (action.expectedRevision !== document.revision) return refused('revision_conflict')
    if (action.content === document.content) return { ok: true, aggregate }
    const proposal = document.proposal
    return { ok: true, aggregate: { ...aggregate, document: { ...document, revision: document.revision + 1, content: action.content, proposal: proposal && (proposal.status === 'ready' || proposal.status === 'generating') ? { ...proposal, status: 'conflicted' } : proposal } } }
  }
  if (action.kind === 'propose') {
    if (action.expectedRevision !== document.revision) return refused('revision_conflict')
    if (action.selectionStart > action.selectionEnd || action.selectionEnd > document.content.length || document.content.slice(action.selectionStart, action.selectionEnd) !== action.selectedText) return refused('selection_conflict')
    const old = document.proposal
    const history = old && (old.status === 'applied' || old.status === 'discarded') ? rememberProposalDisposition(aggregate, old.status) : rememberProposalDisposition(aggregate, 'superseded')
    return { ok: true, aggregate: { proposalHistory: history, document: { ...document, proposal: { id: proposalId, status: 'generating', baseRevision: document.revision, baseContent: document.content, snapshotDigest: document.snapshotDigest, generation: (old?.generation ?? 0) + 1, selectionStart: action.selectionStart, selectionEnd: action.selectionEnd, selectedText: action.selectedText, instruction: action.instruction, replacementText: null, appliedRevision: null } } } }
  }
  const historical = aggregate.proposalHistory.find((item) => item.id === action.proposalId)
  const proposal = document.proposal
  if (historical) {
    if (action.kind === 'discard' || historical.status === 'applied') return { ok: true, aggregate }
    return refused(historical.status === 'discarded' ? 'proposal_discarded' : 'proposal_superseded')
  }
  if (!proposal || proposal.id !== action.proposalId) return refused('proposal_not_found')
  if (proposal.status === 'applied') return { ok: true, aggregate }
  if (action.kind === 'discard') return { ok: true, aggregate: { ...aggregate, document: { ...document, proposal: { ...proposal, status: 'discarded' } } } }
  if (proposal.status === 'discarded') return refused('proposal_discarded')
  if (proposal.status === 'superseded') return refused('proposal_superseded')
  if (action.hasUnsavedDraft) return refused('unsaved_draft')
  if (proposal.status !== 'ready' || proposal.baseRevision !== document.revision || proposal.snapshotDigest !== document.snapshotDigest || document.content.slice(proposal.selectionStart, proposal.selectionEnd) !== proposal.selectedText || proposal.replacementText === null) return refused('proposal_conflict')
  const nextRevision = document.revision + 1
  return { ok: true, aggregate: { ...aggregate, document: { ...document, revision: nextRevision, content: document.content.slice(0, proposal.selectionStart) + proposal.replacementText + document.content.slice(proposal.selectionEnd), proposal: { ...proposal, status: 'applied', appliedRevision: nextRevision } } } }
}

export function completeCanvasDocumentProposal(aggregate: CanvasDocumentAggregate, response: CanvasProposalCompletion): Decision {
  const document = aggregate.document
  const proposal = document.proposal
  if (aggregate.proposalHistory.some((item) => item.id === response.proposalId)) return { ok: true, aggregate }
  if (!proposal || proposal.id !== response.proposalId) return refused('proposal_not_found')
  if (proposal.baseRevision !== response.baseRevision || proposal.generation !== response.generation) return refused('proposal_target_mismatch')
  if (proposal.status !== 'generating' && proposal.status !== 'conflicted') return { ok: true, aggregate }
  return { ok: true, aggregate: { ...aggregate, document: { ...document, proposal: { ...proposal, replacementText: response.replacementText, status: document.revision === proposal.baseRevision ? 'ready' : 'conflicted' } } } }
}
