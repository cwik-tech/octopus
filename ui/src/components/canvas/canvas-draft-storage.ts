import { z } from 'zod'
import { CANVAS_DOCUMENT_MAX_BYTES } from '@contracts/canvas-documents'

export const canvasDraftSchema = z.strictObject({ baseRevision: z.number().int().nonnegative(), baseContent: z.string().max(CANVAS_DOCUMENT_MAX_BYTES), content: z.string().max(CANVAS_DOCUMENT_MAX_BYTES) })
export type CanvasDraft = z.infer<typeof canvasDraftSchema>
const ownerKey = 'pipeline-canvas-draft-owner'

export function canvasDraftStorageKey(sessionId: string, documentKey: string) {
  let owner = sessionStorage.getItem(ownerKey)
  if (!owner) { owner = crypto.randomUUID(); sessionStorage.setItem(ownerKey, owner) }
  return `pipeline-canvas-draft:${JSON.stringify([sessionId, documentKey])}:${owner}`
}

export function readCanvasDraft(key: string): CanvasDraft | null {
  const value = localStorage.getItem(key)
  if (!value) return null
  const raw: unknown = JSON.parse(value)
  return canvasDraftSchema.parse(raw)
}

export function findRecoverableCanvasDraft(key: string): { key: string; draft: CanvasDraft } | null {
  const prefix = key.slice(0, key.lastIndexOf(':') + 1)
  for (let index = 0; index < localStorage.length; index += 1) {
    const candidate = localStorage.key(index)
    if (candidate && candidate !== key && candidate.startsWith(prefix)) {
      try {
        const draft = readCanvasDraft(candidate)
        if (draft) return { key: candidate, draft }
      } catch (cause) {
        // Another window's corrupt entry cannot invalidate this window's
        // draft. Leave its bytes intact and continue to valid recoveries.
        if (!(cause instanceof SyntaxError || cause instanceof z.ZodError)) throw cause
      }
    }
  }
  return null
}
