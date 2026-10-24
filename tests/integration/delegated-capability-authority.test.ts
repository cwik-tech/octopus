import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { MCP_RUNTIME_CONTRACT_VERSION } from '../../contracts/mcp.js'
import {
  RUNTIME_PROCESS_IDENTITY_ENV,
  RUNTIME_TASK_ID_ENV,
} from '../../contracts/runtime-capability-authority.js'
import { deriveRuntimeAssignmentCredential } from '../../core/runtime-assignment-credential.js'
import { runTeam } from '../../domains/agent-execution/agent-runner.js'
import {
  GENERATE_WORD_TOOL_CONTRACT_VERSION,
  GENERATE_WORD_TOOL_URL_ENV,
} from '../../domains/word-generation/generate-word-types.js'
import {
  buildSessionRunAssignmentLocation,
  writeRunAssignmentLocator,
  type SessionRunAssignmentLocation,
} from '../../domains/run/run-location.js'
import { buildChildAssignmentLocation } from '../../domains/runtime/runtime-paths.js'
import { prepareDelegatedRuntimeAssignmentAuthority } from '../../domains/run/runtime-assignment-authority.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { PROCESS_IDENTITY_ARGUMENT } from '../../domains/sessions/task-process-supervisor.js'
import { parseTeamRegistry } from '../../parsers/team-registry.js'
import {
  GenerateWordCapabilityDispatchGateway,
} from '../../services/generate-word-capability-adapter.js'
import { CapabilityDispatchRuntime } from '../../services/capability-dispatch-runtime.js'
import { GenerateWordToolService } from '../../services/generate-word-tool-service.js'
import { RuntimeCapabilityAuthorityResolver } from '../../services/runtime-capability-authority.js'
import { handleGenerateWordToolRoute } from '../../server/routes/generate-word-tool.js'
import { runWorkflow } from '../../workflows/runner.js'

test('a delegated child assignment can use its parent task authority at the real HTTP dispatch boundary', async () => {
  const root = await fsp.realpath(
    await fsp.mkdtemp(path.join(os.tmpdir(), 'delegated-capability-authority-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const teamPath = path.join(root, 'teams', 'writer')
  const fakePiPath = await createFakePi(root)
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({
    title: 'Delegated capability authority',
  })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'delegated-authority-workflow',
    brief: 'Delegate one child capability call.',
  })
  assert.ok(task?.assignmentId)
  const parentAssignment = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: session.id,
    runId: task.runId,
    assignmentId: task.assignmentId,
  })
  assert.ok(parentAssignment)

  const processIdentity = 'delegated-authority-process'
  const taskProcess = await startTaskProcess(processIdentity)
  assert.ok(taskProcess.pid)
  const running = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'running',
      processIdentity,
      executionAttemptId: processIdentity,
      ownerInstanceId: sessionStore.getInstanceId(),
      pid: taskProcess.pid,
    },
  )
  assert.equal(running?.updated, true)
  await waitForProcessIdentityProbe(sessionStore, running.task)

  await fsp.mkdir(path.join(repoRootPath, 'agents', 'documenter'), {
    recursive: true,
  })
  await fsp.writeFile(
    path.join(repoRootPath, 'agents', 'documenter', 'documenter.md'),
    '---\nname: documenter\ntools: generate_word\n---\n\n# Documenter\n',
    'utf8',
  )
  await fsp.mkdir(teamPath, { recursive: true })

  const authority = new RuntimeCapabilityAuthorityResolver({
    workspacePath,
    sessionStore,
  })
  const dispatchRuntime = new CapabilityDispatchRuntime({
    workspacePath,
    runtimeAuthority: authority,
    leaseResolver: async () => null,
  })
  const gateway = new GenerateWordCapabilityDispatchGateway({
    dispatcher: dispatchRuntime.dispatcher,
    service: new GenerateWordToolService({ workspacePath, repoRootPath }),
  })
  const server = await startServer((req, res) =>
    handleGenerateWordToolRoute({ req, res, invoker: gateway, authority }),
  )

  const environmentNames = [
    'PATH',
    'TEAM_RUNTIME_PI_CLI_PATH',
    RUNTIME_TASK_ID_ENV,
    RUNTIME_PROCESS_IDENTITY_ENV,
    GENERATE_WORD_TOOL_URL_ENV,
    'TEAM_RUNTIME_EXECUTION_ATTEMPT_ID',
    'TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH',
  ] as const
  const originalEnvironment = new Map(
    environmentNames.map((name) => [name, process.env[name]]),
  )
  process.env.PATH = `${fakePiPath}${path.delimiter}${process.env.PATH ?? ''}`
  delete process.env.TEAM_RUNTIME_PI_CLI_PATH
  process.env[RUNTIME_TASK_ID_ENV] = task.id
  process.env[RUNTIME_PROCESS_IDENTITY_ENV] = processIdentity
  process.env[GENERATE_WORD_TOOL_URL_ENV] = server.url
  process.env.TEAM_RUNTIME_EXECUTION_ATTEMPT_ID = processIdentity
  process.env.TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH = path.join(
    root,
    'private-launch-gate',
  )

  try {
    const result = await runTeam({
      teamPath,
      workspacePath,
      brief: 'List the available Word profiles.',
      outputArtifact: 'delegated-authority-result.json',
      spawnDepth: 0,
      parentAssignmentLocation: parentAssignment,
    })
    const observed: unknown = JSON.parse(result.text)

    assert.ok(isDelegatedRouteObservation(observed))
    assert.notEqual(observed.assignmentId, task.assignmentId)
    assert.notEqual(observed.processIdentity, processIdentity)
    assert.equal(observed.executionAttemptIdPresent, false)
    assert.equal(observed.launchGatePathPresent, false)
    assert.equal(observed.status, 200)
    assert.ok(isSuccessfulProfileResponse(observed.response))
    assert.equal(
      observed.response.version,
      GENERATE_WORD_TOOL_CONTRACT_VERSION,
    )
  } finally {
    for (const name of environmentNames) {
      const original = originalEnvironment.get(name)
      if (original === undefined) delete process.env[name]
      else process.env[name] = original
    }
    await server.close()
    await dispatchRuntime.close()
    await stopTaskProcess(taskProcess)
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('a workflow agent child receives assignment-scoped authority without root launch secrets', async () => {
  const root = await fsp.realpath(
    await fsp.mkdtemp(path.join(os.tmpdir(), 'workflow-child-authority-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({
    title: 'Workflow child capability authority',
  })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'workflow-child-authority',
    brief: 'Run one workflow agent child.',
  })
  assert.ok(task?.assignmentId)
  const parentAssignment = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: session.id,
    runId: task.runId,
    assignmentId: task.assignmentId,
  })
  assert.ok(parentAssignment)

  const processIdentity = 'workflow-child-authority-process'
  const taskProcess = await startTaskProcess(processIdentity)
  assert.ok(taskProcess.pid)
  const running = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'running',
      processIdentity,
      executionAttemptId: processIdentity,
      ownerInstanceId: sessionStore.getInstanceId(),
      pid: taskProcess.pid,
    },
  )
  assert.equal(running?.updated, true)
  await waitForProcessIdentityProbe(sessionStore, running.task)

  const templatePath = path.join(root, 'workflow.yaml')
  await fsp.writeFile(templatePath, `
workflow:
  id: workflow-child-authority
  steps:
    - id: draft
      type: agent
      team: writing-team
      agent: writer
      stage_type: chain
      input_artifact: incoming-brief.md
      result_artifact: draft.md
  output:
    from_step: draft
    artifact: draft.md
  on_blocked: stop
  on_failed: stop
`, 'utf8')
  const teamRegistryResult = parseTeamRegistry(
    path.join(process.cwd(), 'teams.yaml'),
  )
  assert.deepEqual(teamRegistryResult.errors, [])

  const environmentNames = [
    RUNTIME_TASK_ID_ENV,
    RUNTIME_PROCESS_IDENTITY_ENV,
    'TEAM_RUNTIME_EXECUTION_ATTEMPT_ID',
    'TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH',
  ] as const
  const originalEnvironment = new Map(
    environmentNames.map((name) => [name, process.env[name]]),
  )
  process.env[RUNTIME_TASK_ID_ENV] = task.id
  process.env[RUNTIME_PROCESS_IDENTITY_ENV] = processIdentity
  process.env.TEAM_RUNTIME_EXECUTION_ATTEMPT_ID = processIdentity
  process.env.TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH = path.join(
    root,
    'private-launch-gate',
  )

  const agentCalls: import('../../core/types.js').AgentRunOptions[] = []
  try {
    const result = await runWorkflow({
      workflowEntry: {
        name: 'workflow-child-authority',
        template_path: templatePath,
      },
      teamRegistry: new Map(
        teamRegistryResult.entries.map((entry) => [entry.name, entry]),
      ),
      brief: 'Draft one document.',
      workspacePath,
      spawnDepth: 0,
      rootSessionId: task.runId,
      assignmentLocation: parentAssignment,
      runAgentImpl: async (options) => {
        agentCalls.push(options)
        return {
          text: '# Draft\n\nCompleted.',
          cost: 0,
          durationMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          contextTokens: 2,
          model: options.model,
          costTracked: true,
        }
      },
    })
    assert.equal(result.status, 'completed')
    assert.equal(agentCalls.length, 1)
    const childEnvironment = agentCalls[0]?.workerEnvironment
    const assignmentId = childEnvironment?.TEAM_RUNTIME_ASSIGNMENT_ID
    const childCredential = childEnvironment?.[RUNTIME_PROCESS_IDENTITY_ENV]
    assert.ok(assignmentId)
    assert.notEqual(assignmentId, task.assignmentId)
    assert.ok(childCredential)
    assert.notEqual(childCredential, processIdentity)
    assert.equal(
      childEnvironment?.TEAM_RUNTIME_EXECUTION_ATTEMPT_ID,
      undefined,
    )
    assert.equal(
      childEnvironment?.TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH,
      undefined,
    )

    const authority = new RuntimeCapabilityAuthorityResolver({
      workspacePath,
      sessionStore,
    })
    const resolution = await authority.authorize({
      sessionId: session.id,
      runId: task.runId,
      assignmentId,
      taskId: task.id,
      processIdentity: childCredential,
    })
    assert.equal(resolution.assignmentPath, agentCalls[0]?.cwd)
  } finally {
    for (const name of environmentNames) {
      const original = originalEnvironment.get(name)
      if (original === undefined) delete process.env[name]
      else process.env[name] = original
    }
    await stopTaskProcess(taskProcess)
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('a nested delegated credential authorizes its exact descendant assignment', async (context) => {
  const fixture = await createAuthorityFixture(context, 'nested-authority')
  const child = await fixture.delegate(
    fixture.rootLocation,
    'nested-authority-child',
    fixture.rootProcessIdentity,
  )
  const grandchild = await fixture.delegate(
    child.location,
    'nested-authority-grandchild',
    child.processIdentity,
  )

  const resolution = await fixture.authority.authorize(
    fixture.claims(grandchild.location, grandchild.processIdentity),
  )

  assert.equal(resolution.assignmentPath, grandchild.location.assignmentPath)
})

test('a child credential cannot forge a descendant on a sibling lineage', async (context) => {
  const fixture = await createAuthorityFixture(context, 'sibling-authority')
  const firstChild = await fixture.delegate(
    fixture.rootLocation,
    'sibling-authority-first',
    fixture.rootProcessIdentity,
  )
  const sibling = await fixture.delegate(
    fixture.rootLocation,
    'sibling-authority-second',
    fixture.rootProcessIdentity,
  )
  const siblingDescendant = await fixture.delegate(
    sibling.location,
    'sibling-authority-descendant',
    sibling.processIdentity,
  )
  const forgedCredential = deriveRuntimeAssignmentCredential({
    parent: {
      kind: 'delegated',
      credential: firstChild.processIdentity,
      assignmentId: firstChild.location.assignmentId,
    },
    assignmentId: siblingDescendant.location.assignmentId,
  })

  await assert.rejects(
    fixture.authority.authorize(
      fixture.claims(siblingDescendant.location, forgedCredential),
    ),
    isUnauthorizedAuthorityError,
  )
})

test('a tampered delegated credential is rejected', async (context) => {
  const fixture = await createAuthorityFixture(context, 'tamper-authority')
  const child = await fixture.delegate(
    fixture.rootLocation,
    'tamper-authority-child',
    fixture.rootProcessIdentity,
  )
  const finalCharacter = child.processIdentity.at(-1)
  assert.ok(finalCharacter)
  const tamperedCredential =
    `${child.processIdentity.slice(0, -1)}${finalCharacter === 'A' ? 'B' : 'A'}`

  await assert.rejects(
    fixture.authority.authorize(
      fixture.claims(child.location, tamperedCredential),
    ),
    isUnauthorizedAuthorityError,
  )
})

test('a task retry revokes an old child credential and accepts a newly minted one', async (context) => {
  const fixture = await createAuthorityFixture(context, 'retry-authority')
  const child = await fixture.delegate(
    fixture.rootLocation,
    'retry-authority-child',
    fixture.rootProcessIdentity,
  )
  const replacementIdentity = 'retry-authority-process-replacement'
  const replacementProcess = await startTaskProcess(replacementIdentity)
  context.after(() => stopTaskProcess(replacementProcess))
  assert.ok(replacementProcess.pid)
  const retried = await fixture.sessionStore.compareAndSetTaskRecord(
    fixture.task.sessionId,
    fixture.task.id,
    ['running'],
    {
      processIdentity: replacementIdentity,
      executionAttemptId: replacementIdentity,
      ownerInstanceId: fixture.sessionStore.getInstanceId(),
      pid: replacementProcess.pid,
    },
  )
  assert.equal(retried?.updated, true)
  await waitForProcessIdentityProbe(fixture.sessionStore, retried.task)

  await assert.rejects(
    fixture.authority.authorize(
      fixture.claims(child.location, child.processIdentity),
    ),
    isUnauthorizedAuthorityError,
  )

  const replacement = await fixture.delegate(
    fixture.rootLocation,
    child.location.assignmentId,
    replacementIdentity,
  )
  const resolution = await fixture.authority.authorize(
    fixture.claims(replacement.location, replacement.processIdentity),
  )
  assert.equal(resolution.assignmentPath, child.location.assignmentPath)
})

interface DelegatedAuthorityFixture {
  readonly workspacePath: string
  readonly sessionStore: FileSystemSessionStore
  readonly task: NonNullable<
    Awaited<ReturnType<FileSystemSessionStore['getTaskRecord']>>
  >
  readonly rootLocation: SessionRunAssignmentLocation
  readonly rootProcessIdentity: string
  readonly authority: RuntimeCapabilityAuthorityResolver
  claims(
    location: SessionRunAssignmentLocation,
    processIdentity: string,
  ): {
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId: string
    readonly taskId: string
    readonly processIdentity: string
  }
  delegate(
    parent: SessionRunAssignmentLocation,
    assignmentId: string,
    parentProcessIdentity: string,
  ): Promise<{
    readonly location: SessionRunAssignmentLocation
    readonly processIdentity: string
  }>
}

async function createAuthorityFixture(
  context: test.TestContext,
  prefix: string,
): Promise<DelegatedAuthorityFixture> {
  const root = await fsp.realpath(
    await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-`)),
  )
  context.after(() => fsp.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: prefix })
  const createdTask = await sessionStore.createTaskRecord(session.id, {
    workflowId: `${prefix}-workflow`,
    brief: 'Exercise delegated assignment authority.',
  })
  assert.ok(createdTask?.assignmentId)
  const rootLocation = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: session.id,
    runId: createdTask.runId,
    assignmentId: createdTask.assignmentId,
  })
  assert.ok(rootLocation)
  const rootProcessIdentity = `${prefix}-process`
  const taskProcess = await startTaskProcess(rootProcessIdentity)
  context.after(() => stopTaskProcess(taskProcess))
  assert.ok(taskProcess.pid)
  const running = await sessionStore.compareAndSetTaskRecord(
    session.id,
    createdTask.id,
    ['queued'],
    {
      status: 'running',
      processIdentity: rootProcessIdentity,
      executionAttemptId: rootProcessIdentity,
      ownerInstanceId: sessionStore.getInstanceId(),
      pid: taskProcess.pid,
    },
  )
  assert.equal(running?.updated, true)
  await waitForProcessIdentityProbe(sessionStore, running.task)
  const task = running.task
  const authority = new RuntimeCapabilityAuthorityResolver({
    workspacePath,
    sessionStore,
  })

  return {
    workspacePath,
    sessionStore,
    task,
    rootLocation,
    rootProcessIdentity,
    authority,
    claims: (location, processIdentity) => ({
      sessionId: location.sessionId,
      runId: location.runId,
      assignmentId: location.assignmentId,
      taskId: task.id,
      processIdentity,
    }),
    delegate: async (parent, assignmentId, parentProcessIdentity) => {
      const location = buildChildAssignmentLocation(
        workspacePath,
        parent,
        assignmentId,
      )
      assert.ok(location)
      await fsp.mkdir(location.assignmentPath, { recursive: true })
      await writeRunAssignmentLocator(workspacePath, location)
      const delegated = await prepareDelegatedRuntimeAssignmentAuthority({
        workspacePath,
        parentLocation: parent,
        childLocation: location,
        environment: {
          [RUNTIME_TASK_ID_ENV]: task.id,
          [RUNTIME_PROCESS_IDENTITY_ENV]: parentProcessIdentity,
        },
      })
      assert.ok(delegated)
      return { location, processIdentity: delegated.processIdentity }
    },
  }
}

function isUnauthorizedAuthorityError(error: unknown): boolean {
  return error instanceof Error &&
    'code' in error &&
    error.code === 'unauthorized'
}

interface DelegatedRouteObservation {
  readonly assignmentId: string
  readonly executionAttemptIdPresent: boolean
  readonly launchGatePathPresent: boolean
  readonly processIdentity: string
  readonly status: number
  readonly response: unknown
}

function isDelegatedRouteObservation(
  value: unknown,
): value is DelegatedRouteObservation {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'assignmentId' in value &&
    typeof value.assignmentId === 'string' &&
    'executionAttemptIdPresent' in value &&
    typeof value.executionAttemptIdPresent === 'boolean' &&
    'launchGatePathPresent' in value &&
    typeof value.launchGatePathPresent === 'boolean' &&
    'processIdentity' in value &&
    typeof value.processIdentity === 'string' &&
    'status' in value &&
    typeof value.status === 'number' &&
    'response' in value
}

function isSuccessfulProfileResponse(value: unknown): value is {
  readonly version: number
  readonly output: {
    readonly ok: true
    readonly action: 'list_profiles'
    readonly profiles: readonly unknown[]
  }
} {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('version' in value) ||
    typeof value.version !== 'number' ||
    !('output' in value)
  ) {
    return false
  }
  const output = value.output
  return output !== null &&
    typeof output === 'object' &&
    !Array.isArray(output) &&
    'ok' in output &&
    output.ok === true &&
    'action' in output &&
    output.action === 'list_profiles' &&
    'profiles' in output &&
    Array.isArray(output.profiles)
}

async function createFakePi(root: string): Promise<string> {
  const directory = path.join(root, 'fake-pi')
  const scriptPath = path.join(directory, 'pi')
  await fsp.mkdir(directory, { recursive: true })
  await fsp.writeFile(
    scriptPath,
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const assignmentId = process.env.TEAM_RUNTIME_ASSIGNMENT_ID
const outputPath = path.join(
  process.cwd(),
  process.env.TEAM_OUTPUT_ARTIFACT || 'delegated-authority-result.json',
)
const request = {
  version: ${GENERATE_WORD_TOOL_CONTRACT_VERSION},
  context: {
    contractVersion: ${MCP_RUNTIME_CONTRACT_VERSION},
    requestId: 'delegated-authority-request',
    leaseId: 'generate-word-' + assignmentId,
    sessionId: process.env.TEAM_RUNTIME_SESSION_ID,
    runId: process.env.TEAM_RUNTIME_RUN_ID,
    assignmentId,
    taskId: process.env.TEAM_RUNTIME_TASK_ID,
    processIdentity: process.env.TEAM_RUNTIME_PROCESS_IDENTITY,
    agentPath: 'agents/documenter',
  },
  toolCallId: 'delegated-authority-call',
  input: { action: 'list_profiles' },
}

fetch(process.env.${GENERATE_WORD_TOOL_URL_ENV}, {
  method: 'POST',
  headers: {
    'connection': 'close',
    'content-type': 'application/json',
  },
  body: JSON.stringify(request),
}).then(async (response) => {
  const body = await response.json()
  fs.writeFileSync(outputPath, JSON.stringify({
    assignmentId,
    executionAttemptIdPresent: Object.hasOwn(
      process.env,
      'TEAM_RUNTIME_EXECUTION_ATTEMPT_ID',
    ),
    launchGatePathPresent: Object.hasOwn(
      process.env,
      'TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH',
    ),
    processIdentity: process.env.TEAM_RUNTIME_PROCESS_IDENTITY,
    status: response.status,
    response: body,
  }))
}).catch((error) => {
  fs.writeFileSync(outputPath, JSON.stringify({
    assignmentId,
    executionAttemptIdPresent: Object.hasOwn(
      process.env,
      'TEAM_RUNTIME_EXECUTION_ATTEMPT_ID',
    ),
    launchGatePathPresent: Object.hasOwn(
      process.env,
      'TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH',
    ),
    processIdentity: process.env.TEAM_RUNTIME_PROCESS_IDENTITY,
    status: 0,
    response: { error: String(error) },
  }))
  process.exitCode = 1
})
`,
    { encoding: 'utf8', mode: 0o755 },
  )
  return directory
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
