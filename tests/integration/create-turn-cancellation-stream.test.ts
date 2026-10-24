/**
 * Stop must never leave a finished-looking answer behind.
 *
 * Cancellation on the Create lanes has two shapes. When the abort interrupts
 * the provider call the turn throws, and the bubble closes as an error on the
 * way out — that path is already covered. The one under test here is the other
 * one: the user pressed Stop, but generation had already returned by the time
 * the abort landed, so the route reaches its own cancellation check with a
 * complete result in hand. A bubble closes exactly once, so publishing
 * `completed` before consulting that check cannot be taken back, and the user
 * is shown a finished answer for work that was thrown away.
 *
 * Driven through the route handlers rather than the whole server so the race
 * is stated rather than raced for: the registry reports the job stopped, and
 * the model answers normally.
 *
 * The last test here covers the same rule for a different failure: the turn was
 * not stopped, but the acceptance work that follows generation threw. Success
 * is only success once that work is done.
 */
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { URL } from 'node:url'

import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import { CreateJobRegistry } from '../../server/create-job-registry.js'
import { ResourceArchitectStore } from '../../server/resource-architect-store.js'
import { handleResourceArchitectRoutes } from '../../server/routes/resource-architect.js'
import { handleWorkflowRoutes } from '../../server/routes/workflows.js'
import type { AgentTextStreamFrame } from '../../contracts/agent-text-stream.js'
import type { ResourceArchitectTurnMetric } from '../../contracts/resource-architect.js'

const DEADLINE_MS = 10_000

/**
 * A registry that stops the job at the moment the turn asks to settle.
 *
 * Stated rather than raced for, and stated with the registry's own operations:
 * the real `cancel` runs — flipping the status and aborting a signal that has
 * nothing left to interrupt, exactly as it does when the provider call has
 * already resolved — and the real `claimCompletion` then refuses for its own
 * reason. Nothing here invents an outcome.
 *
 * Written against `claimCompletion` because that is what the routes now
 * consult. An earlier version overrode `isCancelled`, which the completion
 * claim replaced, so it was stating a precondition nothing read.
 */
class StoppedAfterGenerationRegistry extends CreateJobRegistry {
  stopped = false
  override claimCompletion(jobId: string): 'granted' | 'cancelled' {
    if (this.stopped && this.isActive(jobId)) this.cancel(jobId)
    return super.claimCompletion(jobId)
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

interface ModelServer {
  readonly url: string
  readonly close: () => Promise<void>
}

/** A model endpoint that answers in full and ends, so nothing is interrupted. */
async function startModelServer(suffixes: readonly string[]): Promise<ModelServer> {
  const server = http.createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) {
        // Consume the real request body.
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      })
      for (const [index, content] of suffixes.entries()) {
        const chunk =
          index === 0
            ? { model: 'test-model', choices: [{ delta: { content } }] }
            : { choices: [{ delta: { content } }] }
        response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

interface RouteServer {
  readonly url: string
  readonly close: () => Promise<void>
}

/** Serve exactly one route handler, so nothing else can answer the request. */
async function startRouteServer(
  handle: (params: {
    req: http.IncomingMessage
    res: http.ServerResponse
    url: URL
  }) => Promise<boolean>,
): Promise<RouteServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void handle({ req, res, url }).then(
      (handled) => {
        if (!handled && !res.writableEnded) {
          res.writeHead(404).end()
        }
      },
      (error: unknown) => {
        if (!res.writableEnded) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: String(error) }))
        }
      },
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function framesOf(hub: AgentTextStreamHub, channelId: string): AgentTextStreamFrame[] {
  return [...(hub.read(channelId, 0)?.frames ?? [])]
}

function assertStoppedTurnHasNoCompletion(frames: readonly AgentTextStreamFrame[]): void {
  const terminals = frames.filter(
    (frame) => frame.type === 'final' || frame.type === 'error',
  )
  const describe = JSON.stringify(frames)
  assert.equal(
    terminals.some((frame) => frame.type === 'final'),
    false,
    `a stopped turn was reported as a completed answer: ${describe}`,
  )
  // The bubble still has to close, or the reader waits on text that will
  // never finish.
  assert.equal(terminals.at(-1)?.type, 'error', describe)
}

function writeResourceArchitectConfig(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, 'teams', 'resource-architect'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'agents', 'resource-architect'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  fs.writeFileSync(
    path.join(repoRoot, 'teams', 'resource-architect', 'team.yaml'),
    [
      'agents:',
      '  - agent_file: ../../agents/resource-architect/resource-architect.md',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(repoRoot, 'agents', 'resource-architect', 'resource-architect.md'),
    // The architect runs with its own agent file's pair.
    "---\nprovider: openai\nmodel: test-model\nthinking: medium\n---\n\n" + ('Help the user design Agents and Teams.'),
  )
}

function writeWorkflowArchitectConfig(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, 'teams', 'workflow-architect'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'agents', 'workflow-architect'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  fs.mkdirSync(path.join(repoRoot, 'workflows'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'workflows', 'registry.yaml'), '')
  fs.writeFileSync(
    path.join(repoRoot, 'teams', 'workflow-architect', 'team.yaml'),
    [
      'agents:',
      '  - agent_file: ../../agents/workflow-architect/workflow-architect.md',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(repoRoot, 'agents', 'workflow-architect', 'workflow-architect.md'),
    // The architect runs with its own agent file's pair.
    "---\nprovider: openai\nmodel: test-model\nthinking: medium\n---\n\n" + ('Reply with one JSON object in a fenced code block.'),
  )
}

interface Lane {
  readonly directory: string
  readonly repoRoot: string
  readonly workspacePath: string
  readonly restoreEnvironment: () => void
}

function prepareLane(prefix: string, modelUrl: string): Lane {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const repoRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(repoRoot, { recursive: true })
  const previousKey = process.env.OPENAI_API_KEY
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = modelUrl
  return {
    directory,
    repoRoot,
    workspacePath,
    restoreEnvironment: () => {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousKey
      if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
      else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl
    },
  }
}

test('an Agent Architect turn stopped after generation is not reported as completed', async () => {
  const model = await startModelServer(['Kestrel', ' and Marlin'])
  const lane = prepareLane('architect-stop-', model.url)
  writeResourceArchitectConfig(lane.repoRoot)

  const hub = new AgentTextStreamHub()
  const registry = new StoppedAfterGenerationRegistry()
  // Stated up front: this turn belongs to a job the user has already stopped.
  registry.stopped = true

  const route = await startRouteServer(({ req, res, url }) =>
    handleResourceArchitectRoutes({
      req,
      res,
      url,
      options: {
        repoRootPath: lane.repoRoot,
        createJobRegistry: registry,
        resourceArchitectStore: new ResourceArchitectStore(lane.workspacePath),
        // This existing cancellation contract exercises the supported single-pass mode.
        reviewEnabled: false,
        agentTextStreamHub: hub,
        isAbortLike,
      },
    }),
  )

  const jobId = crypto.randomUUID()
  try {
    const response = await withDeadline(
      fetch(`${route.url}/create/resource-architect/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId,
          operation: 'conversation',
          history: [{ role: 'user', text: 'Design me a reviewer.' }],
          currentPlan: null,
        }),
      }),
      'the turn never answered',
    )
    const payload = (await response.json()) as { cancelled?: boolean }
    assert.equal(payload.cancelled, true, JSON.stringify(payload))
  } finally {
    registry.close()
    await route.close()
    await model.close()
    lane.restoreEnvironment()
    fs.rmSync(lane.directory, { recursive: true, force: true })
  }

  assertStoppedTurnHasNoCompletion(framesOf(hub, jobId))
})

test('a Workflow Architect turn stopped after generation is not reported as completed', async () => {
  const model = await startModelServer([
    '```json\n{"message": "I suggest the review workflow.",',
    ' "draft": null, "warnings": []}\n```',
  ])
  const lane = prepareLane('workflow-stop-', model.url)
  writeWorkflowArchitectConfig(lane.repoRoot)

  const hub = new AgentTextStreamHub()
  const registry = new StoppedAfterGenerationRegistry()
  registry.stopped = true

  const route = await startRouteServer(({ req, res, url }) =>
    handleWorkflowRoutes({
      req,
      res,
      url,
      options: {
        repoRootPath: lane.repoRoot,
        workflowsRegistryPath: path.join(lane.repoRoot, 'workflows', 'registry.yaml'),
        createJobRegistry: registry,
        agentTextStreamHub: hub,
        isAbortLike,
      },
    }),
  )

  const jobId = crypto.randomUUID()
  try {
    const response = await withDeadline(
      fetch(`${route.url}/create/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId,
          history: [{ role: 'user', text: 'Build me a review workflow.' }],
          currentDraft: null,
        }),
      }),
      'the turn never answered',
    )
    const payload = (await response.json()) as { cancelled?: boolean }
    assert.equal(payload.cancelled, true, JSON.stringify(payload))
  } finally {
    registry.close()
    await route.close()
    await model.close()
    lane.restoreEnvironment()
    fs.rmSync(lane.directory, { recursive: true, force: true })
  }

  assertStoppedTurnHasNoCompletion(framesOf(hub, jobId))
})

/**
 * A store whose *terminal* write fails, once generation has already succeeded.
 *
 * The obstruction is real: the store's own file is replaced by a directory, so
 * `writeFileAtomic`'s rename fails at the system call and the store's normal
 * write is what refuses. Only the moment is chosen.
 *
 * Written this way because an earlier version threw from every
 * `saveTurnMetric`, including the `running` record the route writes *before*
 * the provider is called. That turn never reached generation at all, so the
 * case could not have guarded what it claimed to.
 *
 * Aimed at the *completed* record specifically, and three things matter.
 * `attempted` shows the route reached its single completed-record write
 * (`server/routes/resource-architect.ts:203`), which only the branch after a
 * returned turn result can do — but a turn whose provider *failed* reaches it
 * too, because a failed call returns a fallback result rather than throwing
 * (`resource-architect-llm.ts:353`). Provider identity does not separate the
 * two either: a fallback deliberately keeps the pair it failed on.
 * `completedWasFallback` is what does, and `stored` then shows nothing but the
 * first write survived.
 */
class TerminalWriteFailureStore extends ResourceArchitectStore {
  readonly stored: string[] = []
  readonly attempted: string[] = []
  completedWasFallback: boolean | null = null
  private obstructed = false

  constructor(private readonly workspace: string) {
    super(workspace)
  }

  override async saveTurnMetric(
    metric: ResourceArchitectTurnMetric,
  ): Promise<void> {
    this.attempted.push(metric.status)
    if (metric.status === 'completed') this.completedWasFallback = metric.fallback
    if (!this.obstructed && metric.status === 'completed') {
      this.obstructed = true
      const filePath = path.join(
        this.workspace,
        'resource-architect-telemetry',
        'turns.json',
      )
      fs.rmSync(filePath, { force: true })
      fs.mkdirSync(filePath, { recursive: true })
    }
    await super.saveTurnMetric(metric)
    this.stored.push(metric.status)
  }
}

test('an Agent Architect turn whose acceptance work fails is not reported as completed', async () => {
  const model = await startModelServer(['Kestrel', ' and Marlin'])
  const lane = prepareLane('architect-accept-', model.url)
  writeResourceArchitectConfig(lane.repoRoot)

  const hub = new AgentTextStreamHub()
  const registry = new CreateJobRegistry()
  const store = new TerminalWriteFailureStore(lane.workspacePath)

  const route = await startRouteServer(({ req, res, url }) =>
    handleResourceArchitectRoutes({
      req,
      res,
      url,
      options: {
        repoRootPath: lane.repoRoot,
        createJobRegistry: registry,
        // Generation succeeds; recording its outcome does not.
        resourceArchitectStore: store,
        reviewEnabled: false,
        agentTextStreamHub: hub,
        isAbortLike,
      },
    }),
  )

  const jobId = crypto.randomUUID()
  try {
    const response = await withDeadline(
      fetch(`${route.url}/create/resource-architect/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId,
          operation: 'conversation',
          history: [{ role: 'user', text: 'Design me a reviewer.' }],
          currentPlan: null,
        }),
      }),
      'the turn never answered',
    )
    // The turn genuinely failed, so the user keeps nothing from it.
    assert.equal(response.ok, false, `unexpected success: ${response.status}`)
    // The route reached its completion branch, so the turn service returned a
    // result. On its own that is not yet proof a provider answered — see the
    // check below.
    assert.ok(
      store.attempted.includes('completed'),
      `the turn never reached a completion to record: ${JSON.stringify(store.attempted)}`,
    )
    // And the provider answered: a call that failed would have come back as a
    // fallback result, which the route records as completed just the same.
    assert.equal(
      store.completedWasFallback,
      false,
      'generation fell back rather than answering',
    )
    // Phase diagnostics can replace the running row. The public store snapshot
    // must retain only its last accepted running row after the refused write.
    const recorded = await store.listTurnMetrics()
    assert.deepEqual(recorded.map((metric) => metric.status), ['running'], JSON.stringify(store.attempted))
  } finally {
    registry.close()
    await route.close()
    await model.close()
    lane.restoreEnvironment()
    fs.rmSync(lane.directory, { recursive: true, force: true })
  }

  const frames = framesOf(hub, jobId)
  const describe = JSON.stringify(frames)
  assert.equal(
    frames.some((frame) => frame.type === 'final'),
    false,
    `a turn that was never accepted was reported as completed: ${describe}`,
  )
  assert.equal(frames.at(-1)?.type, 'error', describe)
})
