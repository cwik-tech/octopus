export interface ObservedWebSource {
  readonly url: string
  readonly title?: string
  readonly text: string
}

/**
 * The host, not the model, owns whether a turn requires research evidence.
 * `researchQuestion` stays at the caller interface during migration; the
 * service converts it into this once, at the boundary.
 */
export type WebEvidenceTurnMode =
  | { readonly kind: 'not-required' }
  | { readonly kind: 'required'; readonly question: string }

/**
 * The Capability A decision: either the accepted answer with its URL spellings
 * rewritten to the canonical URLs the runtime holds, or a fail-closed
 * rejection with a reason code and the content-free counts telemetry needs.
 */
export type WebResearchLinkDecision =
  | {
      readonly kind: 'accepted'
      readonly answer: string
      readonly citedUrlCount: number
      readonly observedUrlCount: number
    }
  | {
      readonly kind: 'insufficient'
      readonly reason:
        | 'answer_empty'
        | 'answer_declared_insufficient'
        | 'unobserved_url'
        | 'not_enough_relevant_sources'
      readonly citedUrlCount: number
      readonly observedUrlCount: number
      readonly unobservedUrlCount: number
    }

export function decideWebResearchLinks(input: {
  readonly question: string
  readonly answer: string
  readonly sources: readonly ObservedWebSource[]
}): WebResearchLinkDecision {
  // 1. Normalize and deduplicate the runtime observation registry. Two views
  // over the same survivor set: the normalized view drives matching, and the
  // canonical view keeps the exact URL the runtime holds for the rewrite. The
  // survivor itself is retained — never a raw URL to look up again — so
  // selection stays a pure function of the observation set rather than of
  // which duplicate arrived first.
  const canonicalByNormalized = new Map<string, ObservedWebSource>()
  for (const source of input.sources) {
    const normalized = normalizeUrl(source.url)
    if (!normalized) continue
    const previous = canonicalByNormalized.get(normalized)
    if (!previous || outranksObservedWebSource(source, previous)) {
      canonicalByNormalized.set(normalized, source)
    }
  }
  const deduplicated = deduplicateSources(input.sources)
  const observedUrlCount = deduplicated.length

  const insufficient = (
    reason:
      | 'answer_empty'
      | 'answer_declared_insufficient'
      | 'unobserved_url'
      | 'not_enough_relevant_sources',
    citedUrlCount: number,
    unobservedUrlCount: number,
  ): WebResearchLinkDecision => ({
    kind: 'insufficient',
    reason,
    citedUrlCount,
    observedUrlCount,
    unobservedUrlCount,
  })

  const answer = stripTrailingFollowUpInvitation(input.answer)
  if (!answer) return insufficient('answer_empty', 0, 0)
  if (INSUFFICIENT_PATTERN.test(answer)) {
    return insufficient('answer_declared_insufficient', 0, 0)
  }

  // 2. Extract every HTTP or HTTPS URL from the candidate answer, in any case
  // the scheme can validly be spelled. A case-sensitive pattern would let an
  // uppercase `HTTPS://` sail past the observation check entirely. (The
  // legacy guard below keeps its historical extractor; this path is the one
  // that fails closed.)
  const citedSpellings = extractUrlsCaseInsensitive(answer)
  const citedNormalized = new Set(
    citedSpellings.map(normalizeUrl).filter(Boolean),
  )
  const invalidSpellingCount = new Set(
    citedSpellings.filter((spelling) => !normalizeUrl(spelling)),
  ).size

  // 3. Any URL that matches no runtime observation rejects the whole answer.
  // Other valid citations cannot offset it, and a spelling the URL parser
  // cannot read is one the registry can never vouch for.
  const unobserved = [...citedNormalized].filter(
    (normalized) => !canonicalByNormalized.has(normalized),
  )
  const unobservedUrlCount = unobserved.length + invalidSpellingCount
  if (unobservedUrlCount > 0) {
    return insufficient(
      'unobserved_url',
      citedNormalized.size,
      unobservedUrlCount,
    )
  }

  // 4. The existing question relevance and independent-host count rules.
  const requiredSourceCount = RECOMMENDATION_PATTERN.test(input.question) ? 2 : 1
  const questionTokens = significantTokens(input.question)
  const requestedUrls = new Set(
    extractUrls(input.question).map(normalizeUrl).filter(Boolean),
  )
  const relevantSources = deduplicated.filter((source) =>
    requestedUrls.has(normalizeUrl(source.url)) ||
    isRelevantSource(source, questionTokens))
  const citedRelevantHosts = new Set(
    relevantSources.flatMap((source) => {
      const normalized = normalizeUrl(source.url)
      if (!normalized || !citedNormalized.has(normalized)) return []
      const host = independentHost(normalized)
      return host ? [host] : []
    }),
  )
  if (citedRelevantHosts.size < requiredSourceCount) {
    return insufficient(
      'not_enough_relevant_sources',
      citedNormalized.size,
      0,
    )
  }

  // 5. Replace accepted URL spellings with the exact canonical URL held by
  // the runtime. One pass, so a replaced prefix can never corrupt a longer
  // neighbouring URL, and trailing punctuation stays where the model put it.
  const rewritten = answer.replace(/https?:\/\/[^\s<]+/gi, (spelling) => {
    const trimmed = spelling.replace(/[),.;:!?\]}]+$/g, '')
    const canonical = canonicalByNormalized.get(normalizeUrl(trimmed))?.url
    return canonical === undefined
      ? spelling
      : canonical + spelling.slice(trimmed.length)
  })

  // 6. Return only the accepted answer; rejections returned above carry no
  // candidate text.
  return {
    kind: 'accepted',
    answer: rewritten,
    citedUrlCount: citedNormalized.size,
    observedUrlCount,
  }
}

export const INSUFFICIENT_WEB_RESEARCH_RESPONSE =
  "I couldn't verify a reliable answer from enough relevant, independently observed sources. The accessible pages were blocked, unavailable, or did not directly support the requested claim."

const RECOMMENDATION_PATTERN =
  /\b(best|better|top|recommend(?:ation|ations|ed)?|ranking|ranked|compare|comparison|versus|vs\.?|which (?:one|place|product|service))\b/i

const INSUFFICIENT_PATTERN =
  /\b(insufficient evidence|not enough (?:relevant )?(?:evidence|sources)|could not verify|couldn't verify|unable to verify)\b/i

const TRAILING_INVITATION_PATTERNS = [
  /\s*\bIf you want\b[\s\S]*$/i,
  /\s*\bWould you like\b[\s\S]*$/i,
  /\s*\bLet me know if\b[\s\S]*$/i,
]

const STOP_WORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'best', 'better',
  'can', 'compare', 'comparison', 'could', 'current', 'currently', 'do',
  'find', 'for', 'from', 'give', 'how', 'i', 'in', 'is', 'it', 'latest',
  'me', 'most', 'of', 'on', 'or', 'please', 'ranked', 'ranking',
  'recommend', 'recommendation', 'recommendations', 'recommended', 'research',
  'should', 'tell', 'the', 'this', 'to', 'top', 'versus', 'vs', 'what',
  'when', 'where', 'which', 'who', 'why', 'with', 'would', 'you',
])

export function enforceWebResearchEvidence(input: {
  readonly question: string
  readonly answer: string
  readonly sources: readonly ObservedWebSource[]
}): string {
  const answer = stripTrailingFollowUpInvitation(input.answer)
  if (!answer || INSUFFICIENT_PATTERN.test(answer)) {
    return INSUFFICIENT_WEB_RESEARCH_RESPONSE
  }

  const requiredSourceCount = RECOMMENDATION_PATTERN.test(input.question) ? 2 : 1
  const questionTokens = significantTokens(input.question)
  const requestedUrls = new Set(
    extractUrls(input.question).map(normalizeUrl).filter(Boolean),
  )
  const relevantSources = deduplicateSources(input.sources)
    .filter((source) =>
      requestedUrls.has(normalizeUrl(source.url)) ||
      isRelevantSource(source, questionTokens))
  const citedUrls = new Set(extractUrls(answer).map(normalizeUrl).filter(Boolean))
  const citedRelevantHosts = new Set(
    relevantSources.flatMap((source) => {
      const normalized = normalizeUrl(source.url)
      if (!normalized || !citedUrls.has(normalized)) return []
      const host = independentHost(normalized)
      return host ? [host] : []
    }),
  )

  return citedRelevantHosts.size >= requiredSourceCount
    ? answer
    : INSUFFICIENT_WEB_RESEARCH_RESPONSE
}

export function stripTrailingFollowUpInvitation(value: string): string {
  let result = value.trim()
  for (const pattern of TRAILING_INVITATION_PATTERNS) {
    result = result.replace(pattern, '').trim()
  }
  return result
}

/**
 * Total order over observations of one URL so the retained record is a pure
 * function of the observation set, independent of arrival order: longest text
 * wins; equal lengths break on lexicographically greater text, then title,
 * then the raw URL spelling. Without that last rung, two observations that
 * normalize to one canonical URL with identical title and text tie, and the
 * survivor falls back to arrival order.
 *
 * Every dedupe of `ObservedWebSource` must use this comparator. Retention that
 * falls back to first-writer-wins becomes nondeterministic the moment the
 * observing capability is audited parallel-safe, because arrival order is then
 * completion order.
 */
export function outranksObservedWebSource(
  candidate: ObservedWebSource,
  previous: ObservedWebSource,
): boolean {
  if (candidate.text.length !== previous.text.length) {
    return candidate.text.length > previous.text.length
  }
  if (candidate.text !== previous.text) {
    return candidate.text > previous.text
  }
  if ((candidate.title ?? '') !== (previous.title ?? '')) {
    return (candidate.title ?? '') > (previous.title ?? '')
  }
  return candidate.url > previous.url
}

/**
 * Deduplicates on the normalized URL — a coarser key than the raw URL the
 * gateway retains on, so distinct raw URLs can merge here and the comparator
 * decides the survivor. Output is sorted by URL so the result is a pure
 * function of the input set rather than of its order.
 */
function deduplicateSources(sources: readonly ObservedWebSource[]): ObservedWebSource[] {
  const byUrl = new Map<string, ObservedWebSource>()
  for (const source of sources) {
    const normalized = normalizeUrl(source.url)
    if (!normalized) continue
    const candidate = { ...source, url: normalized }
    const previous = byUrl.get(normalized)
    if (!previous || outranksObservedWebSource(candidate, previous)) {
      byUrl.set(normalized, candidate)
    }
  }
  return [...byUrl.values()].sort((left, right) =>
    left.url < right.url ? -1 : left.url > right.url ? 1 : 0,
  )
}

function isRelevantSource(
  source: ObservedWebSource,
  questionTokens: readonly string[],
): boolean {
  if (!source.text.trim() || questionTokens.length === 0) return false
  const sourceTokens = new Set(significantTokens([
    source.url,
    source.title ?? '',
    source.text,
  ].join('\n')))
  const matches = questionTokens.filter((token) => sourceTokens.has(token)).length
  const requiredMatches = questionTokens.length <= 2
    ? 1
    : Math.max(2, Math.ceil(questionTokens.length * 0.6))
  return matches >= requiredMatches
}

function significantTokens(value: string): string[] {
  const tokens = value
    .toLowerCase()
    .replace(/https?:\/\//g, ' ')
    .match(/[a-z0-9]+/g) ?? []
  return [...new Set(tokens
    .map(normalizeToken)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token) && !/^\d+$/.test(token)))]
}

function normalizeToken(value: string): string {
  if (value.length > 4 && value.endsWith('ies')) return `${value.slice(0, -3)}y`
  if (value.length > 4 && value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1)
  return value
}

function extractUrls(value: string): string[] {
  return (value.match(/https?:\/\/[^\s<]+/g) ?? [])
    .map((url) => url.replace(/[),.;:!?\]}]+$/g, ''))
}

/**
 * The fail-closed variant used by the Capability A decision. URL schemes are
 * case-insensitive, so every valid spelling of HTTP and HTTPS is subject to
 * matching and canonical rendering; `new URL` lowercases scheme and host,
 * which `normalizeUrl` then compares on equal terms.
 */
function extractUrlsCaseInsensitive(value: string): string[] {
  return (value.match(/https?:\/\/[^\s<]+/gi) ?? [])
    .map((url) => url.replace(/[),.;:!?\]}]+$/g, ''))
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch {
    return ''
  }
}

function independentHost(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}
