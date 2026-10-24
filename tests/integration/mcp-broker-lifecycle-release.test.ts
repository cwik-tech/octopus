import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  namespaceMcpToolName,
  type McpBrokerCallRequest,
  type McpBrokerRequestContext,
  type McpRunLeaseClaims,
} from '../../domains/mcp/mcp-runtime.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { CapabilityDispatchLifecycleCoordinator } from '../../services/capability-dispatch-lifecycle.js'

/**
 * Branch 1, Package 1b — inner lifecycle journey. One coherent outcome: the
 * MCP parent broker is an external participant in the shared dispatch
 * lifecycle for assignment release.
 *
 * Real local MCP transport throughout: one real `McpSettingsService` +
 * `McpClientManager` over two real stdio fixtures. Server A carries the
 * gated leader (started marker, then blocked at the gate until aborted);
 * server B carries the ungated late tool. Client-manager tool locks are per
 * server, so the late call on server B is never queued behind the gated
 * leader on server A. Both calls share one assignment, one lease scope, and
 * the one shared lifecycle coordinator the broker is constructed with.
 *
 * Expected Red until the broker participates in the lifecycle: the release
 * drains nothing, the late call executes through server B's transport, and
 * its result is a success rather than the mapped refusal.
 */

const repoRoot = process.cwd()
const nodeExecutablePath = process.execPath
const fixturePath = path.join(repoRoot, 'tests/fixtures/mcp/stdio-server.mjs')

const SERVER_A_ID = 'lifecycle-leader-fixture'
const SERVER_B_ID = 'lifecycle-late-fixture'
const NAMESPACED_LEADER_TOOL = namespaceMcpToolName(SERVER_A_ID, 'echo-marker')
const NAMESPACED_LATE_TOOL = namespaceMcpToolName(SERVER_B_ID, 'echo-marker')
const SESSION_ID = 'session-lifecycle-release'
const RUN_ID = 'run-lifecycle-release'
const ASSIGNMENT_ID = 'assignment-lifecycle-release'
const LEASE_ID = 'lease-lifecycle-release'
const AGENT_PATH = 'agents/lifecycle-release'
const LEADER_MARKER = 'release-leader-marker'
const LATE_MARKER = 'release-late-marker'
const RELEASE_DRAIN_TIMEOUT_MS = 250
const WAIT_TIMEOUT_MS = 10_000
const nowMs = Date.now()

process.env.PIPELINE_SKIP_TRUSTED_FOLDER_CHECK = '1'

test('assignment release drains an admitted MCP call and refuses a late call before transport', {
  timeout: 30_000,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-broker-lifecycle-release-'))
  // Server A (gated leader) evidence paths.
  const lifecyclePathA = path.join(directory, 'mcp-lifecycle-a.jsonl')
  const callsPathA = path.join(directory, 'mcp-calls-a.jsonl')
  const startedPathA = path.join(directory, 'mcp-started-a.txt')
  const gatePath = path.join(directory, 'mcp-gate.lock')
  // Server B (ungated late tool) evidence paths.
  const lifecyclePathB = path.join(directory, 'mcp-lifecycle-b.jsonl')
  const callsPathB = path.join(directory, 'mcp-calls-b.jsonl')

  const clientManager = new McpClientManager({
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 15_000,
    closeTimeoutMs: 1_000,
  })
  const settings = new McpSettingsService({
    storagePath: path.join(directory, 'mcp-servers.json'),
    secretCodec: {
      encrypt: (value: string) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
    },
    clientManager,
  })
  await settings.saveServer({
    id: SERVER_A_ID,
    name: 'Lifecycle leader fixture',
    transport: {
      type: 'stdio',
      command: nodeExecutablePath,
      args: [fixturePath],
      cwd: repoRoot,
      secretEnvironment: {
        MCP_FIXTURE_LIFECYCLE_PATH: { operation: 'replace', value: lifecyclePathA },
        MCP_FIXTURE_CALLS_PATH: { operation: 'replace', value: callsPathA },
        MCP_FIXTURE_TOOL_STARTED_PATH: { operation: 'replace', value: startedPathA },
        MCP_FIXTURE_TOOL_GATE_PATH: { operation: 'replace', value: gatePath },
        MCP_FIXTURE_TOOL_GATE_MARKER: { operation: 'replace', value: LEADER_MARKER },
      },
    },
  })
  await settings.saveServer({
    id: SERVER_B_ID,
    name: 'Lifecycle late fixture',
    transport: {
      type: 'stdio',
      command: nodeExecutablePath,
      args: [fixturePath],
      cwd: repoRoot,
      secretEnvironment: {
        MCP_FIXTURE_LIFECYCLE_PATH: { operation: 'replace', value: lifecyclePathB },
        MCP_FIXTURE_CALLS_PATH: { operation: 'replace', value: callsPathB },
      },
    },
  })

  const lifecycle = new CapabilityDispatchLifecycleCoordinator({
    releaseDrainTimeoutMs: RELEASE_DRAIN_TIMEOUT_MS,
  })
  const broker = new McpParentBroker({
    settingsService: settings,
    clientManager,
    grantResolver: () => true,
    leaseResolver: (context) => activeLease(context),
    limits: {
      perCallTimeoutMs: 15_000,
      maxConcurrentCallsPerRun: 2,
    },
    lifecycle,
  })

  try {
    const validatedA = await settings.validateServer(SERVER_A_ID, {
      stdioTrustAcknowledged: true,
    })
    assert.notEqual(
      validatedA.capabilities.tools,
      undefined,
      'server A must negotiate tool capability',
    )
    const validatedB = await settings.validateServer(SERVER_B_ID, {
      stdioTrustAcknowledged: true,
    })
    assert.notEqual(
      validatedB.capabilities.tools,
      undefined,
      'server B must negotiate tool capability',
    )
    await waitForLifecycleEvent(lifecyclePathA, 'ready', WAIT_TIMEOUT_MS)
    await waitForLifecycleEvent(lifecyclePathB, 'ready', WAIT_TIMEOUT_MS)

    // 1. The gated leader call reaches server A and blocks at the gate.
    let leaderSettled = false
    const leaderPromise = broker
      .callTool(
        toolCall(
          'leader',
          'release-leader-call',
          NAMESPACED_LEADER_TOOL,
          LEADER_MARKER,
        ),
      )
      .then((result) => {
        leaderSettled = true
        return result
      })
    // Event gate only: the started marker proves the leader is in transport,
    // blocked at the gate. It is never counted or compared afterwards. If
    // the leader settles before the marker appears, the wait fails
    // immediately with the complete sanitized leader result.
    await waitForStartedMarker(startedPathA, leaderPromise, WAIT_TIMEOUT_MS)

    // 2. Release the assignment through the shared lifecycle while the
    // leader is still draining.
    const scope = { sessionId: SESSION_ID, runId: RUN_ID, assignmentId: ASSIGNMENT_ID }
    const releasePromise = lifecycle.releaseAssignment(scope)

    // 3. A late call for the released assignment must be refused before any
    // transport interaction with server B.
    const lateResult = await broker.callTool(
      toolCall('late', 'release-late-call', NAMESPACED_LATE_TOOL, LATE_MARKER),
    )
    assert.equal(
      lateResult.isError,
      true,
      `the late call must be refused by the released assignment barrier; got: ` +
        JSON.stringify(lateResult),
    )
    assert.equal(lateResult.error?.code, 'result_too_large')
    assert.equal(lateResult.error?.retryable, true)
    assertCallsFileAbsentOrEmpty(callsPathB)

    // 4. The release drains the admitted leader on server A: it resolves
    // only after the leader settles, and the leader settles as a sanitized
    // failure once the bounded drain aborts the gated call.
    await releasePromise
    assert.equal(
      leaderSettled,
      true,
      'the release must drain the admitted leader rather than resolve over it',
    )
    const leaderResult = await leaderPromise
    assert.equal(
      leaderResult.isError,
      true,
      `the drained leader must settle as a failure; got: ` +
        JSON.stringify(leaderResult),
    )

    // 5. Exactly one transport attempt occurred: the gated leader on server
    // A, aborted at the gate and appending no call record; the refused late
    // call left nothing behind on server B.
    assertCallsFileAbsentOrEmpty(callsPathA)
    assertCallsFileAbsentOrEmpty(callsPathB)
  } finally {
    // Release the gated leader so authorization completions settle and
    // closeAll can proceed. Deterministic in both flows: in Red it releases
    // the still-gated leader; in Green the leader was already aborted by the
    // lifecycle drain and this is a no-op.
    fs.writeFileSync(gatePath, 'cleanup-open', 'utf8')
    await settings.closeAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function brokerContext(
  requestId: string,
): McpBrokerRequestContext {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId,
    leaseId: LEASE_ID,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    assignmentId: ASSIGNMENT_ID,
    agentPath: AGENT_PATH,
  }
}

function activeLease(context: McpBrokerRequestContext): McpRunLeaseClaims {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    audience: 'mcp-broker',
    leaseId: context.leaseId,
    sessionId: context.sessionId,
    runId: context.runId,
    assignmentId: context.assignmentId,
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
    allowedAgentPaths: [context.agentPath],
  }
}

function toolCall(
  requestId: string,
  toolCallId: string,
  namespacedToolName: string,
  marker: string,
): McpBrokerCallRequest {
  return {
    context: brokerContext(requestId),
    toolCallId,
    namespacedToolName,
    arguments: { marker },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
}

function assertCallsFileAbsentOrEmpty(filePath: string): void {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return
    throw error
  }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0)
  assert.deepEqual(
    lines,
    [],
    `the MCP calls file must remain absent or empty; got ${lines.length} record(s)`,
  )
}

function readJsonLines(filePath: string): unknown[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return []
    throw error
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      return parsed
    })
}

/**
 * Event-based bounded wait on the fixture lifecycle file. The fixture writes
 * one JSON object per event (`recordLifecycle`), so each row is parsed as
 * unknown and narrowed before its `event` field is compared. Watches the
 * containing directory (the file may not exist yet); no polling loop, no
 * sleeps.
 */
function waitForLifecycleEvent(
  filePath: string,
  event: string,
  timeoutMs: number,
): Promise<void> {
  const eventRecorded = () =>
    readJsonLines(filePath).some(
      (row) => isRecord(row) && row['event'] === event,
    )
  return waitForCondition(eventRecorded, filePath, timeoutMs)
}

/**
 * Event-based bounded wait for the fixture's started marker, raced against
 * the leader's own settlement. If the leader settles before the marker
 * appears, the wait fails immediately with the complete sanitized leader
 * result instead of running out the bounded timeout. Watches the containing
 * directory (the file may not exist yet); watcher and timer are closed on
 * every outcome. No polling loop, no sleeps, no floating settlement.
 */
function waitForStartedMarker(
  filePath: string,
  leaderPromise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let watcher: fs.FSWatcher | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (outcome: () => void) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      watcher?.close()
      outcome()
    }
    const markerPresent = () => {
      let raw: string
      try {
        raw = fs.readFileSync(filePath, 'utf8')
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') return false
        throw error
      }
      return raw.split('\n').some((line) => line.trim().length > 0)
    }
    if (markerPresent()) {
      resolve()
      return
    }
    timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`Timed out waiting for the started marker (${filePath})`)),
      )
    }, timeoutMs)
    // Intentionally detached observer: both fulfillment and rejection are
    // consumed here, and `finish` is idempotent, so no settlement floats
    // unhandled regardless of which racer wins.
    void leaderPromise.then(
      (result) => {
        finish(() =>
          reject(
            new Error(
              'the leader settled before reaching the fixture gate; result: ' +
                JSON.stringify(result),
            ),
          ),
        )
      },
      (error: unknown) => {
        finish(() =>
          reject(
            error instanceof Error
              ? error
              : new Error(
                  `the leader rejected before reaching the fixture gate: ${String(error)}`,
                ),
          ),
        )
      },
    )
    try {
      watcher = fs.watch(path.dirname(filePath), () => {
        if (!markerPresent()) return
        finish(resolve)
      })
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      return
    }
    // A write that lands between the first check and the watcher registration
    // fires no event; re-check once the watcher exists.
    if (markerPresent()) finish(resolve)
  })
}

function waitForCondition(
  satisfied: () => boolean,
  filePath: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (satisfied()) {
      resolve()
      return
    }
    let watcher: fs.FSWatcher | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (outcome: () => void) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      watcher?.close()
      outcome()
    }
    timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`Timed out waiting for ${filePath} to satisfy the wait predicate`)),
      )
    }, timeoutMs)
    try {
      watcher = fs.watch(path.dirname(filePath), () => {
        if (!satisfied()) return
        finish(resolve)
      })
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      return
    }
    // A write that lands between the first check and the watcher registration
    // fires no event; re-check once the watcher exists.
    if (satisfied()) finish(resolve)
  })
}
