import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  RunBashRiskEvent,
  RunDelegationLifecycleSnapshot,
  RunDetails,
  RunDiagnosticsSnapshot,
  RunLaunchResult,
  RunStartRequest,
  RunStatus,
  RunSummary,
  RunTranscriptSnapshot,
} from '../../contracts/runs.js'
import type { EngineEventEnvelope } from '../runtime/runtime-events.js'
import { getAssignmentLogPath } from '../runtime/logger.js'
import { JsonlFileCache } from '../../core/jsonl-cache.js'
import { analyzeBashCommand } from '../../core/tool-policy.js'
import {
  isSafePathSegment,
  resolveExistingPathInside,
  resolveRelativePathInside,
} from '../../core/path-safety.js'
import {
  listRunAssignmentLocations,
  resolveRunAssignmentLocation,
} from './run-location.js'
import {
  deriveTitleFromBrief,
  isUsableJobTitle,
  sanitizeRawTitle,
} from '../job-title/job-title-sanitize.js'
import { readMcpRunDiagnostics } from '../mcp/mcp-run-diagnostics.js'
import { RUN_PRIVATE_RUNTIME_DIRECTORY_NAME } from '../../core/run-assignment-location.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
import { artifactMediaTypeForExtension, isTextArtifactExtension } from '../../core/artifact-media.js'

export type {
  RunBashRiskEvent,
  RunDelegationLifecycleSnapshot,
  RunDetails,
  RunDiagnosticsSnapshot,
  RunLaunchResult,
  RunStartRequest,
  RunStatus,
  RunSummary,
  RunTranscriptSnapshot,
}

function stripMarkdownFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/)
  return match?.[1] ?? content
}

function extractMarkdownSection(body: string, heading: string): string | null {
  const marker = `## ${heading}\n`
  const startIndex = body.indexOf(marker)
  if (startIndex === -1) return null

  const sectionStart = startIndex + marker.length
  const nextHeadingIndex = body.indexOf('\n## ', sectionStart)
  const section = nextHeadingIndex === -1
    ? body.slice(sectionStart)
    : body.slice(sectionStart, nextHeadingIndex)

  return section.trim() || null
}

function summarizeJobTitle(text: string): string | null {
  return deriveTitleFromBrief(text)
}

function deriveJobTitleFromJobRequest(assignmentPath: string): string | null {
  const filePath = path.join(assignmentPath, 'job-request.md')
  if (!fs.existsSync(filePath)) return null

  const body = stripMarkdownFrontmatter(fs.readFileSync(filePath, 'utf8'))

  const contractMatch = body.match(/```json\n([\s\S]*?)\n```/)
  const contractSource = contractMatch?.[1]
  if (contractSource) {
    try {
      const contract: unknown = JSON.parse(contractSource)
      if (isRecord(contract)) {
        if (typeof contract.job_title === 'string') {
          const sanitized = sanitizeRawTitle(contract.job_title)
          const brief = typeof contract.input_summary === 'string' ? contract.input_summary : body
          if (sanitized && isUsableJobTitle(sanitized, brief)) return sanitized
        }
        if (typeof contract.input_summary === 'string') {
          const fromInputSummary = summarizeJobTitle(contract.input_summary)
          if (fromInputSummary) return fromInputSummary
        }
      }
    } catch {
      // Fall through to the markdown-section fallback below.
    }
  }

  const titleSection = extractMarkdownSection(body, 'Title')
  if (titleSection) {
    const sanitized = sanitizeRawTitle(titleSection)
    if (sanitized && isUsableJobTitle(sanitized, body)) return sanitized
  }

  const intakeSummary = extractMarkdownSection(body, 'Intake Summary')
  if (intakeSummary) {
    return summarizeJobTitle(intakeSummary)
  }

  return null
}

function deriveRunJobTitle(assignmentPath: string): string | null {
  return deriveJobTitleFromJobRequest(assignmentPath)
}

export interface RunStore {
  listRuns(): Promise<RunSummary[]>
  getRun(runId: string): Promise<RunDetails | null>
  listRunEvents(runId: string): Promise<EngineEventEnvelope[]>
  tailRunEvents(
    runId: string,
    onEvent: (event: EngineEventEnvelope, index: number) => void | Promise<void>,
    options?: { fromIndex?: number; pollIntervalMs?: number },
  ): () => void
  readArtifact(runId: string, artifactPath: string, options?: { readonly maxBytes?: number }): Promise<{
    content: string | Buffer
    contentDisposition?: string
    contentType: string
  } | null>
  openArtifactStream?(runId: string, artifactPath: string, options?: {
    readonly range?: { readonly start: number; readonly end: number }
  }): Promise<{
    readonly stream: fs.ReadStream
    readonly contentDisposition?: string
    readonly contentLength: number
    readonly contentType: string
    readonly etag?: string
  } | null>
  getRunDiagnostics(runId: string): Promise<RunDiagnosticsSnapshot | null>
}

function listFilesRecursively(dirPath: string, baseDir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dirPath)) return acc
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name)
    const relativePath = path.relative(baseDir, fullPath)
    if (
      hasPrivateRuntimeSegment(relativePath) ||
      resolvesInsidePrivateRuntime(baseDir, fullPath)
    ) {
      continue
    }
    if (entry.isDirectory()) {
      if (relativePath === 'logs') continue
      listFilesRecursively(fullPath, baseDir, acc)
      continue
    }
    acc.push(relativePath)
  }
  return acc.sort()
}

function hasPrivateRuntimeSegment(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]+/)
    .some((segment) => segment === RUN_PRIVATE_RUNTIME_DIRECTORY_NAME)
}

function resolvesInsidePrivateRuntime(baseDir: string, candidatePath: string): boolean {
  const resolvedCandidate = resolveExistingPathInside(baseDir, candidatePath)
  if (!resolvedCandidate) return false

  const resolvedBase = fs.realpathSync(baseDir)
  return hasPrivateRuntimeSegment(path.relative(resolvedBase, resolvedCandidate))
}

/**
 * Shared security preamble for every artifact read path: private-runtime
 * exclusion, containment inside the assignment, and a real (non-symlink)
 * regular file. Buffered and streaming reads must agree on this contract —
 * an artifact one reader accepts the other must accept too.
 */
function resolveReadableArtifactFile(
  assignmentPath: string,
  artifactPath: string,
): { readablePath: string; readableStat: fs.Stats } | null {
  if (hasPrivateRuntimeSegment(artifactPath)) return null
  const safePath = resolveSafeArtifactPath(assignmentPath, artifactPath)
  if (!safePath || !fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) return null
  // `resolveExistingPathInside` returns fully resolved real paths, so symlink
  // detection has to happen on the requested path itself — otherwise an alias
  // to a real file inside the assignment would be indistinguishable from the
  // real file.
  if (fs.lstatSync(safePath).isSymbolicLink()) return null
  const readablePath = resolveExistingPathInside(assignmentPath, safePath)
  if (!readablePath) return null
  if (resolvesInsidePrivateRuntime(assignmentPath, readablePath)) return null
  const readableStat = fs.lstatSync(readablePath)
  if (!readableStat.isFile() || readableStat.isSymbolicLink()) return null
  return { readablePath, readableStat }
}

function hasOpenExecutionActivity(events: EngineEventEnvelope[]): boolean {
  let activeAgentCount = 0
  let hostTurnCount = 0
  let providerRequestCount = 0

  for (const event of events) {
    if (event.type === 'agent.start') {
      activeAgentCount += 1
      continue
    }

    if (event.type === 'agent.end' || event.type === 'agent.fail' || event.type === 'agent.skip') {
      activeAgentCount = Math.max(0, activeAgentCount - 1)
      continue
    }

    if (event.type === 'host.agent_start') {
      hostTurnCount += 1
      continue
    }

    if (event.type === 'host.agent_end') {
      hostTurnCount = Math.max(0, hostTurnCount - 1)
      continue
    }

    if (event.type === 'provider.request.start') {
      providerRequestCount += 1
      continue
    }

    if (event.type === 'provider.request.end') {
      providerRequestCount = Math.max(0, providerRequestCount - 1)
    }
  }

  return activeAgentCount > 0 || hostTurnCount > 0 || providerRequestCount > 0
}

function resolveRunStatus(events: EngineEventEnvelope[]): RunStatus {
  let sawIncomplete = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type
    if (type === 'run.completed') return 'completed'
    if (type === 'run.failed') return 'failed'
    if (type === 'run.blocked') return 'blocked'
    if (type === 'run.cancelled') return 'cancelled'
    if (type === 'run.incomplete') sawIncomplete = true
  }
  if (sawIncomplete) return 'incomplete'
  if (events.length === 0) return 'unknown'
  if (hasOpenExecutionActivity(events)) return 'active'
  return 'incomplete'
}

function eventSortKey(event: EngineEventEnvelope, fallbackIndex: number): string {
  return `${event.timestamp || ''}\u0000${event.assignment_path || ''}\u0000${fallbackIndex}`
}

function resolveSafeArtifactPath(assignmentPath: string, artifactPath: string): string | null {
  return resolveRelativePathInside(assignmentPath, artifactPath)
}

function readJsonlObjects(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed: unknown = JSON.parse(line)
        return isRecord(parsed) ? parsed : null
      } catch {
        return null
      }
    })
    .filter((event): event is Record<string, unknown> => Boolean(event))
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {}
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function extractBashCommand(payload: Record<string, unknown>): string | null {
  const directKeys = ['command', 'cmd', 'script', 'input', 'content']
  for (const key of directKeys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value
  }

  const nestedKeys = ['args', 'arguments', 'parameters', 'params']
  for (const key of nestedKeys) {
    const value = payload[key]
    if (!isRecord(value)) continue
    const command = extractBashCommand(value)
    if (command) return command
  }

  return null
}

function deriveBashRisks(runId: string, events: EngineEventEnvelope[]): RunBashRiskEvent[] {
  return events.flatMap((event) => {
    const payload = event.payload ?? {}
    const toolName = typeof payload.tool_name === 'string'
      ? payload.tool_name
      : typeof payload.toolName === 'string'
        ? payload.toolName
        : ''
    if (toolName !== 'bash') return []

    const command = extractBashCommand(payload)
    if (!command) return []

    const analysis = analyzeBashCommand(command)
    return [{
      command,
      flags: analysis.flags,
      risk: analysis.risk,
      runId,
      timestamp: event.timestamp,
      ...whenDefined(typeof payload.tool_call_id === 'string' ? payload.tool_call_id : undefined, (toolCallId) => ({ toolCallId })),
      sourceEventType: event.type,
    }]
  })
}

export class FileSystemRunStore implements RunStore {
  private readonly eventCache = new JsonlFileCache()

  constructor(private readonly workspacePath: string) {}

  private getRunPath(runId: string): string | null {
    return resolveRunAssignmentLocation(this.workspacePath, runId)?.assignmentPath ?? null
  }

  private getEngineEventsPath(runId: string): string | null {
    const runPath = this.getRunPath(runId)
    return runPath ? getAssignmentLogPath(runPath, 'engine-events.jsonl') : null
  }

  private listAssignmentRunIds(): string[] {
    return listRunAssignmentLocations(this.workspacePath)
      .map((location) => location.assignmentId)
  }

  private readOwnRunEvents(runId: string): EngineEventEnvelope[] {
    const eventsPath = this.getEngineEventsPath(runId)
    return eventsPath ? this.eventCache.read<EngineEventEnvelope>(eventsPath) : []
  }

  private readAggregatedRunEvents(runId: string): EngineEventEnvelope[] {
    if (!isSafePathSegment(runId)) return []
    const events: EngineEventEnvelope[] = []

    for (const assignmentRunId of this.listAssignmentRunIds()) {
      const assignmentEvents = this.readOwnRunEvents(assignmentRunId)
      if (assignmentRunId === runId) {
        events.push(...assignmentEvents)
        continue
      }

      events.push(
        ...assignmentEvents.filter((event) => event.root_run_id === runId),
      )
    }

    return events
      .map((event, index) => ({ event, index }))
      .sort((left, right) =>
        eventSortKey(left.event, left.index).localeCompare(eventSortKey(right.event, right.index)),
      )
      .map(({ event }) => event)
  }

  async listRuns(): Promise<RunSummary[]> {
    const runs = await Promise.all(
      this.listAssignmentRunIds()
        .map(async (runId) => {
          const details = await this.getRun(runId)
          return details
        }),
    )

    return runs
      .filter((run): run is RunDetails => Boolean(run))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }

  async getRun(runId: string): Promise<RunDetails | null> {
    const assignmentPath = this.getRunPath(runId)
    if (!assignmentPath || !fs.existsSync(assignmentPath)) return null

    const events = this.readOwnRunEvents(runId)
    const startEvent = events.find((event) => event.type === 'run.session_started' && event.run_id === runId)
    const stat = fs.statSync(assignmentPath)
    const artifactPaths = listFilesRecursively(assignmentPath, assignmentPath)

    return {
      id: runId,
      assignmentPath,
      team: startEvent?.team ?? null,
      jobTitle: deriveRunJobTitle(assignmentPath),
      startedAt: startEvent?.timestamp ?? stat.birthtime.toISOString(),
      updatedAt: events.at(-1)?.timestamp ?? stat.mtime.toISOString(),
      status: resolveRunStatus(events),
      ...whenDefined(startEvent?.root_run_id, (rootRunId) => ({ rootRunId: rootRunId })),
      ...whenDefined(startEvent?.parent_run_id, (parentRunId) => ({ parentRunId: parentRunId })),
      artifactPaths,
      eventCount: events.length,
      latestEventType: events.at(-1)?.type ?? null,
    }
  }

  async listRunEvents(runId: string): Promise<EngineEventEnvelope[]> {
    return this.readAggregatedRunEvents(runId)
  }

  tailRunEvents(
    runId: string,
    onEvent: (event: EngineEventEnvelope, index: number) => void | Promise<void>,
    options: { fromIndex?: number; pollIntervalMs?: number } = {},
  ): () => void {
    if (!isSafePathSegment(runId)) return () => {}
    const pollIntervalMs = options.pollIntervalMs ?? 250
    let nextIndex = options.fromIndex ?? 0
    let polling = false
    let stopped = false

    const poll = async (): Promise<void> => {
      if (stopped || polling) return
      polling = true
      try {
        const events = this.readAggregatedRunEvents(runId)
        for (let index = nextIndex; index < events.length; index++) {
          if (stopped) return
          const event = events[index]
          if (!event) continue
          await onEvent(event, index)
          nextIndex = index + 1
        }
      } catch (error) {
        // Polling runs from a timer, outside the request handler's try/catch.
        // Contain store/callback failures so one SSE client cannot crash Node.
        console.error('[run-store] SSE event tail failed:', error)
      } finally {
        polling = false
      }
    }

    void poll()
    const interval = setInterval(() => { void poll() }, pollIntervalMs)
    interval.unref?.()
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }

  async readArtifact(
    runId: string,
    artifactPath: string,
    options: { readonly maxBytes?: number } = {},
  ): Promise<{
    content: string | Buffer
    contentDisposition?: string
    contentType: string
  } | null> {
    const assignmentPath = this.getRunPath(runId)
    if (!assignmentPath || !fs.existsSync(assignmentPath)) return null

    const readable = resolveReadableArtifactFile(assignmentPath, artifactPath)
    if (!readable) return null
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    ) return null
    if (options.maxBytes !== undefined && readable.readableStat.size > options.maxBytes) return null

    const ext = path.extname(readable.readablePath).toLowerCase()
    const baseMediaType = artifactMediaTypeForExtension(ext)
    const isBinaryArtifact = !isTextArtifactExtension(ext)
    const contentType = isBinaryArtifact
      ? baseMediaType ?? 'application/octet-stream'
      : `${baseMediaType ?? 'text/plain'}; charset=utf-8`

    return {
      content: isBinaryArtifact
        ? fs.readFileSync(readable.readablePath)
        : fs.readFileSync(readable.readablePath, 'utf8'),
      ...(isBinaryArtifact
        ? { contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(readable.readablePath))}` }
        : {}),
      contentType,
    }
  }

  async openArtifactStream(
    runId: string,
    artifactPath: string,
    options: { readonly range?: { readonly start: number; readonly end: number } } = {},
  ): Promise<{
    readonly stream: fs.ReadStream
    readonly contentDisposition?: string
    readonly contentLength: number
    readonly contentType: string
    readonly etag?: string
  } | null> {
    const assignmentPath = this.getRunPath(runId)
    if (!assignmentPath || !fs.existsSync(assignmentPath)) return null
    const readable = resolveReadableArtifactFile(assignmentPath, artifactPath)
    if (!readable) return null
    const readableStat = readable.readableStat
    const readablePath = readable.readablePath
    const extension = path.extname(readablePath).toLowerCase()
    const mediaType = artifactMediaTypeForExtension(extension)
    const contentType = mediaType === 'video/mp4' || mediaType === 'video/webm'
      ? mediaType
      : 'application/octet-stream'
    const etag = `"${readableStat.size.toString(16)}-${Math.trunc(readableStat.mtimeMs).toString(16)}"`
    if (options.range) {
      const { start, end } = options.range
      if (
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start || start >= readableStat.size
      ) return null
      const clampedEnd = Math.min(end, readableStat.size - 1)
      return {
        stream: fs.createReadStream(readablePath, { start, end: clampedEnd }),
        contentLength: clampedEnd - start + 1,
        contentType,
        contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(readablePath))}`,
        etag,
      }
    }
    return {
      stream: fs.createReadStream(readablePath),
      contentLength: readableStat.size,
      contentType,
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(readablePath))}`,
      etag,
    }
  }

  async getRunDiagnostics(runId: string): Promise<RunDiagnosticsSnapshot | null> {
    const assignmentPath = this.getRunPath(runId)
    if (!assignmentPath || !fs.existsSync(assignmentPath)) return null

    const events = await this.listRunEvents(runId)
    return {
      bashRisks: deriveBashRisks(runId, events),
      delegations: {
        lifecycle: readJsonlObjects(getAssignmentLogPath(assignmentPath, 'delegation-lifecycle.jsonl')),
        state: readJsonObject(getAssignmentLogPath(assignmentPath, 'delegation-state.json')),
      },
      mcp: await readMcpRunDiagnostics(this.workspacePath, runId),
      transcript: {
        canonical: readJsonlObjects(getAssignmentLogPath(assignmentPath, 'transcript-events.jsonl')),
        raw: readJsonlObjects(getAssignmentLogPath(assignmentPath, 'transcript-raw.jsonl')),
      },
    }
  }
}
