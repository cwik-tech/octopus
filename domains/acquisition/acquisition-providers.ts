import { fetch } from 'undici'

import type {
  ResearchSearchResult,
  ResearchWebToolInput,
} from './acquisition-types.js'
import { canonicalizeSourceUrl } from './acquisition-url.js'

export type AcquisitionProviderId = 'exa' | 'brave' | 'firecrawl' | 'browser-use'

const MAX_SEARCH_RESPONSE_BYTES = 2 * 1_024 * 1_024
const MAX_READER_RESPONSE_BYTES = 10 * 1_024 * 1_024

export interface SearchProvider {
  readonly id: Extract<AcquisitionProviderId, 'exa' | 'brave'>
  search(
    input: SearchProviderInput,
    signal?: AbortSignal,
  ): Promise<readonly ResearchSearchResult[]>
}

export interface ManagedReaderProvider {
  readonly id: Extract<AcquisitionProviderId, 'firecrawl'>
  acquire(
    url: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly finalUrl: string
    readonly canonicalUrl: string
    readonly title?: string
    readonly mediaType: string
    readonly text: string
  }>
}

export interface SearchProviderInput {
  readonly query: string
  readonly maximumResults: number
  readonly includeDomains: readonly string[]
  readonly excludeDomains: readonly string[]
  readonly publishedAfter?: string
  readonly publishedBefore?: string
}

export class ExaSearchProvider implements SearchProvider {
  readonly id = 'exa' as const

  constructor(
    private readonly apiKey: string,
    private readonly endpoint = 'https://api.exa.ai/search',
  ) {}

  async search(
    input: SearchProviderInput,
    signal?: AbortSignal,
  ): Promise<readonly ResearchSearchResult[]> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      signal: providerSignal(signal),
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        query: input.query,
        numResults: input.maximumResults,
        type: 'auto',
        ...(input.includeDomains.length > 0
          ? { includeDomains: input.includeDomains }
          : {}),
        ...(input.excludeDomains.length > 0
          ? { excludeDomains: input.excludeDomains }
          : {}),
        ...(input.publishedAfter
          ? { startPublishedDate: input.publishedAfter }
          : {}),
        ...(input.publishedBefore
          ? { endPublishedDate: input.publishedBefore }
          : {}),
        contents: {
          text: { maxCharacters: 1_000 },
        },
      }),
    })
    const payload = await readProviderJson(response, 'Exa')
    const results = arrayField(payload, 'results')
    return results.flatMap((entry, index) => {
      const url = stringField(entry, 'url')
      const title = stringField(entry, 'title')
      if (!url || !title) return []
      try {
        const text = stringField(entry, 'text')
        const publishedAt = canonicalTimestamp(stringField(entry, 'publishedDate'))
        return [{
          title,
          url,
          canonicalUrl: canonicalizeSourceUrl(url),
          ...(text ? { snippet: text.slice(0, 1_000) } : {}),
          ...(publishedAt ? { publishedAt } : {}),
          provider: this.id,
          score: numericField(entry, 'score') ?? Math.max(0, 1 - index / input.maximumResults),
        }]
      } catch {
        return []
      }
    })
  }
}

export class BraveSearchProvider implements SearchProvider {
  readonly id = 'brave' as const

  constructor(
    private readonly apiKey: string,
    private readonly endpoint = 'https://api.search.brave.com/res/v1/web/search',
  ) {}

  async search(
    input: SearchProviderInput,
    signal?: AbortSignal,
  ): Promise<readonly ResearchSearchResult[]> {
    const url = new URL(this.endpoint)
    url.searchParams.set('q', withBraveFilters(input))
    url.searchParams.set('count', String(input.maximumResults))
    url.searchParams.set('safesearch', 'moderate')
    url.searchParams.set('text_decorations', 'false')
    url.searchParams.set('extra_snippets', 'true')
    const freshness = braveFreshness(input)
    if (freshness) url.searchParams.set('freshness', freshness)
    const response = await fetch(url, {
      signal: providerSignal(signal),
      headers: {
        accept: 'application/json',
        'x-subscription-token': this.apiKey,
      },
    })
    const payload = await readProviderJson(response, 'Brave Search')
    const web = recordField(payload, 'web')
    const results = web ? arrayField(web, 'results') : []
    return results.flatMap((entry, index) => {
      const resultUrl = stringField(entry, 'url')
      const title = stringField(entry, 'title')
      if (!resultUrl || !title) return []
      try {
        const description = stringField(entry, 'description')
        const extra = arrayField(entry, 'extra_snippets')
          .map((value) => typeof value === 'string' ? value : '')
          .filter(Boolean)
        const publishedAt = canonicalTimestamp(stringField(entry, 'page_age'))
        return [{
          title,
          url: resultUrl,
          canonicalUrl: canonicalizeSourceUrl(resultUrl),
          ...((description || extra.length > 0)
            ? { snippet: [description, ...extra].filter(Boolean).join(' ').slice(0, 1_000) }
            : {}),
          ...(publishedAt ? { publishedAt } : {}),
          provider: this.id,
          score: Math.max(0, 1 - index / input.maximumResults),
        }]
      } catch {
        return []
      }
    })
  }
}

export class FirecrawlReaderProvider implements ManagedReaderProvider {
  readonly id = 'firecrawl' as const

  constructor(
    private readonly apiKey: string,
    private readonly endpoint = 'https://api.firecrawl.dev/v2/scrape',
  ) {}

  async acquire(
    url: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly finalUrl: string
    readonly canonicalUrl: string
    readonly title?: string
    readonly mediaType: string
    readonly text: string
  }> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      signal: providerSignal(signal, 30_000),
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        timeout: 25_000,
      }),
    })
    const payload = await readProviderJson(
      response,
      'Firecrawl',
      MAX_READER_RESPONSE_BYTES,
    )
    if ('success' in payload && payload.success !== true) {
      throw new Error(stringField(payload, 'error') || 'Firecrawl acquisition failed.')
    }
    const data = recordField(payload, 'data') ?? payload
    const text = stringField(data, 'markdown')
    if (!text?.trim()) throw new Error('Firecrawl returned no readable content.')
    const metadata = recordField(data, 'metadata')
    const finalUrl =
      stringField(metadata ?? {}, 'sourceURL') ||
      stringField(metadata ?? {}, 'url') ||
      url
    const title = stringField(metadata ?? {}, 'title')
    return {
      finalUrl: canonicalizeSourceUrl(finalUrl),
      canonicalUrl: canonicalizeSourceUrl(
        stringField(metadata ?? {}, 'canonicalUrl') || finalUrl,
      ),
      ...(title ? { title } : {}),
      mediaType: 'text/markdown',
      text,
    }
  }
}

export class AcquisitionSearchCoordinator {
  constructor(private readonly providers: readonly SearchProvider[]) {}

  async search(
    input: Pick<
      ResearchWebToolInput,
      | 'query'
      | 'maximumResults'
      | 'includeDomains'
      | 'excludeDomains'
      | 'publishedAfter'
      | 'publishedBefore'
    >,
    signal?: AbortSignal,
  ): Promise<readonly ResearchSearchResult[]> {
    if (!input.query?.trim()) throw new Error('Search query is required.')
    const maximumResults = Math.max(1, Math.min(input.maximumResults ?? 10, 20))
    const providerInput: SearchProviderInput = {
      query: input.query.trim(),
      maximumResults,
      includeDomains: input.includeDomains ?? [],
      excludeDomains: input.excludeDomains ?? [],
      ...(input.publishedAfter
        ? { publishedAfter: publishedBoundary(input.publishedAfter, false) }
        : {}),
      ...(input.publishedBefore
        ? { publishedBefore: publishedBoundary(input.publishedBefore, true) }
        : {}),
    }
    const collected: ResearchSearchResult[] = []
    const failures: Error[] = []
    for (const provider of this.providers) {
      try {
        collected.push(...await provider.search(providerInput, signal))
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)))
      }
      if (
        collected.length >= maximumResults &&
        distinctHosts(collected) >= Math.min(5, maximumResults)
      ) {
        break
      }
    }
    if (collected.length === 0 && failures.length > 0) {
      throw new Error(failures.map((failure) => failure.message).join(' '))
    }
    return mergeAndRank(collected).slice(0, maximumResults)
  }
}

function mergeAndRank(
  results: readonly ResearchSearchResult[],
): readonly ResearchSearchResult[] {
  const merged = new Map<string, {
    result: ResearchSearchResult
    providers: Set<string>
  }>()
  for (const result of results) {
    const current = merged.get(result.canonicalUrl)
    if (!current) {
      merged.set(result.canonicalUrl, {
        result,
        providers: new Set([result.provider]),
      })
      continue
    }
    current.providers.add(result.provider)
    if (result.score > current.result.score) current.result = result
  }
  const hostCounts = new Map<string, number>()
  return [...merged.values()]
    .map(({ result, providers }) => ({
      ...result,
      score: Math.min(2, result.score + (providers.size - 1) * 0.25),
    }))
    .sort((left, right) => right.score - left.score)
    .map((result) => {
      const host = new URL(result.canonicalUrl).hostname
      const count = hostCounts.get(host) ?? 0
      hostCounts.set(host, count + 1)
      return { result, hostPenalty: count * 0.15 }
    })
    .sort(
      (left, right) =>
        right.result.score - right.hostPenalty -
        (left.result.score - left.hostPenalty),
    )
    .map(({ result }) => result)
}

function withBraveFilters(input: SearchProviderInput): string {
  const filters = [
    ...input.includeDomains.map((domain) => `site:${domain}`),
    ...input.excludeDomains.map((domain) => `-site:${domain}`),
  ]
  return [input.query, ...filters].join(' ')
}

function braveFreshness(input: SearchProviderInput): string | undefined {
  if (!input.publishedAfter && !input.publishedBefore) return undefined
  const start = (input.publishedAfter ?? '1970-01-01').slice(0, 10)
  const end = (
    input.publishedBefore ??
    new Date().toISOString()
  ).slice(0, 10)
  return `${start}to${end}`
}

function publishedBoundary(value: string, endOfDay: boolean): string {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
  }
  return new Date(value).toISOString()
}

function distinctHosts(results: readonly ResearchSearchResult[]): number {
  return new Set(results.map((result) => new URL(result.canonicalUrl).hostname)).size
}

function providerSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function readProviderJson(
  response: Awaited<ReturnType<typeof fetch>>,
  label: string,
  maximumBytes = MAX_SEARCH_RESPONSE_BYTES,
): Promise<Record<string, unknown>> {
  const text = await readBoundedProviderText(response, label, maximumBytes)
  if (!response.ok) {
    throw new Error(
      `${label} returned HTTP ${response.status}${providerErrorSuffix(text)}.`,
    )
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${label} returned invalid JSON.`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response.`)
  }
  return value as Record<string, unknown>
}

async function readBoundedProviderText(
  response: Awaited<ReturnType<typeof fetch>>,
  label: string,
  maximumBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel()
    throw new Error(`${label} returned an oversized response.`)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      // undici types body chunks as `any`; a fetch body yields bytes.
      const chunk: unknown = result.value
      if (!(chunk instanceof Uint8Array)) {
        await reader.cancel()
        throw new Error(`${label} returned an invalid response.`)
      }
      bytes += chunk.byteLength
      if (bytes > maximumBytes) {
        await reader.cancel()
        throw new Error(`${label} returned an oversized response.`)
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes)
    .toString('utf8')
}

function providerErrorSuffix(value: string): string {
  if (!value.trim()) return ''
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const message =
        (typeof record.error === 'string' && record.error) ||
        (typeof record.message === 'string' && record.message)
      return message ? `: ${message.slice(0, 300)}` : ''
    }
  } catch {
    // Provider error bodies are untrusted; omit non-JSON payloads.
  }
  return ''
}

function arrayField(
  value: unknown,
  key: string,
): readonly unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const field = (value as Record<string, unknown>)[key]
  return Array.isArray(field) ? field as readonly unknown[] : []
}

function recordField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const field = value[key]
  return field && typeof field === 'object' && !Array.isArray(field)
    ? field as Record<string, unknown>
    : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.trim() ? field.trim() : undefined
}

function numericField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

function canonicalTimestamp(value: string | undefined): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined
  return new Date(value).toISOString()
}
