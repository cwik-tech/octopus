import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'

import {
  TASK_QUEUE_CONTROL_DIRECTORY,
  TASK_QUEUE_OWNER_FILENAME,
  WorkspaceDispatcherOwner,
  WorkspaceDispatcherOwnerError,
  parseWorkspaceOwnerRecord,
} from '../../core/workspace-dispatcher-owner.js'
import { TASK_QUEUE_EVENT_FILENAME } from '../../core/task-queue-events.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-dispatcher-owner-'))
}

test('workspace dispatcher owner is exclusive and releases only its epoch', async () => {
  const workspacePath = makeWorkspace()
  try {
    const owner = await WorkspaceDispatcherOwner.acquire({
      workspacePath,
      instanceId: 'first-api',
    })
    const ownerPath = path.join(
      workspacePath,
      TASK_QUEUE_CONTROL_DIRECTORY,
      TASK_QUEUE_OWNER_FILENAME,
    )
    const persisted = parseWorkspaceOwnerRecord(
      JSON.parse(fs.readFileSync(ownerPath, 'utf8')),
    )
    assert.equal(persisted?.instanceId, 'first-api')
    assert.equal(persisted?.epoch, owner.epoch)
    assert.equal(fs.statSync(path.dirname(ownerPath)).mode & 0o777, 0o700)
    assert.equal(fs.statSync(ownerPath).mode & 0o777, 0o600)

    await assert.rejects(
      WorkspaceDispatcherOwner.acquire({ workspacePath }),
      (error: unknown) =>
        error instanceof WorkspaceDispatcherOwnerError &&
        error.code === 'workspace_in_use',
    )

    await owner.assertCurrent()
    await owner.release()
    assert.equal(fs.existsSync(ownerPath), false)
    const events = fs.readFileSync(
      path.join(path.dirname(ownerPath), TASK_QUEUE_EVENT_FILENAME),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line) as { event: string })
    assert.ok(events.some((event) => event.event === 'task_queue.owner_acquired'))
    assert.ok(events.some((event) => event.event === 'task_queue.owner_conflict'))
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('workspace dispatcher owner reclaims a proven-dead process record', async () => {
  const workspacePath = makeWorkspace()
  const ownerPath = path.join(
    workspacePath,
    TASK_QUEUE_CONTROL_DIRECTORY,
    TASK_QUEUE_OWNER_FILENAME,
  )
  try {
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true })
    fs.writeFileSync(ownerPath, `${JSON.stringify({
      version: 1,
      pid: 2_000_000_000,
      instanceId: 'dead-api',
      epoch: 'dead-epoch',
      acquiredAt: '2026-07-14T00:00:00.000Z',
    })}\n`, { mode: 0o600 })

    const owner = await WorkspaceDispatcherOwner.acquire({
      workspacePath,
      instanceId: 'replacement-api',
      isProcessAlive: () => false,
    })
    assert.equal(owner.record.instanceId, 'replacement-api')
    assert.notEqual(owner.epoch, 'dead-epoch')
    const events = fs.readFileSync(
      path.join(path.dirname(ownerPath), TASK_QUEUE_EVENT_FILENAME),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line) as { event: string })
    assert.ok(events.some((event) => event.event === 'task_queue.owner_reclaimed'))
    await owner.release()
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('workspace dispatcher owner fails closed on a corrupt record', async () => {
  const workspacePath = makeWorkspace()
  try {
    const ownerPath = path.join(
      workspacePath,
      TASK_QUEUE_CONTROL_DIRECTORY,
      TASK_QUEUE_OWNER_FILENAME,
    )
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true })
    fs.writeFileSync(ownerPath, '{"version":1,"pid":"bad"}\n')

    await assert.rejects(
      WorkspaceDispatcherOwner.acquire({ workspacePath }),
      (error: unknown) =>
        error instanceof WorkspaceDispatcherOwnerError &&
        error.code === 'owner_corrupt',
    )
    assert.equal(fs.existsSync(ownerPath), true)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('workspace dispatcher ownership rejects a real live process and reclaims it after death', async () => {
  const workspacePath = makeWorkspace()
  const fixturePath = path.resolve(
    process.cwd(),
    'tests',
    'fixtures',
    'workspace-owner-child.ts',
  )
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fixturePath, workspacePath],
    {
    stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  try {
    const firstLine = await readFirstLine(child.stdout!)
    const record = parseWorkspaceOwnerRecord(JSON.parse(firstLine))
    assert.equal(record?.pid, child.pid)

    await assert.rejects(
      WorkspaceDispatcherOwner.acquire({ workspacePath }),
      (error: unknown) =>
        error instanceof WorkspaceDispatcherOwnerError &&
        error.code === 'workspace_in_use',
    )

    child.kill('SIGKILL')
    await new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve())
      child.once('error', reject)
    })
    const replacement = await WorkspaceDispatcherOwner.acquire({ workspacePath })
    assert.notEqual(replacement.epoch, record?.epoch)
    await replacement.release()
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

function readFirstLine(
  stream: NodeJS.ReadableStream,
  timeoutMs = 5_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for owner child')),
      timeoutMs,
    )
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timeout)
      resolve(buffer.slice(0, newline))
    })
  })
}
