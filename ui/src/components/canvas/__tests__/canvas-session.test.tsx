import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { CanvasSession } from '../canvas-session'
import { CanvasToggle } from '../canvas-panel'
import { useCanvas } from '../canvas-context'

function Composer() {
  const [draft, setDraft] = useState('')
  return <input aria-label="Unsent reply" value={draft} onChange={(event) => setDraft(event.target.value)} />
}
function CanvasVisibility() {
  const canvas = useCanvas()
  return <p>{canvas?.requested ? 'Canvas requested' : 'Canvas not requested'}</p>
}

it('materializing a draft chat preserves the existing composer subtree and unsent text', () => {
  const view = render(<CanvasSession sessionId={null}><Composer /></CanvasSession>)
  const input = screen.getByRole('textbox', { name: 'Unsent reply' })
  fireEvent.change(input, { target: { value: 'Keep my unsent reply' } })
  view.rerender(<CanvasSession sessionId="ad605beb-dadc-403a-bca4-b05df6e00001"><Composer /></CanvasSession>)
  expect(screen.getByRole('textbox', { name: 'Unsent reply' })).toBe(input)
  expect(input).toHaveValue('Keep my unsent reply')
})

it('the Canvas action opens an empty workspace before any file has been opened', () => {
  render(<CanvasSession sessionId="ad605beb-dadc-403a-bca4-b05df6e00001"><CanvasToggle /><CanvasVisibility /></CanvasSession>)
  fireEvent.click(screen.getByRole('button', { name: 'Canvas' }))
  expect(screen.getByText('Canvas requested')).toBeVisible()
})
