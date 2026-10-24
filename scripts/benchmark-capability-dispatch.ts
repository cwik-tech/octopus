import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

import { serialCapabilityEffect } from '../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityExecutionContext,
} from '../contracts/capability-dispatch.js'
import { CapabilityDispatcher } from '../core/capability-dispatcher.js'
import {
  readExecutionJournal,
  type ExecutionJournalReadResult,
} from '../core/execution-journal.js'
import { DURABLE_DISPATCH_STREAM_KIND } from '../core/durable-dispatch.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../core/capability-execution-scheduler.js'
import { CapabilityInvocationBindings } from '../core/capability-invocation-bindings.js'
import { AssignmentCapabilityEvidenceWriter } from '../domains/runtime/capability-evidence-writer.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../services/capability-dispatch-lifecycle.js'
import { WorkspaceExecutionJournalRegistry } from '../services/workspace-execution-journal-registry.js'

export interface DurationSummary {
  readonly samples: number
  readonly minimumMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maximumMs: number
}

interface BenchmarkOptions {
  readonly iterations: number
  readonly warmupIterations: number
  readonly outputPath?: string
  /**
   * Also measure the dispatch path with the durable execution journal as its
   * authority. The cutover plan gates defaulting `PIPELINE_DURABLE_JOURNAL`
   * on measuring a real turn, and nothing else exercises the journal here.
   */
  readonly durableJournal?: boolean
  /** Concurrent calls per wave when measuring a parallel turn. */
  readonly turnConcurrency?: number
  /**
   * Thresholds the durable measurement is held to.
   *
   * A durable run at `APPROVED_DURABLE_BUDGET_TURN_CONCURRENCY` is held to the
   * approved defaults without asking (D11). Any other width must state its own
   * thresholds as an explicit pair, because the concurrent bound is calibrated
   * for one width. Absent only when the run is not journal-authoritative.
   */
  readonly durableBudget?: DurableJournalBudgetThresholds
}

export interface McpBrokerEchoBenchmarkOptions {
  readonly moduleRoot: string
  readonly iterations: number
  readonly warmupIterations: number
}

export interface McpBrokerEchoBenchmarkReport {
  readonly moduleRoot: string
  readonly iterations: number
  readonly warmupIterations: number
  readonly echoValidated: boolean
  readonly brokerEchoMs: DurationSummary
  readonly auditEventsPerMeasuredCall: number
  readonly auditBytesPerMeasuredCall: number
  readonly dispatchEventsPerMeasuredCall: number
  readonly dispatchBytesPerMeasuredCall: number
}

export async function runMcpBrokerEchoBenchmark(
  options: McpBrokerEchoBenchmarkOptions,
): Promise<McpBrokerEchoBenchmarkReport> {
  validateBenchmarkOptions(options)
  const moduleRoot = await fs.realpath(path.resolve(options.moduleRoot))
  const modules = await loadMcpBenchmarkModules(moduleRoot)
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-dispatch-benchmark-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  const assignmentPath = path.join(
    workspacePath,
    'sessions',
    'benchmark-session',
    'runs',
    'benchmark-run',
    'assignments',
    'benchmark-assignment',
  )
  await fs.mkdir(assignmentPath, { recursive: true, mode: 0o700 })
  const dispatchWriter = new AssignmentCapabilityEvidenceWriter({
    assignmentPath,
    sessionId: 'benchmark-session',
    runId: 'benchmark-run',
    assignmentId: 'benchmark-assignment',
  })
  const manager = new modules.McpClientManager({
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
  })
  const settings = new modules.McpSettingsService({
    storagePath: path.join(directory, 'mcp-settings.json'),
    clientManager: manager,
  })
  const fixturePath = await resolveMcpFixturePath(moduleRoot)
  const nowMs = Date.now()
  const broker = new modules.McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: settings,
    clientManager: manager,
    grantResolver: () => true,
    leaseResolver: (value: unknown) => benchmarkLease(value, nowMs),
    evidenceStoreFactory: (value: unknown) => {
      const scope = readEvidenceScope(value)
      if (!scope) throw new Error('MCP benchmark evidence scope is invalid.')
      return new modules.McpEvidenceStore({ workspacePath, ...scope })
    },
    capabilityEvidence: dispatchWriter,
    limits: {
      maxCallsPerRun:
        options.iterations + options.warmupIterations + 8,
    },
    now: () => new Date(nowMs),
  })

  try {
    await settings.saveServer({
      id: 'benchmark-stdio',
      name: 'Benchmark stdio',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [fixturePath],
        cwd: moduleRoot,
      },
    })
    await settings.validateServer('benchmark-stdio', {
      stdioTrustAcknowledged: true,
    })
    for (let index = 0; index < options.warmupIterations; index += 1) {
      await callBenchmarkEcho(broker, `warmup-${index}`)
    }
    const auditPath = path.join(assignmentPath, 'mcp', 'audit', 'events.jsonl')
    const dispatchPath = path.join(
      assignmentPath,
      'logs',
      'capability-dispatch-events.jsonl',
    )
    const auditBefore = await readAuditMetrics(auditPath)
    const dispatchBefore = await readAuditMetrics(dispatchPath)
    const durations: number[] = []
    for (let index = 0; index < options.iterations; index += 1) {
      const startedAt = performance.now()
      await callBenchmarkEcho(broker, `measured-${index}`)
      durations.push(performance.now() - startedAt)
    }
    const auditAfter = await readAuditMetrics(auditPath)
    const dispatchAfter = await readAuditMetrics(dispatchPath)
    return {
      moduleRoot,
      iterations: options.iterations,
      warmupIterations: options.warmupIterations,
      echoValidated: true,
      brokerEchoMs: roundSummary(
        summarizeCapabilityDispatchDurations(durations),
      ),
      auditEventsPerMeasuredCall:
        (auditAfter.events - auditBefore.events) / options.iterations,
      auditBytesPerMeasuredCall:
        (auditAfter.bytes - auditBefore.bytes) / options.iterations,
      dispatchEventsPerMeasuredCall:
        (dispatchAfter.events - dispatchBefore.events) / options.iterations,
      dispatchBytesPerMeasuredCall:
        (dispatchAfter.bytes - dispatchBefore.bytes) / options.iterations,
    }
  } finally {
    await dispatchWriter.close().catch(() => undefined)
    await settings.closeAll().catch(() => undefined)
    await fs.rm(directory, { recursive: true, force: true })
  }
}

interface BenchmarkMcpClientManager {
  callTool(
    serverId: string,
    request: Readonly<Record<string, unknown>>,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>
}

interface BenchmarkMcpSettingsService {
  saveServer(input: Readonly<Record<string, unknown>>): Promise<unknown>
  validateServer(
    serverId: string,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>
  closeAll(): Promise<void>
}

interface BenchmarkMcpBroker {
  callTool(input: Readonly<Record<string, unknown>>): Promise<unknown>
}

interface BenchmarkMcpModules {
  readonly McpClientManager: new (
    options: Readonly<Record<string, unknown>>,
  ) => BenchmarkMcpClientManager
  readonly McpSettingsService: new (
    options: Readonly<Record<string, unknown>>,
  ) => BenchmarkMcpSettingsService
  readonly McpParentBroker: new (
    options: Readonly<Record<string, unknown>>,
  ) => BenchmarkMcpBroker
  readonly McpEvidenceStore: new (
    options: Readonly<Record<string, unknown>>,
  ) => object
}

async function loadMcpBenchmarkModules(
  moduleRoot: string,
): Promise<BenchmarkMcpModules> {
  const moduleExtension = await resolveBenchmarkModuleExtension(moduleRoot)
  const [client, settings, broker, evidence]: [unknown, unknown, unknown, unknown] =
    await Promise.all([
      import(pathToFileURL(path.join(
        moduleRoot,
        `domains/mcp/mcp-client-manager${moduleExtension}`,
      )).href),
      import(pathToFileURL(path.join(
        moduleRoot,
        `services/mcp-settings-service${moduleExtension}`,
      )).href),
      import(pathToFileURL(path.join(
        moduleRoot,
        `domains/mcp/mcp-parent-broker${moduleExtension}`,
      )).href),
      import(pathToFileURL(path.join(
        moduleRoot,
        `domains/mcp/mcp-evidence-store${moduleExtension}`,
      )).href),
    ])
  const clientConstructor = moduleExport(client, 'McpClientManager')
  const settingsConstructor = moduleExport(settings, 'McpSettingsService')
  const brokerConstructor = moduleExport(broker, 'McpParentBroker')
  const evidenceConstructor = moduleExport(evidence, 'McpEvidenceStore')
  if (
    !isBenchmarkMcpClientManagerConstructor(clientConstructor) ||
    !isBenchmarkMcpSettingsServiceConstructor(settingsConstructor) ||
    !isBenchmarkMcpBrokerConstructor(brokerConstructor) ||
    !isUnknownConstructor(evidenceConstructor)
  ) {
    throw new Error('MCP benchmark modules are invalid.')
  }
  return {
    McpClientManager: clientConstructor,
    McpSettingsService: settingsConstructor,
    McpParentBroker: brokerConstructor,
    McpEvidenceStore: evidenceConstructor,
  }
}

async function resolveBenchmarkModuleExtension(
  moduleRoot: string,
): Promise<'.ts' | '.js'> {
  const relativePath = path.join('domains', 'mcp', 'mcp-client-manager')
  if (await pathExists(path.join(moduleRoot, `${relativePath}.ts`))) return '.ts'
  if (await pathExists(path.join(moduleRoot, `${relativePath}.js`))) return '.js'
  throw new Error('MCP benchmark module root is invalid.')
}

async function resolveMcpFixturePath(moduleRoot: string): Promise<string> {
  const relativePath = path.join('tests', 'fixtures', 'mcp', 'stdio-server.mjs')
  const moduleCandidate = path.join(moduleRoot, relativePath)
  if (await pathExists(moduleCandidate)) return moduleCandidate
  if (path.basename(moduleRoot) === '.tests-dist') {
    const sourceCandidate = path.join(path.dirname(moduleRoot), relativePath)
    if (await pathExists(sourceCandidate)) return sourceCandidate
  }
  throw new Error('MCP benchmark stdio fixture is unavailable.')
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath)
    return true
  } catch {
    return false
  }
}

interface UnknownConstructor {
  new (options: Readonly<Record<string, unknown>>): object
}

function moduleExport(
  value: unknown,
  name: string,
): unknown {
  return isRecord(value) ? value[name] : undefined
}

function isUnknownConstructor(value: unknown): value is UnknownConstructor {
  return typeof value === 'function' &&
    isRecord(Reflect.get(value, 'prototype'))
}

function isBenchmarkMcpClientManagerConstructor(
  value: unknown,
): value is BenchmarkMcpModules['McpClientManager'] {
  if (!isUnknownConstructor(value)) return false
  const prototype: unknown = Reflect.get(value, 'prototype')
  return isRecord(prototype) && typeof prototype.callTool === 'function'
}

function isBenchmarkMcpSettingsServiceConstructor(
  value: unknown,
): value is BenchmarkMcpModules['McpSettingsService'] {
  if (!isUnknownConstructor(value)) return false
  const prototype: unknown = Reflect.get(value, 'prototype')
  return isRecord(prototype) &&
    typeof prototype.saveServer === 'function' &&
    typeof prototype.validateServer === 'function' &&
    typeof prototype.closeAll === 'function'
}

function isBenchmarkMcpBrokerConstructor(
  value: unknown,
): value is BenchmarkMcpModules['McpParentBroker'] {
  if (!isUnknownConstructor(value)) return false
  const prototype: unknown = Reflect.get(value, 'prototype')
  return isRecord(prototype) && typeof prototype.callTool === 'function'
}

function benchmarkLease(value: unknown, nowMs: number): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error('MCP benchmark context is invalid.')
  const leaseId = readIdentifier(value.leaseId)
  const sessionId = readIdentifier(value.sessionId)
  const runId = readIdentifier(value.runId)
  const assignmentId = readIdentifier(value.assignmentId)
  const agentPath = readIdentifier(value.agentPath)
  if (!leaseId || !sessionId || !runId || !assignmentId || !agentPath) {
    throw new Error('MCP benchmark context is invalid.')
  }
  return {
    contractVersion: 1,
    audience: 'mcp-broker',
    leaseId,
    sessionId,
    runId,
    assignmentId,
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60 * 60 * 1_000,
    allowedAgentPaths: [agentPath],
  }
}

function readEvidenceScope(value: unknown): Readonly<{
  sessionId: string
  runId: string
  assignmentId: string
}> | null {
  if (!isRecord(value)) return null
  const sessionId = readIdentifier(value.sessionId)
  const runId = readIdentifier(value.runId)
  const assignmentId = readIdentifier(value.assignmentId)
  return sessionId && runId && assignmentId
    ? { sessionId, runId, assignmentId }
    : null
}

async function callBenchmarkEcho(
  broker: BenchmarkMcpBroker,
  callId: string,
): Promise<void> {
  const marker = `benchmark-${callId}`
  const result = await broker.callTool({
    context: {
      contractVersion: 1,
      requestId: `request-${callId}`,
      leaseId: 'benchmark-lease',
      sessionId: 'benchmark-session',
      runId: 'benchmark-run',
      assignmentId: 'benchmark-assignment',
      agentPath: 'agents/benchmark',
    },
    toolCallId: `call-${callId}`,
    namespacedToolName: 'mcp__benchmark-stdio__echo-marker',
    arguments: { marker },
  })
  if (!isRecord(result) || result.isError !== false) {
    throw new Error('MCP benchmark echo failed.')
  }
  const content = result.content
  if (
    !Array.isArray(content) ||
    !content.some((entry: unknown) =>
      isRecord(entry) &&
      entry.type === 'text' &&
      entry.text === `echo-marker:${marker}`,
    )
  ) {
    throw new Error('MCP benchmark echo result is invalid.')
  }
}

async function readAuditMetrics(
  filePath: string,
): Promise<{ readonly events: number; readonly bytes: number }> {
  try {
    const content = await fs.readFile(filePath)
    return {
      events: content.toString('utf8').split('\n').filter(Boolean).length,
      bytes: content.byteLength,
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { events: 0, bytes: 0 }
    }
    throw error
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readIdentifier(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\0-\x1f\x7f]/u.test(value)
    ? value
    : null
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

/** The two figures a durable budget is applied to. */
export interface DurableJournalBudgetInput {
  readonly serialP50Ms: number
  readonly concurrentPerCallP50Ms: number
}

export interface DurableJournalBudgetThresholds {
  readonly serialP50Ms: number
  readonly concurrentPerCallP50Ms: number
}

/**
 * The width the approved concurrent bound was measured at, and the only width
 * it describes.
 *
 * `concurrentPerCallMs` is a wave duration divided by the wave's width, so its
 * value depends on that width: the same code measures ~53 ms at 8 and ~63 ms at
 * 4. A bound calibrated at one width says nothing at another.
 */
export const APPROVED_DURABLE_BUDGET_TURN_CONCURRENCY = 8

/**
 * The thresholds a durable-journal run is held to when none are supplied
 * (D11, approved 2026-08-22).
 *
 * Wider than the plan's earlier candidates, and deliberately so. A quiet-machine
 * sweep across every commit from the one that recorded the baseline to HEAD
 * measured serial p50 between 74 and 87 ms, including a 3.6 ms spread between a
 * documentation-only commit and its parent — identical runtime, different
 * number. A bound at 80 ms would sit inside that noise and fail roughly half of
 * all runs while catching nothing. 100 ms clears the observed maximum with
 * headroom and still catches a doubling.
 *
 * `concurrentPerCallP50Ms` is **not** a width-independent limit. It is the
 * approved bound for a normalized 8-wide wave and applies only at
 * `APPROVED_DURABLE_BUDGET_TURN_CONCURRENCY`; any other width has to state its
 * own thresholds explicitly.
 *
 * There is deliberately no p95 bound: p95 varied by 3.3× across identical runs
 * at this sample size, so gating on it would report noise as regression.
 */
export const APPROVED_DURABLE_JOURNAL_BUDGET: DurableJournalBudgetThresholds = {
  serialP50Ms: 100,
  concurrentPerCallP50Ms: 65,
}

export interface DurableJournalBudgetResult {
  readonly serialP50Ms: number
  readonly concurrentPerCallP50Ms: number
  readonly serialP50Pass: boolean
  readonly concurrentPerCallP50Pass: boolean
  readonly pass: boolean
  /**
   * The width the concurrent figure was measured at. Echoed so a narrow
   * exploratory run can never be read as the 8-wide gate D11 decides.
   */
  readonly turnConcurrency?: number
}

/**
 * Compare measured durable figures against thresholds the caller supplies.
 *
 * No default lives in this comparator: it holds a measurement to whichever
 * thresholds it is handed, which keeps it testable against synthetic values.
 * Choosing them belongs to `parseArguments`, which selects the D11-approved
 * defaults for a width-8 durable run and otherwise requires an explicit pair.
 * Both bounds are inclusive: a measurement equal to its budget is within it.
 */
export function evaluateDurableJournalBudget(
  measured: DurableJournalBudgetInput,
  thresholds: DurableJournalBudgetThresholds,
): DurableJournalBudgetResult {
  const serialP50Pass = measured.serialP50Ms <= thresholds.serialP50Ms
  const concurrentPerCallP50Pass =
    measured.concurrentPerCallP50Ms <= thresholds.concurrentPerCallP50Ms
  return {
    serialP50Ms: thresholds.serialP50Ms,
    concurrentPerCallP50Ms: thresholds.concurrentPerCallP50Ms,
    serialP50Pass,
    concurrentPerCallP50Pass,
    pass: serialP50Pass && concurrentPerCallP50Pass,
  }
}

/**
 * Appends per *accepted* dispatch, derived from the journal rather than stated.
 *
 * The field was a literal `5`, corroborated only by the event count happening
 * to divide evenly (N13). Counting distinct streams blindly would be no better:
 * a dispatch killed after `committed` contributes four appends and never
 * completed, so including it understates the per-dispatch cost this number
 * exists to report. Only streams that reached `accepted` count, and their whole
 * event set forms the numerator.
 *
 * Fails rather than inventing a figure: an unreadable scan and a journal with
 * no accepted dispatch are both "there is no measurement here".
 */
export function measureAppendsPerAcceptedDispatch(
  read: ExecutionJournalReadResult,
): number {
  if (read.kind !== 'ok') {
    throw new Error(
      `The execution journal could not be read (${read.kind}), so appends per dispatch cannot be measured.`,
    )
  }
  const perStream = new Map<string, number>()
  const accepted = new Set<string>()
  for (const event of read.events) {
    if (event.streamKind !== DURABLE_DISPATCH_STREAM_KIND) continue
    perStream.set(event.streamId, (perStream.get(event.streamId) ?? 0) + 1)
    if (event.type === 'capability.dispatch.accepted') accepted.add(event.streamId)
  }
  if (accepted.size === 0) {
    throw new Error(
      'No accepted capability dispatch is recorded, so appends per dispatch cannot be measured.',
    )
  }
  let appends = 0
  for (const streamId of accepted) appends += perStream.get(streamId) ?? 0
  return appends / accepted.size
}

export function summarizeCapabilityDispatchDurations(
  durationsMs: readonly number[],
): DurationSummary {
  if (
    durationsMs.length === 0 ||
    durationsMs.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new Error('Capability dispatch benchmark durations are invalid.')
  }
  const sorted = [...durationsMs].sort((left, right) => left - right)
  return {
    samples: sorted.length,
    minimumMs: sorted[0] ?? 0,
    p50Ms: nearestRank(sorted, 0.5),
    p95Ms: nearestRank(sorted, 0.95),
    maximumMs: sorted.at(-1) ?? 0,
  }
}

/**
 * The report, typed only as far as the exit decision needs. Everything else
 * stays open, but `durableJournal` is concrete so the gate reads its own
 * output rather than re-narrowing it.
 */
export interface CapabilityDispatchBenchmarkReport
  extends Readonly<Record<string, unknown>> {
  readonly durableJournal?: DurableJournalMeasurement
}

export async function runCapabilityDispatchBenchmark(
  options: BenchmarkOptions,
): Promise<CapabilityDispatchBenchmarkReport> {
  validateBenchmarkOptions(options)
  const workspacePath = await fs.mkdtemp(
    path.join(os.tmpdir(), 'capability-dispatch-benchmark-'),
  )
  const assignmentPath = path.join(workspacePath, 'assignment')
  await fs.mkdir(assignmentPath, { recursive: true, mode: 0o700 })
  const writer = new AssignmentCapabilityEvidenceWriter({
    assignmentPath,
    sessionId: 'benchmark-session',
    runId: 'benchmark-run',
    assignmentId: 'benchmark-assignment',
  })
  let attempt = 0
  const dispatcher = new CapabilityDispatcher({
    bindings: new CapabilityInvocationBindings({
      maxActivePerScope: 4,
      maxRetainedPerScope: options.iterations + options.warmupIterations + 8,
    }),
    authority: { authorize: async () => ({ kind: 'allow' }) },
    policy: { evaluate: async () => ({ kind: 'allow' }) },
    budget: {
      preflight: async () => ({ kind: 'not-metered' }),
      reserve: async () => ({ reservationId: 'unused' }),
      settle: async () => ({ costTracked: false, budgetOverrun: false }),
      release: async () => undefined,
    },
    evidence: writer,
    scheduler: new PerAuthorityCapabilityExecutionScheduler(),
    clock: { now: Date.now },
    ids: {
      nextAttemptId: () => {
        attempt += 1
        return `benchmark-attempt-${attempt}`
      },
    },
  })
  const adapter: CapabilityAdapter = {
    capabilityId: 'benchmark.noop',
    prepare: async () => ({
      effect: serialCapabilityEffect('read-only'),
      risk: 'safe',
      argumentNames: ['sequence'],
      policyDecision: { kind: 'allow' },
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => ({ ok: true }),
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
  const directNoop = async () => ({ ok: true })

  try {
    for (let index = 0; index < options.warmupIterations; index += 1) {
      await directNoop()
      await dispatchNoop(dispatcher, adapter, `warmup-${index}`, index)
    }
    const metricsBefore = writer.getMetrics()
    const directDurations: number[] = []
    const dispatchDurations: number[] = []
    for (let index = 0; index < options.iterations; index += 1) {
      const directStart = performance.now()
      await directNoop()
      directDurations.push(performance.now() - directStart)

      const dispatchStart = performance.now()
      await dispatchNoop(dispatcher, adapter, `measured-${index}`, index)
      dispatchDurations.push(performance.now() - dispatchStart)
    }
    const metricsAfter = writer.getMetrics()
    const direct = summarizeCapabilityDispatchDurations(directDurations)
    const dispatch = summarizeCapabilityDispatchDurations(dispatchDurations)
    const report: Readonly<Record<string, unknown>> = {
      benchmarkSchemaVersion: 1,
      measuredAt: new Date().toISOString(),
      referenceMachine: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
      },
      iterations: options.iterations,
      warmupIterations: options.warmupIterations,
      directNoopMs: roundSummary(direct),
      governedNoopMs: roundSummary(dispatch),
      estimatedControlPlaneOverheadMs: {
        p50: round(dispatch.p50Ms - direct.p50Ms),
        p95: round(dispatch.p95Ms - direct.p95Ms),
      },
      evidencePerMeasuredCall: {
        appendOperations:
          (metricsAfter.appendOperations - metricsBefore.appendOperations) /
          options.iterations,
        bytes:
          (metricsAfter.bytesWritten - metricsBefore.bytesWritten) /
          options.iterations,
        directoryCreateOperations:
          (metricsAfter.directoryCreateOperations -
            metricsBefore.directoryCreateOperations) /
          options.iterations,
      },
      provisionalBudget: {
        p50Ms: 2,
        p95Ms: 10,
        p50Pass: dispatch.p50Ms <= 2,
        p95Pass: dispatch.p95Ms <= 10,
      },
      ...(options.durableJournal
        ? {
            durableJournal: await measureDurableJournalDispatch(options),
          }
        : {}),
    }
    if (options.outputPath) {
      await fs.writeFile(
        path.resolve(options.outputPath),
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8',
      )
    }
    return report
  } finally {
    await writer.close()
    await fs.rm(workspacePath, { recursive: true, force: true })
  }
}

/**
 * The durable half of the report, typed so the CLI can read its budget verdict
 * directly. `Record<string, unknown>` would force the exit-code decision to
 * re-narrow data this module itself produced, which is how a gate ends up
 * guessing about its own output.
 */
export interface DurableJournalMeasurement {
  readonly serialPerCallMs: DurationSummary
  readonly concurrentWaveMs: DurationSummary
  readonly concurrentPerCallMs: { readonly p50: number; readonly p95: number }
  readonly turnConcurrency: number
  readonly journalOpenAndScanMs: number
  readonly journalEventCount: number
  /**
   * Kept under its published name, which AC14 names as a deliverable. Only its
   * calculation changed: it was a literal `5` and is now derived from the
   * accepted dispatch streams the journal actually holds.
   */
  readonly appendsPerSuccessfulDispatch: number
  /** Present only when thresholds were supplied; there is no default. */
  readonly budget?: DurableJournalBudgetResult
}

/**
 * The journal-authoritative dispatch path (Phase 8 cutover).
 *
 * Reports the serial and concurrent shapes separately because they differ in
 * kind, not degree: the journal group-commits, so concurrent calls in one turn
 * amortise a lock cycle and an fsync that strictly serial calls each pay in
 * full. A successful dispatch performs five awaited appends
 * (requested, prepared, started, committed, accepted), so per-call cost is
 * roughly five barriers plus the projection write.
 */
async function measureDurableJournalDispatch(
  options: BenchmarkOptions,
): Promise<DurableJournalMeasurement> {
  const workspacePath = await fs.mkdtemp(
    path.join(os.tmpdir(), 'capability-journal-benchmark-'),
  )
  const context: CapabilityExecutionContext = {
    contractVersion: 1,
    requestId: 'journal-benchmark',
    sessionId: 'benchmark-session',
    runId: 'benchmark-run',
    assignmentId: 'benchmark-assignment',
    agentPath: 'agents/benchmark',
    authority: {
      kind: 'runtime-assignment',
      processIdentity: 'benchmark-process',
    },
  }
  const assignmentPath = path.join(
    workspacePath,
    'sessions',
    context.sessionId,
    'runs',
    context.runId,
    'assignments',
    context.assignmentId,
  )
  await fs.mkdir(assignmentPath, { recursive: true, mode: 0o700 })

  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'benchmark-tenant',
    mode: 'authoritative',
  })
  let attempt = 0
  const dispatcher = new CapabilityDispatcher({
    bindings: new CapabilityInvocationBindings({
      maxActivePerScope: Math.max(8, options.turnConcurrency ?? 8),
      maxRetainedPerScope: options.iterations + options.warmupIterations + 8,
    }),
    authority: { authorize: async () => ({ kind: 'allow' }) },
    policy: { evaluate: async () => ({ kind: 'allow' }) },
    budget: {
      preflight: async () => ({ kind: 'not-metered' }),
      reserve: async () => ({ reservationId: 'unused' }),
      settle: async () => ({ costTracked: false, budgetOverrun: false }),
      release: async () => undefined,
    },
    evidence: { append: async () => undefined },
    scheduler: new PerAuthorityCapabilityExecutionScheduler(),
    clock: { now: Date.now },
    ids: {
      nextAttemptId: () => {
        attempt += 1
        return `journal-attempt-${attempt}`
      },
    },
    durable: (input) => registry.resolve(input),
  })
  const adapter: CapabilityAdapter = {
    capabilityId: 'benchmark.noop',
    prepare: async () => ({
      effect: serialCapabilityEffect('read-only'),
      risk: 'safe',
      argumentNames: ['sequence'],
      policyDecision: { kind: 'allow' },
      recoveryPolicy: 'read_only_retryable' as const,
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => ({ ok: true }),
      acceptResult: async ({ value }) => ({ value }),
    }),
  }

  try {
    for (let index = 0; index < options.warmupIterations; index += 1) {
      await dispatchNoop(dispatcher, adapter, `journal-warmup-${index}`, index, context)
    }

    const serialDurations: number[] = []
    for (let index = 0; index < options.iterations; index += 1) {
      const startedAt = performance.now()
      await dispatchNoop(dispatcher, adapter, `journal-serial-${index}`, index, context)
      serialDurations.push(performance.now() - startedAt)
    }

    const concurrency = Math.max(1, options.turnConcurrency ?? 8)
    const waves = Math.max(1, Math.floor(options.iterations / concurrency))
    const waveDurations: number[] = []
    for (let wave = 0; wave < waves; wave += 1) {
      const startedAt = performance.now()
      await Promise.all(
        Array.from({ length: concurrency }, (_unused, slot) =>
          dispatchNoop(
            dispatcher,
            adapter,
            `journal-wave-${wave}-${slot}`,
            wave * concurrency + slot,
            context,
          ),
        ),
      )
      waveDurations.push(performance.now() - startedAt)
    }

    const openedAt = performance.now()
    const reopened = await readExecutionJournal(assignmentPath)
    const openMs = performance.now() - openedAt

    const serial = summarizeCapabilityDispatchDurations(serialDurations)
    const wavesSummary = summarizeCapabilityDispatchDurations(waveDurations)
    const concurrentPerCallP50 = round(wavesSummary.p50Ms / concurrency)
    const measured = {
      serialPerCallMs: roundSummary(serial),
      concurrentWaveMs: roundSummary(wavesSummary),
      concurrentPerCallMs: {
        p50: concurrentPerCallP50,
        p95: round(wavesSummary.p95Ms / concurrency),
      },
      turnConcurrency: concurrency,
      journalOpenAndScanMs: round(openMs),
      journalEventCount: reopened.kind === 'ok' ? reopened.events.length : 0,
      appendsPerSuccessfulDispatch: measureAppendsPerAcceptedDispatch(reopened),
    }
    if (!options.durableBudget) return measured
    return {
      ...measured,
      budget: {
        ...evaluateDurableJournalBudget(
          {
            serialP50Ms: measured.serialPerCallMs.p50Ms,
            concurrentPerCallP50Ms: concurrentPerCallP50,
          },
          options.durableBudget,
        ),
        turnConcurrency: concurrency,
      },
    }
  } finally {
    await registry.close()
    await fs.rm(workspacePath, { recursive: true, force: true })
  }
}

async function dispatchNoop(
  dispatcher: CapabilityDispatcher,
  adapter: CapabilityAdapter,
  toolCallId: string,
  sequence: number,
  contextOverride?: CapabilityExecutionContext,
): Promise<void> {
  const result = await dispatcher.dispatch({
    context: contextOverride ?? {
      contractVersion: 1,
      requestId: `benchmark-request-${toolCallId}`,
      sessionId: 'benchmark-session',
      runId: 'benchmark-run',
      assignmentId: 'benchmark-assignment',
      agentPath: 'agents/benchmark',
      authority: {
        kind: 'runtime-assignment',
        processIdentity: 'benchmark-process',
      },
    },
    invocation: {
      capabilityId: 'benchmark.noop',
      source: { kind: 'builtin', id: 'benchmark', version: '1' },
      toolCallId,
      input: { sequence },
    },
    adapter,
  })
  if (result.status !== 'completed') {
    throw new Error(`Governed no-op failed with ${result.status}.`)
  }
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const rank = Math.max(1, Math.ceil(sorted.length * percentile))
  return sorted[rank - 1] ?? sorted.at(-1) ?? 0
}

function roundSummary(summary: DurationSummary): DurationSummary {
  return {
    samples: summary.samples,
    minimumMs: round(summary.minimumMs),
    p50Ms: round(summary.p50Ms),
    p95Ms: round(summary.p95Ms),
    maximumMs: round(summary.maximumMs),
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function validateBenchmarkOptions(options: BenchmarkOptions): void {
  if (
    !Number.isSafeInteger(options.iterations) ||
    options.iterations <= 0 ||
    !Number.isSafeInteger(options.warmupIterations) ||
    options.warmupIterations < 0
  ) {
    throw new Error('Capability dispatch benchmark options are invalid.')
  }
}

function parseArguments(argv: readonly string[]): BenchmarkOptions {
  let iterations = 1_000
  let warmupIterations = 100
  let outputPath: string | undefined
  let durableJournal = false
  let turnConcurrency = 8
  let durableSerialP50Ms: number | undefined
  let durableConcurrentPerCallP50Ms: number | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    const value = argv[index + 1]
    if (name === '--iterations' && value) {
      iterations = parseInteger(value, name)
      index += 1
    } else if (name === '--warmup' && value) {
      warmupIterations = parseInteger(value, name)
      index += 1
    } else if (name === '--output' && value) {
      outputPath = value
      index += 1
    } else if (name === '--durable-journal') {
      durableJournal = true
    } else if (name === '--turn-concurrency' && value) {
      turnConcurrency = parseInteger(value, name)
      index += 1
    } else if (name === '--durable-serial-p50-ms' && value) {
      durableSerialP50Ms = parseThreshold(value, name)
      index += 1
    } else if (name === '--durable-concurrent-per-call-p50-ms' && value) {
      durableConcurrentPerCallP50Ms = parseThreshold(value, name)
      index += 1
    } else {
      throw new Error(`Unknown or incomplete benchmark argument: ${name ?? ''}`)
    }
  }
  const durableBudget = resolveDurableBudget({
    durableJournal,
    turnConcurrency,
    serialP50Ms: durableSerialP50Ms,
    concurrentPerCallP50Ms: durableConcurrentPerCallP50Ms,
  })
  return {
    iterations,
    warmupIterations,
    ...(outputPath ? { outputPath } : {}),
    ...(durableJournal ? { durableJournal } : {}),
    turnConcurrency,
    ...(durableBudget ? { durableBudget } : {}),
  }
}

/**
 * The two thresholds are a pair, and only mean anything alongside
 * `--durable-journal`. Half a budget would silently gate on one dimension while
 * the other went unchecked, and a budget with nothing to measure is a typo
 * rather than an instruction — both are refused.
 *
 * With neither supplied, a durable run is held to the approved defaults. The
 * gate applies without being asked for: one that had to be requested would be
 * absent from exactly the runs nobody thought to configure.
 */
function resolveDurableBudget(input: {
  readonly durableJournal: boolean
  readonly turnConcurrency: number
  readonly serialP50Ms: number | undefined
  readonly concurrentPerCallP50Ms: number | undefined
}): DurableJournalBudgetThresholds | undefined {
  const supplied =
    input.serialP50Ms !== undefined || input.concurrentPerCallP50Ms !== undefined
  if (!supplied) {
    if (!input.durableJournal) return undefined
    if (input.turnConcurrency !== APPROVED_DURABLE_BUDGET_TURN_CONCURRENCY) {
      // Applying the approved concurrent bound to another width would compare
      // against a number calibrated for a wave this run never measured. The
      // alternative — silently skipping the gate — is worse: it removes the
      // check from exactly the runs nobody configured.
      throw new Error(
        `The default durable budget is calibrated for --turn-concurrency ${APPROVED_DURABLE_BUDGET_TURN_CONCURRENCY}, ` +
          `not ${input.turnConcurrency}: concurrentPerCallMs is a wave duration divided by its width, so the ` +
          'approved bound does not describe another width. Run at that width, or state width-specific thresholds ' +
          'with --durable-serial-p50-ms and --durable-concurrent-per-call-p50-ms.',
      )
    }
    return APPROVED_DURABLE_JOURNAL_BUDGET
  }
  if (!input.durableJournal) {
    throw new Error(
      'Durable budget thresholds require --durable-journal, which is what measures them.',
    )
  }
  if (input.serialP50Ms === undefined || input.concurrentPerCallP50Ms === undefined) {
    throw new Error(
      'Durable budget thresholds must be given as a pair: both --durable-serial-p50-ms and --durable-concurrent-per-call-p50-ms.',
    )
  }
  return {
    serialP50Ms: input.serialP50Ms,
    concurrentPerCallP50Ms: input.concurrentPerCallP50Ms,
  }
}

function parseThreshold(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a finite positive number of milliseconds.`)
  }
  return parsed
}

function parseInteger(value: string, name: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be an integer.`)
  return Number(value)
}

function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1]
  return Boolean(entry && pathToFileURL(path.resolve(entry)).href === moduleUrl)
}

if (isMainModule(import.meta.url)) {
  runCapabilityDispatchBenchmark(parseArguments(process.argv.slice(2)))
    .then((report) => {
      // The report is emitted first and in full, whatever the verdict: a gate
      // that withholds its evidence when it fails is useless to whoever has to
      // act on it. Only then does the applied budget decide the exit code,
      // which is what makes this enforceable rather than two booleans nobody
      // reads (N13).
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      const budget = report.durableJournal?.budget
      if (budget && !budget.pass) process.exitCode = 1
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown error'
      process.stderr.write(`Capability dispatch benchmark failed: ${message}\n`)
      process.exitCode = 1
    })
}
