/**
 * Job Title Sanitizer
 *
 * Pure string utilities for turning raw model output (or contract values)
 * into a clean 2-6 word execution-card headline. No provider/IO dependencies
 * so it is safe to import from both the engine path (writing the contract)
 * and the read path (`domains/run/run-store.ts`, used by `server/api-server.ts`).
 */

const MAX_WORDS = 8
const MAX_CHARS = 70

const TASK_PREFIX_PATTERN =
  /^(write|create|build|make|generate|draft|produce|prepare|evaluate|assess|analy[sz]e|review|summari[sz]e|investigate|research)\b/i

const GENERIC_TITLE_PATTERNS: RegExp[] = [
  /^write\s+(?:a\s+|an\s+|the\s+)?(?:concise\s+)?one[- ]page\s+(report|overview)$/i,
  /^write\s+(?:a\s+|an\s+|the\s+)?(?:concise\s+)?one[- ]pager$/i,
  /^(create|build|make|generate|draft|produce|prepare)\s+(?:a\s+|an\s+|the\s+)?(report|overview|memo|analysis|summary|profile)$/i,
  /^(evaluate|assess|analy[sz]e|review)\s+(?:a\s+|an\s+|the\s+)?(deal|company|startup|request|brief)$/i,
]

const NARRATION_PATTERNS: RegExp[] = [
  /^i['’]?m\b/i,
  /^i\s+(will|am|need|should|have|'?ll)\b/i,
  /^let\s+me\b/i,
  /^first[,\s]/i,
  /^reading\b/i,
  /^analy[sz]ing\b/i,
  /^thinking\b/i,
  /^okay\b/i,
  /^sure\b/i,
  /^here['’]?s\b/i,
  /^the\s+(user|request|brief|input)\b/i,
  /\bprompt\.md\b/i,
  /```/,
]

export function looksLikeNarration(line: string): boolean {
  return NARRATION_PATTERNS.some((pattern) => pattern.test(line))
}

export function cleanCandidate(line: string): string {
  return line
    .replace(/^[#>*\-•\s]+|[\s]+$/g, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeForTitleComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isLazyPrefixOfBrief(title: string, brief: string): boolean {
  const t = normalizeForTitleComparison(title)
  const b = normalizeForTitleComparison(brief)
  if (!t || !b) return false
  return b.startsWith(t)
}

export function isGenericRequestTitle(title: string): boolean {
  const cleaned = cleanCandidate(title)
  if (!cleaned) return true
  if (GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(cleaned))) return true
  return TASK_PREFIX_PATTERN.test(cleaned) && cleaned.split(' ').length <= 5
}

export function isUsableJobTitle(title: string, brief?: string): boolean {
  const cleaned = cleanCandidate(title)
  if (!cleaned || looksLikeNarration(cleaned)) return false
  if (isGenericRequestTitle(cleaned)) return false
  if (brief && isLazyPrefixOfBrief(cleaned, brief)) return false
  return true
}

function stripBriefNoise(text: string): string {
  return text
    .replace(/\s+Use the active parsed input bundle at\s+["'][\s\S]*$/i, '')
    .replace(/\s+Use the active parsed input bundle at\s+[\s\S]*$/i, '')
    .replace(/\s+Use the provided.*$/i, '')
    .replace(/\s+Use the materials.*$/i, '')
    .replace(/\s+using the active parsed input bundle.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleCase(text: string): string {
  return text
    .replace(/\bversus\b/gi, 'vs')
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      if (word.toLowerCase() === 'vs') return 'vs'
      if (/^[A-Z0-9]{2,}$/.test(word)) return word
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(' ')
}

function cleanSubject(raw: string): string {
  return raw
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+for\s+(?:a|an|the)\s+.*$/i, '')
    .replace(/\s+for\s+general\s+.*$/i, '')
    .replace(/\s+from\s+the\s+perspective\s+.*$/i, '')
    .replace(/\s+using\s+.*$/i, '')
    .replace(/[.!?;:]+$/g, '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildFallbackTitle(subject: string, suffix: string): string | null {
  const normalizedSubject = titleCase(cleanSubject(subject))
  if (!normalizedSubject) return null
  const title = `${normalizedSubject} ${suffix}`
  return sanitizeRawTitle(title)
}

/**
 * Derive a concise, subject-focused title from a free-form brief.
 *
 * This is intentionally domain-neutral so sessions, jobs, and run cards use
 * the same deterministic fallback when an LLM title is unavailable.
 */
export function deriveTitleFromBrief(brief: string): string | null {
  const cleanedBrief = stripBriefNoise(brief)
  if (!cleanedBrief) return null

  const dealMatch = cleanedBrief.match(
    /\b(?:evaluate|assess|review|analy[sz]e)\s+(?:the\s+)?((?:pre[- ]seed|seed|series\s+[a-z])[^.,;]*?)\s+(?:for|of)\s+(.+?)(?=\.|,|;|\s+from\b|\s+using\b|$)/i,
  )
  const dealStage = dealMatch?.[1]
  const dealSubject = dealMatch?.[2]
  if (dealStage && dealSubject) {
    return buildFallbackTitle(`${dealSubject} ${dealStage}`, 'Review')
  }

  const memoMatch = cleanedBrief.match(
    /\b(?:memo|one[- ]pager|one[- ]page\s+report|one[- ]page\s+overview|report|overview|profile)\s+(?:on|of|about)\s+(.+?)(?=\s+for\s+(?:a|an|the|general)\b|\.|,|;|$)/i,
  )
  const memoSubject = memoMatch?.[1]
  if (memoSubject) {
    const suffix = /\bmemo\b/i.test(cleanedBrief) ? 'Memo' : 'Overview'
    return buildFallbackTitle(memoSubject, suffix)
  }

  const analysisMatch = cleanedBrief.match(
    /\b(?:competitive\s+analysis|analysis)\s+(?:for|of|on)\s+(.+?)(?=\.|,|;|\s+for\s+(?:a|an|the)\b|$)/i,
  )
  const analysisSubject = analysisMatch?.[1]
  if (analysisSubject) {
    return buildFallbackTitle(analysisSubject, 'Analysis')
  }

  const aboutMatch = cleanedBrief.match(
    /\b(?:about|on|of)\s+(.+?)(?=\s+for\s+(?:a|an|the|general)\b|\.|,|;|$)/i,
  )
  const aboutSubject = aboutMatch?.[1]
  if (aboutSubject) {
    return buildFallbackTitle(aboutSubject, 'Overview')
  }

  const actionMatch = cleanedBrief.match(
    /^(?:investigate|research|summari[sz]e|review|evaluate|assess|analy[sz]e|write|create|build|draft|prepare)\s+(?:a\s+|an\s+|the\s+)?(.+?)(?=\.|,|;|\s+for\s+(?:a|an|the|general)\b|$)/i,
  )
  const actionSubject = actionMatch?.[1]
  if (actionSubject) {
    const suffix = /^(investigate|research)/i.test(cleanedBrief) ? 'Research' : 'Overview'
    return buildFallbackTitle(actionSubject, suffix)
  }

  return sanitizeRawTitle(titleCase(cleanedBrief))
}

/**
 * Reduce a possibly-multiline raw model response to a clean Title-case headline.
 * Picks the last narration-free line, truncates to MAX_WORDS / MAX_CHARS, and
 * returns `null` if nothing usable remains so the caller can fall back.
 */
export function sanitizeRawTitle(raw: string): string | null {
  const lines = raw
    .split('\n')
    .map(cleanCandidate)
    .filter((line) => line.length > 0)
  if (lines.length === 0) return null

  const reversed = [...lines].reverse()
  const candidate =
    reversed.find(
      (line) => !looksLikeNarration(line) && line.split(' ').length <= MAX_WORDS + 2,
    ) ?? reversed.find((line) => !looksLikeNarration(line))
  if (!candidate) return null

  const truncatedWords = candidate.split(' ').slice(0, MAX_WORDS).join(' ')
  const finalTitle = truncatedWords.slice(0, MAX_CHARS).trim()
  if (!finalTitle || looksLikeNarration(finalTitle)) return null
  return finalTitle
}
