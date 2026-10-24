import type {
  EngineEventEnvelope,
  ExcelWorkbookPreview,
  RunDiagnosticsSnapshot,
  RunDetails,
  RunEventsSnapshotResponse,
  RunTeamFlow,
  RunsResponse,
} from '@/lib/models/runtime-model'
import { isEngineEventEnvelope } from '@contracts/runtime-events'
import { getApiBaseUrl } from '@/lib/utils/desktop'

const API_BASE = getApiBaseUrl()

class ApiContractError extends Error {
  constructor(contract: string) {
    super(`Invalid API response: expected ${contract}`)
    this.name = 'ApiContractError'
  }
}

function toUrl(path: string): string {
  return `${API_BASE}${path}`
}

function encodePathSegments(value: string): string {
  return value.split('/').map((part) => encodeURIComponent(part)).join('/')
}

export function artifactUrl(runId: string, artifactPath: string): string {
  return toUrl(`/runs/${encodeURIComponent(runId)}/assignments/${encodePathSegments(artifactPath)}`)
}

async function expectOk(response: Response): Promise<Response> {
  if (response.ok) return response

  const fallbackMessage = `${response.status} ${response.statusText}`
  let payload: { error?: string } | null = null
  try {
    payload = await response.json() as { error?: string }
  } catch {
    // Non-JSON failures use the HTTP status text.
  }
  throw new Error(payload?.error || fallbackMessage)
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }

    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort() {
      window.clearTimeout(timeout)
      reject(abortError())
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function fetchRuns(): Promise<RunsResponse> {
  const response = await expectOk(await fetch(toUrl('/runs')))
  return response.json() as Promise<RunsResponse>
}

export async function fetchRunDetails(runId: string): Promise<RunDetails> {
  const response = await expectOk(await fetch(toUrl(`/runs/${encodeURIComponent(runId)}`)))
  return response.json() as Promise<RunDetails>
}

export async function fetchRunTeamFlow(runId: string): Promise<RunTeamFlow> {
  const response = await expectOk(await fetch(toUrl(`/runs/${encodeURIComponent(runId)}/flow`)))
  return response.json() as Promise<RunTeamFlow>
}

export async function fetchRunDiagnostics(runId: string): Promise<RunDiagnosticsSnapshot> {
  const response = await expectOk(await fetch(toUrl(`/runs/${encodeURIComponent(runId)}/diagnostics`)))
  return response.json() as Promise<RunDiagnosticsSnapshot>
}

export async function fetchRunEventsSnapshot(runId: string): Promise<RunEventsSnapshotResponse> {
  const response = await expectOk(
    await fetch(toUrl(`/runs/${encodeURIComponent(runId)}/events?snapshot=1`)),
  )

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return requireRunEventsSnapshot(await response.json())
  }

  if (contentType.includes('text/event-stream')) {
    return readSseSnapshot(response)
  }

  throw new Error(`Unsupported event snapshot response: ${contentType || 'unknown content type'}`)
}

export async function fetchArtifact(runId: string, artifactPath: string): Promise<string> {
  const response = await expectOk(
    await fetch(artifactUrl(runId, artifactPath)),
  )

  return response.text()
}

export async function fetchExcelWorkbookPreview(
  runId: string,
  artifactPath: string,
): Promise<ExcelWorkbookPreview> {
  const response = await expectOk(
    await fetch(`${artifactUrl(runId, artifactPath)}?preview=workbook`),
  )

  return response.json() as Promise<ExcelWorkbookPreview>
}

interface ParsedSseMessage {
  data: string
  event: string
  id: string | null
}

function parseSseMessage(block: string): ParsedSseMessage | null {
  const trimmedBlock = block.trim()
  if (!trimmedBlock || trimmedBlock.startsWith(':')) return null

  let eventName = 'message'
  let eventId: string | null = null
  const dataLines: string[] = []

  for (const line of trimmedBlock.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim()
    if (line.startsWith('id:')) eventId = line.slice(3).trim()
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }

  if (dataLines.length === 0) return null

  return {
    data: dataLines.join('\n'),
    event: eventName,
    id: eventId,
  }
}

async function readSseSnapshot(response: Response): Promise<RunEventsSnapshotResponse> {
  if (!response.body) {
    throw new Error('Event stream is not available')
  }

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  const events: EngineEventEnvelope[] = []
  let buffer = ''
  const idleMs = 220
  const maxWindowMs = 2000
  const startedAt = Date.now()

  try {
    while (Date.now() - startedAt < maxWindowMs) {
      const nextChunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), idleMs)),
      ])

      if (nextChunk === null || nextChunk.done) {
        break
      }

      buffer += decoder.decode(nextChunk.value, { stream: true })

      while (buffer.includes('\n\n')) {
        const separatorIndex = buffer.indexOf('\n\n')
        const rawBlock = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)

        const parsed = parseSseMessage(rawBlock)
        if (!parsed || parsed.event === 'message') continue

        events.push(parseEngineEvent(parsed.data))
      }
    }
  } finally {
    void reader.cancel().catch(() => {})
  }

  return { events }
}

export async function openRunEventStream(args: {
  fromIndex?: number
  onEvent: (id: string, event: EngineEventEnvelope) => void
  onStatus: (status: 'connecting' | 'live' | 'reconnecting') => void
  runId: string
  signal: AbortSignal
}): Promise<void> {
  const retryDelaysMs = [250, 400, 650, 1000, 1500, 2500, 5000]
  const retryDelayMs = (attempt: number): number =>
    retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 5000
  let nextIndex = Math.max(0, args.fromIndex ?? 0)
  let reconnectAttempt = 0
  let firstConnection = true
  let hasConnected = false
  let initialNotFoundAttempts = 0

  while (!args.signal.aborted) {
    args.onStatus(firstConnection ? 'connecting' : 'reconnecting')
    const suffix = nextIndex > 0 ? `?from=${nextIndex}` : ''
    let response: Response

    try {
      response = await fetch(
        toUrl(`/runs/${encodeURIComponent(args.runId)}/events${suffix}`),
        {
          headers: { accept: 'text/event-stream' },
          signal: args.signal,
        },
      )
    } catch {
      if (args.signal.aborted) return
      await delay(retryDelayMs(reconnectAttempt), args.signal)
      reconnectAttempt += 1
      firstConnection = false
      continue
    }

    if (!response.ok) {
      if (
        response.status !== 404 ||
        (!hasConnected && initialNotFoundAttempts >= 5)
      ) {
        await expectOk(response)
      }
      initialNotFoundAttempts += 1
      await delay(retryDelayMs(reconnectAttempt), args.signal)
      reconnectAttempt += 1
      firstConnection = false
      continue
    }

    if (!response.body) {
      await delay(retryDelayMs(reconnectAttempt), args.signal)
      reconnectAttempt += 1
      firstConnection = false
      continue
    }

    args.onStatus('live')
    hasConnected = true
    initialNotFoundAttempts = 0
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ''
    let receivedEvent = false

    try {
      while (!args.signal.aborted) {
        const chunk = await reader.read()
        if (chunk.done) break

        buffer += decoder.decode(chunk.value, { stream: true })

        while (buffer.includes('\n\n')) {
          const separatorIndex = buffer.indexOf('\n\n')
          const rawBlock = buffer.slice(0, separatorIndex)
          buffer = buffer.slice(separatorIndex + 2)

          const parsed = parseSseMessage(rawBlock)
          if (!parsed || parsed.event === 'message') continue

          const event = parseEngineEvent(parsed.data)
          const id = parsed.id ?? `${event.timestamp}:${event.type}`
          const numericId = parsed.id === null ? Number.NaN : Number(parsed.id)
          if (Number.isSafeInteger(numericId) && numericId >= nextIndex) {
            nextIndex = numericId + 1
          }
          receivedEvent = true
          args.onEvent(id, event)
        }
      }
    } catch (error) {
      if (args.signal.aborted) return
      if (error instanceof SyntaxError || error instanceof ApiContractError) {
        throw error
      }
    } finally {
      reader.releaseLock()
    }

    if (args.signal.aborted) return
    firstConnection = false
    reconnectAttempt = receivedEvent ? 0 : reconnectAttempt + 1
    await delay(retryDelayMs(reconnectAttempt), args.signal)
  }
}

function parseEngineEvent(data: string): EngineEventEnvelope {
  const value: unknown = JSON.parse(data)
  if (!isEngineEventEnvelope(value)) {
    throw new ApiContractError('EngineEventEnvelope')
  }
  return value
}

function requireRunEventsSnapshot(value: unknown): RunEventsSnapshotResponse {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('events' in value) ||
    !Array.isArray(value.events) ||
    !value.events.every(isEngineEventEnvelope)
  ) {
    throw new ApiContractError('RunEventsSnapshotResponse')
  }
  return { events: value.events }
}
