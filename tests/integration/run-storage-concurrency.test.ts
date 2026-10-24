import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { readCheckpoint } from '../../domains/runtime/checkpoint.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-storage-concurrency-'))
}

async function runCheckpointWriter(params: {
  checkpointModuleUrl: string
  assignmentPath: string
  assignmentId: string
  marker: number
}): Promise<void> {
  const script = `
    const { writeCheckpoint } = await import(process.env.CHECKPOINT_MODULE_URL);
    const assignmentPath = process.env.ASSIGNMENT_PATH;
    const assignmentId = process.env.ASSIGNMENT_ID;
    const marker = Number(process.env.CHECKPOINT_MARKER);
    for (let index = 0; index < 75; index += 1) {
      writeCheckpoint(assignmentPath, {
        sessionId: assignmentId,
        currentLevelIndex: index,
        totalCost: marker + index,
        startTime: marker,
        levelStates: new Map(),
        timerStarted: true,
        endTime: null,
        spawnDepth: 0,
      });
    }
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CHECKPOINT_MODULE_URL: params.checkpointModuleUrl,
      ASSIGNMENT_PATH: params.assignmentPath,
      ASSIGNMENT_ID: params.assignmentId,
      CHECKPOINT_MARKER: String(params.marker),
    },
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const [exitCode, signal] = (await once(child, 'exit')) as [
    number | null,
    NodeJS.Signals | null,
  ]
  assert.equal(signal, null)
  assert.equal(exitCode, 0, stderr)
}

test('real parallel processes keep assignment checkpoints isolated and atomic', async () => {
  const workspacePath = makeWorkspace()
  const first = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'parallel-session',
    runId: 'parallel-run-a',
    assignmentId: 'parallel-assignment-a',
  })
  const second = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'parallel-session',
    runId: 'parallel-run-b',
    assignmentId: 'parallel-assignment-b',
  })
  assert.ok(first)
  assert.ok(second)
  fs.mkdirSync(first.assignmentPath, { recursive: true })
  fs.mkdirSync(second.assignmentPath, { recursive: true })

  try {
    const checkpointModuleUrl = new URL(
      '../../domains/runtime/checkpoint.js',
      import.meta.url,
    ).href
    await Promise.all([
      runCheckpointWriter({
        checkpointModuleUrl,
        assignmentPath: first.assignmentPath,
        assignmentId: first.assignmentId,
        marker: 1_000,
      }),
      runCheckpointWriter({
        checkpointModuleUrl,
        assignmentPath: second.assignmentPath,
        assignmentId: second.assignmentId,
        marker: 2_000,
      }),
    ])

    const firstCheckpoint = readCheckpoint(first.assignmentPath)
    const secondCheckpoint = readCheckpoint(second.assignmentPath)
    assert.equal(firstCheckpoint?.sessionId, first.assignmentId)
    assert.equal(firstCheckpoint?.currentLevelIndex, 74)
    assert.equal(firstCheckpoint?.totalCost, 1_074)
    assert.equal(secondCheckpoint?.sessionId, second.assignmentId)
    assert.equal(secondCheckpoint?.currentLevelIndex, 74)
    assert.equal(secondCheckpoint?.totalCost, 2_074)
    assert.equal(fs.existsSync(path.join(workspacePath, 'checkpoint.json')), false)

    for (const assignmentPath of [
      first.assignmentPath,
      second.assignmentPath,
    ]) {
      assert.deepEqual(
        fs.readdirSync(assignmentPath).filter((entry) => entry.endsWith('.tmp')),
        [],
      )
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
