import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {
  CapabilityDispatchResult,
  CapabilityExecutionContext,
} from '../../contracts/capability-dispatch.js'
import type { CapabilityDurableDispatchPort } from '../../contracts/durable-dispatch.js'
import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { ExecutionJournalInspectionService } from '../../services/execution-journal-inspection.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'

/**
 * Phase 3 acceptance: an assignment journal is a lifecycle record, not a copy
 * of what a capability returned. A browser snapshot and an MCP tool result are
 * the two shapes that used to land in it — one small enough to inline, one
 * large enough to become a journal-owned file — and neither may leave a byte
 * anywhere below `.runtime/execution-journal/`. Durable reuse still has to
 * work across a restart, which is what makes this a relocation rather than a
 * deletion.
 */

const TENANT = 'tenant-content-separation'
const SESSION_ID = '2f7f2e18-6b1a-4a7c-9d13-8c5b0f3a41d2'
const RUN_ID = 'run-content-separation'
const ASSIGNMENT_ID = 'assignment-content-separation'

/** Unique enough that finding it in any file is proof, never a coincidence. */
const BROWSER_SENTINEL = 'browser-result-sentinel-9f2c41a7bd'
const MCP_SENTINEL = 'mcp-result-sentinel-4d7b18e3ca'

const BROWSER_DIGEST = 'a'.repeat(64)
const MCP_DIGEST = 'b'.repeat(64)

const browserResultValue = {
  kind: 'browser.snapshot',
  url: 'https://example.invalid/report',
  text: `visible page text ${BROWSER_SENTINEL}`,
}

const mcpResultValue = {
  kind: 'mcp.tool.result',
  toolName: 'search_documents',
  content: `${MCP_SENTINEL}${'x'.repeat(200_000)}`,
}

test('an assignment journal keeps no capability result content and still replays both after a restart', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = makeAssignmentDirectory(workspacePath)

    // Arrange: two real dispatch lifecycles on one real assignment journal.
    await withRegistry(workspacePath, async (port) => {
      await recordAcceptedDispatch(port, {
        dispatchId: 'dispatch-browser',
        argumentDigest: BROWSER_DIGEST,
        capabilityId: 'browser.snapshot',
        value: browserResultValue,
      })
      await recordAcceptedDispatch(port, {
        dispatchId: 'dispatch-mcp',
        argumentDigest: MCP_DIGEST,
        capabilityId: 'mcp.call_tool',
        value: mcpResultValue,
      })
    })

    // Act: a second process-shaped open of the same assignment.
    await withRegistry(workspacePath, async (port) => {
      const browser = await port.recover({
        dispatchId: 'dispatch-browser',
        argumentDigest: BROWSER_DIGEST,
      })
      assert.equal(browser.kind, 'retained')
      if (browser.kind !== 'retained') return
      assert.equal(browser.result.status, 'completed')
      if (browser.result.status !== 'completed') return
      assert.deepEqual(browser.result.value, browserResultValue)

      const mcp = await port.recover({
        dispatchId: 'dispatch-mcp',
        argumentDigest: MCP_DIGEST,
      })
      assert.equal(mcp.kind, 'retained')
      if (mcp.kind !== 'retained') return
      assert.equal(mcp.result.status, 'completed')
      if (mcp.result.status !== 'completed') return
      assert.deepEqual(mcp.result.value, mcpResultValue)
    })

    // Assert: the operator report explains the assignment without carrying a
    // byte of what the capabilities returned.
    const inspection = new ExecutionJournalInspectionService({
      workspacePath,
      authority: { authorize: async () => true },
    })
    const report = await inspection.inspect({
      sessionId: SESSION_ID,
      runId: RUN_ID,
      assignmentId: ASSIGNMENT_ID,
    })
    assert.equal(report.kind, 'report')
    const serializedReport = JSON.stringify(report)
    assert.ok(
      !serializedReport.includes(BROWSER_SENTINEL) &&
        !serializedReport.includes(MCP_SENTINEL),
      'the operator report must never carry capability result content',
    )

    // Assert: no file the journal owns holds either result, including the
    // manifest, the projections, and any sidecar beside the JSONL.
    const journalDirectory = path.join(
      assignmentPath,
      '.runtime',
      'execution-journal',
    )
    for (const filePath of listRegularFiles(journalDirectory)) {
      const contents = fs.readFileSync(filePath, 'utf8')
      assert.ok(
        !contents.includes(BROWSER_SENTINEL),
        `${path.relative(journalDirectory, filePath)} retains the browser result`,
      )
      assert.ok(
        !contents.includes(MCP_SENTINEL),
        `${path.relative(journalDirectory, filePath)} retains the MCP result`,
      )
    }

    // Assert: the exact bytes live in the assignment's own content store.
    const contentStorePath = path.join(
      assignmentPath,
      '.runtime',
      'capability-results',
    )
    const storedFiles = listRegularFiles(contentStorePath)
    assert.equal(storedFiles.length, 2)
    const storedContents = storedFiles.map((filePath) =>
      fs.readFileSync(filePath, 'utf8'),
    )
    assert.ok(storedContents.some((body) => body.includes(BROWSER_SENTINEL)))
    assert.ok(storedContents.some((body) => body.includes(MCP_SENTINEL)))
    assert.equal(fs.statSync(contentStorePath).mode & 0o777, 0o700)
    for (const filePath of storedFiles) {
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
    }

    // Assert: deleting the owning session removes both owners together.
    const sessions = new FileSystemSessionStore(workspacePath)
    assert.equal(await sessions.deleteSession(SESSION_ID), true)
    assert.equal(fs.existsSync(journalDirectory), false)
    assert.equal(fs.existsSync(contentStorePath), false)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'capability-content-separation-'))
}

function makeAssignmentDirectory(workspacePath: string): string {
  const assignmentPath = path.join(
    workspacePath,
    'sessions',
    SESSION_ID,
    'runs',
    RUN_ID,
    'assignments',
    ASSIGNMENT_ID,
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  return assignmentPath
}

async function withRegistry(
  workspacePath: string,
  use: (port: CapabilityDurableDispatchPort) => Promise<void>,
): Promise<void> {
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const port = await registry.resolve({
      context: makeContext(),
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 10_000,
    })
    assert.ok(port, 'the assignment must enrol a durable dispatch port')
    await use(port)
  } finally {
    await registry.close()
  }
}

function makeContext(): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: 'request-content-separation',
    sessionId: SESSION_ID,
    runId: RUN_ID,
    assignmentId: ASSIGNMENT_ID,
    agentPath: 'agents/content-separation',
    authority: {
      kind: 'runtime-assignment',
      processIdentity: 'content-separation',
    },
  }
}

async function recordAcceptedDispatch(
  port: CapabilityDurableDispatchPort,
  input: {
    readonly dispatchId: string
    readonly argumentDigest: string
    readonly capabilityId: string
    readonly value: unknown
  },
): Promise<void> {
  const attemptId = `attempt-${input.dispatchId}`
  await port.recordRequested({ dispatchId: input.dispatchId, attemptId })
  await port.recordPrepared({
    dispatchId: input.dispatchId,
    attemptId,
    argumentDigest: input.argumentDigest,
    capabilityId: input.capabilityId,
    effect: serialCapabilityEffect('read-only'),
    recoveryPolicy: 'read_only_retryable',
  })
  await port.recordStarted({ dispatchId: input.dispatchId, attemptId })
  await port.recordCommitted({ dispatchId: input.dispatchId, attemptId })
  await port.recordAccepted({
    dispatchId: input.dispatchId,
    attemptId,
    result: completedResult(input.dispatchId, input.value),
  })
}

function completedResult(
  dispatchId: string,
  value: unknown,
): CapabilityDispatchResult {
  return {
    status: 'completed',
    dispatchId,
    value,
    costTracked: false,
    budgetOverrun: false,
  }
}

function listRegularFiles(directory: string): readonly string[] {
  if (!fs.existsSync(directory)) return []
  const found: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...listRegularFiles(entryPath))
    else if (entry.isFile()) found.push(entryPath)
  }
  return found
}
