import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

import type { CanonicalJsonObject } from '../../contracts/canonical-json.js'
import type { CapabilityExecutionContext } from '../../contracts/capability-dispatch.js'
import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import {
  ExecutionJournalInspectionService,
  type ExecutionJournalMetricsSource,
} from '../../services/execution-journal-inspection.js'
import { handleExecutionJournalRoutes } from '../../server/routes/execution-journals.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { WORKFLOW_STATE_STREAM_KIND } from '../../workflows/workflow-journal.js'
import { createJournalBackedAgentTurnRecorder } from '../../services/agent-turn-journal-recorder.js'
import type { AgentTurnJournalRecorder } from '../../services/agent-turn-journal-recorder.js'
import { createJournalBackedWebEvidenceValidationRecorder } from '../../services/web-evidence-validation-recorder.js'

/**
 * Phase 3: after a restart nothing knows which journals exist or which
 * dispatches are unresolved. Discovery answers that from disk, read-only, and
 * never provisions the storage it reads.
 */

const TENANT = 'tenant-inspection'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'journal-inspection-'))
}

function assignmentDir(workspacePath: string, assignmentId: string): string {
  return path.join(
    workspacePath,
    'sessions',
    'session-one',
    'runs',
    'run-one',
    'assignments',
    assignmentId,
  )
}

function makeContext(
  workspacePath: string,
  assignmentId: string,
): CapabilityExecutionContext {
  fs.mkdirSync(assignmentDir(workspacePath, assignmentId), { recursive: true })
  return {
    contractVersion: 1,
    requestId: `request-${assignmentId}`,
    sessionId: 'session-one',
    runId: 'run-one',
    assignmentId,
    agentPath: 'agents/probe',
    authority: { kind: 'runtime-assignment', processIdentity: 'probe' },
  }
}

async function enroll(
  workspacePath: string,
  assignmentId: string,
  record: (port: Awaited<ReturnType<WorkspaceExecutionJournalRegistry['resolve']>>) => Promise<void>,
): Promise<void> {
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  const port = await registry.resolve({
    context: makeContext(workspacePath, assignmentId),
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 5_000,
  })
  await record(port)
  await registry.close()
}

function service(
  workspacePath: string,
  authorize: () => boolean = () => true,
  options: {
    readonly journals?: ExecutionJournalMetricsSource
    readonly clock?: () => number
  } = {},
): ExecutionJournalInspectionService {
  return new ExecutionJournalInspectionService({
    workspacePath,
    authority: { authorize: async () => authorize() },
    ...(options.journals === undefined ? {} : { journals: options.journals }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
}

test('discovery lists enrolled assignments without provisioning anything', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-one', async (port) => {
      await port?.recordRequested({ dispatchId: 'd-1', attemptId: 'a-1' })
    })
    // Present on disk but never enrolled.
    fs.mkdirSync(assignmentDir(workspacePath, 'assignment-bare'), {
      recursive: true,
    })

    const found = await service(workspacePath).listJournals()
    assert.deepEqual(
      found.map((entry) => entry.scope.assignmentId),
      ['assignment-one'],
    )

    // A read path never creates storage.
    assert.equal(
      fs.existsSync(
        path.join(assignmentDir(workspacePath, 'assignment-bare'), '.runtime'),
      ),
      false,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('inspection reports unresolved dispatches and projection lag', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-one', async (port) => {
      // Settled: accepted.
      await port?.recordRequested({ dispatchId: 'settled', attemptId: 'a-1' })
      await port?.recordPrepared({
        dispatchId: 'settled',
        attemptId: 'a-1',
        argumentDigest: 'digest',
        capabilityId: 'cap',
        effect: { kind: 'read-only', concurrency: 'serial' },
        recoveryPolicy: 'read_only_retryable',
      })
      await port?.recordStarted({ dispatchId: 'settled', attemptId: 'a-1' })
      await port?.recordCommitted({ dispatchId: 'settled', attemptId: 'a-1' })
      await port?.recordAccepted({
        dispatchId: 'settled',
        attemptId: 'a-1',
        result: {
          status: 'completed',
          dispatchId: 'settled',
          value: { ok: true },
          costTracked: false,
          budgetOverrun: false,
        },
      })
      // Unproven: started with no terminal record.
      await port?.recordRequested({ dispatchId: 'stuck', attemptId: 'a-1' })
      await port?.recordPrepared({
        dispatchId: 'stuck',
        attemptId: 'a-1',
        argumentDigest: 'digest',
        capabilityId: 'cap',
        effect: { kind: 'mutating', concurrency: 'serial' },
        recoveryPolicy: 'non_retryable',
      })
      await port?.recordStarted({ dispatchId: 'stuck', attemptId: 'a-1' })
    })

    const report = await service(workspacePath).inspect({
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'assignment-one',
    })
    assert.equal(report.kind, 'report')
    if (report.kind !== 'report') return
    assert.deepEqual(
      report.unresolved.map((entry) => entry.dispatchId),
      ['stuck'],
    )
    assert.equal(report.unresolved[0]?.state, 'indeterminate')
    assert.equal(report.projection, 'current')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * AC8: after a restart, the operator surface must be able to see that a
 * configured view is behind.
 *
 * A view whose every derive failed recorded no metadata, and the process that
 * held the in-memory flag is gone. All that survives is the journal and the
 * absent watermark — so if `absent` meant "no view here", a stalled derive and
 * an unconfigured projection would be indistinguishable in the report, and the
 * one that needs acting on is invisible.
 *
 * Deleting the metadata is how this test reaches that state without waiting
 * for a real fault; the journal keeps the dispatch events either way, which is
 * the whole input the classification has after a restart.
 */
test('inspection reports a view with no metadata and events to project as lagging', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-restart', async (port) => {
      await port?.recordRequested({ dispatchId: 'd-1', attemptId: 'a-1' })
      await port?.recordStarted({ dispatchId: 'd-1', attemptId: 'a-1' })
    })

    // What a failed derive leaves behind: dispatch events on the journal, and
    // no record that any of them were ever applied.
    const projectionsDirectory = path.join(
      assignmentDir(workspacePath, 'assignment-restart'),
      '.runtime',
      'execution-journal',
      'projections',
    )
    fs.rmSync(projectionsDirectory, { recursive: true, force: true })

    const report = await service(workspacePath).inspect({
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'assignment-restart',
    })
    assert.equal(report.kind, 'report')
    if (report.kind !== 'report') return
    assert.equal(
      report.projection,
      'lagging',
      'the configured view has applied nothing and has work waiting — that ' +
        'is behind, not absent',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * AC8: teardown brings the view forward before it closes the journal.
 *
 * Catch-up needs the journal to read from, so once the journal is closed the
 * chance is gone until something reopens the assignment. Releasing an
 * assignment without flushing therefore leaves the view further behind than it
 * needs to be — permanently, for a terminal assignment that will never be
 * dispatched to again.
 *
 * This is a latency and tidiness fix rather than a correctness one: the
 * watermark still says what is missing, and a later reader still recovers it.
 * It is worth doing because a terminal assignment has no later reader.
 */
test('releasing an assignment brings its evidence view forward first', async () => {
  const workspacePath = makeWorkspace()
  try {
    const registry = new WorkspaceExecutionJournalRegistry({
      workspacePath,
      tenantId: TENANT,
      mode: 'authoritative',
    })
    const context = makeContext(workspacePath, 'assignment-release-flush')
    const logsDirectory = path.join(
      assignmentDir(workspacePath, 'assignment-release-flush'),
      'logs',
    )
    // Blocked while the dispatch records, so nothing derives.
    fs.writeFileSync(logsDirectory, 'not a directory', { mode: 0o600 })
    const port = await registry.resolve({
      context,
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    })
    // `identity` is what the legacy line is built from; an event without one
    // projects to nothing, so a fixture that omits it would assert on an
    // empty view whatever the flush did.
    await port?.recordRequested({
      dispatchId: 'd-flush',
      attemptId: 'a-1',
      identity: { type: 'capability.dispatch.requested', dispatchId: 'd-flush' },
    })
    await port?.recordStarted({
      dispatchId: 'd-flush',
      attemptId: 'a-1',
      identity: { type: 'capability.dispatch.started', dispatchId: 'd-flush' },
    })

    // The fault clears, and the assignment is then released.
    fs.rmSync(logsDirectory)
    fs.mkdirSync(logsDirectory, { recursive: true, mode: 0o700 })
    await registry.releaseAssignment({
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'assignment-release-flush',
    })
    await registry.close()

    const evidencePath = path.join(
      logsDirectory,
      'capability-dispatch-events.jsonl',
    )
    const lines = fs.existsSync(evidencePath)
      ? fs
        .readFileSync(evidencePath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
      : []
    assert.equal(
      lines.length,
      2,
      'the released assignment leaves its view caught up, not stranded: ' +
        JSON.stringify(lines),
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * The other teardown path. Runtime shutdown closes the registry rather than
 * releasing each assignment, so both have to bring their views forward — a
 * guarantee wired into only one of them is not a guarantee.
 */
test('closing the registry brings every open evidence view forward first', async () => {
  const workspacePath = makeWorkspace()
  try {
    const registry = new WorkspaceExecutionJournalRegistry({
      workspacePath,
      tenantId: TENANT,
      mode: 'authoritative',
    })
    const context = makeContext(workspacePath, 'assignment-close-flush')
    const logsDirectory = path.join(
      assignmentDir(workspacePath, 'assignment-close-flush'),
      'logs',
    )
    fs.writeFileSync(logsDirectory, 'not a directory', { mode: 0o600 })
    const port = await registry.resolve({
      context,
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    })
    await port?.recordRequested({
      dispatchId: 'd-close',
      attemptId: 'a-1',
      identity: { type: 'capability.dispatch.requested', dispatchId: 'd-close' },
    })
    await port?.recordStarted({
      dispatchId: 'd-close',
      attemptId: 'a-1',
      identity: { type: 'capability.dispatch.started', dispatchId: 'd-close' },
    })

    fs.rmSync(logsDirectory)
    fs.mkdirSync(logsDirectory, { recursive: true, mode: 0o700 })
    await registry.close()

    const evidencePath = path.join(
      logsDirectory,
      'capability-dispatch-events.jsonl',
    )
    const lines = fs.existsSync(evidencePath)
      ? fs
        .readFileSync(evidencePath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
      : []
    assert.equal(
      lines.length,
      2,
      'shutdown leaves the view caught up, not stranded: ' +
        JSON.stringify(lines),
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('inspection distinguishes not_found, corrupt, and unsupported_version', async () => {
  const workspacePath = makeWorkspace()
  try {
    const missing = await service(workspacePath).inspect({
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'never-enrolled',
    })
    assert.equal(missing.kind, 'not_found')

    await enroll(workspacePath, 'assignment-corrupt', async (port) => {
      await port?.recordRequested({ dispatchId: 'd-1', attemptId: 'a-1' })
    })
    const journalPath = path.join(
      assignmentDir(workspacePath, 'assignment-corrupt'),
      '.runtime',
      'execution-journal',
      'journal.jsonl',
    )
    fs.appendFileSync(journalPath, '{"schemaVersion":1,"broken":true}\n')
    const corrupt = await service(workspacePath).inspect({
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'assignment-corrupt',
    })
    assert.equal(corrupt.kind, 'corrupt')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('inspection refuses an unauthorized caller', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-one', async (port) => {
      await port?.recordRequested({ dispatchId: 'd-1', attemptId: 'a-1' })
    })
    const denied = service(workspacePath, () => false)
    await assert.rejects(denied.listJournals(), /authorization/i)
    await assert.rejects(
      denied.inspect({
        sessionId: 'session-one',
        runId: 'run-one',
        assignmentId: 'assignment-one',
      }),
      /authorization/i,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a journal copied under another assignment is not reported as that assignment', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-real', async (port) => {
      await port?.recordRequested({ dispatchId: 'd-1', attemptId: 'a-1' })
    })
    // A valid journal, moved somewhere it does not belong.
    const impostor = assignmentDir(workspacePath, 'assignment-impostor')
    fs.mkdirSync(impostor, { recursive: true })
    fs.cpSync(
      path.join(assignmentDir(workspacePath, 'assignment-real'), '.runtime'),
      path.join(impostor, '.runtime'),
      { recursive: true },
    )

    const report = await service(workspacePath).inspect({
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'assignment-impostor',
    })
    // The manifest says it belongs to another assignment; reporting it under
    // the requested scope would be a plausible but wrong answer.
    assert.notEqual(report.kind, 'report')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the operator route serves discovery and inspection over HTTP', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-one', async (port) => {
      await port?.recordRequested({ dispatchId: 'd-1', attemptId: 'a-1' })
    })

    const inspection = service(workspacePath)
    const server = http.createServer((req, res) => {
      void handleExecutionJournalRoutes({
        req,
        res,
        url: new URL(req.url ?? '/', 'http://127.0.0.1'),
        service: inspection,
      }).then((handled) => {
        if (!handled) {
          res.writeHead(404)
          res.end()
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    try {
      const listed = await fetch(`${base}/execution-journals`)
      assert.equal(listed.status, 200)
      const body = (await listed.json()) as {
        journals: ReadonlyArray<{ assignmentId: string }>
      }
      assert.deepEqual(
        body.journals.map((entry) => entry.assignmentId),
        ['assignment-one'],
      )

      const report = await fetch(
        `${base}/execution-journals/session-one/run-one/assignment-one`,
      )
      assert.equal(report.status, 200)

      // Each failure mode reaches the caller as its own status.
      const missing = await fetch(
        `${base}/execution-journals/session-one/run-one/never-enrolled`,
      )
      assert.equal(missing.status, 404)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the route decodes percent-encoded path segments and refuses undeclared shapes', async () => {
  // The repo's convention is decodeSafePathSegment (mcp-interactions.ts:136,
  // mcp-agent-grants.ts:73, mcp-settings.ts:213). Passing raw segments makes a
  // legitimately encoded id resolve to a literal directory name.
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-one', async (port) => {
      await port?.recordRequested({ dispatchId: 'd-1', attemptId: 'a-1' })
    })
    const inspection = service(workspacePath)
    const server = http.createServer((req, res) => {
      void handleExecutionJournalRoutes({
        req,
        res,
        url: new URL(req.url ?? '/', 'http://127.0.0.1'),
        service: inspection,
      }).then((handled) => {
        if (!handled) {
          res.writeHead(418)
          res.end()
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    try {
      // 'assignment-one' percent-encoded must reach the same journal.
      const encoded = await fetch(
        `${base}/execution-journals/session-one/run-one/%61ssignment-one`,
      )
      assert.equal(
        encoded.status,
        200,
        'a percent-encoded assignment id must resolve to the same journal',
      )

      // The method check must precede the service check and reach the caller.
      const posted = await fetch(`${base}/execution-journals`, { method: 'POST' })
      assert.equal(posted.status, 405)

      // A shape outside the declared inventory pattern is not this route's.
      const undeclared = await fetch(`${base}/execution-journals/one/two`)
      assert.equal(
        undeclared.status,
        418,
        'an undeclared path shape must fall through rather than be claimed',
      )
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('inspection refuses an assignment reached through a symlinked path', async () => {
  // listJournals is lstat-based and skips symlinks; inspect resolved the path
  // without canonicalising it, so the two disagreed about what is inside the
  // workspace. The production evidence writer asserts realpath containment.
  const workspacePath = makeWorkspace()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-outside-'))
  try {
    await enroll(workspacePath, 'assignment-one', async (port) => {
      await port?.recordRequested({ dispatchId: 'd-1', attemptId: 'a-1' })
    })

    // Plant a real journal outside the workspace, then point a session
    // directory at it. Without canonicalisation, inspect reports it as this
    // workspace's; the fixture must contain a genuine journal or the test
    // would pass merely because nothing is there.
    const planted = path.join(
      outside,
      'runs',
      'run-one',
      'assignments',
      'assignment-one',
    )
    fs.mkdirSync(planted, { recursive: true })
    fs.cpSync(
      path.join(
        workspacePath,
        'sessions',
        'session-one',
        'runs',
        'run-one',
        'assignments',
        'assignment-one',
        '.runtime',
      ),
      path.join(planted, '.runtime'),
      { recursive: true },
    )
    const escaped = path.join(workspacePath, 'sessions', 'escaped')
    fs.symlinkSync(outside, escaped)
    // The planted journal is genuinely readable through the symlink.
    assert.ok(
      fs.existsSync(
        path.join(escaped, 'runs', 'run-one', 'assignments', 'assignment-one', '.runtime'),
      ),
    )

    const report = await service(workspacePath).inspect({
      sessionId: 'escaped',
      runId: 'run-one',
      assignmentId: 'assignment-one',
    })
    assert.equal(
      report.kind,
      'not_found',
      'a path leaving the workspace through a symlink must not be reported',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

/* ── AC11b: the report has to be enough to decide from ────────────────────── */

/**
 * Seeing a wedged dispatch and knowing what to do about it are different
 * things. `non_retryable`, `unknown`, and a stream with no trustworthy
 * declaration at all lead an operator to three different decisions, and until
 * now the report collapsed them into one line saying "blocked".
 */

/**
 * The part of the report these tests read, parsed rather than asserted.
 *
 * The body arrives over HTTP as external input, so it is validated at the
 * boundary: a shape assertion would prove only that TypeScript was told to
 * believe something. Only the fields these tests use are described, so this
 * stays a parser for a known response and not a second copy of the contract.
 */
interface ReportView {
  readonly projection: string
  readonly metrics: MetricsView
  readonly unresolved: readonly UnresolvedView[]
}

type MetricsView =
  | { readonly kind: 'live'; readonly appendCount: number }
  | { readonly kind: 'no-open-handle' }
  | { readonly kind: 'unavailable'; readonly reason: string }

interface UnresolvedView {
  readonly dispatchId: string
  readonly recovery: string
  readonly unresolvedSince: string
  readonly ageMs: number
  readonly declared?: {
    readonly capabilityId: string
    readonly effectKind: string
    readonly recoveryPolicy: string
  }
}

function fieldOf(value: unknown, key: string, at: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    assert.fail(`${at} is not a JSON object`)
  }
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}

function stringField(value: unknown, key: string, at: string): string {
  const field = fieldOf(value, key, at)
  if (typeof field !== 'string') assert.fail(`${at}.${key} is not a string`)
  return field
}

function numberField(value: unknown, key: string, at: string): number {
  const field = fieldOf(value, key, at)
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    assert.fail(`${at}.${key} is not a finite number`)
  }
  return field
}

function parseMetricsView(value: unknown): MetricsView {
  const kind = stringField(value, 'kind', 'metrics')
  if (kind === 'live') {
    const counters = fieldOf(value, 'counters', 'metrics')
    return { kind, appendCount: numberField(counters, 'appendCount', 'counters') }
  }
  if (kind === 'no-open-handle') return { kind }
  if (kind === 'unavailable') {
    return { kind, reason: stringField(value, 'reason', 'metrics') }
  }
  return assert.fail(`metrics.kind is not a reported arm: ${kind}`)
}

function parseUnresolvedView(value: unknown, index: number): UnresolvedView {
  const at = `unresolved[${index}]`
  const declared = fieldOf(value, 'declared', at)
  return {
    dispatchId: stringField(value, 'dispatchId', at),
    recovery: stringField(value, 'recovery', at),
    unresolvedSince: stringField(value, 'unresolvedSince', at),
    ageMs: numberField(value, 'ageMs', at),
    ...(declared === undefined
      ? {}
      : {
          declared: {
            capabilityId: stringField(declared, 'capabilityId', `${at}.declared`),
            effectKind: stringField(declared, 'effectKind', `${at}.declared`),
            recoveryPolicy: stringField(
              declared,
              'recoveryPolicy',
              `${at}.declared`,
            ),
          },
        }),
  }
}

function parseReportView(body: unknown): ReportView {
  const kind = stringField(body, 'kind', 'report')
  if (kind !== 'report') assert.fail(`report.kind is ${kind}, not 'report'`)
  const unresolved = fieldOf(body, 'unresolved', 'report')
  if (!Array.isArray(unresolved)) assert.fail('report.unresolved is not an array')
  return {
    projection: stringField(body, 'projection', 'report'),
    metrics: parseMetricsView(fieldOf(body, 'metrics', 'report')),
    unresolved: unresolved.map(parseUnresolvedView),
  }
}

/** The report as an operator actually receives it: over HTTP, then parsed. */
async function readReport(
  inspection: ExecutionJournalInspectionService,
  assignmentId: string,
): Promise<ReportView> {
  const server = http.createServer((req, res) => {
    void handleExecutionJournalRoutes({
      req,
      res,
      url: new URL(req.url ?? '/', 'http://127.0.0.1'),
      service: inspection,
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const response = await fetch(
      `http://127.0.0.1:${address.port}/execution-journals/session-one/run-one/${assignmentId}`,
    )
    assert.equal(response.status, 200)
    return parseReportView(await response.json())
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

function unresolvedById(report: ReportView, dispatchId: string): UnresolvedView {
  const entry = report.unresolved.find((item) => item.dispatchId === dispatchId)
  assert.ok(entry, `${dispatchId} must be reported as unresolved`)
  return entry
}

/** Far enough ahead that any real `recordedAt` is decades in its past. */
const FIXED_NOW = Date.parse('2099-01-01T00:00:00.000Z')

test('the report says why each unresolved dispatch is blocked, and for how long', async () => {
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const context = makeContext(workspacePath, 'assignment-one')
    const budget = {
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    }
    const port = await registry.resolve({ context, ...budget })
    assert.ok(port)

    // Blocked because the adapter said the effect must never be repeated.
    await port.recordRequested({ dispatchId: 'declared-non-retryable', attemptId: 'a-1' })
    await port.recordPrepared({
      dispatchId: 'declared-non-retryable',
      attemptId: 'a-1',
      argumentDigest: 'digest',
      capabilityId: 'cap.mutating',
      effect: { kind: 'mutating', concurrency: 'serial' },
      recoveryPolicy: 'non_retryable',
    })
    await port.recordStarted({ dispatchId: 'declared-non-retryable', attemptId: 'a-1' })

    // Blocked because the adapter declared nothing usable — a different call.
    await port.recordRequested({ dispatchId: 'declared-unknown', attemptId: 'a-1' })
    await port.recordPrepared({
      dispatchId: 'declared-unknown',
      attemptId: 'a-1',
      argumentDigest: 'digest',
      capabilityId: 'cap.destructive',
      effect: { kind: 'destructive', concurrency: 'serial' },
      recoveryPolicy: 'unknown',
    })
    await port.recordStarted({ dispatchId: 'declared-unknown', attemptId: 'a-1' })

    // A stream the reducer cannot read: acceptance with no execution before it.
    // There is no declaration to trust here, and inventing one would be worse
    // than saying so.
    await port.recordRequested({ dispatchId: 'unreadable', attemptId: 'a-1' })
    await port.recordAccepted({
      dispatchId: 'unreadable',
      attemptId: 'a-1',
      result: {
        status: 'completed',
        dispatchId: 'unreadable',
        value: { ok: true },
        costTracked: false,
        budgetOverrun: false,
      },
    })

    // An operator authorized a retry that has not happened yet.
    await port.recordRequested({ dispatchId: 'authorized-retry', attemptId: 'a-1' })
    await port.recordPrepared({
      dispatchId: 'authorized-retry',
      attemptId: 'a-1',
      argumentDigest: 'digest',
      capabilityId: 'cap.mutating',
      effect: { kind: 'mutating', concurrency: 'serial' },
      recoveryPolicy: 'non_retryable',
    })
    await port.recordStarted({ dispatchId: 'authorized-retry', attemptId: 'a-1' })
    const resolutionPort = await registry.resolveResolutionPort({
      scope: {
        sessionId: 'session-one',
        runId: 'run-one',
        assignmentId: 'assignment-one',
      },
      ...budget,
    })
    assert.ok(resolutionPort)
    const authorized = await resolutionPort.recordOperatorResolution({
      dispatchId: 'authorized-retry',
      scope: {
        sessionId: 'session-one',
        runId: 'run-one',
        assignmentId: 'assignment-one',
      },
      decision: 'not_committed',
      principal: {
        credentialScope: 'full',
        tenantId: TENANT,
        processInstanceId: 'instance-report-test',
      },
      reason: 'reconciliation found no effect',
      recordedAtMs: Date.now(),
    })
    assert.equal(authorized.kind, 'recorded')

    // A prepared record whose effect kind and policy are outside the unions.
    // Written as raw journal text because the recorder's own types cannot
    // express it — which is the point: the report reads what is on disk, and
    // what is on disk was written by some other version or some other hand.
    const journal = await registry.resolveJournalHandle({ context, ...budget })
    assert.ok(journal)
    const corrupt: readonly [string, string, CanonicalJsonObject][] = [
      ['requested', 'capability.dispatch.requested', { attemptId: 'a-1' }],
      [
        'prepared',
        'capability.dispatch.prepared',
        {
          attemptId: 'a-1',
          argumentDigest: 'digest',
          capabilityId: 'cap.corrupt',
          effectKind: 'catastrophic',
          effectConcurrency: 'whenever',
          recoveryPolicy: 'best_effort',
        },
      ],
      ['started', 'capability.dispatch.started', { attemptId: 'a-1' }],
    ]
    let revision = 0
    for (const [stage, type, payload] of corrupt) {
      const appended = await journal.append({
        eventId: `corrupt-effect:${stage}:a-1`,
        streamKind: 'capability.dispatch',
        streamId: 'corrupt-effect',
        expectedStreamRevision: revision,
        type,
        payloadSchemaVersion: 1,
        payload,
        correlationId: 'corrupt-effect',
      })
      assert.equal(appended.kind, 'appended')
      if (appended.kind !== 'appended') return
      revision = appended.event.streamRevision
    }
    await registry.close()

    const report = await readReport(
      service(workspacePath, () => true, { clock: () => FIXED_NOW }),
      'assignment-one',
    )

    const nonRetryable = unresolvedById(report, 'declared-non-retryable')
    assert.deepEqual(nonRetryable.declared, {
      capabilityId: 'cap.mutating',
      effectKind: 'mutating',
      recoveryPolicy: 'non_retryable',
    })
    const unknownPolicy = unresolvedById(report, 'declared-unknown')
    assert.deepEqual(unknownPolicy.declared, {
      capabilityId: 'cap.destructive',
      effectKind: 'destructive',
      recoveryPolicy: 'unknown',
    })
    assert.equal(
      unresolvedById(report, 'unreadable').declared,
      undefined,
      'a stream with no readable preparation must not be given a policy',
    )

    // Age, measured from when the dispatch last moved to the injected clock.
    // Both ends are known independently: the journal wrote `unresolvedSince`,
    // and the test supplied `FIXED_NOW`.
    const stalled = unresolvedById(report, 'declared-non-retryable')
    const recordedAt = Date.parse(stalled.unresolvedSince)
    assert.ok(
      Number.isFinite(recordedAt),
      `unresolvedSince must be a readable time, got ${stalled.unresolvedSince}`,
    )
    assert.equal(
      stalled.ageMs,
      Math.max(0, FIXED_NOW - recordedAt),
      'age must be measured from the recorded time to the report clock',
    )

    assert.equal(
      unresolvedById(report, 'authorized-retry').recovery,
      'retriable',
      'an authorized retry that has not run yet is the third recovery arm',
    )

    assert.deepEqual(
      unresolvedById(report, 'corrupt-effect').declared,
      {
        capabilityId: 'cap.corrupt',
        effectKind: 'unknown',
        recoveryPolicy: 'unknown',
      },
      'journal text outside the effect and policy unions is read as unknown, ' +
        'never echoed to a reader as though the runtime would honour it',
    )
  } finally {
    await registry.close().catch(() => undefined)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the report carries this process journal metrics and a projection status that is not permanently lagging', async () => {
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const context = makeContext(workspacePath, 'assignment-one')
    const budget = {
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    }
    const port = await registry.resolve({ context, ...budget })
    assert.ok(port)
    await port.recordRequested({ dispatchId: 'settled', attemptId: 'a-1' })
    await port.recordPrepared({
      dispatchId: 'settled',
      attemptId: 'a-1',
      argumentDigest: 'digest',
      capabilityId: 'cap',
      effect: { kind: 'read-only', concurrency: 'serial' },
      recoveryPolicy: 'read_only_retryable',
    })
    await port.recordStarted({ dispatchId: 'settled', attemptId: 'a-1' })
    await port.recordAccepted({
      dispatchId: 'settled',
      attemptId: 'a-1',
      result: {
        status: 'completed',
        dispatchId: 'settled',
        value: { ok: true },
        costTracked: false,
        budgetOverrun: false,
      },
    })

    // One journal per assignment carries workflow state too, and it advances
    // the shared sequence counter. The dispatch view derives nothing from it,
    // so comparing against the journal-wide maximum reports every assignment
    // that runs a workflow as permanently behind (N31).
    const journal = await registry.resolveJournalHandle({ context, ...budget })
    assert.ok(journal)
    const appended = await journal.append({
      eventId: 'workflow-after-dispatch',
      streamKind: WORKFLOW_STATE_STREAM_KIND,
      streamId: 'workflow-one',
      expectedStreamRevision: 0,
      type: 'workflow.state.snapshot',
      payloadSchemaVersion: 1,
      payload: { step: 'research' },
      correlationId: 'workflow-one',
    })
    assert.equal(appended.kind, 'appended')

    const live = await readReport(
      service(workspacePath, () => true, { journals: registry }),
      'assignment-one',
    )
    assert.equal(
      live.projection,
      'current',
      'workflow events in the same journal must not read as dispatch-view lag',
    )
    assert.equal(live.metrics.kind, 'live')
    assert.ok(
      live.metrics.kind === 'live' && live.metrics.appendCount > 0,
      'a live handle reports what it has actually done',
    )

    await registry.close()

    const afterRestart = await readReport(
      service(workspacePath, () => true, { journals: registry }),
      'assignment-one',
    )
    assert.equal(
      afterRestart.metrics.kind,
      'no-open-handle',
      'counters are per-handle and in-memory, so an unopened journal has none ' +
        'to report — and zeros would read as "no conflicts, no corruption"',
    )

    // A source that faults is a different fact from a source that has nothing.
    // Reporting the fault as "nobody has it open" would tell an operator to
    // stop looking.
    const faulting = await readReport(
      service(workspacePath, () => true, {
        journals: {
          peekMetrics: async () => {
            const error: NodeJS.ErrnoException = new Error(
              `cannot read /private/${workspacePath}/journal`,
            )
            error.code = 'EIO'
            throw error
          },
        },
      }),
      'assignment-one',
    )
    assert.equal(
      faulting.metrics.kind,
      'unavailable',
      'a metrics source that fails must not be reported as no-open-handle',
    )
    assert.equal(
      faulting.metrics.kind === 'unavailable' ? faulting.metrics.reason : '',
      'EIO',
      'the reason is an error code; a message can carry a path',
    )
    assert.equal(
      faulting.projection,
      'current',
      'and the report an operator came for is still served in full',
    )
  } finally {
    await registry.close().catch(() => undefined)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * A journal outlives the code that wrote it.
 *
 * `idempotent_with_key` was a declared recovery policy the runtime never
 * honoured: no idempotency key reaches a dispatcher, so it always failed
 * closed. Removing it from the union does not remove it from journals already
 * on disk, and what those journals say has to keep reading as the fail-closed
 * value rather than as a promise nothing kept.
 */
test('a legacy idempotent_with_key policy on disk is reported as unknown', async () => {
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const context = makeContext(workspacePath, 'assignment-one')
    const budget = {
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    }
    const journal = await registry.resolveJournalHandle({ context, ...budget })
    assert.ok(journal)

    // Written as raw journal text because the recorder's types no longer
    // express this policy — which is the situation under test.
    const legacy: readonly [string, string, CanonicalJsonObject][] = [
      ['requested', 'capability.dispatch.requested', { attemptId: 'a-1' }],
      [
        'prepared',
        'capability.dispatch.prepared',
        {
          attemptId: 'a-1',
          argumentDigest: 'digest',
          capabilityId: 'cap.legacy',
          effectKind: 'mutating',
          effectConcurrency: 'serial',
          recoveryPolicy: 'idempotent_with_key',
        },
      ],
      ['started', 'capability.dispatch.started', { attemptId: 'a-1' }],
    ]
    let revision = 0
    for (const [stage, type, payload] of legacy) {
      const appended = await journal.append({
        eventId: `legacy-policy:${stage}:a-1`,
        streamKind: 'capability.dispatch',
        streamId: 'legacy-policy',
        expectedStreamRevision: revision,
        type,
        payloadSchemaVersion: 1,
        payload,
        correlationId: 'legacy-policy',
      })
      assert.equal(appended.kind, 'appended')
      if (appended.kind !== 'appended') return
      revision = appended.event.streamRevision
    }
    await registry.close()

    const report = await readReport(service(workspacePath), 'assignment-one')
    const entry = unresolvedById(report, 'legacy-policy')
    assert.deepEqual(
      entry.declared,
      {
        capabilityId: 'cap.legacy',
        effectKind: 'mutating',
        recoveryPolicy: 'unknown',
      },
      'a policy the runtime no longer offers must read as the fail-closed ' +
        'value, never echoed back as though it still meant something',
    )
    // Compatibility evidence rather than Red: this already held, and it has to
    // keep holding — the effect is unproven and nothing may repeat it.
    assert.equal(entry.recovery, 'blocked')
  } finally {
    await registry.close().catch(() => undefined)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the report states each agent turn state and keeps capability evidence separate', async () => {
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  const budget = {
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 5_000,
  }
  try {
    // One assignment per turn state, plus one that also dispatched a
    // capability — the two streams share a journal and must not be conflated.
    const states: readonly {
      readonly assignmentId: string
      readonly expected: string
      readonly record: (
        recorder: AgentTurnJournalRecorder,
      ) => Promise<void>
    }[] = [
      {
        assignmentId: 'turn-in-progress',
        expected: 'provider_in_progress',
        record: async () => undefined,
      },
      {
        assignmentId: 'turn-pending',
        expected: 'reply_pending',
        record: async (recorder) => {
          await recorder.recordPrepared(preparedInput('msg-pending'))
        },
      },
      {
        assignmentId: 'turn-completed',
        expected: 'completed',
        record: async (recorder) => {
          await recorder.recordPrepared(preparedInput('msg-done'))
          await recorder.recordCompleted({
            turnId: TURN_ID,
            replyId: REPLY_ID,
            assistantMessageId: 'msg-done',
            route: 'mcp-native',
          })
        },
      },
      {
        assignmentId: 'turn-failed',
        expected: 'failed',
        record: async (recorder) => {
          await recorder.recordFailed({
            turnId: TURN_ID,
            replyId: REPLY_ID,
            failure: {
              layer: 'provider-adapter',
              phase: 'provider-request',
              serviceCode: 'provider_failed',
              providerCode: 'model_overloaded',
              httpStatus: 503,
              retryable: true,
            },
          })
        },
      },
      {
        assignmentId: 'turn-cancelled',
        expected: 'cancelled',
        record: async (recorder) => {
          await recorder.recordCancelled({
            turnId: TURN_ID,
            replyId: REPLY_ID,
            phase: 'provider-request',
          })
        },
      },
    ]

    for (const state of states) {
      const journal = await registry.resolveJournalHandle({
        context: makeContext(workspacePath, state.assignmentId),
        ...budget,
      })
      assert.ok(journal)
      const recorder = createJournalBackedAgentTurnRecorder(
        journal,
        state.assignmentId,
      )
      await recorder.recordStarted({
        turnId: TURN_ID,
        replyId: REPLY_ID,
        speakerOrdinal: 0,
        agentPath: 'agents/probe',
        requestedModel: 'fixture/probe',
      })
      await state.record(recorder)
    }

    // The mixed assignment: an agent turn and an unresolved dispatch together.
    const mixedContext = makeContext(workspacePath, 'turn-mixed')
    const mixedPort = await registry.resolve({ context: mixedContext, ...budget })
    await mixedPort?.recordRequested({ dispatchId: 'd-mixed', attemptId: 'a-1' })
    await mixedPort?.recordPrepared({
      dispatchId: 'd-mixed',
      attemptId: 'a-1',
      argumentDigest: 'digest',
      capabilityId: 'cap.mutating',
      effect: { kind: 'mutating', concurrency: 'serial' },
      recoveryPolicy: 'non_retryable',
    })
    await mixedPort?.recordStarted({ dispatchId: 'd-mixed', attemptId: 'a-1' })
    const mixedJournal = await registry.resolveJournalHandle({
      context: mixedContext,
      ...budget,
    })
    assert.ok(mixedJournal)
    const mixedRecorder = createJournalBackedAgentTurnRecorder(
      mixedJournal,
      'turn-mixed',
    )
    await mixedRecorder.recordStarted({
      turnId: TURN_ID,
      replyId: REPLY_ID,
      speakerOrdinal: 0,
      agentPath: 'agents/probe',
    })
    await registry.close()

    const inspection = service(workspacePath)
    for (const state of states) {
      const report = await inspection.inspect({
        sessionId: 'session-one',
        runId: 'run-one',
        assignmentId: state.assignmentId,
      })
      assert.equal(report.kind, 'report')
      if (report.kind !== 'report') return
      assert.equal(report.agentTurns.length, 1, state.assignmentId)
      const turn = report.agentTurns[0]
      assert.equal(turn?.state, state.expected, state.assignmentId)
      assert.equal(turn?.turnId, TURN_ID)
      assert.equal(turn?.assignmentId, state.assignmentId)
      assert.deepEqual(report.unresolved, [], state.assignmentId)
    }

    const failed = await inspection.inspect({
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'turn-failed',
    })
    assert.equal(failed.kind, 'report')
    if (failed.kind !== 'report') return
    assert.equal(failed.agentTurns[0]?.failure?.httpStatus, 503)
    assert.equal(failed.agentTurns[0]?.failure?.providerCode, 'model_overloaded')
    assert.equal(failed.agentTurns[0]?.failure?.retryable, true)

    const mixed = await inspection.inspect({
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'turn-mixed',
    })
    assert.equal(mixed.kind, 'report')
    if (mixed.kind !== 'report') return
    assert.equal(mixed.agentTurns.length, 1)
    assert.equal(mixed.agentTurns[0]?.state, 'provider_in_progress')
    assert.equal(
      mixed.unresolved.length,
      1,
      'the capability dispatch is still reported in its own list',
    )
  } finally {
    await registry.close().catch(() => undefined)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('an agent-turn stream that violates its own order is reported as invalid', async () => {
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const journal = await registry.resolveJournalHandle({
      context: makeContext(workspacePath, 'turn-invalid'),
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    })
    assert.ok(journal)
    // A terminal with no start. Written directly, because the recorder cannot
    // produce it — which is the point: the report reads what is on disk.
    const appended = await journal.append({
      eventId: 'turn-invalid:agent-turn:terminal',
      streamKind: 'agent.turn',
      streamId: 'turn-invalid',
      expectedStreamRevision: 0,
      type: 'agent.turn.completed',
      payloadSchemaVersion: 1,
      payload: {
        turnId: TURN_ID,
        replyId: REPLY_ID,
        assistantMessageId: 'msg-orphan',
        route: 'mcp-native',
      },
      correlationId: TURN_ID,
    })
    assert.equal(appended.kind, 'appended')
    await registry.close()

    const report = await service(workspacePath).inspect({
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'turn-invalid',
    })
    assert.equal(report.kind, 'report')
    if (report.kind !== 'report') return
    assert.equal(report.agentTurns[0]?.state, 'invalid')
  } finally {
    await registry.close().catch(() => undefined)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

const TURN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const REPLY_ID = 'probe:0'

function preparedInput(assistantMessageId: string) {
  return {
    turnId: TURN_ID,
    replyId: REPLY_ID,
    assistantMessageId,
    outcome: 'success' as const,
    route: 'mcp-native' as const,
    resolvedModel: 'fixture/probe',
    outputByteLength: 12,
  }
}

test('the report summarizes web evidence validations by provider, route, mode, and decision', async () => {
  const workspacePath = makeWorkspace()
  try {
    const registry = new WorkspaceExecutionJournalRegistry({
      workspacePath,
      tenantId: TENANT,
      mode: 'authoritative',
    })
    const budget = {
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    }
    const journal = await registry.resolveJournalHandle({
      context: makeContext(workspacePath, 'assignment-web-evidence'),
      ...budget,
    })
    assert.ok(journal)
    const recorder = createJournalBackedWebEvidenceValidationRecorder(
      journal,
      'assignment-web-evidence',
    )
    const base = {
      stage: 'links' as const,
      providerKind: 'openai',
      providerRoute: 'mcp-native' as const,
      observedUrlCount: 2,
      citedUrlCount: 3,
      unobservedUrlCount: 1,
      legacyDecision: 'accepted' as const,
      durationMs: 2,
    }
    await recorder.recordValidation({
      ...base,
      turnId: 'turn-shadow-reject',
      mode: 'shadow',
      decision: 'unobserved_url',
      displayedDiffersFromCandidate: false,
      persistedDiffersFromCandidate: true,
      enforcementWouldDiffer: true,
    })
    await recorder.recordValidation({
      ...base,
      turnId: 'turn-shadow-accept',
      mode: 'shadow',
      decision: 'accepted',
      unobservedUrlCount: 0,
      displayedDiffersFromCandidate: false,
      persistedDiffersFromCandidate: false,
      enforcementWouldDiffer: false,
    })
    await recorder.recordValidation({
      ...base,
      turnId: 'turn-enforce-reject',
      mode: 'enforce',
      decision: 'unobserved_url',
      displayedDiffersFromCandidate: true,
      persistedDiffersFromCandidate: true,
      enforcementWouldDiffer: true,
    })
    await registry.close()

    const report = await service(workspacePath).inspect({
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'assignment-web-evidence',
    })
    assert.equal(report.kind, 'report')
    if (report.kind !== 'report') return
    // The §8.2 review needs unobserved_url and would-change rates per cohort:
    // provider kind, provider route, and rollout mode, with decision counts.
    assert.deepEqual(report.webEvidenceValidations, {
      recordedCount: 3,
      invalidCount: 0,
      cohorts: [
        {
          providerKind: 'openai',
          providerRoute: 'mcp-native',
          mode: 'enforce',
          recordedCount: 1,
          acceptedCount: 0,
          insufficientCount: 1,
          wouldDifferCount: 1,
          byDecision: { unobserved_url: 1 },
        },
        {
          providerKind: 'openai',
          providerRoute: 'mcp-native',
          mode: 'shadow',
          recordedCount: 2,
          acceptedCount: 1,
          insufficientCount: 1,
          wouldDifferCount: 1,
          byDecision: { accepted: 1, unobserved_url: 1 },
        },
      ],
    })
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * Phase 3: an operator has to be able to tell an assignment whose journal
 * still holds capability result content from one that only names it. The
 * report says which, and says it without reproducing any of that content.
 */

const RESULT_SENTINEL = 'inspection-result-sentinel-7be21c'
const LEGACY_RESULT_VALUE = { kind: 'browser.snapshot', text: RESULT_SENTINEL }

test('an assignment written after the cutover reports its results without content', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-v2', async (port) => {
      await recordAcceptedLifecycle(port, LEGACY_RESULT_VALUE)
    })

    const report = await service(workspacePath).inspect({
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'assignment-v2',
    })

    assert.equal(report.kind, 'report')
    if (report.kind !== 'report') return
    assert.deepEqual(report.capabilityResults, {
      counts: {
        content_reference_v2: 1,
        legacy_inline_v1: 0,
        legacy_journal_receipt_v1: 0,
        unretained: 0,
      },
      legacyContentBearing: false,
      contentOwner: 'assignment-capability-results',
    })
    assert.ok(!JSON.stringify(report).includes(RESULT_SENTINEL))
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('an assignment holding a v1 inline result is marked legacy content-bearing', async () => {
  const workspacePath = makeWorkspace()
  try {
    await seedLegacyDispatch(workspacePath, 'assignment-v1-inline', {
      resultKind: 'inline',
      resultValue: LEGACY_RESULT_VALUE,
    })

    const report = await service(workspacePath).inspect({
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'assignment-v1-inline',
    })

    assert.equal(report.kind, 'report')
    if (report.kind !== 'report') return
    assert.deepEqual(report.capabilityResults, {
      counts: {
        content_reference_v2: 0,
        legacy_inline_v1: 1,
        legacy_journal_receipt_v1: 0,
        unretained: 0,
      },
      legacyContentBearing: true,
      legacyReason: 'capability_result_v1',
    })
    // The journal genuinely holds the content; the report still must not.
    assert.ok(!JSON.stringify(report).includes(RESULT_SENTINEL))
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('an assignment holding a v1 journal-owned receipt is marked legacy content-bearing', async () => {
  const workspacePath = makeWorkspace()
  try {
    await seedLegacyDispatch(workspacePath, 'assignment-v1-receipt', {
      resultKind: 'receipt',
      receipt: {
        relativePath: `results/${'a'.repeat(64)}.json`,
        contentSha256: 'a'.repeat(64),
        byteLength: 12,
        mediaType: 'application/json',
        resultSchemaVersion: 1,
      },
    })

    const report = await service(workspacePath).inspect({
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'assignment-v1-receipt',
    })

    assert.equal(report.kind, 'report')
    if (report.kind !== 'report') return
    assert.deepEqual(report.capabilityResults, {
      counts: {
        content_reference_v2: 0,
        legacy_inline_v1: 0,
        legacy_journal_receipt_v1: 1,
        unretained: 0,
      },
      legacyContentBearing: true,
      legacyReason: 'capability_result_v1',
    })
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

async function recordAcceptedLifecycle(
  port: Awaited<ReturnType<WorkspaceExecutionJournalRegistry['resolve']>>,
  value: CanonicalJsonObject,
): Promise<void> {
  await port?.recordRequested({ dispatchId: 'd-1', attemptId: 'a-1' })
  await port?.recordPrepared({
    dispatchId: 'd-1',
    attemptId: 'a-1',
    argumentDigest: 'c'.repeat(64),
    capabilityId: 'browser.snapshot',
    effect: serialCapabilityEffect('read-only'),
    recoveryPolicy: 'read_only_retryable',
  })
  await port?.recordStarted({ dispatchId: 'd-1', attemptId: 'a-1' })
  await port?.recordAccepted({
    dispatchId: 'd-1',
    attemptId: 'a-1',
    result: {
      status: 'completed',
      dispatchId: 'd-1',
      value,
      costTracked: false,
      budgetOverrun: false,
    },
  })
}

/**
 * One dispatch stream in the shape a build before Phase 3 wrote it: payload
 * version 1, carrying the result itself. Appended through the real journal so
 * the fixture has a valid hash chain rather than hand-written bytes.
 */
async function seedLegacyDispatch(
  workspacePath: string,
  assignmentId: string,
  retained: CanonicalJsonObject,
): Promise<void> {
  fs.mkdirSync(assignmentDir(workspacePath, assignmentId), { recursive: true })
  const journal = await initializeExecutionJournal({
    scopeRoot: assignmentDir(workspacePath, assignmentId),
    identity: {
      scopeKind: 'assignment',
      scopeId: assignmentId,
      tenantId: TENANT,
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId,
    },
  })
  try {
    const stages: readonly (readonly [string, CanonicalJsonObject])[] = [
      ['requested', { attemptId: 'a-1' }],
      [
        'prepared',
        {
          attemptId: 'a-1',
          argumentDigest: 'c'.repeat(64),
          capabilityId: 'browser.snapshot',
          effectKind: 'read-only',
          effectConcurrency: 'serial',
          recoveryPolicy: 'read_only_retryable',
        },
      ],
      ['started', { attemptId: 'a-1' }],
      [
        'accepted',
        {
          attemptId: 'a-1',
          dispatchId: 'd-1',
          status: 'completed',
          costTracked: false,
          budgetOverrun: false,
          ...retained,
        },
      ],
    ]
    let revision = 0
    for (const [stage, payload] of stages) {
      await journal.append({
        eventId: `d-1:${stage}:a-1`,
        streamKind: 'capability.dispatch',
        streamId: 'd-1',
        expectedStreamRevision: revision,
        type: `capability.dispatch.${stage}`,
        payloadSchemaVersion: 1,
        payload,
        correlationId: 'd-1',
      })
      revision += 1
    }
  } finally {
    await journal.close()
  }
}
