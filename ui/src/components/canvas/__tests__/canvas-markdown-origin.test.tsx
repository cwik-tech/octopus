import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { canvasTabKey } from '@contracts/canvas-workspace'
import { CanvasContext, type CanvasController } from '../canvas-context'
import { CanvasPanel } from '../canvas-panel'

afterEach(() => vi.unstubAllGlobals())

it('opens its saved working copy even when the original file is unavailable', async () => {
  const target = { runId: 'origin-run', artifactPath: 'files/report.md' }
  const sessionId = 'ad605beb-dadc-403a-bca4-b05df6e00004'
  const controller: CanvasController = { sessionId, workspace: { schemaVersion: 1, revision: 1, tabs: [target], activeKey: canvasTabKey(target) }, error: null, hidden: false, requested: true, expanded: false, detached: false, standalone: false, opening: false, canDetach: false, detach: () => {}, act: () => {}, open: () => {}, show: () => {}, hide: () => {}, toggleExpanded: () => {} }
  // jsdom has no desktop HTTP server; only that boundary is replaced. The
  // Electron save/reopen journey checks the actual retained file behavior.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => String(url).includes('/document?')
    ? Response.json({ schemaVersion: 1, id: 'c'.repeat(64), sessionId, origin: target, snapshotDigest: 'd'.repeat(64), revision: 3, content: '# Saved working copy\n\nKeep these edits.', proposal: null })
    : Response.json({ error: 'Original file no longer exists' }, { status: 404 })))
  render(<CanvasContext value={controller}><CanvasPanel /></CanvasContext>)

  expect(await screen.findByRole('textbox', { name: 'Markdown document' })).toHaveValue('# Saved working copy\n\nKeep these edits.')
})
