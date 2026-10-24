import { CanvasWordSnapshot } from './canvas-word-snapshot'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { PenLine } from 'lucide-react'
import type { CanvasTab } from '@contracts/canvas-workspace'
import { Button } from '@/components/ui/button'
import { MarkdownViewer } from '@/components/markdown-viewer'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { useCanvasDocument } from './use-canvas-document'

export interface CanvasMarkdownDocumentProps {
  sessionId: string
  target: CanvasTab
  originContent: string | null
  onOpenArtifact?: (target: CanvasTab) => void
  editActionTarget?: HTMLElement | null
}

export function CanvasMarkdownDocument({ sessionId, target, originContent, onOpenArtifact, editActionTarget }: CanvasMarkdownDocumentProps) {
  // UI handlers deliberately void controller requests; the controller catches
  // failures and retains them in the visible document state.
  const model = useCanvasDocument(sessionId, target)
  const [instruction, setInstruction] = useState('')
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [reviewing, setReviewing] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const document = model.document
  const content = model.draft?.content ?? document?.content ?? originContent ?? ''
  const stale = model.draft !== null && document !== null && model.draft.baseRevision !== document.revision
  const proposal = document?.proposal
  const activeProposal = proposal && ['generating', 'ready', 'conflicted', 'failed'].includes(proposal.status) ? proposal : null
  const editAction = !document ? <Button aria-label="Edit Markdown" title="Edit Markdown" size="icon-sm" variant="ghost" disabled={!model.loaded || model.busy !== null} onClick={() => { void model.mutate({ kind: 'create', target }) }}><PenLine className="size-4" /></Button> : null
  return <div className="flex min-h-full flex-col gap-3">
    {editActionTarget === undefined ? editAction : editActionTarget ? createPortal(editAction, editActionTarget) : null}
    {model.error ? <p role="alert" className="text-sm text-destructive">{model.error}</p> : null}
    {!document ? <>
      {originContent === null ? <p className="text-sm text-muted-foreground">{model.loaded ? 'Original preview unavailable. A saved working copy remains independent of this file.' : 'Loading document…'}</p> : <MarkdownViewer content={originContent} artifactRunId={target.runId} currentArtifactPath={target.artifactPath} {...(onOpenArtifact ? { onOpenArtifact } : {})} />}
    </> : <>
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">{model.busy === 'save' ? 'Saving…' : model.dirty ? 'Unsaved changes' : 'All changes saved'}</p>
        <Button size="sm" variant="outline" onClick={() => setPreviewing((value) => !value)}>{previewing ? 'Edit source' : 'Preview Markdown'}</Button>
        {model.dirty ? <Button size="sm" variant="ghost" disabled={model.busy !== null} onClick={model.discardDraft}>Discard local changes</Button> : null}
        <Button size="sm" disabled={!model.dirty || stale || model.busy !== null} onClick={() => { void model.mutate({ kind: 'save', target, expectedRevision: model.draft?.baseRevision ?? document.revision, content }) }}>Save changes</Button>
      </div>
      {model.recoverable && !model.dirty ? <Button size="sm" variant="outline" className="h-auto whitespace-normal py-2 text-left" onClick={model.recoverDraft}>Recover unsaved draft from another window</Button> : null}
      {stale ? <div className="space-y-2 rounded-lg border p-3 text-sm"><p>A newer saved revision is available. Your draft has been kept.</p><Button size="sm" variant="outline" onClick={() => setReviewing((value) => !value)}>Review saved revision</Button>{reviewing ? <><pre aria-label="Draft base Markdown" className="whitespace-pre-wrap break-words">{model.draft?.baseContent}</pre><pre aria-label="Current saved Markdown" className="whitespace-pre-wrap break-words">{document.content}</pre><Button size="sm" variant="outline" className="h-auto whitespace-normal py-2 text-left" onClick={model.discardDraft}>Discard local draft and use saved revision</Button></> : null}</div> : null}
      {previewing ? <MarkdownViewer content={content} artifactRunId={target.runId} currentArtifactPath={target.artifactPath} {...(onOpenArtifact ? { onOpenArtifact } : {})} /> : <Textarea aria-label="Markdown document" value={content} spellCheck={false} className="min-h-64 flex-1 resize-y font-mono text-sm" onChange={(event) => model.edit(event.currentTarget.value)} onSelect={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} />}
      <div className="space-y-2 border-t pt-3">
        <label htmlFor={`canvas-instruction-${document.id}`} className="text-sm font-medium">Revise selected text</label>
        <Input id={`canvas-instruction-${document.id}`} aria-label="Revision instruction" value={instruction} maxLength={8000} placeholder="Describe the change for the selected text" onChange={(event) => setInstruction(event.currentTarget.value)} />
        <Button size="sm" variant="outline" disabled={model.dirty || model.busy !== null || !instruction.trim() || previewing} onClick={() => { void model.mutate({ kind: 'propose', target, expectedRevision: document.revision, selectionStart: selection.start, selectionEnd: selection.end, selectedText: content.slice(selection.start, selection.end), instruction }) }}>Request revision</Button>
        {model.busy === 'propose' ? <div className="flex items-center gap-2"><p className="text-xs text-muted-foreground">Generating revision…</p><Button size="sm" variant="outline" onClick={() => { void model.discardGenerating() }}>Discard pending revision</Button></div> : null}
        {model.dirty ? <p className="text-xs text-muted-foreground">Save or discard your local edits before requesting or accepting a revision.</p> : null}
      </div>
      <CanvasWordSnapshot key={`${sessionId}:${document.id}`} sessionId={sessionId} target={target} revision={document.revision} disabled={model.dirty || model.busy !== null} />
      {activeProposal ? <section aria-label="Agent revision review" className="space-y-2 rounded-lg border p-3 text-sm">
        <p className="font-medium">{activeProposal.status === 'generating' ? 'Generating revision…' : activeProposal.status === 'conflicted' ? 'This revision conflicts with newer saved text.' : activeProposal.status === 'failed' ? 'The revision could not be generated. Request a new revision to try again.' : 'Review proposed revision'}</p>
        <pre aria-label="Captured selection" className="whitespace-pre-wrap">{activeProposal.selectedText || '(insertion)'}</pre>
        {activeProposal.replacementText !== null ? <pre aria-label="Proposed replacement" className="whitespace-pre-wrap">{activeProposal.replacementText}</pre> : null}
        {activeProposal.status === 'conflicted' ? <><pre aria-label="Proposal base Markdown" className="whitespace-pre-wrap">{activeProposal.baseContent}</pre><pre aria-label="Current proposal Markdown" className="whitespace-pre-wrap">{document.content}</pre><p>Select the intended text in the current saved document, then request a new revision.</p></> : null}
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={activeProposal.status !== 'ready' || model.dirty || model.busy !== null || activeProposal.baseRevision !== document.revision} onClick={() => { void model.mutate({ kind: 'accept', target, proposalId: activeProposal.id, hasUnsavedDraft: model.dirty }) }}>Accept revision</Button><Button size="sm" variant="outline" disabled={model.busy !== null && model.busy !== 'propose'} onClick={() => { void model.mutate({ kind: 'discard', target, proposalId: activeProposal.id }) }}>Discard revision</Button></div>
      </section> : null}
    </>}
  </div>
}
