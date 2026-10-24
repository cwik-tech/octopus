import { estimateContextTokens } from '../../core/context-tokens.js'
import { resolveContextWindow } from '../provider/context-window.js'
import { modelImageSchema } from '../../contracts/model-image.js'
export class DocumentRequestBudgetError extends Error {
  constructor(tokens: number, inputLimit: number) {
    super(`Document request budget exceeded: ${tokens} estimated tokens; limit ${inputLimit}. Reduce the request or read smaller ranges.`)
    this.name = 'DocumentRequestBudgetError'
  }
}

/** Bound the complete request envelope, including every accumulated tool result. */
export function assertDocumentRequestBudget(input: { provider: string; model: string; request: unknown; connectionKind?: string }) {
  const window = resolveContextWindow(input)
  const inputLimit = Math.min(64_000, Math.max(1_024, window.tokens - 4_096))
  let imageTokens = 0
  const serialized = JSON.stringify(input.request, (_key: string, value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || !('mimeType' in value) || !('data' in value)) return value
    const image = modelImageSchema.safeParse(value)
    if (!image.success) return value
    // Captured previews have a 1200px longest edge. Reserve a conservative
    // visual allowance instead of charging base64 encoding as natural language.
    imageTokens += 4_096
    return { mimeType: image.data.mimeType, data: '[visual input]' }
  })
  const tokens = estimateContextTokens(serialized ?? '') + imageTokens
  if (tokens > inputLimit) throw new DocumentRequestBudgetError(tokens, inputLimit)
}
