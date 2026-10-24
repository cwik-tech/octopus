import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

import { parsePlan } from '../../parsers/plan-parser.js'
import { writeCheckpoint } from '../../domains/runtime/checkpoint.js'
import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import {
  getRunRuntimePaths,
  resolveAssignmentPath,
} from '../../domains/runtime/runtime-paths.js'

interface ReplacementProcessResult {
  pid: number
  recoveryMode: string
  checkpointSessionId: string
  checkpointRootSessionId: string
  checkpointPlanPath: string
  checkpointActiveTaskIds: string[]
  completedStatusBeforeRecovery: string
  completedStatusAfterRecovery: string
  interruptedStatusBeforeRecovery: string
  interruptedStatusAfterRecovery: string
  stageStatus: string
  staleResultExistedBeforeRecovery: boolean
  staleResultExistsAfterRecovery: boolean
  recoveredText: string
  terminalProbeText: string
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      resolve(address.port)
    })
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

function runReplacementProcess(params: {
  assignmentPath: string
  outputPath: string
  providerUrl: string
}): Promise<{ pid: number; stdout: string; stderr: string }> {
  const entryPath = path.join(
    process.cwd(),
    '.tests-dist',
    'tests',
    'support',
    'pipeline-recovery-worker.js',
  )
  assert.ok(fs.existsSync(entryPath), `Missing compiled process fixture: ${entryPath}`)

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENAI_API_KEY: 'offline-recovery-test-key',
        TEAM_RUNTIME_RECOVERY: '1',
        PIPELINE_RECOVERY_ASSIGNMENT_PATH: params.assignmentPath,
        PIPELINE_RECOVERY_OUTPUT_PATH: params.outputPath,
        PIPELINE_RECOVERY_PROVIDER_URL: params.providerUrl,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(
          `Replacement process exited ${String(code)} (${String(signal)}).\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`,
        ))
        return
      }
      resolve({ pid: child.pid!, stdout, stderr })
    })
  })
}

test('a replacement process preserves completed pipeline work and recovers only the interrupted task', {
  timeout: 20_000,
}, async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-process-recovery-'))
  const childRunId = 'pipeline-child-run'
  const rootRunId = 'pipeline-root-run'
  const assignmentPath = resolveAssignmentPath(workspacePath, childRunId)
  const runtimePaths = getRunRuntimePaths(assignmentPath)
  const planPath = path.join(
    runtimePaths.privateRuntimePath,
    'pipeline',
    'execution',
    'plan.md',
  )
  const replacementOutputPath = path.join(workspacePath, 'replacement-result.json')
  fs.mkdirSync(path.dirname(planPath), { recursive: true })
  fs.writeFileSync(planPath, `
# Plan: Interrupted pipeline process
**Status:** executing

### S1: Recovery sprint

#### T1: Already committed internal task
- **Agent:** writer
- **Status:** completed
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** committed.md

#### T2: Resume one internal task
- **Agent:** writer
- **Status:** in_progress
- **Validate:** false
- **Depends on:** T1
- **Gate:** false
- **Result file:** result.md
`)
  fs.writeFileSync(path.join(assignmentPath, 'committed.md'), 'committed predecessor output')
  fs.writeFileSync(path.join(assignmentPath, 'result.md'), 'partial predecessor output')
  writeCheckpoint(assignmentPath, {
    sessionId: childRunId,
    currentLevelIndex: 0,
    levelStates: new Map([
      ['execution', {
        status: 'active',
        stageStatus: STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER,
        loopbackCount: 0,
        engineState: {
          type: 'pipeline',
          planPath,
          completedSprintIds: [],
          activeTaskIds: ['T2'],
        },
      }],
    ]),
    totalCost: 0,
    startTime: Date.now(),
    timerStarted: true,
    endTime: null,
    spawnDepth: 1,
    rootSessionId: rootRunId,
    parentSessionId: 'pipeline-parent-session',
  })

  let providerRequests = 0
  const requestBodies: unknown[] = []
  const provider = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      providerRequests += 1
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        model: 'deterministic-recovery-model',
        output_text: 'Recovered provider execution reached terminal output.',
        usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
      }))
    })
  })

  try {
    const port = await listen(provider)
    const replacement = await runReplacementProcess({
      assignmentPath,
      outputPath: replacementOutputPath,
      providerUrl: `http://127.0.0.1:${port}/v1/responses`,
    })
    const result = JSON.parse(
      fs.readFileSync(replacementOutputPath, 'utf8'),
    ) as ReplacementProcessResult

    assert.notEqual(replacement.pid, process.pid)
    assert.equal(result.pid, replacement.pid)
    assert.equal(result.recoveryMode, '1')
    assert.equal(result.checkpointSessionId, childRunId)
    assert.equal(result.checkpointRootSessionId, rootRunId)
    assert.equal(result.checkpointPlanPath, planPath)
    assert.deepEqual(result.checkpointActiveTaskIds, ['T2'])
    assert.equal(result.completedStatusBeforeRecovery, 'completed')
    assert.equal(result.completedStatusAfterRecovery, 'completed')
    assert.equal(result.interruptedStatusBeforeRecovery, 'in_progress')
    assert.equal(result.interruptedStatusAfterRecovery, 'completed')
    assert.equal(result.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    assert.equal(result.staleResultExistedBeforeRecovery, true)
    assert.equal(result.staleResultExistsAfterRecovery, false)
    assert.match(result.recoveredText, /Recovered provider execution reached terminal output/)
    assert.match(result.recoveredText, /Pipeline complete:.*all tasks are terminal/s)
    assert.equal(result.terminalProbeText, 'All tasks complete. Pipeline finished.')
    assert.equal(providerRequests, 1, 'the interrupted internal task must resume exactly once')
    assert.equal(requestBodies.length, 1)
    assert.doesNotMatch(JSON.stringify(requestBodies[0]), /Task Assignment: T1/)
    assert.match(JSON.stringify(requestBodies[0]), /Task Assignment: T2/)
    assert.equal(parsePlan(planPath)?.tasks.get('T1')?.status, 'completed')
    assert.equal(parsePlan(planPath)?.tasks.get('T2')?.status, 'completed')
    assert.equal(
      fs.readFileSync(path.join(assignmentPath, 'committed.md'), 'utf8'),
      'committed predecessor output',
    )
    assert.equal(
      fs.existsSync(path.join(workspacePath, '.pi-tasks', 'plan.md')),
      false,
      'recovery must use the persisted run-local plan',
    )
  } finally {
    if (provider.listening) await close(provider)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
