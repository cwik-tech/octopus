import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasDocument, CanvasDocumentAction, CanvasProposal } from '@contracts/canvas-documents'
import { canvasTabKey, type CanvasTab } from '@contracts/canvas-workspace'
import { CanvasDocumentRequestError, canvasDocumentUrl, requestCanvasDocument } from '@/lib/clients/canvas-document-client'
import { canvasDraftStorageKey, findRecoverableCanvasDraft, readCanvasDraft, type CanvasDraft } from './canvas-draft-storage'

interface DocumentState { document: CanvasDocument | null; draft: CanvasDraft | null; error: string | null; draftPersistenceError: string | null; loaded: boolean; busy: CanvasDocumentAction['kind'] | null }
interface PendingProposal { token: symbol; action: Extract<CanvasDocumentAction, { kind: 'propose' }>; generation: number; snapshotDigest: string; signal: AbortSignal }
const initial: DocumentState = { document: null, draft: null, error: null, draftPersistenceError: null, loaded: false, busy: null }
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Canvas document is unavailable'
const proposalOrder: Record<CanvasProposal['status'], number> = { generating: 0, ready: 1, conflicted: 2, failed: 3, discarded: 4, superseded: 4, applied: 5 }

function isOlderDocument(previous: CanvasDocument, next: CanvasDocument) {
  if (previous.revision !== next.revision) return previous.revision > next.revision
  const before = previous.proposal
  const after = next.proposal
  if (!before) return false
  if (!after) return true
  if (before.generation !== after.generation) return before.generation > after.generation
  if (proposalOrder[before.status] !== proposalOrder[after.status]) return proposalOrder[before.status] > proposalOrder[after.status]
  return before.replacementText !== null && after.replacementText === null
}

function matchesPendingCapture(proposal: CanvasProposal, pending: PendingProposal) {
  const capture = pending.action
  return proposal.generation === pending.generation && proposal.snapshotDigest === pending.snapshotDigest && proposal.baseRevision === capture.expectedRevision && proposal.selectionStart === capture.selectionStart && proposal.selectionEnd === capture.selectionEnd && proposal.selectedText === capture.selectedText && proposal.instruction === capture.instruction.trim()
}

export function useCanvasDocument(sessionId: string, target: CanvasTab) {
  const stableTarget = useMemo(() => ({ runId: target.runId, artifactPath: target.artifactPath }), [target.runId, target.artifactPath])
  const [state, setState] = useState<DocumentState>(initial)
  const [recoverable, setRecoverable] = useState<ReturnType<typeof findRecoverableCanvasDraft>>(null)
  const changes = useRef<BroadcastChannel | null>(null)
  const scope = useRef<AbortController | null>(null)
  const activeMutation = useRef<symbol | null>(null)
  const pendingProposal = useRef<PendingProposal | null>(null)
  const storageKey = useMemo(() => canvasDraftStorageKey(sessionId, canvasTabKey(stableTarget)), [sessionId, stableTarget])
  const receive = useCallback((next: CanvasDocument | null, preserveError = false) => {
    setState((previous) => {
      if (!next) return { ...previous, loaded: true }
      if (previous.document && isOlderDocument(previous.document, next)) return previous
      return { ...previous, document: next, loaded: true, error: preserveError ? previous.error : null }
    })
  }, [])
  const refresh = useCallback(async (signal: AbortSignal, preserveError = false) => {
    try { const next = await requestCanvasDocument(sessionId, stableTarget, signal); if (!signal.aborted) receive(next, preserveError) }
    catch (cause) { if (!signal.aborted) setState((value) => ({ ...value, loaded: true, error: preserveError && value.error ? value.error : message(cause) })) }
  }, [receive, sessionId, stableTarget])
  useEffect(() => {
    const controller = new AbortController()
    scope.current = controller
    try {
      const draft = readCanvasDraft(storageKey)
      setState({ ...initial, draft })
      setRecoverable(findRecoverableCanvasDraft(storageKey))
    } catch (cause) { setState({ ...initial, error: `The local draft could not be restored: ${message(cause)}` }) }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`canvas-document:${canvasDocumentUrl(sessionId, stableTarget)}`)
    changes.current = channel
    // Refresh owns its error state; browser event handlers need no promise.
    const reload = () => { void refresh(controller.signal) }
    if (channel) channel.onmessage = reload
    window.addEventListener('focus', reload)
    reload()
    return () => { controller.abort(); scope.current = null; activeMutation.current = null; pendingProposal.current = null; channel?.close(); changes.current = null; window.removeEventListener('focus', reload) }
  }, [refresh, sessionId, stableTarget, storageKey])
  const persistDraft = useCallback((draft: CanvasDraft | null) => {
    try {
      if (draft) localStorage.setItem(storageKey, JSON.stringify(draft)); else localStorage.removeItem(storageKey)
      setState((value) => value.draftPersistenceError === null ? value : { ...value, draftPersistenceError: null })
    } catch (cause) { setState((value) => ({ ...value, draftPersistenceError: `Your draft could not be saved locally. Keep this window open: ${message(cause)}` })) }
  }, [storageKey])
  const edit = (content: string) => {
    if (!state.document) return
    const changingRevision = state.busy === 'save' || state.busy === 'accept'
    const draft = content === state.document.content && !changingRevision ? null : { baseRevision: state.draft?.baseRevision ?? state.document.revision, baseContent: state.draft?.baseContent ?? state.document.content, content }
    setState((value) => ({ ...value, draft }))
    persistDraft(draft)
  }
  const mutate = async (action: CanvasDocumentAction) => {
    const signal = scope.current?.signal
    if (!signal || signal.aborted) return
    const token = Symbol()
    activeMutation.current = token
    if (action.kind === 'propose' && state.document) pendingProposal.current = { token, action, generation: (state.document.proposal?.generation ?? 0) + 1, snapshotDigest: state.document.snapshotDigest, signal }
    setState((value) => ({ ...value, busy: action.kind, error: null }))
    try {
      const next = await requestCanvasDocument(sessionId, stableTarget, signal, action)
      if (signal.aborted) return
      receive(next, activeMutation.current !== token)
      if (action.kind === 'save' && next) {
        setState((value) => {
          if (value.document?.revision !== next.revision || value.document.content !== action.content || !value.draft) return value
          const draft = value.draft.content === action.content ? null : value.draft.baseRevision === action.expectedRevision ? { ...value.draft, baseRevision: next.revision, baseContent: next.content } : value.draft
          persistDraft(draft)
          return { ...value, draft }
        })
      }
      changes.current?.postMessage(null)
    } catch (cause) {
      if (!signal.aborted && activeMutation.current === token) { setState((value) => ({ ...value, error: message(cause) })); await refresh(signal, true) }
    } finally {
      if (pendingProposal.current?.token === token) pendingProposal.current = null
      if (!signal.aborted && activeMutation.current === token) setState((value) => ({ ...value, busy: null }))
    }
  }
  const discardGenerating = async () => {
    const pending = pendingProposal.current
    if (!pending || pending.signal.aborted) return
    try {
      const current = await requestCanvasDocument(sessionId, stableTarget, pending.signal)
      if (pending.signal.aborted || pendingProposal.current !== pending) return
      receive(current)
      const proposal = current?.proposal
      if (!proposal) throw new CanvasDocumentRequestError('proposal_not_admitted', 'The revision request is not yet admitted. Try discarding again.')
      if (!matchesPendingCapture(proposal, pending) || proposal.status === 'applied' || proposal.status === 'superseded') throw new CanvasDocumentRequestError('proposal_changed', 'The revision request changed. Review the current proposal before discarding it.')
      if (proposal.status === 'discarded') {
        if (activeMutation.current === pending.token) setState((value) => ({ ...value, busy: null }))
        return
      }
      await mutate({ kind: 'discard', target: stableTarget, proposalId: proposal.id })
    } catch (cause) {
      if (!pending.signal.aborted && pendingProposal.current === pending) setState((value) => ({ ...value, error: message(cause) }))
    }
  }
  const dirty = state.draft !== null
  useEffect(() => {
    if (!dirty) return
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [dirty])
  return { ...state, error: state.draftPersistenceError ?? state.error, dirty, recoverable, edit, mutate, discardGenerating, discardDraft: () => { persistDraft(null); setState((value) => ({ ...value, draft: null })) }, recoverDraft: () => {
    if (!recoverable) return
    persistDraft(recoverable.draft)
    setState((value) => ({ ...value, draft: recoverable.draft }))
    setRecoverable(null)
  } }
}
