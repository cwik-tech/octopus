import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { setRuntimeApprovedModelChoice } from '../../domains/provider/approved-model-choice.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dispatchToAgentOrTeam, runAgent, runTeam } from '../../domains/agent-execution/agent-runner.js'
import { SubTeamFailedError } from '../../domains/agent-execution/sub-team-failure.js'
import { globalCircuitBreaker } from '../../domains/runtime/circuit-breaker.js'
import { terminateTaskProcess } from '../../domains/sessions/task-process-supervisor.js'
import type { SessionTask } from '../../contracts/sessions.js'
import type { AgentRunEvent } from '../../core/types.js'
import { initProviders } from '../../providers/index.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import {
  MCP_WORKER_TURN_CONTRACT_VERSION,
  MCP_WORKER_TURN_URL_ENV,
  MCP_WORKER_WORKFLOW_STEP_ID_ENV,
} from '../../domains/mcp/mcp-worker-turn.js'
import {
  RUNTIME_ASSIGNMENT_ID_ENV,
  RUNTIME_RUN_ID_ENV,
  RUNTIME_SESSION_ID_ENV,
} from '../../domains/runtime/runtime-paths.js'
import {
  RUNTIME_PROCESS_IDENTITY_ENV,
  RUNTIME_TASK_ID_ENV,
} from '../../contracts/runtime-capability-authority.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { writeCheckpoint } from '../../domains/runtime/checkpoint.js'
import { STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from '../../core/constants.js'
import type { LoadedAgent, RuntimeState } from '../../core/types.js'

// Register all providers before tests run
initProviders()

/**
 * Every real Pi run ends on `agent_settled`: `message_end` says what a message
 * held, `agent_settled` says Pi will not auto-retry, auto-compact and retry, or
 * run a queued follow-up. Appending it here keeps these fixtures faithful to
 * the installed protocol without every handler having to remember it.
 */
const PI_SETTLED_LINE =
  "process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')"

function withFakePi<T>(handlerSource: string, fn: (binDir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pi-bin-'))
  const scriptPath = path.join(dir, 'pi')
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node\n${handlerSource}\n${PI_SETTLED_LINE}\n`,
    { mode: 0o755 },
  )

  return fn(dir).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

async function waitForPath(candidatePath: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(candidatePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${candidatePath}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`)
}

test('runAgent parses JSON output from a Pi subprocess', async () => {
  await withFakePi(`
const payload = {
  type: 'message_end',
  message: {
    role: 'assistant',
    model: 'fake-model-v2',
    usage: {
      input: 12,
      output: 34,
      totalTokens: 46,
      cost: { total: 0.25 }
    },
    content: [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' }
    ]
  }
}
process.stdout.write(JSON.stringify(payload) + '\\n')
`, async (binDir) => {
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      const result = await runAgent({
        systemPrompt: 'test prompt',
        userMessage: 'test user message',
        model: 'fake-model',
        thinking: 'low',
        provider: 'pi',
      })

      assert.equal(result.text, 'Hello world')
      assert.equal(result.cost, 0.25)
      assert.equal(result.inputTokens, 12)
      assert.equal(result.outputTokens, 34)
      assert.equal(result.contextTokens, 46)
      assert.equal(result.model, 'fake-model-v2')
    } finally {
      process.env.PATH = originalPath
    }
  })
})

test('runAgent forwards --tools to the Pi provider when tools are allowed', async () => {
  await withFakePi(`
const idx = process.argv.indexOf('--tools')
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    model: 'fake-model-v2',
    usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
    content: [{ type: 'text', text: idx >= 0 ? process.argv[idx + 1] : 'missing' }]
  }
}) + '\\n')
`, async (binDir) => {
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      const result = await runAgent({
        systemPrompt: 'test prompt',
        userMessage: 'test user message',
        model: 'fake-model',
        thinking: 'low',
        provider: 'pi',
        tools: ['handoff', 'submit_for_review'],
      })

      assert.equal(result.text, 'handoff,submit_for_review')
    } finally {
      process.env.PATH = originalPath
    }
  })
})

test('runAgent forwards --no-tools to the Pi provider when tools are explicitly empty', async () => {
  await withFakePi(`
const hasNoTools = process.argv.includes('--no-tools')
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    model: 'fake-model-v2',
    usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
    content: [{ type: 'text', text: hasNoTools ? 'yes' : 'no' }]
  }
}) + '\\n')
`, async (binDir) => {
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      const result = await runAgent({
        systemPrompt: 'test prompt',
        userMessage: 'test user message',
        model: 'fake-model',
        thinking: 'low',
        provider: 'pi',
        tools: [],
      })

      assert.equal(result.text, 'yes')
    } finally {
      process.env.PATH = originalPath
    }
  })
})

test('runAgent fails closed before raw provider fallback when a browser worker model is unsupported', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-worker-fail-closed-'))
  const markerPath = path.join(directory, 'raw-provider-invoked')
  const executablePath = path.join(directory, 'codex')
  fs.writeFileSync(
    executablePath,
    [
      '#!/bin/sh',
      `touch ${JSON.stringify(markerPath)}`,
      'exit 9',
      '',
    ].join('\n'),
    { mode: 0o700 },
  )
  let workerResponse: Record<string, unknown> = {}
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(workerResponse))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const originalPath = process.env.PATH
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ''}`

  try {
    for (const testCase of [
      {
        response: {
          version: MCP_WORKER_TURN_CONTRACT_VERSION,
          kind: 'provider-unsupported',
          providerSupport: {
            provider: 'codex',
            state: 'unsupported',
            reasonCode: 'cli_model_unavailable',
          },
        },
        code: 'cli_model_unavailable',
        message: /Enable this agent.*Codex CLI model/i,
      },
      {
        response: {
          version: MCP_WORKER_TURN_CONTRACT_VERSION,
          kind: 'no-tools',
          providerSupport: {
            provider: 'codex',
            state: 'supported',
            mode: 'host-tool-bridge',
          },
        },
        code: 'mcp_browser_tool_unavailable',
        message: /managed Browser tool is unavailable/i,
      },
    ] as const) {
      workerResponse = testCase.response
      await assert.rejects(
        runAgent({
          systemPrompt: 'Use the managed Browser.',
          userMessage: 'Research this topic.',
          model: 'default',
          thinking: 'medium',
          provider: 'codex',
          agentName: 'web-researcher',
          tools: ['read', 'browser'],
          workerEnvironment: {
            [MCP_WORKER_TURN_URL_ENV]:
              `http://127.0.0.1:${address.port}/worker-turn`,
            [RUNTIME_SESSION_ID_ENV]: '11111111-1111-4111-8111-111111111111',
            [RUNTIME_RUN_ID_ENV]: 'run-browser-fail-closed',
            [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-browser-fail-closed',
            TEAM_RUNTIME_TASK_ID: 'task-browser-fail-closed',
            TEAM_RUNTIME_PROCESS_IDENTITY: 'process-browser-fail-closed',
            TEAM_RUNTIME_WORKFLOW_ID: 'workflow-browser-fail-closed',
            [MCP_WORKER_WORKFLOW_STEP_ID_ENV]: 'research',
          },
        }),
        (error: unknown) =>
          error instanceof ProviderError &&
          error.kind === 'configuration' &&
          error.code === testCase.code &&
          error.retryable === false &&
          testCase.message.test(error.providerMessage),
      )
    }
    assert.equal(fs.existsSync(markerPath), false)
  } finally {
    process.env.PATH = originalPath
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    )
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('runTeam writes the child brief and reads the output artifact', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const incomingPath = path.join(cwd, 'incoming-brief.md')
const outputPath = path.join(cwd, 'memo.md')
const brief = fs.existsSync(incomingPath) ? fs.readFileSync(incomingPath, 'utf8') : 'missing brief'
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(
  outputPath,
  '# Fake Team Output\\n\\n' + brief + '\\n\\nchat_mode=' + (process.env.TEAM_CHAT_MODE || '0'),
)
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: {
    usage: { cost: { total: 0.5 } }
  }
}) + '\\n')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-test-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: pipeline
      coordinator: worker
      config:
        parallel: false
        gate:
          type: artifact_exists
          strictness: hard
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: memo.md
`)

      const workerDir = path.join(teamDir, 'agents', 'worker')
      fs.mkdirSync(workerDir, { recursive: true })
      fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')

      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'This is the child brief.',
        outputArtifact: 'memo.md',
        spawnDepth: 0,
      })
      const secondResult = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'This is the second child brief.',
        outputArtifact: 'memo.md',
        executionMode: 'team-chat',
        spawnDepth: 0,
      })

      assert.equal(result.cost, 0.5)
      assert.match(result.text, /This is the child brief\./)
      assert.match(result.text, /chat_mode=0/)
      assert.match(secondResult.text, /chat_mode=1/)
      const assignmentsRoot = path.join(teamDir, 'child-workspace', 'assignments')
      const assignmentDirs = fs.readdirSync(assignmentsRoot)
      assert.equal(assignmentDirs.length, 2)
      assert.notEqual(result.childSessionId, secondResult.childSessionId)
      assert.notEqual(result.assignmentPath, secondResult.assignmentPath)
      const assignmentDir = result.assignmentPath
      const incomingContent = fs.readFileSync(path.join(assignmentDir, 'incoming-brief.md'), 'utf8')
      assert.match(incomingContent, /artifact_type: "brief"/)
      assert.match(incomingContent, /This is the child brief\./)
      assert.ok(fs.existsSync(path.join(assignmentDir, 'memo.md')))
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam accepts a completed Team chat without a deliverable artifact', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const logsPath = path.join(process.cwd(), 'logs')
fs.mkdirSync(logsPath, { recursive: true })
fs.writeFileSync(
  path.join(logsPath, 'runtime-events.jsonl'),
  JSON.stringify({ event: 'run.completed' }) + '\\n',
)
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-chat-no-artifact-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'workspace'),
        brief: 'Continue the conversation.',
        outputArtifact: 'unused-result.md',
        executionMode: 'team-chat',
        spawnDepth: 0,
      })

      assert.equal(result.status, 'completed')
      assert.equal(result.succeeded, true)
      assert.equal(result.artifactPath, '')
      assert.doesNotMatch(result.text, /expected output artifact|produce.*artifact/i)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam fallback resolves the team runtime from the repository root', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const extensionFlag = process.argv.indexOf('-e')
const extensionPath = extensionFlag >= 0 ? process.argv[extensionFlag + 1] : ''
const outputPath = path.join(process.cwd(), process.env.TEAM_OUTPUT_ARTIFACT)
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, extensionPath)
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-fallback-'))
    const originalPath = process.env.PATH
    const originalExtension = process.env.TEAM_RUNTIME_EXTENSION_ENTRY
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    delete process.env.TEAM_RUNTIME_EXTENSION_ENTRY

    try {
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'workspace'),
        brief: 'Resolve the default team runtime.',
        outputArtifact: 'runtime-entry.txt',
        spawnDepth: 0,
      })
      const compiledOrSourceRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
      )
      assert.equal(
        result.text.trim(),
        path.join(compiledOrSourceRoot, 'team-runtime', 'index.ts'),
      )
    } finally {
      process.env.PATH = originalPath
      if (originalExtension === undefined) {
        delete process.env.TEAM_RUNTIME_EXTENSION_ENTRY
      } else {
        process.env.TEAM_RUNTIME_EXTENSION_ENTRY = originalExtension
      }
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam propagates assignment-scoped task authority without root launch secrets', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const authority = {
  taskId: process.env.TEAM_RUNTIME_TASK_ID,
  processIdentity: process.env.TEAM_RUNTIME_PROCESS_IDENTITY,
  executionAttemptIdPresent: Object.hasOwn(process.env, 'TEAM_RUNTIME_EXECUTION_ATTEMPT_ID'),
  launchGatePathPresent: Object.hasOwn(process.env, 'TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH'),
}
fs.writeFileSync(path.join(process.cwd(), 'authority.json'), JSON.stringify(authority))
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-authority-'))
    const workspacePath = path.join(teamDir, 'workspace')
    const parentAssignmentLocation = buildSessionRunAssignmentLocation(workspacePath, {
      sessionId: 'product-session',
      runId: 'product-run',
      assignmentId: 'parent-assignment',
    })
    assert.ok(parentAssignmentLocation)

    const originalPath = process.env.PATH
    const originalTaskId = process.env[RUNTIME_TASK_ID_ENV]
    const originalProcessIdentity = process.env[RUNTIME_PROCESS_IDENTITY_ENV]
    const originalExecutionAttemptId =
      process.env.TEAM_RUNTIME_EXECUTION_ATTEMPT_ID
    const originalLaunchGatePath =
      process.env.TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    process.env[RUNTIME_TASK_ID_ENV] = 'product-task'
    process.env[RUNTIME_PROCESS_IDENTITY_ENV] = 'product-process'
    process.env.TEAM_RUNTIME_EXECUTION_ATTEMPT_ID = 'product-process'
    process.env.TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH = path.join(
      teamDir,
      'private-launch-gate',
    )

    try {
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath,
        brief: 'Propagate the parent capability authority.',
        outputArtifact: 'authority.json',
        spawnDepth: 0,
        parentAssignmentLocation,
      })

      const observed: unknown = JSON.parse(result.text)
      assert.ok(isDelegatedAuthorityObservation(observed))
      assert.equal(observed.taskId, 'product-task')
      assert.match(observed.processIdentity, /^d1\./u)
      assert.notEqual(observed.processIdentity, 'product-process')
      assert.equal(observed.executionAttemptIdPresent, false)
      assert.equal(observed.launchGatePathPresent, false)
    } finally {
      process.env.PATH = originalPath
      if (originalTaskId === undefined) delete process.env[RUNTIME_TASK_ID_ENV]
      else process.env[RUNTIME_TASK_ID_ENV] = originalTaskId
      if (originalProcessIdentity === undefined) {
        delete process.env[RUNTIME_PROCESS_IDENTITY_ENV]
      } else {
        process.env[RUNTIME_PROCESS_IDENTITY_ENV] = originalProcessIdentity
      }
      if (originalExecutionAttemptId === undefined) {
        delete process.env.TEAM_RUNTIME_EXECUTION_ATTEMPT_ID
      } else {
        process.env.TEAM_RUNTIME_EXECUTION_ATTEMPT_ID =
          originalExecutionAttemptId
      }
      if (originalLaunchGatePath === undefined) {
        delete process.env.TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH
      } else {
        process.env.TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH = originalLaunchGatePath
      }
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

function isDelegatedAuthorityObservation(value: unknown): value is {
  readonly taskId: string
  readonly processIdentity: string
  readonly executionAttemptIdPresent: boolean
  readonly launchGatePathPresent: boolean
} {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'taskId' in value &&
    typeof value.taskId === 'string' &&
    'processIdentity' in value &&
    typeof value.processIdentity === 'string' &&
    'executionAttemptIdPresent' in value &&
    typeof value.executionAttemptIdPresent === 'boolean' &&
    'launchGatePathPresent' in value &&
    typeof value.launchGatePathPresent === 'boolean'
}

test('runTeam resolves with a failed result when the Pi process cannot spawn', async () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-spawn-error-test-'))
  const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-pi-bin-'))
  const originalPath = process.env.PATH
  const originalBundledCli = process.env.TEAM_RUNTIME_PI_CLI_PATH
  try {
    process.env.PATH = emptyBinDir
    delete process.env.TEAM_RUNTIME_PI_CLI_PATH

    const result = await runTeam({
      teamPath: teamDir,
      workspacePath: path.join(teamDir, 'workspace'),
      brief: 'This child cannot start.',
      spawnDepth: 0,
    })

    assert.equal(result.succeeded, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.exitCode, null)
    assert.match(result.text, /Child team process could not start/)
  } finally {
    process.env.PATH = originalPath
    if (originalBundledCli === undefined) delete process.env.TEAM_RUNTIME_PI_CLI_PATH
    else process.env.TEAM_RUNTIME_PI_CLI_PATH = originalBundledCli
    fs.rmSync(teamDir, { recursive: true, force: true })
    fs.rmSync(emptyBinDir, { recursive: true, force: true })
  }
})

test('runTeam forwards TEAM_WORKSPACE_PATH so child boot can use the shared parent workspace', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const outputPath = path.join(cwd, 'memo.md')
fs.writeFileSync(outputPath, process.env.TEAM_WORKSPACE_PATH || 'missing')
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: {
    usage: { cost: { total: 0.1 } }
  }
}) + '\\n')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-workspace-override-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: pipeline
      coordinator: worker
      config:
        parallel: false
        gate:
          type: artifact_exists
          strictness: hard
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: memo.md
`)
      const workerDir = path.join(teamDir, 'agents', 'worker')
      fs.mkdirSync(workerDir, { recursive: true })
      fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')

      const sharedWorkspace = path.join(teamDir, 'shared-workspace')
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: sharedWorkspace,
        workspacePathOverride: sharedWorkspace,
        brief: 'Shared workspace test.',
        outputArtifact: 'memo.md',
        spawnDepth: 0,
      })

      assert.equal(result.text.trim(), sharedWorkspace)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam forwards TEAM_BOOT_ENTRY_JSON so delegated child host selection can use the registry host override', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const outputPath = path.join(cwd, 'memo.md')
fs.writeFileSync(outputPath, process.env.TEAM_BOOT_ENTRY_JSON || 'missing')
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: {
    usage: { cost: { total: 0.1 } }
  }
}) + '\\n')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-boot-entry-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: pipeline
      coordinator: worker
      config:
        parallel: false
        gate:
          type: artifact_exists
          strictness: hard
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: memo.md
`)
      const workerDir = path.join(teamDir, 'agents', 'worker')
      fs.mkdirSync(workerDir, { recursive: true })
      fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')

      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'Boot entry propagation test.',
        bootEntry: {
          name: 'child-team',
          type: 'team',
          team_path: teamDir,
          host_model: 'gpt-5.4-mini',
          host_provider: 'openai',
        },
        outputArtifact: 'memo.md',
        spawnDepth: 0,
      })

      const bootEntry = JSON.parse(result.text.trim())
      assert.equal(bootEntry.name, 'child-team')
      assert.equal(bootEntry.host_model, 'gpt-5.4-mini')
      assert.equal(bootEntry.host_provider, 'openai')
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam prefers the child output artifact content over subprocess chatter', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const outputPath = path.join(cwd, 'memo.md')
fs.writeFileSync(outputPath, '# Canonical Child Output\\n\\nReal artifact content')
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: {
    usage: { cost: { total: 0.25 } },
    content: [{ type: 'text', text: 'runtime chatter only' }]
  }
}) + '\\n')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-artifact-prefer-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
    produces:
      - path: memo.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: pipeline
      coordinator: worker
      config:
        parallel: false
        gate:
          type: artifact_exists
          strictness: hard
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: memo.md
`)

      const workerDir = path.join(teamDir, 'agents', 'worker')
      fs.mkdirSync(workerDir, { recursive: true })
      fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')

      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'ignored',
        outputArtifact: 'memo.md',
        requestedResultType: 'artifact:memo.md',
        spawnDepth: 0,
      })

      assert.match(result.text, /Real artifact content/)
      assert.doesNotMatch(result.text, /runtime chatter only/)
      assert.equal(result.requestedResultType, 'artifact:memo.md')
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam keeps the delegated brief out of the child kickoff prompt', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const outputPath = path.join(cwd, 'memo.md')
const kickoffPrompt = process.argv[process.argv.length - 1] || ''
fs.writeFileSync(outputPath, kickoffPrompt)
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-prompt-test-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: pipeline
      coordinator: worker
      config:
        parallel: false
        gate:
          type: artifact_exists
          strictness: hard
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: memo.md
`)

      const workerDir = path.join(teamDir, 'agents', 'worker')
      fs.mkdirSync(workerDir, { recursive: true })
      fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')

      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'Prepare a one pager on BMW.',
        outputArtifact: 'memo.md',
        spawnDepth: 0,
      })

      assert.match(result.text, /Continue the team workflow from the active level/)
      assert.match(result.text, /incoming-brief\.md/)
      assert.match(result.text, /memo\.md/)
      assert.doesNotMatch(result.text, /Prepare a one pager on BMW\./)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam retries once when a delegated child exits idle without tools', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const attemptPath = path.join(cwd, 'attempt-count.txt')
const logsDir = path.join(cwd, 'logs')
fs.mkdirSync(logsDir, { recursive: true })
const currentAttempt = Number(fs.existsSync(attemptPath) ? fs.readFileSync(attemptPath, 'utf8') : '0') + 1
fs.writeFileSync(attemptPath, String(currentAttempt))
fs.appendFileSync(path.join(cwd, 'attempt-budgets.txt'), (process.env.TEAM_BUDGET_CAP ?? 'missing') + '\\n')

const hostEventsPath = path.join(logsDir, 'host-events.jsonl')
if (currentAttempt === 1) {
  fs.appendFileSync(hostEventsPath, JSON.stringify({ event: 'host.agent_end.no_tool_call', tool_calls_in_turn: 0 }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'message_end',
    message: { usage: { cost: { total: 0.1 } } }
  }) + '\\n')
} else {
  const outputPath = path.join(cwd, 'memo.md')
  const kickoffPrompt = process.argv[process.argv.length - 1] || ''
  fs.writeFileSync(outputPath, kickoffPrompt)
  fs.appendFileSync(hostEventsPath, JSON.stringify({ event: 'host.agent_end', tool_calls_in_turn: 2 }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'message_end',
    message: { usage: { cost: { total: 0.2 } } }
  }) + '\\n')
}
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-idle-retry-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: discussion
      coordinator: worker
      config:
        mode: deliberate
        participants: [worker]
        max_rounds: 1
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: memo.md
`)

      const workerDir = path.join(teamDir, 'agents', 'worker')
      fs.mkdirSync(workerDir, { recursive: true })
      fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')

      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'Assess the brief and produce memo.md.',
        outputArtifact: 'memo.md',
        requestedResultType: 'artifact:memo.md',
        spawnDepth: 0,
        budgetUsd: 1,
        budgetPolicy: 'halt',
      })

      assert.equal(result.succeeded, true)
      assert.ok(Math.abs(result.cost - 0.3) < 1e-9)
      assert.equal(result.costTracked, true)
      assert.deepEqual(
        fs.readFileSync(path.join(result.assignmentPath, 'attempt-budgets.txt'), 'utf8')
          .trim()
          .split('\n'),
        ['1', '0.9'],
      )
      assert.match(result.text, /Recovery attempt: the previous delegated child run ended without calling any tools/)
      assert.match(result.text, /do not wait for user approval in this delegated session/i)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam names the agent that halted rather than restating that the stage stopped', async () => {
  // The YouTube extraction session. Its agent exhausted three attempts against
  // an exhausted provider quota and halted; the run record said only that the
  // stage had blocked, which is a restatement rather than a reason. The
  // provider-events summary cannot help here: a Team agent's provider call runs
  // in the orchestrator, so the child's own provider log is empty by design.
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const runtimeDir = path.join(cwd, '.runtime')
fs.mkdirSync(runtimeDir, { recursive: true })
fs.writeFileSync(path.join(runtimeDir, 'checkpoint.json'), JSON.stringify({
  version: 1,
  currentLevelIndex: 0,
  levelStates: [{ levelId: 'extract', status: 'active', stageStatus: 'blocked' }]
}))
for (const attempt of [1, 2, 3]) {
  fs.appendFileSync(path.join(cwd, 'agent-errors.jsonl'), JSON.stringify({
    timestamp: '2026-09-10T19:37:0' + attempt + '.000Z',
    session_id: 'child',
    level_id: 'extract',
    agent_name: 'youtube-extractor',
    attempt,
    max_attempts: 3,
    policy: 'retry',
    error_message: "You've hit your provider usage limit. Try again after it resets. Parent worker turn failed: execution_failed (provider_failed).",
    error_type: 'agent_failure',
    duration_ms: 2700
  }) + '\\n')
}
fs.appendFileSync(path.join(cwd, 'agent-errors.jsonl'), JSON.stringify({
  timestamp: '2026-09-10T19:37:15.918Z',
  session_id: 'child',
  level_id: 'extract',
  agent_name: 'youtube-extractor',
  attempt: 3,
  max_attempts: 3,
  policy: 'halt',
  error_message: "You've hit your provider usage limit. Try again after it resets. Parent worker turn failed: execution_failed (provider_failed).",
  error_type: 'halt',
  duration_ms: 11785
}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: { usage: { cost: { total: 0.1 } } }
}) + '\\n')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-agent-halt-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'Watch the video and write the manual.',
        outputArtifact: 'extraction-report.md',
        requestedResultType: 'artifact:extraction-report.md',
        spawnDepth: 0,
      })

      assert.equal(result.succeeded, false)
      assert.match(result.text, /Child agent `youtube-extractor` halted after 3 attempts/)
      assert.match(result.text, /Reason: You've hit your provider usage limit/)
      // The stage outcome is the generic answer this replaces.
      assert.doesNotMatch(result.text, /Child stage `extract` blocked/)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam reports a review that ran out of iterations, not that a stage stopped', async () => {
  // A review team that never reached approval. The stage checkpoint says only
  // that it blocked, which is a restatement; the review log says what actually
  // happened and what the user can do about it. The checkpoint is written here
  // too, because it is always written — a summary that reads the review log
  // only when no checkpoint exists would never see this in a real run.
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const runtimeDir = path.join(cwd, '.runtime')
fs.mkdirSync(runtimeDir, { recursive: true })
fs.writeFileSync(path.join(runtimeDir, 'checkpoint.json'), JSON.stringify({
  version: 1,
  currentLevelIndex: 0,
  levelStates: [{ levelId: 'setup', status: 'active', stageStatus: 'blocked' }]
}))
const logsDir = path.join(cwd, 'logs')
fs.mkdirSync(logsDir, { recursive: true })
fs.appendFileSync(path.join(logsDir, 'review-events.jsonl'), JSON.stringify({
  step: 'loop.max-iterations-reached',
  iteration: 1,
  max_iterations: 1,
  last_verdict: 'revise',
  on_max_iterations: 'escalate_to_user'
}) + '\\n')
fs.writeFileSync(path.join(cwd, 'review-feedback-v1.md'), [
  '---',
  'iteration: 1',
  '---',
  '## Blocking Issues',
  '1. [Section: Clause 7] - the cap is stated without its carve-outs.'
].join('\\n'))
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: { usage: { cost: { total: 0.1 } } }
}) + '\\n')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-review-exhausted-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'Summarise the liability cap.',
        outputArtifact: 'final-result.md',
        requestedResultType: 'artifact:final-result.md',
        spawnDepth: 0,
      })

      assert.equal(result.succeeded, false)
      assert.match(result.text, /1\/1 review iterations/)
      assert.match(result.text, /Last verdict: REVISE/)
      // Terminal, and truthful about what comes next: nothing is waiting for
      // the user, and a new run is the only thing that moves this on.
      assert.match(result.text, /start a new run/i)
      assert.doesNotMatch(result.text, /requires user direction/i)
      // The generic stage outcome is the answer this replaces.
      assert.doesNotMatch(result.text, /inspect the stage artifacts/)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam keeps the later blocker when an earlier review published its result', async () => {
  // A team with two stages. The first is a review under `approve_latest`: it
  // used up its rounds and then published the latest draft anyway, so the
  // limit marker is in the log *and* a result was written after it. A later
  // stage is what actually blocked. Reading the marker alone would tell the
  // user their review published nothing, about a review that did.
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const runtimeDir = path.join(cwd, '.runtime')
fs.mkdirSync(runtimeDir, { recursive: true })
fs.writeFileSync(path.join(runtimeDir, 'checkpoint.json'), JSON.stringify({
  version: 1,
  currentLevelIndex: 1,
  levelStates: [
    { levelId: 'review', status: 'completed', stageStatus: 'completed' },
    { levelId: 'finish', status: 'active', stageStatus: 'blocked' }
  ]
}))
const logsDir = path.join(cwd, 'logs')
fs.mkdirSync(logsDir, { recursive: true })
const reviewLog = path.join(logsDir, 'review-events.jsonl')
fs.appendFileSync(reviewLog, JSON.stringify({
  step: 'loop.max-iterations-reached',
  iteration: 2,
  max_iterations: 2,
  last_verdict: 'revise',
  on_max_iterations: 'approve_latest'
}) + '\\n')
// The policy then published the latest draft, which is what makes the marker
// above a step in a finished review rather than the end of the story.
fs.appendFileSync(reviewLog, JSON.stringify({
  step: 'final.write.end',
  path: 'review-result.md',
  iteration: 2
}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: { usage: { cost: { total: 0.1 } } }
}) + '\\n')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-review-published-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'Summarise the liability cap, then file it.',
        outputArtifact: 'final-result.md',
        requestedResultType: 'artifact:final-result.md',
        spawnDepth: 0,
      })

      assert.equal(result.succeeded, false)
      // The stage that actually blocked, not the review that finished.
      assert.match(result.text, /Child stage `finish` blocked/)
      assert.doesNotMatch(result.text, /review iterations/)
      assert.doesNotMatch(result.text, /start a new run/i)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam does not retry or misdiagnose an idle host after runtime autostart blocked', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const attemptPath = path.join(cwd, 'attempt-count.txt')
const currentAttempt = Number(fs.existsSync(attemptPath) ? fs.readFileSync(attemptPath, 'utf8') : '0') + 1
fs.writeFileSync(attemptPath, String(currentAttempt))
const logsDir = path.join(cwd, 'logs')
const runtimeDir = path.join(cwd, '.runtime')
fs.mkdirSync(logsDir, { recursive: true })
fs.mkdirSync(runtimeDir, { recursive: true })
fs.appendFileSync(path.join(logsDir, 'host-events.jsonl'), JSON.stringify({
  timestamp: '2026-07-18T02:42:15.999Z',
  event: 'host.session_start'
}) + '\\n')
fs.appendFileSync(path.join(logsDir, 'runtime-events.jsonl'), JSON.stringify({
  timestamp: '2026-07-18T02:42:16.003Z',
  event: 'runtime.stage_autostart.begin',
  tool_name: 'dispatch'
}) + '\\n')
fs.appendFileSync(path.join(logsDir, 'runtime-events.jsonl'), JSON.stringify({
  timestamp: '2026-07-18T02:42:16.007Z',
  event: 'runtime.stage_autostart.end',
  tool_name: 'dispatch',
  is_error: false
}) + '\\n')
fs.appendFileSync(path.join(logsDir, 'host-events.jsonl'), JSON.stringify({
  timestamp: '2026-07-18T02:42:18.736Z',
  event: 'host.agent_end.no_tool_call',
  tool_calls_in_turn: 0
}) + '\\n')
fs.writeFileSync(path.join(runtimeDir, 'checkpoint.json'), JSON.stringify({
  version: 1,
  currentLevelIndex: 0,
  levelStates: [{ levelId: 'collect-evidence', status: 'active', stageStatus: 'blocked' }]
}))
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: { usage: { cost: { total: 0.1 } } }
}) + '\\n')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-autostart-blocked-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'Collect evidence.',
        outputArtifact: 'research-package.md',
        requestedResultType: 'artifact:research-package.md',
        spawnDepth: 0,
      })

      assert.equal(result.succeeded, false)
      assert.equal(result.status, 'blocked')
      assert.equal(
        fs.readFileSync(path.join(result.assignmentPath, 'attempt-count.txt'), 'utf8'),
        '1',
      )
      assert.match(result.text, /Child stage `collect-evidence` blocked/)
      assert.match(result.text, /runtime did execute its stage tools/)
      assert.doesNotMatch(result.text, /missing credentials|host-provider problem/i)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam does not retry an unpriced idle child under a hard budget', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const attemptPath = path.join(cwd, 'attempt-count.txt')
const currentAttempt = Number(fs.existsSync(attemptPath) ? fs.readFileSync(attemptPath, 'utf8') : '0') + 1
fs.writeFileSync(attemptPath, String(currentAttempt))
const logsDir = path.join(cwd, 'logs')
fs.mkdirSync(logsDir, { recursive: true })
fs.appendFileSync(path.join(logsDir, 'host-events.jsonl'), JSON.stringify({ event: 'host.agent_end.no_tool_call', tool_calls_in_turn: 0 }) + '\\n')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-unpriced-retry-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: chain
      sequence:
        - worker
      config:
        output:
          format: memo.md
          user_review: false
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: memo.md
`)
      const workerDir = path.join(teamDir, 'agents', 'worker')
      fs.mkdirSync(workerDir, { recursive: true })
      fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')

      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'Produce memo.md.',
        outputArtifact: 'memo.md',
        requestedResultType: 'artifact:memo.md',
        spawnDepth: 0,
        budgetUsd: 1,
        budgetPolicy: 'halt',
      })

      assert.equal(result.succeeded, false)
      assert.equal(result.costTracked, false)
      assert.equal(
        fs.readFileSync(path.join(result.assignmentPath, 'attempt-count.txt'), 'utf8'),
        '1',
      )
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam surfaces child host-provider failure details when no artifact is produced', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const logsDir = path.join(cwd, 'logs')
fs.mkdirSync(logsDir, { recursive: true })
fs.appendFileSync(path.join(logsDir, 'host-events.jsonl'), JSON.stringify({
  event: 'host.model_selection.resolved',
  resolved_host_provider: 'anthropic-api',
  resolved_host_model: 'claude-opus-4-6'
}) + '\\n')
fs.appendFileSync(path.join(logsDir, 'host-events.jsonl'), JSON.stringify({
  event: 'host.agent_end.no_tool_call',
  host_provider: 'anthropic-api',
  host_model: 'claude-opus-4-6',
  turn_duration_ms: 211
}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: { usage: { cost: { total: 0.1 } } }
}) + '\\n')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-host-failure-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: discussion
      coordinator: worker
      participants: [worker]
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 1
        constraints: {}
        output:
          path: output
          format: memo.md
          user_review: false
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: memo.md
`)
      const workerDir = path.join(teamDir, 'agents', 'worker')
      fs.mkdirSync(workerDir, { recursive: true })
      fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')

      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'ignored',
        outputArtifact: 'memo.md',
        requestedResultType: 'artifact:memo.md',
        spawnDepth: 0,
      })

      assert.equal(result.succeeded, false)
      assert.match(result.text, /Child host coordinator produced no stage tool calls before `memo\.md`\./)
      assert.match(result.text, /Host provider: anthropic-api/)
      // The idle turn is only attributable to the host once every other
      // recorded startup cause has been ruled out, and the message must say so
      // rather than asserting a credentials or quota problem.
      assert.match(result.text, /no configuration error, no host-start failure, and no skipped or failed stage autostart/i)
      assert.doesNotMatch(result.text, /usually indicates a host-provider problem/i)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam surfaces child provider failure details when no artifact is produced', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const logsDir = path.join(cwd, 'logs')
fs.mkdirSync(logsDir, { recursive: true })
fs.appendFileSync(path.join(logsDir, 'provider-events.jsonl'), JSON.stringify({
  event: 'request.fail',
  status: 'failed',
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  agent_name: 'analyst',
  detail: 'Credit balance is too low to access the API.',
  raw: { http_status: 402 }
}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: { usage: { cost: { total: 0.1 } } }
}) + '\\n')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-provider-failure-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: pipeline
      coordinator: worker
      config:
        parallel: false
        gate:
          type: artifact_exists
          strictness: hard
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: memo.md
`)
      const workerDir = path.join(teamDir, 'agents', 'worker')
      fs.mkdirSync(workerDir, { recursive: true })
      fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')

      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'ignored',
        outputArtifact: 'memo.md',
        requestedResultType: 'artifact:memo.md',
        spawnDepth: 0,
      })

      assert.equal(result.succeeded, false)
      assert.match(result.text, /Child provider failure while producing `memo\.md`\./)
      assert.match(result.text, /Provider: anthropic/)
      assert.match(result.text, /HTTP status: 402/)
      assert.match(result.text, /Credit balance is too low to access the API\./)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam propagates a zero remaining budget to the child env', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const outputPath = path.join(cwd, 'output', 'memo.md')
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, process.env.TEAM_BUDGET_CAP ?? 'missing')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-budget-test-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: pipeline
      coordinator: worker
      config:
        parallel: false
        gate:
          type: artifact_exists
          strictness: hard
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: memo.md
`)

      const workerDir = path.join(teamDir, 'agents', 'worker')
      fs.mkdirSync(workerDir, { recursive: true })
      fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')

      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'This is the child brief.',
        spawnDepth: 0,
        budgetUsd: 0,
      })

      assert.equal(result.text, '0')
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam returns the assignment-local expected artifact path when no child output was produced', async () => {
  await withFakePi(`
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: {
    usage: { cost: { total: 0 } }
  }
}) + '\\n')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-missing-output-test-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: pipeline
      coordinator: worker
      config:
        parallel: false
        gate:
          type: artifact_exists
          strictness: hard
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: missing.md
`)

      const workerDir = path.join(teamDir, 'agents', 'worker')
      fs.mkdirSync(workerDir, { recursive: true })
      fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')

      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'This child will not produce an artifact.',
        outputArtifact: 'missing.md',
        spawnDepth: 0,
      })

      assert.equal(result.artifactPath, '')
      assert.equal(result.succeeded, false)
      assert.equal(result.exitCode, 0)
      assert.match(result.text, /completed without producing the expected output artifact: missing\.md/)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam recovery removes stale output and does not accept it when the retry writes nothing', async () => {
  await withFakePi(`process.exitCode = 0`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-stale-recovery-'))
    const workspacePath = path.join(teamDir, 'workspace')
    const assignmentPath = path.join(workspacePath, 'assignments', 'recovery-run')
    const outputPath = path.join(assignmentPath, 'output', 'memo.md')
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, 'STALE OUTPUT')
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath,
        childSessionId: 'recovery-run',
        brief: 'Retry this child run.',
        outputArtifact: 'output/memo.md',
        recoveryMode: true,
        spawnDepth: 0,
      })

      assert.equal(result.succeeded, false)
      assert.equal(result.artifactPath, '')
      assert.doesNotMatch(result.text, /STALE OUTPUT/)
      assert.equal(fs.existsSync(outputPath), false)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam recovery keeps the completed output a resumable checkpoint already accounts for', async () => {
  // A recovered run resumes from its checkpoint rather than re-running the
  // stage that produced this file. Deleting it would strip the very artifact
  // the completion gate is about to look for, so the finished work would be
  // reported as incomplete.
  await withFakePi(`process.exitCode = 0`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-checkpoint-recovery-'))
    const workspacePath = path.join(teamDir, 'workspace')
    const assignmentPath = path.join(workspacePath, 'assignments', 'recovery-run')
    const outputPath = path.join(assignmentPath, 'output', 'memo.md')
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, 'COMPLETED OUTPUT')
    writeCheckpoint(assignmentPath, {
      sessionId: 'recovery-run',
      currentLevelIndex: 0,
      levelStates: new Map([[
        'l1',
        {
          status: 'active',
          stageStatus: STAGE_LIFECYCLE_STATUS.COMPLETED,
          loopbackCount: 0,
          engineState: {
            type: STAGE_TYPE.CHAIN,
            currentStep: 1,
            totalSteps: 1,
            outputs: [{ agent: 'worker', text: 'COMPLETED OUTPUT' }],
          },
        },
      ]]),
      totalCost: 0,
      startTime: Date.now() - 60_000,
      timerStarted: true,
      endTime: null,
      spawnDepth: 0,
    })
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      await runTeam({
        teamPath: teamDir,
        workspacePath,
        childSessionId: 'recovery-run',
        brief: 'Resume this child run.',
        outputArtifact: 'output/memo.md',
        recoveryMode: true,
        spawnDepth: 0,
      })

      assert.equal(fs.readFileSync(outputPath, 'utf8'), 'COMPLETED OUTPUT')
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam rejects an output path with an intermediate symlink without touching its target', async () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-output-symlink-'))
  const workspacePath = path.join(teamDir, 'workspace')
  const assignmentPath = path.join(workspacePath, 'assignments', 'symlink-output-run')
  const outsidePath = path.join(teamDir, 'outside-output')
  const outsideArtifactPath = path.join(outsidePath, 'memo.md')
  fs.mkdirSync(assignmentPath, { recursive: true })
  fs.mkdirSync(outsidePath, { recursive: true })
  fs.writeFileSync(outsideArtifactPath, 'OUTSIDE SENTINEL')
  fs.symlinkSync(outsidePath, path.join(assignmentPath, 'output'), 'dir')

  try {
    await assert.rejects(
      runTeam({
        teamPath: teamDir,
        workspacePath,
        childSessionId: 'symlink-output-run',
        brief: 'Do not escape the assignment.',
        outputArtifact: 'output/memo.md',
        recoveryMode: true,
        spawnDepth: 0,
      }),
      /output artifact contains a symbolic-link component/i,
    )

    assert.equal(fs.readFileSync(outsideArtifactPath, 'utf8'), 'OUTSIDE SENTINEL')
    assert.equal(fs.existsSync(path.join(assignmentPath, 'incoming-brief.md')), false)
  } finally {
    fs.rmSync(teamDir, { recursive: true, force: true })
  }
})

test('runTeam rejects input and mount destinations with intermediate symlinks', async () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-write-symlinks-'))
  const workspacePath = path.join(teamDir, 'workspace')
  const outsidePath = path.join(teamDir, 'outside-writes')
  const mountSourcePath = path.join(teamDir, 'mount-source.md')
  fs.mkdirSync(outsidePath, { recursive: true })
  fs.writeFileSync(mountSourcePath, 'MOUNT SOURCE')

  try {
    for (const runId of ['symlink-input-run', 'symlink-mount-run']) {
      const assignmentPath = path.join(workspacePath, 'assignments', runId)
      fs.mkdirSync(assignmentPath, { recursive: true })
      fs.symlinkSync(outsidePath, path.join(assignmentPath, 'unsafe'), 'dir')
    }

    await assert.rejects(
      runTeam({
        teamPath: teamDir,
        workspacePath,
        childSessionId: 'symlink-input-run',
        brief: 'Do not follow the input symlink.',
        inputArtifact: 'unsafe/incoming.md',
        outputArtifact: 'memo.md',
        spawnDepth: 0,
      }),
      /input artifact contains a symbolic-link component/i,
    )
    await assert.rejects(
      runTeam({
        teamPath: teamDir,
        workspacePath,
        childSessionId: 'symlink-mount-run',
        brief: 'Do not follow the mount symlink.',
        outputArtifact: 'memo.md',
        mount: [{ from: mountSourcePath, to: 'unsafe/mounted.md' }],
        spawnDepth: 0,
      }),
      /mount destination contains a symbolic-link component/i,
    )

    assert.deepEqual(fs.readdirSync(outsidePath), [])
  } finally {
    fs.rmSync(teamDir, { recursive: true, force: true })
  }
})

test('runTeam reserves .runtime from input, output, and mount artifact paths', async () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-runtime-reserved-'))
  const workspacePath = path.join(teamDir, 'workspace')
  const mountSourcePath = path.join(teamDir, 'mount-source.md')
  fs.writeFileSync(mountSourcePath, 'MOUNT SOURCE')

  try {
    await assert.rejects(
      runTeam({
        teamPath: teamDir,
        workspacePath,
        childSessionId: 'private-input-run',
        brief: 'Private input is forbidden.',
        inputArtifact: '.runtime/incoming.md',
        outputArtifact: 'memo.md',
        spawnDepth: 0,
      }),
      /input artifact must not use the reserved private runtime path/i,
    )
    await assert.rejects(
      runTeam({
        teamPath: teamDir,
        workspacePath,
        childSessionId: 'private-output-run',
        brief: 'Private output is forbidden.',
        outputArtifact: '.runtime/memo.md',
        spawnDepth: 0,
      }),
      /output artifact must not use the reserved private runtime path/i,
    )
    await assert.rejects(
      runTeam({
        teamPath: teamDir,
        workspacePath,
        childSessionId: 'private-mount-run',
        brief: 'Private mount is forbidden.',
        outputArtifact: 'memo.md',
        mount: [{ from: mountSourcePath, to: '.runtime/mounted.md' }],
        spawnDepth: 0,
      }),
      /mount destination must not use the reserved private runtime path/i,
    )
  } finally {
    fs.rmSync(teamDir, { recursive: true, force: true })
  }
})

test('runTeam never resolves an expected artifact from a sibling assignment', async () => {
  await withFakePi(`
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: { usage: { cost: { total: 0 } } }
}) + '\\n')
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-sibling-artifact-'))
    const workspacePath = path.join(teamDir, 'workspace')
    const siblingArtifact = path.join(
      workspacePath,
      'assignments',
      'sibling-run',
      'output',
      'memo.md',
    )
    fs.mkdirSync(path.dirname(siblingArtifact), { recursive: true })
    fs.writeFileSync(siblingArtifact, 'SIBLING SECRET')
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath,
        childSessionId: 'target-run',
        brief: 'Produce a memo.',
        outputArtifact: 'output/memo.md',
        spawnDepth: 0,
      })

      assert.equal(result.succeeded, false)
      assert.equal(result.artifactPath, '')
      assert.match(result.text, /target-run|expected output artifact: output\/memo\.md/)
      assert.doesNotMatch(result.text, /SIBLING SECRET/)
      assert.ok(fs.existsSync(siblingArtifact))
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam scopes subprocess temporary files to private run storage and cleans the attempt', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
fs.writeFileSync(path.join(process.env.TMPDIR, 'provider-temporary.txt'), 'temporary')
fs.writeFileSync(
  path.join(process.cwd(), 'memo.md'),
  process.env.TMPDIR + '\\n' + process.env.TEAM_RUNTIME_IDEMPOTENCY_KEY,
)
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-private-temp-'))
    const workspacePath = path.join(teamDir, 'workspace')
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath,
        childSessionId: 'temporary-run',
        brief: 'Produce a memo.',
        outputArtifact: 'memo.md',
        idempotencyKey: 'stable-operation-key',
        spawnDepth: 0,
      })
      const privateRuntimePath = path.join(result.assignmentPath, '.runtime')
      const temporaryRoot = path.join(privateRuntimePath, 'tmp')

      assert.equal(result.succeeded, true)
      assert.match(result.text, /assignments\/temporary-run\/\.runtime\/tmp\//)
      assert.match(result.text, /stable-operation-key/)
      assert.deepEqual(fs.readdirSync(temporaryRoot), [])
      // The run-private runtime directory is the journal's durability
      // boundary; whoever creates it first decides whether the run's private
      // tree is world-readable. It must be private from creation.
      assert.equal(
        fs.statSync(privateRuntimePath).mode & 0o777,
        0o700,
        'the assignment .runtime directory must be created private (0700)',
      )
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test('runTeam does not treat an output artifact as success after run.incomplete', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
fs.writeFileSync(path.join(cwd, process.env.TEAM_OUTPUT_ARTIFACT), '# Unapproved result\\n')
fs.mkdirSync(path.join(cwd, 'logs'), { recursive: true })
fs.writeFileSync(
  path.join(cwd, 'logs', 'runtime-events.jsonl'),
  JSON.stringify({ event: 'run.incomplete', reason: 'session_shutdown' }) + '\\n',
)
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-incomplete-output-'))
    const workspacePath = path.join(teamDir, 'workspace')
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath,
        brief: 'Produce an approved result.',
        outputArtifact: 'research-package.md',
        spawnDepth: 0,
      })

      assert.equal(result.status, 'blocked')
      assert.equal(result.succeeded, false)
      assert.match(result.text, /Unapproved result/)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

test(
  'runTeam abort terminates the delegated child process group',
  { skip: process.platform === 'win32' },
  async () => {
    await withFakePi(`
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
})
fs.writeFileSync(path.join(process.cwd(), 'grandchild.pid'), String(grandchild.pid))
setInterval(() => {}, 1000)
`, async (binDir) => {
      const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-process-group-'))
      const workspacePath = path.join(teamDir, 'workspace')
      const childSessionId = 'abort-process-group'
      const assignmentPath = path.join(workspacePath, 'assignments', childSessionId)
      const grandchildPidPath = path.join(assignmentPath, 'grandchild.pid')
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      let grandchildPid: number | null = null

      try {
        const controller = new AbortController()
        const resultPromise = runTeam({
          teamPath: teamDir,
          workspacePath,
          childSessionId,
          brief: 'Wait until cancelled.',
          outputArtifact: 'never-produced.md',
          signal: controller.signal,
          spawnDepth: 0,
        })

        await waitForPath(grandchildPidPath)
        grandchildPid = Number(fs.readFileSync(grandchildPidPath, 'utf8'))
        assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0)
        controller.abort()

        const result = await resultPromise
        assert.equal(result.succeeded, false)
        assert.equal(result.exitSignal, 'SIGTERM')
        await waitForProcessExit(grandchildPid)
      } finally {
        if (grandchildPid !== null) {
          try { process.kill(grandchildPid, 'SIGKILL') } catch { /* Already gone. */ }
        }
        if (originalPath === undefined) delete process.env.PATH
        else process.env.PATH = originalPath
        fs.rmSync(teamDir, { recursive: true, force: true })
      }
    })
  },
)

/**
 * Bound work that is supposed to end by itself.
 *
 * A test whose subject is "the timer fires" must not depend on that timer to
 * terminate: with the wiring broken the run never settles, the whole isolated
 * file hangs, and the `finally` that kills the child and removes the fixture
 * never runs. The bound is a failure detector rather than a deadline — generous
 * enough that a healthy run is never near it, and referenced so it actually
 * fires. It is cleared either way, so a passing test adds no wall-clock.
 */
async function settlesWithin<T>(
  work: Promise<T>,
  boundMs: number,
  what: string,
): Promise<T> {
  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error(`${what} did not settle within ${boundMs}ms`)),
          boundMs,
        )
      }),
    ])
  } finally {
    if (watchdog) clearTimeout(watchdog)
  }
}

test(
  'runTeam timeoutMinutes cancels the delegated child through the same path an abort takes',
  { skip: process.platform === 'win32' },
  async () => {
    // Deterministic without waiting on a clock: the fake child never exits on
    // its own, so the timeout is the only thing that can end this run. If the
    // timer is not armed, or is armed and does not reach `abortChild`, the run
    // never settles and the test fails by timing out rather than passing.
    await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
fs.writeFileSync(path.join(process.cwd(), 'child.pid'), String(process.pid))
setInterval(() => {}, 1000)
`, async (binDir) => {
      const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-timeout-'))
      const workspacePath = path.join(teamDir, 'workspace')
      const childSessionId = 'timeout-cancellation'
      const assignmentPath = path.join(workspacePath, 'assignments', childSessionId)
      const childPidPath = path.join(assignmentPath, 'child.pid')
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      let childPid: number | null = null

      try {
        const resultPromise = runTeam({
          teamPath: teamDir,
          workspacePath,
          childSessionId,
          brief: 'Wait to be timed out.',
          outputArtifact: 'never-produced.md',
          // 600ms. Small enough to keep the suite quick, and the only route out
          // of this run.
          timeoutMinutes: 0.01,
          spawnDepth: 0,
        })

        await waitForPath(childPidPath)
        childPid = Number(fs.readFileSync(childPidPath, 'utf8'))
        assert.ok(Number.isSafeInteger(childPid) && childPid > 0)

        // Bounded well above the 600ms timeout plus its termination, so a
        // healthy run never approaches it and a broken timer fails here instead
        // of hanging the file past its own cleanup.
        const result = await settlesWithin(
          resultPromise,
          30_000,
          'the timed-out run',
        )
        assert.equal(result.succeeded, false, 'a timed-out run has not succeeded')
        assert.equal(
          result.exitSignal,
          'SIGTERM',
          'the timeout must cancel through the same signal path an abort uses',
        )
        await waitForProcessExit(childPid)
      } finally {
        if (originalPath === undefined) delete process.env.PATH
        else process.env.PATH = originalPath
        fs.rmSync(teamDir, { recursive: true, force: true })
        await killAndConfirmGone([], [childPid])
      }
    })
  },
)

/**
 * A minimal but genuinely typed SessionTask for supervisor tests.
 *
 * Typed rather than cast: `terminateTaskProcess` reads `pid`/`processGroupId`,
 * and an `as never` here would hide it from any future field it starts reading.
 */
function makeTerminableTask(
  overrides: Pick<SessionTask, 'pid' | 'processGroupId'>,
): SessionTask {
  return {
    id: 'orphan-probe',
    sessionId: 'orphan-probe-session',
    runId: 'orphan-probe-run',
    workflowId: 'orphan-probe-workflow',
    brief: 'Wait until cancelled.',
    status: 'running',
    createdAt: new Date(0).toISOString(),
    cwd: os.tmpdir(),
    ...overrides,
  }
}

/** Read a process group id without assuming a Node API for it. */
function readProcessGroupId(pid: number): number | null {
  try {
    const raw = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const parsed = Number(raw)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

/**
 * SIGKILL exactly these identities, then prove they are gone.
 *
 * A mutation Red must not be able to poison the host, so cleanup verifies
 * itself against captured pids rather than trusting the signal. Scoped to exact
 * identities on purpose — never a process-name scan, which would both miss
 * these (their argv is `pi`) and risk killing something unrelated.
 */
async function killAndConfirmGone(
  groupIds: ReadonlyArray<number | null>,
  pids: ReadonlyArray<number | null>,
): Promise<void> {
  for (const groupId of groupIds) {
    if (groupId === null || !Number.isSafeInteger(groupId)) continue
    try { process.kill(-groupId, 'SIGKILL') } catch { /* Already gone. */ }
  }
  const targets = pids.filter(
    (pid): pid is number => pid !== null && Number.isSafeInteger(pid),
  )
  for (const pid of targets) {
    try { process.kill(pid, 'SIGKILL') } catch { /* Already gone. */ }
  }

  const deadline = Date.now() + 5_000
  const survivors: number[] = []
  for (const pid of targets) {
    while (processIsAlive(pid) && Date.now() < deadline) {
      await new Promise((settle) => setTimeout(settle, 25))
    }
    if (processIsAlive(pid)) survivors.push(pid)
  }
  assert.deepEqual(
    survivors,
    [],
    `test cleanup failed; these captured processes survived SIGKILL: ${JSON.stringify(survivors)}`,
  )
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
}

test(
  'runTeam does not resolve while a SIGTERM-resistant grandchild is still alive in the group',
  { skip: process.platform === 'win32' },
  async () => {
    // Covers the second topology: the direct child dies obediently on SIGTERM
    // while a grandchild sharing its process group ignores it.
    //
    // An earlier version of this test did not discriminate: it announced the
    // grandchild's pid from the parent as soon as `spawn()` returned, which is
    // before the grandchild has executed anything. An abort landing in that
    // startup window killed it by default disposition, so the test passed
    // against the very implementation it exists to catch. The readiness marker
    // below closes that race.
    await withFakePi(`
const { spawn } = require('node:child_process')
const path = require('node:path')
// Same process group as this child (no detached), and deaf to SIGTERM.
//
// The readiness marker is written by the GRANDCHILD, and only after its
// SIGTERM handler is installed. Writing it here — right after spawn() returns —
// would announce a process that has not started executing yet, and an abort
// landing in that window kills it by default disposition, which made this test
// pass against the very implementation it is meant to catch.
const readyPath = path.join(process.cwd(), 'grandchild.ready')
// Written only if the run removes the isolated Pi agent directory while this
// grandchild is still alive. The directory holds a copy of the user's
// credentials and is the agent directory the whole group was started with, so
// removing it during the SIGTERM grace window pulls it out from under a process
// that is still running. The marker lives outside the directory being removed.
const removedWhileAlivePath = path.join(process.cwd(), 'agent-dir-removed-while-alive')
spawn(
  process.execPath,
  [
    '-e',
    "process.on('SIGTERM', () => {});" +
    "const fs = require('node:fs'); const path = require('node:path');" +
    "const agentDir = process.env.PI_CODING_AGENT_DIR;" +
    "if (agentDir) {" +
    "  try {" +
    "    fs.watch(path.dirname(agentDir), () => {" +
    "      if (!fs.existsSync(agentDir)) {" +
    "        try { fs.writeFileSync(" + JSON.stringify(removedWhileAlivePath) + ", agentDir) } catch {}" +
    "      }" +
    "    })" +
    "  } catch {}" +
    "}" +
    "fs.writeFileSync(" + JSON.stringify(readyPath) + ", String(process.pid));" +
    "setInterval(() => {}, 1000)",
  ],
  { stdio: 'ignore' },
)
// This child itself has no SIGTERM handler, so it exits on the first signal.
setInterval(() => {}, 1000)
`, async (binDir) => {
      const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-stubborn-grandchild-'))
      const workspacePath = path.join(teamDir, 'workspace')
      const childSessionId = 'stubborn-grandchild'
      const assignmentPath = path.join(workspacePath, 'assignments', childSessionId)
      const grandchildReadyPath = path.join(assignmentPath, 'grandchild.ready')
      const removedWhileAlivePath = path.join(
        assignmentPath,
        'agent-dir-removed-while-alive',
      )
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      let grandchildPid: number | null = null

      try {
        const controller = new AbortController()
        const resultPromise = runTeam({
          teamPath: teamDir,
          workspacePath,
          childSessionId,
          brief: 'Wait until cancelled.',
          outputArtifact: 'never-produced.md',
          signal: controller.signal,
          spawnDepth: 0,
        })

        // Wait for the handler to be installed, not merely for spawn to return.
        await waitForPath(grandchildReadyPath)
        grandchildPid = Number(fs.readFileSync(grandchildReadyPath, 'utf8'))
        assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0)

        controller.abort()
        const result = await resultPromise
        assert.equal(result.succeeded, false)

        // Immediately — no polling, no grace. The promise resolving IS the
        // claim that cancellation finished.
        assert.equal(
          processIsAlive(grandchildPid),
          false,
          'runTeam resolved while its SIGTERM-resistant grandchild was still alive',
        )

        // The same claim, about the run's own resources rather than its
        // processes. Cleanup that runs when the direct child closes happens
        // while the group is still being terminated, which takes the agent
        // directory away from a process that is still using it.
        assert.equal(
          fs.existsSync(removedWhileAlivePath),
          false,
          "the run removed its Pi agent directory while a process in its group was still alive",
        )
      } finally {
        // Environment and filesystem teardown first, so a cleanup-verification
        // failure below cannot leave global state mutated.
        if (originalPath === undefined) delete process.env.PATH
        else process.env.PATH = originalPath
        fs.rmSync(teamDir, { recursive: true, force: true })
        await killAndConfirmGone([], [grandchildPid])
      }
    })
  },
)

test(
  'the real supervisor sequence leaves no orphaned delegated group behind',
  { skip: process.platform === 'win32' },
  async () => {
    // A runTeam-only test cannot reproduce this. Tried and rejected: with the
    // runner in-process, the test keeps the event loop alive, so the escalation
    // eventually fires and the group dies. That version passed in 10.3s — the
    // duration itself proving it had merely waited out the timer, against the
    // 10s escalation the delegated path used at the time.
    //
    // The decisive element is the ROOT dying first. A root task worker is its
    // own process group; the delegated child is put in a DIFFERENT group by
    // `detached` at agent-runner.ts:872. The supervisor signals only the root's
    // group (task-process-supervisor.ts:145) and SIGKILLs it after 1s
    // (:157), and the nested escalation used to be 10s away
    // (`SIGKILL_GRACE_PERIOD_MS`, core/constants.ts:166). SIGKILL cannot be
    // caught, so the root died at T+1s taking its pending escalation with it,
    // and a SIGTERM-resistant delegated group was orphaned to PID 1 for good.
    //
    // The delegated path now budgets inside that 1s window instead —
    // DELEGATED_SIGKILL_GRACE_PERIOD_MS (core/constants.ts:183) plus
    // DELEGATED_TERMINATION_CONFIRM_MS (:194), 500ms in total. This test drives
    // the REAL `terminateTaskProcess` against a REAL separate root worker, so
    // the ordering that fix depends on is exercised rather than described.
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-orphan-'))
    const binDir = path.join(workRoot, 'bin')
    const reportPath = path.join(workRoot, 'delegated-group.json')
    fs.mkdirSync(binDir, { recursive: true })

    // A delegated agent that cannot be stopped by SIGTERM, in both generations.
    fs.writeFileSync(path.join(binDir, 'pi'), `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const grandchild = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  { stdio: 'ignore' },
)
process.on('SIGTERM', () => {})
fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({
  childPid: process.pid,
  grandchildPid: grandchild.pid,
}))
setInterval(() => {}, 1000)
`, { mode: 0o755 })

    // The root worker: a separate process, in its own group, that dispatches a
    // delegated child and then simply waits — exactly the shape the supervisor
    // terminates in production.
    const rootScript = path.join(workRoot, 'root-worker.mjs')
    fs.writeFileSync(rootScript, `
import { runTeam } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), '.tests-dist', 'domains', 'agent-execution', 'agent-runner.js')).href)}
const controller = new AbortController()
runTeam({
  teamPath: ${JSON.stringify(workRoot)},
  workspacePath: ${JSON.stringify(path.join(workRoot, 'workspace'))},
  childSessionId: 'orphan-probe',
  brief: 'Wait until cancelled.',
  outputArtifact: 'never-produced.md',
  signal: controller.signal,
  spawnDepth: 0,
}).catch((error) => {
  // Not swallowed: after the fix a group that cannot be killed REJECTS, and
  // that is exactly the signal this worker exists to exercise. Recording it on
  // stderr keeps an unexpected failure visible instead of looking like a clean
  // cancellation.
  process.stderr.write('[root-worker] runTeam rejected: ' + String(error) + '\\n')
})
process.on('SIGTERM', () => { controller.abort() })
setInterval(() => {}, 1000)
`)

    let rootPid: number | null = null
    let childPid: number | null = null
    let grandchildPid: number | null = null
    let childPgid: number | null = null

    try {
      const root = spawn(process.execPath, [rootScript], {
        cwd: workRoot,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
      })
      root.unref()
      rootPid = root.pid ?? null
      assert.ok(rootPid, 'the root worker must start')

      await waitForPath(reportPath, 20_000)
      const parsed: unknown = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
      assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      const reported: Record<string, unknown> = { ...parsed }
      childPid = Number(reported.childPid)
      grandchildPid = Number(reported.grandchildPid)
      assert.ok(Number.isSafeInteger(childPid) && childPid > 0)
      assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0)

      // Prove the two groups really are distinct — the whole premise.
      const rootPgid = readProcessGroupId(rootPid)
      childPgid = readProcessGroupId(childPid)
      assert.equal(rootPgid, rootPid, 'the root worker leads its own group')
      assert.ok(childPgid, 'the delegated child must have a group')
      assert.notEqual(
        childPgid,
        rootPgid,
        'the delegated child is detached into its own group, which is why the ' +
          "supervisor's group kill cannot reach it",
      )

      // The product cancellation path, using the real supervisor and its real
      // 1s grace — not a hand-rolled imitation.
      const outcome = await terminateTaskProcess(
        makeTerminableTask({ pid: rootPid, processGroupId: rootPgid ?? rootPid }),
        { allowUnverifiedIdentity: true },
      )
      assert.equal(outcome, 'exited', 'the root task group must be terminated')

      // Cancellation has returned. Nothing delegated may still be running.
      assert.equal(
        processIsAlive(childPid),
        false,
        'the delegated child was orphaned by cancellation',
      )
      assert.equal(
        processIsAlive(grandchildPid),
        false,
        'the delegated grandchild was orphaned by cancellation',
      )
    } finally {
      // Filesystem teardown first, so a cleanup-verification failure below
      // cannot leave the fixture directory behind.
      fs.rmSync(workRoot, { recursive: true, force: true })
      // Unconditional and exact: groups first, then each captured pid, then
      // proof they are gone — a failing assertion must not leave a
      // signal-resistant orphan on the host.
      await killAndConfirmGone(
        [childPgid, rootPid],
        [grandchildPid, childPid, rootPid],
      )
    }
  },
)

test('runTeam supports a delegated deterministic child that produces draft and final artifacts in one run', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const incomingPath = path.join(cwd, process.env.TEAM_INPUT_ARTIFACT || 'incoming-brief.md')
const brief = fs.existsSync(incomingPath) ? fs.readFileSync(incomingPath, 'utf8') : 'missing brief'
if (process.env.TEAM_DELEGATED_AUTOSTART !== '1') process.exit(7)
fs.writeFileSync(path.join(cwd, 'draft-package.md'), '# Draft\\n\\n' + brief)
fs.writeFileSync(path.join(cwd, process.env.TEAM_OUTPUT_ARTIFACT || 'final-draft.md'), '# Final\\n\\n' + brief)
fs.mkdirSync(path.join(cwd, 'logs'), { recursive: true })
fs.writeFileSync(
  path.join(cwd, 'logs', 'runtime-events.jsonl'),
  JSON.stringify({ event: 'runtime.stage_autostart.begin', tool_name: 'handoff' }) + '\\n' +
  JSON.stringify({ event: 'runtime.stage_autostart.end', tool_name: 'submit_for_review', is_error: false }) + '\\n'
)
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-deterministic-child-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: writing-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: brief-and-draft
    name: Brief And Draft
    order: 0
    stage:
      type: chain
      sequence: [worker]
      config:
        output:
          format: draft-package.md
          user_review: false
  - id: editorial-review
    name: Editorial Review
    order: 1
    stage:
      type: review
      producer: worker
      reviewer: worker
      config:
        max_iterations: 2
        output:
          format: final-draft.md
          user_review: false
gates:
  - from: brief-and-draft
    to: editorial-review
    condition:
      type: artifact_exists
      artifact: draft-package.md
  - from: editorial-review
    to: done
    condition:
      type: artifact_exists
      artifact: final-draft.md
`)

      const workerDir = path.join(teamDir, 'agents', 'worker')
      fs.mkdirSync(workerDir, { recursive: true })
      fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')

      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'Create one pager on Audi.',
        outputArtifact: 'final-draft.md',
        requestedResultType: 'artifact:final-draft.md',
        spawnDepth: 0,
      })

      assert.equal(result.succeeded, true)
      assert.match(result.text, /Create one pager on Audi\./)
      assert.ok(result.assignmentPath.includes(path.join('child-workspace', 'assignments')))
      const runtimeEvents = fs.readFileSync(path.join(result.assignmentPath, 'logs', 'runtime-events.jsonl'), 'utf8')
      assert.match(runtimeEvents, /runtime\.stage_autostart\.begin/)
      assert.match(runtimeEvents, /runtime\.stage_autostart\.end/)
      assert.ok(fs.existsSync(path.join(result.assignmentPath, 'draft-package.md')))
      assert.ok(fs.existsSync(path.join(result.assignmentPath, 'final-draft.md')))
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})

// ─── Startup-failure classification ──────────────────────────────────────────
//
// Every one of these cases used to produce the same sentence — "coordinator
// exited without calling any stage tools … usually indicates a host-provider
// problem" — which is how a runtime that never started the stage was reported
// as a Codex credentials failure. An idle turn is what a delegated child is
// *told* to produce; it identifies nothing on its own.

/** Writes a child team whose only gate is `memo.md`, shared by the cases below. */
function writeIdleChildTeam(teamDir: string): void {
  fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: discussion
      coordinator: worker
      config:
        mode: deliberate
        participants: [worker]
        max_rounds: 1
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: memo.md
`)
  const workerDir = path.join(teamDir, 'agents', 'worker')
  fs.mkdirSync(workerDir, { recursive: true })
  fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')
}

async function runIdleChild(
  prefix: string,
  handlerSource: string,
): Promise<{ text: string; assignmentPath: string }> {
  return withFakePi(handlerSource, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      writeIdleChildTeam(teamDir)
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'Assess the brief and produce memo.md.',
        outputArtifact: 'memo.md',
        requestedResultType: 'artifact:memo.md',
        spawnDepth: 0,
      })
      return { text: result.text, assignmentPath: result.assignmentPath }
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
}

test('a skipped stage autostart is reported as a skipped autostart, not a host-provider problem', async () => {
  const { text } = await runIdleChild('run-team-autostart-skipped-', `
const fs = require('node:fs')
const path = require('node:path')
const logsDir = path.join(process.cwd(), 'logs')
fs.mkdirSync(logsDir, { recursive: true })
fs.appendFileSync(path.join(logsDir, 'host-events.jsonl'), JSON.stringify({
  timestamp: '2026-08-19T10:00:00.000Z',
  event: 'host.session_start'
}) + '\\n')
fs.appendFileSync(path.join(logsDir, 'runtime-events.jsonl'), JSON.stringify({
  timestamp: '2026-08-19T10:00:01.000Z',
  event: 'runtime.stage_autostart.skipped',
  reason: 'missing_tool_invokers',
  missing_tools: ['converse'],
  registered_tools: ['set_roster', 'create_brief']
}) + '\\n')
fs.appendFileSync(path.join(logsDir, 'host-events.jsonl'), JSON.stringify({
  timestamp: '2026-08-19T10:00:02.000Z',
  event: 'host.agent_end.no_tool_call',
  host_provider: 'openai-codex',
  host_model: 'gpt-5.4-mini',
  tool_calls_in_turn: 0
}) + '\\n')
`)

  assert.match(text, /did not start the stage/i)
  assert.match(text, /missing_tool_invokers/)
  assert.match(text, /converse/)
  assert.doesNotMatch(text, /host-provider problem|missing credentials|exhausted credits/i)
})

test('a child that never got past configuration is reported as a config error', async () => {
  const { text } = await runIdleChild('run-team-config-error-', `
const fs = require('node:fs')
const path = require('node:path')
const logsDir = path.join(process.cwd(), 'logs')
fs.mkdirSync(logsDir, { recursive: true })
fs.appendFileSync(path.join(logsDir, 'runtime-events.jsonl'), JSON.stringify({
  timestamp: '2026-08-19T10:00:00.000Z',
  event: 'runtime.config_error',
  errors: ["Host provider 'codex' is unavailable: Codex is not logged in."]
}) + '\\n')
fs.appendFileSync(path.join(logsDir, 'host-events.jsonl'), JSON.stringify({
  timestamp: '2026-08-19T10:00:01.000Z',
  event: 'host.agent_end.no_tool_call',
  host_provider: 'openai-codex',
  host_model: 'gpt-5.4-mini',
  tool_calls_in_turn: 0
}) + '\\n')
`)

  assert.match(text, /could not start/i)
  assert.match(text, /Codex is not logged in/)
  assert.doesNotMatch(text, /host-provider problem|exhausted credits/i)
})

test('a blocked host model selection is reported with the models that were available', async () => {
  const { text } = await runIdleChild('run-team-model-blocked-', `
const fs = require('node:fs')
const path = require('node:path')
const logsDir = path.join(process.cwd(), 'logs')
fs.mkdirSync(logsDir, { recursive: true })
fs.appendFileSync(path.join(logsDir, 'host-events.jsonl'), JSON.stringify({
  timestamp: '2026-08-19T10:00:00.000Z',
  event: 'host.session_start'
}) + '\\n')
fs.appendFileSync(path.join(logsDir, 'host-events.jsonl'), JSON.stringify({
  timestamp: '2026-08-19T10:00:01.000Z',
  event: 'host.model_selection.blocked',
  desired_provider: 'openai-codex',
  desired_model: 'gpt-5.4-mini',
  available_preview: 'anthropic-api:claude-haiku-4-5'
}) + '\\n')
fs.appendFileSync(path.join(logsDir, 'host-events.jsonl'), JSON.stringify({
  timestamp: '2026-08-19T10:00:02.000Z',
  event: 'host.agent_end.no_tool_call',
  tool_calls_in_turn: 0
}) + '\\n')
`)

  assert.match(text, /host model/i)
  assert.match(text, /gpt-5\.4-mini/)
  assert.match(text, /anthropic-api:claude-haiku-4-5/)
})

test('a runtime autostart that failed is reported instead of being masked as executed', async () => {
  const { text } = await runIdleChild('run-team-autostart-failed-', `
const fs = require('node:fs')
const path = require('node:path')
const logsDir = path.join(process.cwd(), 'logs')
fs.mkdirSync(logsDir, { recursive: true })
fs.appendFileSync(path.join(logsDir, 'host-events.jsonl'), JSON.stringify({
  timestamp: '2026-08-19T10:00:00.000Z',
  event: 'host.session_start'
}) + '\\n')
fs.appendFileSync(path.join(logsDir, 'runtime-events.jsonl'), JSON.stringify({
  timestamp: '2026-08-19T10:00:01.000Z',
  event: 'runtime.stage_autostart.begin',
  tool_name: 'delegated_discussion_autostart'
}) + '\\n')
fs.appendFileSync(path.join(logsDir, 'runtime-events.jsonl'), JSON.stringify({
  timestamp: '2026-08-19T10:00:02.000Z',
  event: 'runtime.stage_autostart.end',
  tool_name: 'delegated_discussion_autostart',
  is_error: true,
  error: 'Roster must be locked via set_roster'
}) + '\\n')
`)

  assert.match(text, /runtime started the stage and it failed/i)
  assert.match(text, /Roster must be locked via set_roster/)
})

test('child stderr survives alongside an inconclusive diagnosis', async () => {
  const { text } = await runIdleChild('run-team-stderr-kept-', `
const fs = require('node:fs')
const path = require('node:path')
const logsDir = path.join(process.cwd(), 'logs')
fs.mkdirSync(logsDir, { recursive: true })
fs.appendFileSync(path.join(logsDir, 'host-events.jsonl'), JSON.stringify({
  timestamp: '2026-08-19T10:00:00.000Z',
  event: 'host.session_start'
}) + '\\n')
fs.appendFileSync(path.join(logsDir, 'runtime-events.jsonl'), JSON.stringify({
  timestamp: '2026-08-19T10:00:01.000Z',
  event: 'runtime.stage_autostart.skipped',
  reason: 'missing_tool_invokers',
  missing_tools: ['converse']
}) + '\\n')
process.stderr.write('TypeError: cannot read properties of undefined (reading roster)\\n')
`)

  assert.match(text, /did not start the stage/i)
  assert.match(text, /cannot read properties of undefined/)
})

test('a failed stage autostart still earns the one recovery attempt, and that attempt is told to drive the stage', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const logsDir = path.join(cwd, 'logs')
fs.mkdirSync(logsDir, { recursive: true })
const attemptPath = path.join(cwd, 'attempt-count.txt')
const currentAttempt = Number(fs.existsSync(attemptPath) ? fs.readFileSync(attemptPath, 'utf8') : '0') + 1
fs.writeFileSync(attemptPath, String(currentAttempt))
fs.appendFileSync(
  path.join(cwd, 'attempt-recovery-flags.txt'),
  (process.env.TEAM_RUNTIME_RECOVERY ?? 'missing') + '\\n',
)

const hostEventsPath = path.join(logsDir, 'host-events.jsonl')
const runtimeEventsPath = path.join(logsDir, 'runtime-events.jsonl')
if (currentAttempt === 1) {
  fs.appendFileSync(hostEventsPath, JSON.stringify({
    timestamp: '2026-08-19T10:00:00.000Z',
    event: 'host.session_start'
  }) + '\\n')
  fs.appendFileSync(runtimeEventsPath, JSON.stringify({
    timestamp: '2026-08-19T10:00:01.000Z',
    event: 'runtime.stage_autostart.begin',
    tool_name: 'delegated_discussion_autostart'
  }) + '\\n')
  fs.appendFileSync(runtimeEventsPath, JSON.stringify({
    timestamp: '2026-08-19T10:00:02.000Z',
    event: 'runtime.stage_autostart.end',
    tool_name: 'delegated_discussion_autostart',
    is_error: true,
    error: 'converse failed: every participant errored'
  }) + '\\n')
  fs.appendFileSync(hostEventsPath, JSON.stringify({
    timestamp: '2026-08-19T10:00:03.000Z',
    event: 'host.agent_end.no_tool_call',
    tool_calls_in_turn: 0
  }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'message_end',
    message: { usage: { cost: { total: 0.1 } } }
  }) + '\\n')
} else {
  fs.writeFileSync(path.join(cwd, 'memo.md'), process.argv[process.argv.length - 1] || '')
  fs.appendFileSync(hostEventsPath, JSON.stringify({
    timestamp: '2026-08-19T10:01:00.000Z',
    event: 'host.agent_end',
    tool_calls_in_turn: 3
  }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'message_end',
    message: { usage: { cost: { total: 0.2 } } }
  }) + '\\n')
}
`, async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-autostart-failed-recovery-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      writeIdleChildTeam(teamDir)
      const result = await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'Assess the brief and produce memo.md.',
        outputArtifact: 'memo.md',
        requestedResultType: 'artifact:memo.md',
        spawnDepth: 0,
      })

      assert.equal(result.succeeded, true)
      assert.equal(
        fs.readFileSync(path.join(result.assignmentPath, 'attempt-count.txt'), 'utf8'),
        '2',
        'a failed autostart must not be mistaken for an executed one, or no recovery is attempted',
      )
      assert.deepEqual(
        fs.readFileSync(path.join(result.assignmentPath, 'attempt-recovery-flags.txt'), 'utf8')
          .split('\n')
          .filter(Boolean),
        ['0', '1'],
        'only the second attempt runs in recovery mode',
      )
      // The recovery attempt must actually be instructed to drive the stage;
      // the same env that marks it recovery is what lifts the delegated NOOP
      // prompt in the child runtime.
      const recoveryKickoff = fs.readFileSync(path.join(result.assignmentPath, 'memo.md'), 'utf8')
      assert.match(recoveryKickoff, /Recovery attempt: the previous delegated child run ended without calling any tools/)
      assert.match(recoveryKickoff, /call `set_roster`, call `create_brief`, then call `converse`/)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
})


test('runAgent surfaces a truncated worker turn as a non-retryable provider failure', async () => {
  // The end of the chain. The worker endpoint reports the failure the way the
  // real route does; runAgent must hand failure policy a typed ProviderError,
  // because an untyped bridge error defaults to retryable and would retry a
  // truncation against the same token ceiling.
  const server = http.createServer((_request, response) => {
    response.statusCode = 500
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      error: 'MCP worker turn failed',
      code: 'execution_failed',
      retryable: false,
      providerCode: 'provider_truncated',
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  try {
    await assert.rejects(
      runAgent({
        systemPrompt: 'Draft the section.',
        userMessage: 'Write it.',
        model: 'default',
        thinking: 'medium',
        provider: 'codex',
        agentName: 'section-writer',
        tools: ['read'],
        workerEnvironment: {
          [MCP_WORKER_TURN_URL_ENV]: `http://127.0.0.1:${address.port}/worker-turn`,
          [RUNTIME_SESSION_ID_ENV]: '11111111-1111-4111-8111-111111111111',
          [RUNTIME_RUN_ID_ENV]: 'run-truncated',
          [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-truncated',
          TEAM_RUNTIME_TASK_ID: 'task-truncated',
          TEAM_RUNTIME_PROCESS_IDENTITY: 'process-truncated',
          TEAM_RUNTIME_WORKFLOW_ID: 'workflow-truncated',
          [MCP_WORKER_WORKFLOW_STEP_ID_ENV]: 'draft',
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError, 'failure policy classifies on ProviderError')
        assert.equal(error.code, 'provider_truncated')
        assert.equal(error.retryable, false)
        return true
      },
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    )
  }
})

/** Warnings saying a team-type roster entry's provider setting is ignored. */
function ignoredTeamProviderWarnings(
  calls: ReadonlyArray<{ readonly arguments: readonly unknown[] }>,
): string[] {
  return calls
    .map((call) => call.arguments[0])
    .filter((message): message is string =>
      typeof message === 'string' &&
      message.includes('The provider setting will be ignored'),
    )
}

/**
 * B3 — a delegated child team that did not succeed must reach its parent as a
 * failure, carrying the child's own terminal status.
 *
 * The child is a fake Pi process: a real delegated team runs a provider turn,
 * which is credentialed and billed, and the behaviour under test is what the
 * parent does with the child's *result*, not what a model produces.
 */
for (const childCase of [
  {
    status: 'blocked',
    artifactStatus: 'blocked',
    exitCode: 0,
    label: 'blocked',
  },
  {
    status: 'failed',
    artifactStatus: 'failed',
    exitCode: 0,
    label: 'failed',
  },
] as const) {
  test(`dispatchToAgentOrTeam surfaces a ${childCase.label} child team as a typed failure`, async (t) => {
    await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const outputPath = path.join(cwd, 'memo.md')
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(
  outputPath,
  '---\\nstatus: "${childCase.artifactStatus}"\\n---\\n\\n# Child prose that must not be returned as success\\n',
)
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: { usage: { cost: { total: 0.25 } } }
}) + '\\n')
process.exit(${childCase.exitCode})
`, async (binDir) => {
      const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), `b3-${childCase.label}-`))
      // Every variable that decides which Pi binary runs, so an existing
      // bundled-CLI path in the caller's env cannot bypass the fake child.
      const previousEnv = {
        PATH: process.env.PATH,
        TEAM_RUNTIME_PI_CLI_PATH: process.env.TEAM_RUNTIME_PI_CLI_PATH,
        TEAM_RUNTIME_PI_NODE_PATH: process.env.TEAM_RUNTIME_PI_NODE_PATH,
      }
      process.env.PATH = `${binDir}${path.delimiter}${previousEnv.PATH ?? ''}`
      delete process.env.TEAM_RUNTIME_PI_CLI_PATH
      delete process.env.TEAM_RUNTIME_PI_NODE_PATH
      // The provider circuit is global in-process state; reset it so this case
      // cannot inherit accumulated Pi failures from earlier tests.
      globalCircuitBreaker.resetAll()
      try {
        fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: pipeline
      coordinator: worker
      config:
        parallel: false
        gate:
          type: artifact_exists
          strictness: hard
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: memo.md
`)
        const workerDir = path.join(teamDir, 'agents', 'worker')
        fs.mkdirSync(workerDir, { recursive: true })
        fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')

        const outputPath = path.join(teamDir, 'parent-assignment')
        fs.mkdirSync(outputPath, { recursive: true })
        const state = {
          sessionId: 'parent-session',
          currentLevelIndex: 0,
          levelStates: new Map(),
          totalCost: 0,
          startTime: 0,
          timerStarted: false,
          endTime: null,
          spawnDepth: 0,
        }

        const warn = t.mock.method(console, 'warn')
        await assert.rejects(
          dispatchToAgentOrTeam({
            agent: {
              name: 'delegator',
              provider: 'pi',
              model: 'default',
              thinking: 'low',
              systemPrompt: '',
              agentDir: teamDir,
              experienceEnabled: false,
            },
            rosterEntry: { name: 'child', type: 'team', team_path: teamDir, output_artifact: 'memo.md' },
            finalPrompt: 'prompt',
            userMessage: 'message',
            state,
            workspacePath: path.join(teamDir, 'child-workspace'),
            outputPath,
          } as never),
          (error: unknown) => {
            assert.ok(error instanceof SubTeamFailedError,
              `a ${childCase.label} child must surface as a typed sub-team failure`)
            assert.equal(error.childStatus, childCase.status)
            assert.equal(error.retryable, childCase.status === 'failed')
            // The explanation runTeam assembled must survive, or the parent has
            // a status and nothing to act on.
            assert.match(error.message, /Child reported:/)
            return true
          },
        )

        // Sub-team dispatch always runs Pi, so a Pi agent has nothing to warn about.
        assert.deepEqual(ignoredTeamProviderWarnings(warn.mock.calls), [])

        // The child's prose must not have been handed back as a usable result,
        // and its cost must still be accounted for.
        // Exactly once: a doubled or dropped accounting both fail here.
        assert.equal(state.totalCost, 0.25,
          "a failed child's incurred cost must be accounted exactly once")
        // The provider circuit must not be poisoned by a child-team outcome.
        assert.equal(globalCircuitBreaker.getState('pi'), 'closed',
          'a sub-team failure is not a provider health signal')

        const runsLog = path.join(outputPath, 'logs', 'agent-runs.jsonl')
        assert.ok(fs.existsSync(runsLog), 'the dispatch must still record an end event')
        const endStatuses = fs.readFileSync(runsLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .flatMap((line) => {
            const parsed: unknown = JSON.parse(line)
            // Arrays are `typeof 'object'` and non-null, and spreading one
            // yields index keys rather than the fields this assertion reads,
            // so a malformed line must be rejected here, not silently skipped
            // by the `event !== 'end'` check below.
            if (
              typeof parsed !== 'object' ||
              parsed === null ||
              Array.isArray(parsed)
            ) return []
            const record: Record<string, unknown> = { ...parsed }
            if (record.event !== 'end') return []
            return typeof record.status === 'string' ? [record.status] : []
          })
        assert.ok(endStatuses.length > 0, 'an end event must be recorded')
        assert.equal(
          endStatuses[endStatuses.length - 1],
          childCase.status,
          "the end event must preserve the child's real status",
        )
      } finally {
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        globalCircuitBreaker.resetAll()
        fs.rmSync(teamDir, { recursive: true, force: true })
      }
    })
  })
}

// ─── Generic dispatch carries a provider output schema ───────────────────────

/**
 * A fake `codex` binary that reports the argv it received and the schema file
 * it was handed, so a test can prove what reached the installed CLI contract
 * rather than what a provider helper was called with.
 */
function withFakeCodexBinary<T>(
  handlerSource: string,
  fn: (binDir: string) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-dispatch-bin-'))
  fs.writeFileSync(
    path.join(dir, 'codex'),
    `#!/usr/bin/env node\n${handlerSource}\n`,
    { mode: 0o755 },
  )
  return fn(dir).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

/** A CLI that refuses with a credential error, the way a real one would. */
const CODEX_FAILING_HANDLER = `
process.stderr.write('401 Unauthorized: invalid_api_key\\n')
process.exit(1)
`

const CODEX_SCHEMA_ECHO_HANDLER = `
const fs = require('node:fs')
const nodePath = require('node:path')
// Written beside the fake binary rather than to a path in the environment: the
// runtime strips unknown variables from a provider subprocess, and widening
// that for a test would weaken the thing it protects.
const invocationLog = nodePath.join(__dirname, 'codex-invocations.json')
let seenInvocations = []
try { seenInvocations = JSON.parse(fs.readFileSync(invocationLog, 'utf8')) } catch {}
seenInvocations.push(process.argv.slice(2))
fs.writeFileSync(invocationLog, JSON.stringify(seenInvocations))
const args = process.argv.slice(2)
const schemaIndex = args.indexOf('--output-schema')
const schemaPath = schemaIndex >= 0 ? args[schemaIndex + 1] : ''
const payload = {
  sawOutputSchemaFlag: schemaIndex >= 0,
  schema: schemaPath ? JSON.parse(fs.readFileSync(schemaPath, 'utf8')) : null,
}
process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: { id: 'item_0', type: 'agent_message', text: JSON.stringify(payload) },
}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
}) + '\\n')
`

/** The fake binary answers with this shape; a guard keeps the read honest. */
interface CodexSchemaEcho {
  readonly sawOutputSchemaFlag: boolean
  readonly schema: unknown
}

function readCodexSchemaEcho(text: string): CodexSchemaEcho {
  const parsed: unknown = JSON.parse(text)
  assert.ok(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    `Expected the fake Codex CLI to answer with an object, got: ${text}`,
  )
  const record: Record<string, unknown> = { ...parsed }
  assert.equal(typeof record.sawOutputSchemaFlag, 'boolean')
  return {
    sawOutputSchemaFlag: record.sawOutputSchemaFlag === true,
    schema: record.schema,
  }
}

function makeDispatchState(sessionId: string): RuntimeState {
  return {
    sessionId,
    currentLevelIndex: 0,
    levelStates: new Map(),
    totalCost: 0,
    startTime: 0,
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }
}

function makeCodexAgent(name: string, agentDir: string, systemPrompt: string): LoadedAgent {
  return {
    name,
    model: 'gpt-5.6-terra',
    thinking: 'medium',
    tools: [],
    systemPrompt,
    experienceContent: '',
    experienceEnabled: false,
    skillsContent: '',
    knowledgeContent: '',
    selection: null,
    agentDir,
    color: 36,
    provider: 'codex',
  }
}

test('generic direct-agent dispatch hands its output schema to the Codex CLI', async () => {
  await withFakeCodexBinary(CODEX_SCHEMA_ECHO_HANDLER, async (binDir) => {
    const outputPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-output-schema-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    const outputSchema = {
      type: 'object',
      properties: { decision: { type: 'string', enum: ['APPROVE'] } },
      required: ['decision'],
      additionalProperties: false,
    } as const

    try {
      const result = await dispatchToAgentOrTeam({
        agent: makeCodexAgent('evidence-critic', outputPath, 'Audit the research package.'),
        rosterEntry: { type: 'agent' },
        finalPrompt: 'Audit the research package.',
        userMessage: 'Return one QualityVerdict.',
        state: makeDispatchState('dispatch-schema-session'),
        workspacePath: outputPath,
        outputPath,
        metrics: undefined,
        outputSchema,
      })

      const payload = readCodexSchemaEcho(result.text)
      assert.equal(payload.sawOutputSchemaFlag, true)
      assert.deepEqual(payload.schema, outputSchema)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(outputPath, { recursive: true, force: true })
    }
  })
})

test('generic direct-agent dispatch sends no schema flag when none is supplied', async () => {
  await withFakeCodexBinary(CODEX_SCHEMA_ECHO_HANDLER, async (binDir) => {
    const outputPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-no-schema-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    try {
      const result = await dispatchToAgentOrTeam({
        agent: makeCodexAgent('editor', outputPath, 'Edit the draft.'),
        rosterEntry: { type: 'agent' },
        finalPrompt: 'Edit the draft.',
        userMessage: 'Polish this text.',
        state: makeDispatchState('dispatch-no-schema-session'),
        workspacePath: outputPath,
        outputPath,
        metrics: undefined,
      })

      assert.equal(readCodexSchemaEcho(result.text).sawOutputSchemaFlag, false)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(outputPath, { recursive: true, force: true })
    }
  })
})

test('a dispatch records the selection that admitted the agent, before the provider answers', async () => {
  // The `start` event is written before the provider is called, so a Team run
  // can disclose default use while the agent is still working. Read back from
  // the assignment log, which is what the run store and the UI project.
  await withFakeCodexBinary(CODEX_SCHEMA_ECHO_HANDLER, async (binDir) => {
    const outputPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'dispatch-model-selection-'),
    )
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      const agent = makeCodexAgent('reviewer', outputPath, 'Review it.')
      await dispatchToAgentOrTeam({
        agent: {
          ...agent,
          selection: {
            provider: 'codex',
            model: 'gpt-5.6-terra',
            source: 'app-default',
            reason: 'agent-default',
          },
        },
        rosterEntry: { type: 'agent' },
        finalPrompt: 'Review it.',
        userMessage: 'Review it.',
        state: makeDispatchState('dispatch-model-selection-session'),
        workspacePath: outputPath,
        outputPath,
        metrics: undefined,
      })

      const events = fs
        .readFileSync(path.join(outputPath, 'logs', 'agent-runs.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AgentRunEvent)
      const start = events.find((event) => event.event === 'start')

      assert.ok(start, 'the dispatch must record a start event')
      assert.deepEqual(start.model_selection, {
        provider: 'codex',
        model: 'gpt-5.6-terra',
        source: 'app-default',
        reason: 'agent-default',
        caller: 'agent',
      })
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(outputPath, { recursive: true, force: true })
    }
  })
})

test('a nested Team wrapper does not claim the application default it never dispatched', async (t) => {
  // A `team` roster entry that declares no host pair resolves the application
  // default only so the wrapper has something to name. What actually runs is
  // decided inside the child, by its own registry entry and its own
  // coordinator, and the child records that itself. Repeating the wrapper's
  // unused pair here would put a model in history that no request ever used.
  await withFakeCodexBinary(CODEX_SCHEMA_ECHO_HANDLER, async (binDir) => {
    const outputPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nested-team-model-selection-'),
    )
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    const warn = t.mock.method(console, 'warn')
    try {
      const agent = makeCodexAgent('child', outputPath, 'Do it.')
      await dispatchToAgentOrTeam({
        agent: {
          ...agent,
          selection: {
            provider: 'codex',
            model: 'gpt-5.6-terra',
            source: 'app-default',
            reason: 'agent-default',
          },
        },
        rosterEntry: { type: 'team', team_path: outputPath },
        finalPrompt: 'Do it.',
        userMessage: 'Do it.',
        state: makeDispatchState('nested-team-model-selection-session'),
        workspacePath: outputPath,
        outputPath,
        metrics: undefined,
      }).catch(() => undefined)

      const start = fs
        .readFileSync(path.join(outputPath, 'logs', 'agent-runs.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AgentRunEvent)
        .find((event) => event.event === 'start')

      assert.ok(start)
      assert.equal(start.agent_type, 'team')
      assert.equal(start.model_selection, undefined)
      assert.deepEqual(ignoredTeamProviderWarnings(warn.mock.calls), [
        "[team-runtime] Warning: Provider 'codex' is set on team-type agent 'child' " +
          'but sub-team dispatch always uses Pi. The provider setting will be ignored.',
      ])
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(outputPath, { recursive: true, force: true })
    }
  })
})

test('a nested Team that declares its own host pair records that declaration', async (t) => {
  await withFakeCodexBinary(CODEX_SCHEMA_ECHO_HANDLER, async (binDir) => {
    const outputPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nested-team-host-selection-'),
    )
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    const warn = t.mock.method(console, 'warn')
    try {
      const agent = makeCodexAgent('child', outputPath, 'Do it.')
      await dispatchToAgentOrTeam({
        agent: {
          ...agent,
          selection: {
            provider: 'codex',
            model: 'gpt-5.6-terra',
            source: 'agent',
            reason: 'explicit-agent-choice',
          },
        },
        rosterEntry: {
          type: 'team',
          team_path: outputPath,
          host_provider: 'codex',
          host_model: 'gpt-5.6-terra',
        },
        finalPrompt: 'Do it.',
        userMessage: 'Do it.',
        state: makeDispatchState('nested-team-host-selection-session'),
        workspacePath: outputPath,
        outputPath,
        metrics: undefined,
      }).catch(() => undefined)

      const start = fs
        .readFileSync(path.join(outputPath, 'logs', 'agent-runs.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AgentRunEvent)
        .find((event) => event.event === 'start')

      assert.ok(start)
      assert.deepEqual(start.model_selection, {
        provider: 'codex',
        model: 'gpt-5.6-terra',
        source: 'agent',
        reason: 'explicit-agent-choice',
        caller: 'agent',
      })
      assert.deepEqual(ignoredTeamProviderWarnings(warn.mock.calls), [
        "[team-runtime] Warning: Provider 'codex' is set on team-type agent 'child' " +
          'but sub-team dispatch always uses Pi. The provider setting will be ignored.',
      ])
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(outputPath, { recursive: true, force: true })
    }
  })
})

test('a failed dispatch records why it failed, not only that it did', async () => {
  // A Team dispatch's `fail` event carried a message string and nothing a
  // reader could act on. Deciding whether a user may be offered a retry needs
  // the failure's *kind* and *phase*, and it has to be attributable to the one
  // dispatch that failed — a run where the same agent spoke twice has two
  // failures to tell apart.
  await withFakeCodexBinary(CODEX_FAILING_HANDLER, async (binDir) => {
    const outputPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'dispatch-typed-failure-'),
    )
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      const agent = makeCodexAgent('reviewer', outputPath, 'Review it.')
      await dispatchToAgentOrTeam({
        agent: {
          ...agent,
          selection: {
            provider: 'codex',
            model: 'gpt-5.6-terra',
            source: 'agent',
            reason: 'explicit-agent-choice',
          },
        },
        rosterEntry: { type: 'agent' },
        finalPrompt: 'Review it.',
        userMessage: 'Review it.',
        state: makeDispatchState('dispatch-typed-failure-session'),
        workspacePath: outputPath,
        outputPath,
        metrics: undefined,
      }).catch(() => undefined)

      const events = fs
        .readFileSync(path.join(outputPath, 'logs', 'agent-runs.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AgentRunEvent)
      const start = events.find((event) => event.event === 'start')
      const failed = events.find((event) => event.event === 'fail')

      assert.ok(failed, 'a failed dispatch records a fail event')
      assert.ok(failed.failure, 'and says why it failed, in codes')
      assert.equal(typeof failed.failure.phase, 'string')
      assert.equal(typeof failed.failure.serviceCode, 'string')
      // The CLI launched, so nothing here can claim it sent nothing.
      assert.equal(failed.failure.dispatched, undefined)
      // The CLI launched and then failed. A credential error *category* does
      // not mean the attempt stopped before reaching the provider — Codex can
      // run for a while and emit a structured terminal error at exit — so the
      // recorded phase must not claim otherwise.
      assert.equal(failed.failure.phase, 'provider-request')
      // A CLI that exits with an unrecognized message has no provider kind.
      // Recording none is the honest answer, and it is also what makes the
      // failure ineligible: nothing says the *model* was the problem.
      assert.equal(failed.failure.providerKind, undefined)
      assert.equal(failed.failure.serviceCode, 'provider_failed')
      // Attributable to the exact attempt, so a second attempt by the same
      // agent cannot be mistaken for this one.
      assert.ok(start?.dispatch_id)
      assert.equal(failed.dispatch_id, start.dispatch_id)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(outputPath, { recursive: true, force: true })
    }
  })
})

test('an approved retry applies to the invocation it names, and to no other', async () => {
  // The permission is per invocation, and only the dispatch knows which one it
  // is running. Resolving it when the agent was loaded — before any dispatch
  // exists — would make an invocation-scoped approval either never match, or
  // match every attempt that agent makes.
  await withFakeCodexBinary(CODEX_SCHEMA_ECHO_HANDLER, async (binDir) => {
    const outputPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'dispatch-approved-invocation-'),
    )
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    setRuntimeDefaultModelState({
      status: 'available',
      provider: 'codex',
      model: 'gpt-5.6-terra',
    })
    setRuntimeApprovedModelChoice({
      offerId: 'offer-1',
      agentName: 'reviewer',
      logicalInvocationId: 'invocation-1',
      failedChoice: { provider: 'codex', model: 'gpt-5.6-pinned' },
      proposedDefault: { provider: 'codex', model: 'gpt-5.6-terra' },
    })
    try {
      const agent = {
        ...makeCodexAgent('reviewer', outputPath, 'Review it.'),
        model: 'gpt-5.6-pinned',
        selection: {
          provider: 'codex',
          model: 'gpt-5.6-pinned',
          source: 'agent' as const,
          reason: 'explicit-agent-choice' as const,
        },
      }
      const dispatch = (logicalInvocationId: string) =>
        dispatchToAgentOrTeam({
          agent,
          rosterEntry: { type: 'agent' },
          finalPrompt: 'Review it.',
          userMessage: 'Review it.',
          state: makeDispatchState('dispatch-approved-invocation-session'),
          workspacePath: outputPath,
          outputPath,
          metrics: undefined,
          logicalInvocationId,
        }).catch(() => undefined)

      await dispatch('invocation-1')
      await dispatch('invocation-2')

      // What the CLI was actually told. The record and the request have to
      // name the same model: history saying one thing while another runs is
      // the exact defect this rule exists to remove.
      const invoked = JSON.parse(
        fs.readFileSync(path.join(binDir, 'codex-invocations.json'), 'utf8'),
      ) as string[][]
      assert.equal(invoked.length, 2)
      assert.ok(
        invoked[0]?.includes('gpt-5.6-terra'),
        `approved attempt ran on ${invoked[0]?.join(' ')}`,
      )
      assert.ok(
        invoked[1]?.includes('gpt-5.6-pinned'),
        `unapproved attempt ran on ${invoked[1]?.join(' ')}`,
      )

      const starts = fs
        .readFileSync(path.join(outputPath, 'logs', 'agent-runs.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AgentRunEvent)
        .filter((event) => event.event === 'start')

      assert.equal(starts.length, 2)
      // The approved invocation runs on the pair the user approved.
      assert.equal(starts[0]?.model, 'gpt-5.6-terra')
      assert.equal(starts[0]?.model_selection?.reason, 'user-approved-retry')
      // A different invocation of the same agent runs on its own pair.
      assert.equal(starts[1]?.model, 'gpt-5.6-pinned')
      assert.equal(starts[1]?.model_selection?.source, 'agent')
    } finally {
      setRuntimeApprovedModelChoice(undefined)
      setRuntimeDefaultModelState(undefined)
      process.env.PATH = originalPath
      fs.rmSync(outputPath, { recursive: true, force: true })
    }
  })
})

test('an approval the resolver will not honour stops the attempt', async () => {
  // A default that moved after the approval. Falling back to the pair that
  // already failed would run a model the user declined to keep, under a
  // permission that no longer applies.
  await withFakeCodexBinary(CODEX_SCHEMA_ECHO_HANDLER, async (binDir) => {
    const outputPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'dispatch-stale-approval-'),
    )
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    setRuntimeDefaultModelState({
      status: 'available',
      provider: 'codex',
      model: 'gpt-5.6-moved',
    })
    setRuntimeApprovedModelChoice({
      offerId: 'offer-1',
      agentName: 'reviewer',
      logicalInvocationId: 'invocation-1',
      failedChoice: { provider: 'codex', model: 'gpt-5.6-pinned' },
      proposedDefault: { provider: 'codex', model: 'gpt-5.6-terra' },
    })
    try {
      await assert.rejects(
        dispatchToAgentOrTeam({
          agent: {
            ...makeCodexAgent('reviewer', outputPath, 'Review it.'),
            model: 'gpt-5.6-pinned',
            selection: {
              provider: 'codex',
              model: 'gpt-5.6-pinned',
              source: 'agent' as const,
              reason: 'explicit-agent-choice' as const,
            },
          },
          rosterEntry: { type: 'agent' },
          finalPrompt: 'Review it.',
          userMessage: 'Review it.',
          state: makeDispatchState('dispatch-stale-approval-session'),
          workspacePath: outputPath,
          outputPath,
          metrics: undefined,
          logicalInvocationId: 'invocation-1',
        }),
        /cannot run its approved retry/,
      )

      assert.equal(
        fs.existsSync(path.join(binDir, 'codex-invocations.json')),
        false,
        'nothing was dispatched',
      )
    } finally {
      setRuntimeApprovedModelChoice(undefined)
      setRuntimeDefaultModelState(undefined)
      process.env.PATH = originalPath
      fs.rmSync(outputPath, { recursive: true, force: true })
    }
  })
})

test('a dispatch whose agent has no recorded selection reports none', async () => {
  await withFakeCodexBinary(CODEX_SCHEMA_ECHO_HANDLER, async (binDir) => {
    const outputPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'dispatch-no-model-selection-'),
    )
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      await dispatchToAgentOrTeam({
        agent: makeCodexAgent('reviewer', outputPath, 'Review it.'),
        rosterEntry: { type: 'agent' },
        finalPrompt: 'Review it.',
        userMessage: 'Review it.',
        state: makeDispatchState('dispatch-no-model-selection-session'),
        workspacePath: outputPath,
        outputPath,
        metrics: undefined,
      })

      const start = fs
        .readFileSync(path.join(outputPath, 'logs', 'agent-runs.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AgentRunEvent)
        .find((event) => event.event === 'start')

      assert.ok(start)
      assert.equal(start.model_selection, undefined)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(outputPath, { recursive: true, force: true })
    }
  })
})

/**
 * The parent reads a delegated child's pause out of the child's own
 * `runtime-events.jsonl`. A durable workflow step that resumes reuses the same
 * child assignment directory (`workflows/runner.ts:2246` and `:2251`) and
 * `recoveryMode` clears only the temporary path (`agent-runner.ts:1594`), so
 * that log still holds the previous invocation's lines. These three cases pin
 * both halves of the guard that decides which of those lines belong to this
 * run.
 */
function fakeChildPausingAt(timestampExpression: string): string {
  return `
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const logsDir = path.join(cwd, 'logs')
fs.mkdirSync(logsDir, { recursive: true })
fs.appendFileSync(path.join(logsDir, 'runtime-events.jsonl'), JSON.stringify({
  timestamp: ${timestampExpression},
  event: 'run.awaiting_agent_input',
  session_id: 'child-session',
  level_id: 'ask',
  interruption: { kind: 'awaiting_input', interactionId: 'recorded-question' },
}) + '\\n')
const outputPath = path.join(cwd, process.env.TEAM_OUTPUT_ARTIFACT)
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, '# Child memo\\n\\nWork finished.\\n')
`
}

/** The expression is evaluated inside the child, so a "now" case is stamped
 * while this run is in flight rather than before it starts. */
async function runTeamWithPausingChild(timestampExpression: string) {
  return withFakePi(fakeChildPausingAt(timestampExpression), async (binDir) => {
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-team-question-timestamp-'))
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      return await runTeam({
        teamPath: teamDir,
        workspacePath: path.join(teamDir, 'child-workspace'),
        brief: 'Answer the brief.',
        outputArtifact: 'memo.md',
        spawnDepth: 0,
      })
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(teamDir, { recursive: true, force: true })
    }
  })
}

test('runTeam ignores a child question pause whose timestamp cannot be parsed', async () => {
  const result = await runTeamWithPausingChild("'not-a-timestamp'")

  assert.equal(result.interruption, undefined)
  assert.equal(result.status, 'completed')
})

test('runTeam holds a child question pause that this run recorded', async () => {
  const result = await runTeamWithPausingChild('new Date().toISOString()')

  assert.deepEqual(result.interruption, { kind: 'awaiting_input', interactionId: 'recorded-question' })
  assert.equal(result.status, undefined)
})

test('runTeam ignores a child question pause an earlier invocation left behind', async () => {
  const result = await runTeamWithPausingChild("'1999-01-01T00:00:00.000Z'")

  assert.equal(result.interruption, undefined)
  assert.equal(result.status, 'completed')
})
