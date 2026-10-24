/**
 * Team Runtime — Verdict Parser
 *
 * Shared utility for parsing a string verdict out of LLM response text.
 * Extracts the first non-empty line and matches it against an allowed set.
 * Extracted from engines/review.ts and engines/gate-checker.ts (was duplicated).
 */

/**
 * Parse the first non-empty line of `text` and return it if it matches one of
 * the `allowed` values (case-insensitive).  Returns `null` if no match found.
 */
export function parseVerdict<T extends string>(text: string, allowed: readonly T[]): T | null {
  const firstNonEmptyLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (!firstNonEmptyLine) return null

  const normalized = firstNonEmptyLine.toUpperCase()
  return allowed.find((value) => value === normalized) ?? null
}

/**
 * Parse a verdict from an explicit XML-like tag anywhere in the response text.
 * Returns the tagged verdict only when exactly one valid tagged verdict appears.
 */
export function parseTaggedVerdict<T extends string>(
  text: string,
  allowed: readonly T[],
  tagName: string,
): T | null {
  const pattern = new RegExp(`<${tagName}>\\s*([A-Za-z_ -]+?)\\s*</${tagName}>`, 'gi')
  let match: RegExpExecArray | null
  let matchedVerdict: T | null = null
  let validCount = 0

  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[1]?.trim().toUpperCase()
    const verdict = candidate ? allowed.find((value) => value === candidate) ?? null : null
    if (verdict) {
      matchedVerdict = verdict
      validCount++
      if (validCount > 1) return null
    }
  }

  return validCount === 1 ? matchedVerdict : null
}

/**
 * Normalize review feedback so persisted artifacts begin at the canonical
 * decision signal instead of keeping preamble chatter.
 */
export function canonicalizeReviewFeedback<T extends string>(
  text: string,
  allowed: readonly T[],
  tagName: string,
): string {
  const trimmed = text.trim()
  if (!trimmed) return ''

  if (parseTaggedVerdict(trimmed, allowed, tagName)) {
    const pattern = new RegExp(`<${tagName}>\\s*([A-Za-z_ -]+?)\\s*</${tagName}>`, 'gi')
    let match: RegExpExecArray | null
    let matchedIndex = -1
    let validCount = 0

    while ((match = pattern.exec(trimmed)) !== null) {
      const candidate = match[1]?.trim().toUpperCase()
      const verdict = candidate ? allowed.find((value) => value === candidate) ?? null : null
      if (verdict) {
        matchedIndex = match.index
        validCount++
      }
    }

    if (validCount === 1 && matchedIndex >= 0) {
      return trimmed.slice(matchedIndex).trim()
    }
  }

  const lines = trimmed.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const normalized = lines[index]?.trim().toUpperCase()
    if (normalized && allowed.includes(normalized as T)) {
      return lines.slice(index).join('\n').trim()
    }
  }

  return trimmed
}
