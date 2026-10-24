import { beforeEach, expect, it } from 'vitest'
import { canvasDraftStorageKey, findRecoverableCanvasDraft, readCanvasDraft } from '../canvas-draft-storage'

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })

it.each(['{broken', '{"unexpected":"shape"}'])('preserves this window draft when another window has invalid stored data: %s', (invalid) => {
  const ownKey = canvasDraftStorageKey('session', 'document')
  const prefix = ownKey.slice(0, ownKey.lastIndexOf(':') + 1)
  const own = { baseRevision: 1, baseContent: 'Saved text', content: 'My local edits' }
  const other = { baseRevision: 1, baseContent: 'Saved text', content: 'Recoverable other edits' }
  localStorage.setItem(ownKey, JSON.stringify(own))
  localStorage.setItem(`${prefix}invalid`, invalid)
  localStorage.setItem(`${prefix}valid`, JSON.stringify(other))

  expect(findRecoverableCanvasDraft(ownKey)).toEqual({ key: `${prefix}valid`, draft: other })
  expect(readCanvasDraft(ownKey)).toEqual(own)
  expect(localStorage.getItem(`${prefix}invalid`)).toBe(invalid)
})
