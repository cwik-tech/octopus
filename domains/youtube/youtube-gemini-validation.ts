import { whenDefined } from '../../core/optional-properties.js'
import {
  isYoutubeGeminiVideoAnalysisModel,
  YOUTUBE_GEMINI_MODEL,
  type YoutubeRuntimeGeminiConfig,
} from './youtube-settings.js'

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const MAX_MODEL_RESPONSE_BYTES = 64 * 1_024
const MAX_MODEL_LIST_RESPONSE_BYTES = 512 * 1_024
const MAX_MODEL_LIST_PAGES = 10

export interface YoutubeGeminiModelOption {
  readonly id: string
  readonly displayName: string
  readonly description?: string
}

export async function validateYoutubeGeminiModel(
  config: YoutubeRuntimeGeminiConfig,
  signal?: AbortSignal,
  apiBaseUrl = GEMINI_API_BASE_URL,
): Promise<void> {
  if (!config.apiKey) throw new Error('Gemini API key is not configured.')
  const response = await fetch(
    `${apiBaseUrl}/models/${encodeURIComponent(config.model)}`,
    {
      method: 'GET',
      headers: { 'x-goog-api-key': config.apiKey },
      ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
    },
  )
  if (!response.ok) throw new Error('Gemini model validation failed.')
  const body = await readBoundedText(response, MAX_MODEL_RESPONSE_BYTES, signal)
  const model = JSON.parse(body) as Record<string, unknown>
  const option = parseModelOption(model)
  if (!option || option.id !== config.model) {
    throw new Error('Gemini model validation failed.')
  }
}

export async function listYoutubeGeminiModels(
  config: YoutubeRuntimeGeminiConfig,
  signal?: AbortSignal,
  apiBaseUrl = GEMINI_API_BASE_URL,
): Promise<YoutubeGeminiModelOption[]> {
  if (!config.apiKey) throw new Error('Gemini API key is not configured.')
  try {
    const models = new Map<string, YoutubeGeminiModelOption>()
    const seenTokens = new Set<string>()
    let pageToken: string | undefined
    for (let page = 0; page < MAX_MODEL_LIST_PAGES; page += 1) {
      const url = new URL(`${apiBaseUrl}/models`)
      url.searchParams.set('pageSize', '1000')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'x-goog-api-key': config.apiKey },
        ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
      })
      if (!response.ok) throw new Error('Gemini model discovery failed.')
      const body = await readBoundedText(response, MAX_MODEL_LIST_RESPONSE_BYTES, signal)
      const payload = JSON.parse(body) as Record<string, unknown>
      if (!Array.isArray(payload.models)) throw new Error('Gemini returned an invalid model list.')
      for (const entry of payload.models) {
        const model = parseModelOption(entry)
        if (model) models.set(model.id, model)
      }
      pageToken = typeof payload.nextPageToken === 'string' && payload.nextPageToken
        ? payload.nextPageToken
        : undefined
      if (!pageToken) break
      if (seenTokens.has(pageToken)) throw new Error('Gemini returned an invalid page sequence.')
      seenTokens.add(pageToken)
      if (page === MAX_MODEL_LIST_PAGES - 1) {
        throw new Error('Gemini model discovery exceeded the page limit.')
      }
    }
    return [...models.values()].sort((left, right) => {
      if (left.id === YOUTUBE_GEMINI_MODEL) return -1
      if (right.id === YOUTUBE_GEMINI_MODEL) return 1
      const versionOrder = compareStableModelVersions(right.id, left.id)
      if (versionOrder !== 0) return versionOrder
      return left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id)
    })
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    if (error instanceof Error && error.message === 'Gemini API key is not configured.') throw error
    throw new Error('Gemini model discovery failed.')
  }
}

function parseModelOption(value: unknown): YoutubeGeminiModelOption | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  if (typeof input.name !== 'string' || !input.name.startsWith('models/')) return undefined
  const id = input.name.slice('models/'.length)
  if (!/^gemini-[a-z0-9][a-z0-9._-]{0,119}$/.test(id)) return undefined
  if (
    !Array.isArray(input.supportedGenerationMethods) ||
    !input.supportedGenerationMethods.includes('generateContent')
  ) return undefined
  if (!isYoutubeGeminiVideoAnalysisModel(id)) return undefined
  const displayName = typeof input.displayName === 'string' && input.displayName.trim()
    ? input.displayName.trim().slice(0, 160)
    : id
  const description = typeof input.description === 'string' && input.description.trim()
    ? input.description.trim().slice(0, 500)
    : undefined
  return { id, displayName, ...(description ? { description } : {}) }
}

function compareStableModelVersions(left: string, right: string): number {
  const leftVersion = /^(?:gemini-)(\d+)\.(\d+)-/.exec(left)
  const rightVersion = /^(?:gemini-)(\d+)\.(\d+)-/.exec(right)
  if (!leftVersion || !rightVersion) return 0
  return Number(leftVersion[1]) - Number(rightVersion[1])
    || Number(leftVersion[2]) - Number(rightVersion[2])
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  while (true) {
    if (signal?.aborted) throw signal.reason
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maximumBytes) {
      await reader.cancel('Gemini model response exceeded the size limit.')
      throw new Error('Gemini model response exceeded the size limit.')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}
