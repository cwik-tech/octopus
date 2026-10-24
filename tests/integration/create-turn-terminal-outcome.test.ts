/**
 * One turn, one account of how it ended.
 *
 * Stop and the turn itself both answer the question "did this finish?", and
 * until now they could answer it differently. Each route takes a single
 * cancellation read and then writes the turn's terminal record; a cancellation
 * landing after that read is invisible to the reply but still flips the job, so
 * the Stop acknowledgement says cancelled while the reply — and the durable
 * record behind it — say completed.
 *
 * Stated rather than raced for, and only the *timing* is arranged. The stores
 * here are the real ones with one write held open; what they then write is
 * their own, and every claim about what was stored is read back through a fresh
 * store rather than from the process that did the writing. The cancellation is
 * issued by calling `cancelAndWait` on the same real registry the routes were
 * given, which is the entire body of the cancel route at
 * `server/routes/create-support.ts:53`; sending it over HTTP would leave the
 * moment it lands unobservable, and no timer may stand in for that.
 *
 * Three shapes are covered, because the order matters:
 *   - a cancellation landing *after* the turn commits its outcome, which is the
 *     race itself;
 *   - a cancellation recorded *before* the turn asks to settle, where a
 *     proposal already on disk is deliberately still reported as completed;
 *   - a failure *after* the outcome is committed, which must not produce a
 *     second terminal record for the same turn.
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
import { TurnMetricStore } from '../../server/turn-metric-store.js'
import { handleResourceArchitectRoutes } from '../../server/routes/resource-architect.js'
import { handleWorkflowRoutes } from '../../server/routes/workflows.js'
import type { ResourceArchitectTurnMetric } from '../../contracts/resource-architect.js'

const DEADLINE_MS = 15_000
const WORKFLOW_TELEMETRY = 'workflow-architect-telemetry'
const RESOURCE_TELEMETRY = 'resource-architect-telemetry'

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

/**
 * One moment in a real write, held open.
 *
 * Two promises rather than a flag: one the test waits on to know the route has
 * reached the moment, one the route waits on to leave it. Nothing here decides
 * an outcome — the real write still happens, once released.
 */
class Gate {
  private announce: (() => void) | undefined
  private open: (() => void) | undefined
  private announced = false
  readonly reached: Promise<void>
  private readonly held: Promise<void>

  constructor() {
    this.reached = new Promise<void>((resolve) => {
      this.announce = resolve
    })
    this.held = new Promise<void>((resolve) => {
      this.open = resolve
    })
  }

  release(): void {
    this.open?.()
  }

  /** Holds the first caller and lets every later one straight through. */
  async holdOnce(): Promise<void> {
    if (this.announced) return
    this.announced = true
    this.announce?.()
    await this.held
  }
}

/**
 * The real Workflow Architect store, with a hook before each terminal write.
 *
 * Instrumentation, not a substitute: every write is `super.save`, and the hook
 * decides only *when* it happens and what the world looks like when it does. It
 * never returns or throws an outcome of its own — a store that invented one
 * would be describing a failure the real store cannot have.
 */
class InstrumentedWorkflowTurnStore extends TurnMetricStore {
  private terminalWrites = 0
  /** What the route first tried to write, so a test can check it is the right moment. */
  firstTerminalMetric: ResourceArchitectTurnMetric | undefined
  beforeTerminalWrite: ((attempt: number) => Promise<void> | void) | undefined

  constructor(workspacePath: string) {
    super(workspacePath, WORKFLOW_TELEMETRY)
  }

  override async save(metric: ResourceArchitectTurnMetric): Promise<void> {
    if (metric.status !== 'running') {
      this.terminalWrites += 1
      if (this.terminalWrites === 1) this.firstTerminalMetric = metric
      await this.beforeTerminalWrite?.(this.terminalWrites)
    }
    await super.save(metric)
  }
}

/** The real Agent Architect store, with its terminal write held open. */
class HeldResourceTurnStore extends ResourceArchitectStore {
  private held = false
  heldMetric: ResourceArchitectTurnMetric | undefined

  constructor(
    workspacePath: string,
    private readonly gate: Gate,
  ) {
    super(workspacePath)
  }

  override async saveTurnMetric(
    metric: ResourceArchitectTurnMetric,
  ): Promise<void> {
    if (!this.held && metric.status !== 'running') {
      this.held = true
      this.heldMetric = metric
      await this.gate.holdOnce()
    }
    // The real write, always. Only its moment is chosen here.
    await super.saveTurnMetric(metric)
  }
}

/**
 * Make the store's own file unwritable, for real.
 *
 * `writeFileAtomic` renames a temporary file over `turns.json`, and a rename
 * onto a directory fails at the system call. Nothing is simulated: the store
 * runs its normal write and the filesystem refuses it, which is the failure
 * this needs and the same obstruction the store's own tests use.
 */
function obstructTurnsFile(workspacePath: string, directory: string): () => void {
  const filePath = path.join(workspacePath, directory, 'turns.json')
  fs.rmSync(filePath, { force: true })
  fs.mkdirSync(filePath, { recursive: true })
  return () => fs.rmSync(filePath, { recursive: true, force: true })
}

/**
 * The real store with the plan write held open.
 *
 * A different moment from the one above, and deliberately earlier: the turn
 * service persists the plan before the route ever reads cancellation, so a
 * cancellation landing here is recorded *before* the turn asks to settle.
 */
class HeldPlanSaveStore extends ResourceArchitectStore {
  constructor(
    workspacePath: string,
    private readonly gate: Gate,
  ) {
    super(workspacePath)
  }

  override async savePlan(
    plan: Parameters<ResourceArchitectStore['savePlan']>[0],
  ): Promise<void> {
    await this.gate.holdOnce()
    await super.savePlan(plan)
  }
}

interface ModelServer {
  readonly url: string
  readonly failures: () => string[]
  readonly close: () => Promise<void>
}

/**
 * A model endpoint that answers in full and ends, so nothing is interrupted.
 *
 * Answers a streaming request with SSE and a non-streaming one with a plain
 * body, because the two Architect operations do not ask the same way. Its own
 * failures are recorded rather than left to become unhandled rejections: a
 * fixture that disconnected must be reported as that, not as a route defect.
 */
async function startModelServer(content: string): Promise<ModelServer> {
  const failures: string[] = []
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString('utf8')
      const streaming = /"stream"\s*:\s*true/.test(body)
      if (!streaming) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ model: 'test-model', choices: [{ message: { content } }] }),
        )
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      })
      response.write(
        `data: ${JSON.stringify({ model: 'test-model', choices: [{ delta: { content } }] })}\n\n`,
      )
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    })().catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : String(error))
      response.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    failures: () => [...failures],
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

interface RouteServer {
  readonly url: string
  /**
   * Every handler this server has started, finished.
   *
   * A route answers before it is done: the reply is written, and the record it
   * writes afterwards — in a catch, or a finally — lands later. Reading the
   * store when the response arrives would be reading it in the middle of the
   * turn, and a second row written a moment later would go unseen.
   */
  readonly settled: () => Promise<void>
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
  const handled: Promise<void>[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const running = handle({ req, res, url })
    handled.push(running.then(() => undefined, () => undefined))
    void running.then(
      (wasHandled) => {
        if (!wasHandled && !res.writableEnded) {
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
    settled: async () => {
      await Promise.all([...handled])
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

/** The request carries its own deadline: a waiter's timer does not free a socket. */
function postTurn(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEADLINE_MS),
  })
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
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

function writeWorkflowArchitectConfig(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, 'teams', 'workflow-architect'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'agents', 'workflow-architect'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'workflows'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
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
    '---\nprovider: openai\nmodel: test-model\nthinking: medium\n---\n\nReply with one JSON object in a fenced code block.',
  )
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
    '---\nprovider: openai\nmodel: test-model\nthinking: medium\n---\n\nHelp the user design Agents and Teams.',
  )
}

const WORKFLOW_REPLY_MESSAGE = 'I suggest the review workflow.'
const WORKFLOW_MODEL_CONTENT = `\`\`\`json\n${JSON.stringify({
  message: WORKFLOW_REPLY_MESSAGE,
  draft: null,
  warnings: [],
})}\n\`\`\``
const CONVERSATION_REPLY_MESSAGE = 'Kestrel and Marlin both look right.'
const PROPOSAL_REPLY_MESSAGE = 'The proposal is ready for review.'
const PROPOSAL_MODEL_CONTENT = JSON.stringify({
  message: PROPOSAL_REPLY_MESSAGE,
  outcome: {
    kind: 'standalone_agents',
    agents: [
      {
        name: 'contract-reviewer',
        role: 'Reviewer',
        tier: 'specialist',
        summary: 'Reviews contracts for the user.',
        description: 'Reviews contracts.',
        rationale: 'Requested by the user.',
      },
    ],
  },
  warnings: [],
})

/**
 * What survived to disk, read by a store that did no writing.
 *
 * The process that wrote a record is the last one that should be asked what it
 * wrote: what matters is whether a later reader finds one account or two.
 */
async function storedTurns(
  workspacePath: string,
  directory: string,
  jobId: string,
): Promise<{ status: string }[]> {
  const metrics = await new TurnMetricStore(workspacePath, directory).list()
  return metrics
    .filter((metric) => metric.jobId === jobId)
    .map((metric) => ({ status: metric.status }))
}

/**
 * The one thing both answers have to agree about.
 *
 * Not "the turn completed" and not "Stop won" — either is a legitimate outcome
 * of this race. What may not happen is the two describing the same turn
 * differently, or either of them describing it differently from the record.
 */
function assertOneAccount(params: {
  readonly stopSaidCancelled: boolean
  readonly replySaidCancelled: boolean
  readonly stored: { status: string }[]
}): void {
  const describe = JSON.stringify(params)
  assert.equal(
    params.stopSaidCancelled,
    params.replySaidCancelled,
    `Stop and the turn gave different accounts of one turn: ${describe}`,
  )
  assert.equal(params.stored.length, 1, `not exactly one terminal row: ${describe}`)
  assert.equal(
    params.stored[0]?.status,
    params.replySaidCancelled ? 'cancelled' : 'completed',
    `the reported outcome is not the one that was stored: ${describe}`,
  )
}

test('a Workflow Architect turn cancelled as it stores its outcome gives one account', async () => {
  const model = await startModelServer(WORKFLOW_MODEL_CONTENT)
  const lane = prepareLane('workflow-terminal-', model.url)
  writeWorkflowArchitectConfig(lane.repoRoot)

  const hub = new AgentTextStreamHub()
  const registry = new CreateJobRegistry({ workspacePath: lane.workspacePath })
  const gate = new Gate()
  const store = new InstrumentedWorkflowTurnStore(lane.workspacePath)
  store.beforeTerminalWrite = (attempt) =>
    attempt === 1 ? gate.holdOnce() : undefined

  const route = await startRouteServer(({ req, res, url }) =>
    handleWorkflowRoutes({
      req,
      res,
      url,
      options: {
        repoRootPath: lane.repoRoot,
        workflowsRegistryPath: path.join(lane.repoRoot, 'workflows', 'registry.yaml'),
        createJobRegistry: registry,
        workflowArchitectTurnStore: store,
        agentTextStreamHub: hub,
        isAbortLike,
      },
    }),
  )

  const jobId = crypto.randomUUID()
  try {
    const turn = postTurn(`${route.url}/create/turn`, {
      jobId,
      history: [{ role: 'user', text: 'Build me a review workflow.' }],
      currentDraft: null,
    })

    await withDeadline(gate.reached, 'the turn never reached its terminal write')
    // The right moment, established rather than assumed: the turn produced an
    // answer and is about to record it as completed. Cancelling anywhere else
    // would prove something other than this race.
    assert.equal(
      store.firstTerminalMetric?.status,
      'completed',
      JSON.stringify(store.firstTerminalMetric),
    )
    const stop = registry.cancelAndWait(jobId)
    gate.release()

    const reply = await withDeadline(turn, 'the turn never answered')
    assert.equal(reply.status, 200, `unexpected status ${reply.status}`)
    const replyPayload = (await reply.json()) as { cancelled?: boolean; message?: string }
    const stopPayload = await withDeadline(
      stop,
      'the cancellation acknowledgement never settled',
    )

    assertOneAccount({
      stopSaidCancelled: stopPayload.cancelled,
      replySaidCancelled: replyPayload.cancelled === true,
      stored: await storedTurns(lane.workspacePath, WORKFLOW_TELEMETRY, jobId),
    })
    // The completion that won is the real one, not an empty envelope.
    assert.equal(replyPayload.message, WORKFLOW_REPLY_MESSAGE, JSON.stringify(replyPayload))
    assert.deepEqual(model.failures(), [])
  } finally {
    gate.release()
    registry.close()
    await route.close()
    await model.close()
    lane.restoreEnvironment()
    fs.rmSync(lane.directory, { recursive: true, force: true })
  }
})

test('an Agent Architect turn cancelled as it stores its outcome gives one account', async () => {
  const model = await startModelServer(CONVERSATION_REPLY_MESSAGE)
  const lane = prepareLane('architect-terminal-', model.url)
  writeResourceArchitectConfig(lane.repoRoot)

  const hub = new AgentTextStreamHub()
  const registry = new CreateJobRegistry({ workspacePath: lane.workspacePath })
  const gate = new Gate()
  const store = new HeldResourceTurnStore(lane.workspacePath, gate)

  const route = await startRouteServer(({ req, res, url }) =>
    handleResourceArchitectRoutes({
      req,
      res,
      url,
      options: {
        repoRootPath: lane.repoRoot,
        createJobRegistry: registry,
        resourceArchitectStore: store,
        // This existing completion-claim contract exercises single-pass mode.
        reviewEnabled: false,
        agentTextStreamHub: hub,
        isAbortLike,
      },
    }),
  )

  const jobId = crypto.randomUUID()
  try {
    const turn = postTurn(`${route.url}/create/resource-architect/turn`, {
      jobId,
      operation: 'conversation',
      history: [{ role: 'user', text: 'Design me a reviewer.' }],
      currentPlan: null,
    })

    await withDeadline(gate.reached, 'the turn never reached its terminal write')
    assert.equal(store.heldMetric?.status, 'completed', JSON.stringify(store.heldMetric))
    const stop = registry.cancelAndWait(jobId)
    gate.release()

    const reply = await withDeadline(turn, 'the turn never answered')
    assert.equal(reply.status, 200, `unexpected status ${reply.status}`)
    const replyPayload = (await reply.json()) as { cancelled?: boolean; message?: string }
    const stopPayload = await withDeadline(
      stop,
      'the cancellation acknowledgement never settled',
    )

    assertOneAccount({
      stopSaidCancelled: stopPayload.cancelled,
      replySaidCancelled: replyPayload.cancelled === true,
      stored: await storedTurns(lane.workspacePath, RESOURCE_TELEMETRY, jobId),
    })
    assert.equal(
      replyPayload.message,
      CONVERSATION_REPLY_MESSAGE,
      JSON.stringify(replyPayload),
    )
    assert.deepEqual(model.failures(), [])
  } finally {
    gate.release()
    registry.close()
    await route.close()
    await model.close()
    lane.restoreEnvironment()
    fs.rmSync(lane.directory, { recursive: true, force: true })
  }
})

/**
 * The other order, and the exception it protects.
 *
 * Here the cancellation is recorded *before* the turn asks to settle, so it
 * wins the job. A proposal already written to disk is still reported as
 * completed, because the person has to be able to see the card that authorises
 * building it — so Stop and the reply deliberately differ, and this is the one
 * place they may. Pinned so a compare-and-set cannot close it by accident: a
 * turn that retro-claimed here would tell someone their cancelled turn
 * finished.
 */
test('a stored proposal survives a cancellation recorded before the turn settles', async () => {
  const model = await startModelServer(PROPOSAL_MODEL_CONTENT)
  const lane = prepareLane('architect-proposal-', model.url)
  writeResourceArchitectConfig(lane.repoRoot)

  const hub = new AgentTextStreamHub()
  const registry = new CreateJobRegistry({ workspacePath: lane.workspacePath })
  const gate = new Gate()
  const store = new HeldPlanSaveStore(lane.workspacePath, gate)

  const route = await startRouteServer(({ req, res, url }) =>
    handleResourceArchitectRoutes({
      req,
      res,
      url,
      options: {
        repoRootPath: lane.repoRoot,
        createJobRegistry: registry,
        resourceArchitectStore: store,
        reviewEnabled: false,
        agentTextStreamHub: hub,
        isAbortLike,
      },
    }),
  )

  const jobId = crypto.randomUUID()
  try {
    const turn = postTurn(`${route.url}/create/resource-architect/turn`, {
      jobId,
      operation: 'proposal',
      history: [{ role: 'user', text: 'I need a contract reviewer.' }],
      currentPlan: null,
    })

    await withDeadline(gate.reached, 'the turn never reached its plan write')
    const stop = registry.cancelAndWait(jobId)
    gate.release()

    const reply = await withDeadline(turn, 'the turn never answered')
    assert.equal(reply.status, 200, `unexpected status ${reply.status}`)
    const replyPayload = (await reply.json()) as {
      cancelled?: boolean
      message?: string
      outcome?: { id?: string; kind?: string }
    }
    const stopPayload = await withDeadline(
      stop,
      'the cancellation acknowledgement never settled',
    )

    assert.equal(replyPayload.cancelled, undefined, JSON.stringify(replyPayload))
    assert.equal(replyPayload.message, PROPOSAL_REPLY_MESSAGE, JSON.stringify(replyPayload))
    assert.equal(replyPayload.outcome?.kind, 'standalone_agents')
    assert.deepEqual(
      await storedTurns(lane.workspacePath, RESOURCE_TELEMETRY, jobId),
      [{ status: 'completed' }],
    )
    // The cancellation was recorded first and still is what Stop reports. The
    // proposal is the exception to the reply, not to the job's outcome.
    assert.equal(stopPayload.cancelled, true, JSON.stringify(stopPayload))
    const planId = replyPayload.outcome?.id
    assert.ok(planId, 'the proposal carried no plan id')
    const reread = await new ResourceArchitectStore(lane.workspacePath).getPlan(planId)
    assert.ok(reread, 'the plan the reply authorises is not on disk')
    assert.deepEqual(model.failures(), [])
  } finally {
    gate.release()
    registry.close()
    await route.close()
    await model.close()
    lane.restoreEnvironment()
    fs.rmSync(lane.directory, { recursive: true, force: true })
  }
})


/**
 * A claim is a reservation, not a success.
 *
 * The turn asks to settle as completed and the filesystem refuses the write.
 * Nothing was stored, so nothing may be reported as stored: the claim goes
 * back, the cancellation that arrived while it was held applies after all, and
 * the turn ends as the cancellation it really was. Without that hand-back the
 * job would still read as completing, the record would say `failed`, and Stop
 * would answer cancelled for a turn that reported an error.
 *
 * The obstruction is lifted before the record the catch has to write, not
 * before the one that had to fail — a turn whose cancellation could not be
 * recorded either would be testing two failures at once.
 */
test('a Workflow Architect turn whose terminal write is refused reports the cancellation', async () => {
  const model = await startModelServer(WORKFLOW_MODEL_CONTENT)
  const lane = prepareLane('workflow-refused-', model.url)
  writeWorkflowArchitectConfig(lane.repoRoot)

  const hub = new AgentTextStreamHub()
  const registry = new CreateJobRegistry({ workspacePath: lane.workspacePath })
  const gate = new Gate()
  const store = new InstrumentedWorkflowTurnStore(lane.workspacePath)
  let clearObstruction: (() => void) | undefined
  store.beforeTerminalWrite = async (attempt) => {
    if (attempt === 1) {
      await gate.holdOnce()
      return
    }
    clearObstruction?.()
  }

  const route = await startRouteServer(({ req, res, url }) =>
    handleWorkflowRoutes({
      req,
      res,
      url,
      options: {
        repoRootPath: lane.repoRoot,
        workflowsRegistryPath: path.join(lane.repoRoot, 'workflows', 'registry.yaml'),
        createJobRegistry: registry,
        workflowArchitectTurnStore: store,
        agentTextStreamHub: hub,
        isAbortLike,
      },
    }),
  )

  const jobId = crypto.randomUUID()
  try {
    const turn = postTurn(`${route.url}/create/turn`, {
      jobId,
      history: [{ role: 'user', text: 'Build me a review workflow.' }],
      currentDraft: null,
    })

    await withDeadline(gate.reached, 'the turn never reached its terminal write')
    assert.equal(
      store.firstTerminalMetric?.status,
      'completed',
      JSON.stringify(store.firstTerminalMetric),
    )
    clearObstruction = obstructTurnsFile(lane.workspacePath, WORKFLOW_TELEMETRY)
    const stop = registry.cancelAndWait(jobId)
    gate.release()

    const reply = await withDeadline(turn, 'the turn never answered')
    assert.equal(reply.status, 200, `unexpected status ${reply.status}`)
    const replyPayload = (await reply.json()) as { cancelled?: boolean }
    const stopPayload = await withDeadline(
      stop,
      'the cancellation acknowledgement never settled',
    )

    assertOneAccount({
      stopSaidCancelled: stopPayload.cancelled,
      replySaidCancelled: replyPayload.cancelled === true,
      stored: await storedTurns(lane.workspacePath, WORKFLOW_TELEMETRY, jobId),
    })
    // Named rather than left to the agreement check: no completion reached the
    // disk, so neither answer may claim one.
    assert.equal(stopPayload.cancelled, true, JSON.stringify(stopPayload))
    assert.deepEqual(model.failures(), [])
  } finally {
    gate.release()
    clearObstruction?.()
    registry.close()
    await route.close()
    await model.close()
    lane.restoreEnvironment()
    fs.rmSync(lane.directory, { recursive: true, force: true })
  }
})
