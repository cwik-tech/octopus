/**
 * A dispatch's text has to reach the parent before the run says it ended.
 *
 * The two halves of what the user sees travel by different roads. Display
 * frames are batched and posted over loopback; the durable `agent.end` is
 * written straight to the assignment journal, which the renderer polls. If the
 * end can overtake the frames, the run panel learns the attempt is finished
 * while its text is still in flight — and by then the bubble has already been
 * replaced by the step's outcome, so that text is never shown at all.
 *
 * The MCP worker path makes this the difference between a bubble and nothing:
 * a tool-enabled Team agent produces exactly one frame, at the very end, so a
 * lost race loses the whole answer rather than a tail.
 *
 * Everything below is the real path — the real sender over a real loopback
 * request, the real worker-turn client, and the real journal writer — because
 * the property under test is an ordering between two transports, which a mock
 * of either one would decide for itself.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { dispatchToAgentOrTeam } from '../../domains/agent-execution/agent-runner.js'
import {
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  AGENT_TEXT_STREAM_URL_ENV,
} from '../../domains/runtime/agent-text-delta-tokens.js'
import {
  MCP_WORKER_TURN_CONTRACT_VERSION,
  MCP_WORKER_TURN_URL_ENV,
} from '../../domains/mcp/mcp-worker-turn.js'
import type { LoadedAgent, RuntimeState } from '../../core/types.js'

const ANSWER = 'Electron ships faster but Tauri ships smaller.'
const CHANNEL_ID = '5f2504e0-4f89-41d3-9a0c-0305e82c3399'
const DEADLINE_MS = 10_000

interface HeldIngestServer {
  readonly url: string
  readonly requestArrived: Promise<void>
  readonly frames: () => unknown[]
  readonly release: () => void
  readonly close: () => Promise<void>
}

/**
 * The parent's ingest route, with its answer withheld.
 *
 * Holding the response is what makes the ordering observable: while it is
 * held, a dispatch that respects the barrier cannot have logged its end yet.
 */
async function startHeldIngestServer(): Promise<HeldIngestServer> {
  const received: unknown[] = []
  let signalArrival: (() => void) | undefined
  const requestArrived = new Promise<void>((resolve) => {
    signalArrival = resolve
  })
  let release: (() => void) | undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const frames = (parsed as { frames?: unknown }).frames
        if (Array.isArray(frames)) received.push(...frames)
      } catch {
        // Reported by the frame assertions below rather than here.
      }
      signalArrival?.()
      await released
      response.writeHead(202).end()
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  assert.ok(release)
  return {
    url: `http://127.0.0.1:${address.port}/internal/agent-text-stream`,
    requestArrived,
    frames: () => [...received],
    release,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

interface WorkerServer {
  readonly url: string
  readonly close: () => Promise<void>
}

/** The parent's worker-turn route: one completed, tool-using answer. */
async function startWorkerServer(): Promise<WorkerServer> {
  const server = http.createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) {
        // Consume the real request body.
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          version: MCP_WORKER_TURN_CONTRACT_VERSION,
          kind: 'completed',
          text: ANSWER,
          model: 'vendor/actual',
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          availableToolCount: 3,
          toolCallCount: 1,
          executedToolCallCount: 1,
        }),
      )
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/internal/mcp-worker-turn`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

function withDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${message} (within ${DEADLINE_MS}ms)`)),
      DEADLINE_MS,
    )
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** Every terminal line the assignment journal holds for this dispatch. */
function journalEvents(outputPath: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed: unknown = JSON.parse(line)
          if (parsed && typeof parsed === 'object') {
            events.push({ ...(parsed as Record<string, unknown>) })
          }
        } catch {
          // Not every journal line is JSON; those cannot be an agent event.
        }
      }
    }
  }
  walk(outputPath)
  return events
}

function hasEndEvent(outputPath: string): boolean {
  return journalEvents(outputPath).some((event) => event.event === 'end')
}

const agent: LoadedAgent = {
  name: 'spec-beta',
  model: 'vendor/configured',
  thinking: 'medium',
  tools: ['browser'],
  systemPrompt: 'Compare the runtimes.',
  experienceContent: '',
  experienceEnabled: false,
  skillsContent: '',
  knowledgeContent: '',
  selection: null,
  agentDir: '',
  color: 1,
  provider: 'openai',
}

function runtimeState(): RuntimeState {
  return {
    sessionId: '11111111-1111-4111-8111-111111111111',
    currentLevelIndex: 0,
    levelStates: new Map(),
    totalCost: 0,
    startTime: 0,
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }
}

test('a dispatch does not record its end until its text has reached the parent', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-barrier-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  const outputPath = path.join(directory, 'assignment')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(outputPath, { recursive: true })

  const ingest = await startHeldIngestServer()
  const worker = await startWorkerServer()
  const previousEnv = { ...process.env }
  process.env[AGENT_TEXT_STREAM_URL_ENV] = ingest.url
  process.env[AGENT_TEXT_STREAM_CHANNEL_ENV] = CHANNEL_ID
  process.env[AGENT_TEXT_STREAM_TOKEN_ENV] = 'barrier-test-token'
  process.env[MCP_WORKER_TURN_URL_ENV] = worker.url
  process.env.TEAM_RUNTIME_SESSION_ID = '11111111-1111-4111-8111-111111111111'
  process.env.TEAM_RUNTIME_RUN_ID = '22222222-2222-4222-8222-222222222222'
  process.env.TEAM_RUNTIME_ASSIGNMENT_ID =
    'child-research-33333333-3333-4333-8333-333333333333'
  process.env.TEAM_RUNTIME_TASK_ID = '22222222-2222-4222-8222-222222222222'
  process.env.TEAM_RUNTIME_PROCESS_IDENTITY =
    '44444444-4444-4444-8444-444444444444'
  process.env.TEAM_RUNTIME_WORKFLOW_ID = 'team-chat'
  process.env.TEAM_RUNTIME_WORKFLOW_STEP_ID = 'chat-turn'

  try {
    // Not awaited: the point is what is true while the delivery is in flight.
    const dispatch = dispatchToAgentOrTeam({
      agent,
      rosterEntry: undefined,
      finalPrompt: 'Compare the runtimes.',
      userMessage: 'Which desktop runtime should we pick?',
      state: runtimeState(),
      workspacePath,
      outputPath,
      metrics: undefined,
      logicalInvocationId: 'call-1',
      attempt: 1,
      teamName: 'board-team',
    })
    const settled = dispatch.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    await withDeadline(
      ingest.requestArrived,
      'the dispatch never posted its display frames',
    )

    // The parent has the request and has not answered it. A dispatch that
    // waits for delivery cannot have written its end yet.
    assert.equal(
      hasEndEvent(outputPath),
      false,
      'the run recorded the dispatch as ended while its text was still in flight',
    )

    ingest.release()
    const outcome = await withDeadline(settled, 'the dispatch never finished')
    assert.equal(outcome.ok, true, `the dispatch failed: ${String(outcome.ok ? '' : outcome.error)}`)

    // Both halves landed, and the end is now recorded.
    assert.equal(hasEndEvent(outputPath), true)
    const frames = ingest.frames()
    const describe = JSON.stringify(frames)
    assert.ok(
      frames.some(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          (frame as { text?: unknown }).text === ANSWER,
      ),
      `the answer never reached the parent: ${describe}`,
    )
    assert.ok(
      frames.some(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          (frame as { type?: unknown }).type === 'final',
      ),
      `the bubble was never closed: ${describe}`,
    )
  } finally {
    ingest.release()
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key]
    }
    Object.assign(process.env, previousEnv)
    await ingest.close()
    await worker.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/** The parent's worker-turn route, refusing the turn on an exhausted quota. */
async function startUsageLimitedWorkerServer(): Promise<WorkerServer> {
  const server = http.createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) {
        // Consume the real request body.
      }
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: 'MCP worker turn failed',
          code: 'execution_failed',
          providerCode: 'provider_usage_limit',
          retryable: false,
          resetsAt: 'Sep 14, 2026 at 9:45 PM',
        }),
      )
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/internal/mcp-worker-turn`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

test('a failed dispatch records its failure, and why, under the dispatch that started', async () => {
  // The run panel closes a step's bubble on that attempt's own ending, found by
  // dispatch id. A failure written without one left every failed step open
  // until the whole run ended, and the reason it gave never reached the bubble.
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-failure-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  const outputPath = path.join(directory, 'assignment')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(outputPath, { recursive: true })

  const worker = await startUsageLimitedWorkerServer()
  const previousEnv = { ...process.env }
  process.env[MCP_WORKER_TURN_URL_ENV] = worker.url
  process.env.TEAM_RUNTIME_SESSION_ID = '11111111-1111-4111-8111-111111111111'
  process.env.TEAM_RUNTIME_RUN_ID = '22222222-2222-4222-8222-222222222222'
  process.env.TEAM_RUNTIME_ASSIGNMENT_ID =
    'child-research-33333333-3333-4333-8333-333333333333'
  process.env.TEAM_RUNTIME_TASK_ID = '22222222-2222-4222-8222-222222222222'
  process.env.TEAM_RUNTIME_PROCESS_IDENTITY =
    '44444444-4444-4444-8444-444444444444'
  process.env.TEAM_RUNTIME_WORKFLOW_ID = 'team-chat'
  process.env.TEAM_RUNTIME_WORKFLOW_STEP_ID = 'chat-turn'

  try {
    await assert.rejects(
      withDeadline(
        dispatchToAgentOrTeam({
          agent,
          rosterEntry: undefined,
          finalPrompt: 'Compare the runtimes.',
          userMessage: 'Which desktop runtime should we pick?',
          state: runtimeState(),
          workspacePath,
          outputPath,
          metrics: undefined,
          logicalInvocationId: 'call-1',
          attempt: 1,
          teamName: 'board-team',
        }),
        'the dispatch never settled',
      ),
    )

    const events = journalEvents(outputPath)
    const started = events.find((event) => event.event === 'start')
    const failed = events.find((event) => event.event === 'fail')
    assert.ok(started, 'the dispatch never recorded its start')
    assert.ok(failed, 'the dispatch never recorded its failure')
    assert.equal(typeof started.dispatch_id, 'string')
    assert.equal(
      failed.dispatch_id,
      started.dispatch_id,
      'the failure was not recorded under the dispatch it ended',
    )
    assert.equal(
      failed.status,
      "You've hit your provider usage limit. It resets on Sep 14, 2026 at 9:45 PM.",
    )
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key]
    }
    Object.assign(process.env, previousEnv)
    await worker.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
