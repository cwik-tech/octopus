import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { MCP_RUNTIME_CONTRACT_VERSION } from '../../contracts/mcp.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { PROCESS_IDENTITY_ARGUMENT } from '../../domains/sessions/task-process-supervisor.js'
import {
  GenerateWordCapabilityDispatchGateway,
  type GenerateWordCapabilityDispatchInvoker,
  type GenerateWordCapabilityService,
} from '../../services/generate-word-capability-adapter.js'
import { CapabilityDispatchRuntime } from '../../services/capability-dispatch-runtime.js'
import { GenerateWordToolService } from '../../services/generate-word-tool-service.js'
import type {
  RuntimeCapabilityAuthorityClaims,
  RuntimeCapabilityAuthorityResolution,
} from '../../contracts/runtime-capability-authority.js'
import {
  RuntimeCapabilityAuthorityError,
  RuntimeCapabilityAuthorityResolver,
} from '../../services/runtime-capability-authority.js'
import { handleGenerateWordToolRoute } from '../../server/routes/generate-word-tool.js'
import { GENERATE_WORD_TOOL_CONTRACT_VERSION } from '../../domains/word-generation/generate-word-types.js'

test('a synthetic lease without runtime task authority is rejected before execution', async (context) => {
  const fixture = await createFixture(context)

  const response = await fixture.post({
    ...fixture.validContext,
    taskId: undefined,
    processIdentity: undefined,
  })

  assert.equal(response.status, 400)
  assert.equal(fixture.executionCalls(), 0)
})

test('a stale process identity is rejected before execution', async (context) => {
  const fixture = await createFixture(context)

  const response = await fixture.post({
    ...fixture.validContext,
    processIdentity: 'stale-process-identity',
  })

  assert.equal(response.status, 403)
  assert.equal(fixture.executionCalls(), 0)
})

test('a task authority claim for the wrong run is rejected before execution', async (context) => {
  const fixture = await createFixture(context)

  const response = await fixture.post({
    ...fixture.validContext,
    runId: 'wrong-run',
  })

  assert.equal(response.status, 403)
  assert.equal(fixture.executionCalls(), 0)
})

test('an inactive task is rejected before execution', async (context) => {
  const fixture = await createFixture(context, { active: false })

  const response = await fixture.post(fixture.validContext)

  assert.equal(response.status, 409)
  assert.equal(fixture.executionCalls(), 0)
})

test('a task owned by another runtime instance is rejected before execution', async (context) => {
  const fixture = await createFixture(context, { owner: 'other' })

  const response = await fixture.post(fixture.validContext)

  assert.equal(response.status, 403)
  assert.equal(fixture.executionCalls(), 0)
})

test('a dead task process is rejected before execution', async (context) => {
  const fixture = await createFixture(context, { processState: 'dead' })

  const response = await fixture.post(fixture.validContext)

  assert.equal(response.status, 403)
  assert.equal(fixture.executionCalls(), 0)
})

test('a task process without the persisted identity marker is rejected before execution', async (context) => {
  const fixture = await createFixture(context, {
    commandIdentity: 'different-process-authority-fixture',
  })

  const response = await fixture.post(fixture.validContext)

  assert.equal(response.status, 403)
  assert.equal(fixture.executionCalls(), 0)
})

test('matching active runtime authority permits exactly one execution', async (context) => {
  const fixture = await createFixture(context)

  const response = await fixture.post(fixture.validContext)

  assert.equal(response.status, 200)
  assert.equal(fixture.executionCalls(), 1)
})

test('HTTP preauthorization is reused once by dispatch while live execution checks stay fresh', async (context) => {
  const fixture = await createFixture(context, { throughDispatch: true })

  const response = await fixture.post(fixture.validContext)

  assert.equal(response.status, 200)
  assert.equal(fixture.executionCalls(), 1)
  assert.equal(
    fixture.authorityTaskReads(),
    4,
    'route admission plus three live execution/settlement rechecks should read task state',
  )
})

test('HTTP preauthorization evidence is bound to one exact initial authority check', async (context) => {
  const fixture = await createFixture(context)
  const evidence = await fixture.issueAuthorityEvidence()

  const resolution = await fixture.consumeAuthorityEvidence(evidence)

  assert.equal(resolution.taskId, fixture.validContext.taskId)
  await assert.rejects(
    fixture.consumeAuthorityEvidence(evidence),
    (error) => error instanceof RuntimeCapabilityAuthorityError &&
      error.code === 'unauthorized',
  )

  const mismatchedEvidence = await fixture.issueAuthorityEvidence()
  await assert.rejects(
    fixture.consumeAuthorityEvidence(mismatchedEvidence, { runId: 'wrong-run' }),
    (error) => error instanceof RuntimeCapabilityAuthorityError &&
      error.code === 'unauthorized',
  )
})

interface AuthorityFixture {
  readonly validContext: Record<string, unknown>
  readonly executionCalls: () => number
  readonly authorityTaskReads: () => number
  issueAuthorityEvidence(): Promise<RuntimeCapabilityAuthorityResolution>
  consumeAuthorityEvidence(
    evidence: unknown,
    overrides?: Partial<RuntimeCapabilityAuthorityClaims>,
  ): Promise<RuntimeCapabilityAuthorityResolution>
  post(context: Record<string, unknown>): Promise<Response>
}

async function createFixture(
  testContext: test.TestContext,
  options: {
    readonly active?: boolean
    readonly commandIdentity?: string
    readonly owner?: 'current' | 'other'
    readonly processState?: 'live' | 'dead'
    readonly throughDispatch?: boolean
  } = {},
): Promise<AuthorityFixture> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-capability-authority-')),
  )
  testContext.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Authority fixture' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'authority-workflow',
    brief: 'Exercise one parent capability.',
  })
  assert.ok(task?.assignmentId)
  const processIdentity = 'process-authority-fixture'
  const child = await startTaskProcess(
    options.commandIdentity ?? processIdentity,
  )
  testContext.after(() => stopTaskProcess(child))
  assert.ok(child.pid)
  const running = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'running',
      processIdentity,
      executionAttemptId: processIdentity,
      ownerInstanceId:
        options.owner === 'other'
          ? 'different-runtime-instance'
          : sessionStore.getInstanceId(),
      pid: child.pid,
    },
  )
  assert.equal(running?.updated, true)
  if (
    options.processState !== 'dead' &&
    (options.commandIdentity === undefined ||
      options.commandIdentity === processIdentity)
  ) {
    await waitForProcessIdentityProbe(sessionStore, running.task)
  }
  if (options.active === false) {
    const terminal = await sessionStore.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['running'],
      { status: 'done' },
    )
    assert.equal(terminal?.updated, true)
  }
  if (options.processState === 'dead') {
    await stopTaskProcess(child)
  }

  let authorityTaskReads = 0
  const authority = new RuntimeCapabilityAuthorityResolver({
    workspacePath,
    sessionStore: {
      getTaskRecord: (...args) => {
        authorityTaskReads += 1
        return sessionStore.getTaskRecord(...args)
      },
      ownsTaskProcess: (record) => sessionStore.ownsTaskProcess(record),
      isTaskProcessAlive: (record) => sessionStore.isTaskProcessAlive(record),
      hasValidTaskProcessIdentity: (record) =>
        sessionStore.hasValidTaskProcessIdentity(record),
    },
  })
  let calls = 0
  const dispatchRuntime = options.throughDispatch
    ? new CapabilityDispatchRuntime({
        workspacePath,
        runtimeAuthority: authority,
        leaseResolver: async () => null,
      })
    : undefined
  if (dispatchRuntime) testContext.after(() => dispatchRuntime.close())
  const invoker: GenerateWordCapabilityDispatchInvoker = dispatchRuntime
    ? new GenerateWordCapabilityDispatchGateway({
        dispatcher: dispatchRuntime.dispatcher,
        service: await createWordService(root, workspacePath, () => {
          calls += 1
        }),
      })
    : {
        async execute() {
          calls += 1
          return {
            ok: true,
            action: 'list_profiles',
            profiles: [],
          }
        },
      }
  const server = await startServer((req, res) =>
    handleGenerateWordToolRoute({ req, res, invoker, authority }),
  )
  testContext.after(() => server.close())
  const validContext = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-authority-fixture',
    leaseId: `generate-word-${task.assignmentId}`,
    sessionId: session.id,
    runId: task.runId,
    assignmentId: task.assignmentId,
    taskId: task.id,
    processIdentity,
    agentPath: 'agents/documenter',
  }
  const authorityClaims: RuntimeCapabilityAuthorityClaims = {
    sessionId: session.id,
    runId: task.runId,
    assignmentId: task.assignmentId,
    taskId: task.id,
    processIdentity,
  }
  return {
    validContext,
    executionCalls: () => calls,
    authorityTaskReads: () => authorityTaskReads,
    issueAuthorityEvidence: () => authority.authorize(
      authorityClaims,
      { kind: 'issue-evidence' },
    ),
    consumeAuthorityEvidence: (evidence, overrides = {}) =>
      authority.authorize(
        { ...authorityClaims, ...overrides },
        { kind: 'reuse-evidence', evidence },
      ),
    post: (requestContext) => fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: GENERATE_WORD_TOOL_CONTRACT_VERSION,
        context: requestContext,
        toolCallId: 'call-authority-fixture',
        input: { action: 'list_profiles' },
      }),
    }),
  }
}

async function createWordService(
  root: string,
  workspacePath: string,
  onExecute: () => void,
): Promise<GenerateWordCapabilityService> {
  const repoRootPath = path.join(root, 'repo')
  const agentPath = path.join(repoRootPath, 'agents', 'documenter')
  await fs.mkdir(agentPath, { recursive: true })
  await fs.writeFile(
    path.join(agentPath, 'documenter.md'),
    '---\nname: documenter\ntools: generate_word\n---\n\n# Documenter\n',
    'utf8',
  )
  const service = new GenerateWordToolService({ workspacePath, repoRootPath })
  return {
    tool: service.tool,
    isEnabledForAgent: (agent) => service.isEnabledForAgent(agent),
    execute: (...args) => {
      onExecute()
      return service.execute(...args)
    },
  }
}

async function startTaskProcess(processIdentity: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'setInterval(() => undefined, 1_000)',
      '--',
      `${PROCESS_IDENTITY_ARGUMENT}${processIdentity}`,
    ],
    { stdio: 'ignore' },
  )
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  return child
}

async function stopTaskProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })
  child.kill('SIGKILL')
  await exited
}

async function waitForProcessIdentityProbe(
  sessionStore: FileSystemSessionStore,
  task: NonNullable<Awaited<ReturnType<FileSystemSessionStore['getTaskRecord']>>>,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (sessionStore.hasValidTaskProcessIdentity(task)) return
    await delay(10)
  }
  assert.fail('Task process identity did not become observable.')
}

async function startServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void>,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handler(req, res).catch((error) => {
      res.statusCode = 500
      res.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/private-tool`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}
