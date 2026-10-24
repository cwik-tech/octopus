import assert from 'node:assert/strict'
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  TASK_QUEUE_CONTROL_DIRECTORY,
  TASK_QUEUE_OWNER_FILENAME,
} from '../../core/workspace-dispatcher-owner.js'

interface ApiFixtureMessage {
  type: 'ready' | 'error'
  pid: number
  url?: string
  name?: string
  code?: string
  message?: string
}

interface ApiFixtureProcess {
  child: ChildProcessWithoutNullStreams
  stderr: string[]
}

interface WorkspaceOwnerRecord {
  pid: number
  epoch: string
}

test(
  'startApiServer rejects a second live process and reclaims ownership after SIGKILL',
  { timeout: 30_000 },
  async () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'api-server-process-owner-'),
    )
    const fixtures: ApiFixtureProcess[] = []

    try {
      const first = spawnApiFixture(workspacePath)
      fixtures.push(first)
      const firstMessage = await readFixtureMessage(first)
      assert.equal(firstMessage.type, 'ready')
      assert.equal(firstMessage.pid, first.child.pid)
      assert.ok(firstMessage.url)
      await assertHealthy(firstMessage.url)

      const firstOwner = readOwnerRecord(workspacePath)
      assert.equal(firstOwner.pid, first.child.pid)

      const second = spawnApiFixture(workspacePath)
      fixtures.push(second)
      const secondMessage = await readFixtureMessage(second)
      assert.deepEqual(
        {
          type: secondMessage.type,
          code: secondMessage.code,
          name: secondMessage.name,
        },
        {
          type: 'error',
          code: 'workspace_in_use',
          name: 'WorkspaceDispatcherOwnerError',
        },
      )
      const secondExit = await waitForExit(second)
      assert.equal(secondExit.code, 2, second.stderr.join(''))
      assert.equal(secondExit.signal, null)
      assert.deepEqual(readOwnerRecord(workspacePath), firstOwner)
      await assertHealthy(firstMessage.url)

      assert.equal(first.child.kill('SIGKILL'), true)
      const firstExit = await waitForExit(first)
      assert.equal(firstExit.code, null)
      assert.equal(firstExit.signal, 'SIGKILL')

      const third = spawnApiFixture(workspacePath)
      fixtures.push(third)
      const thirdMessage = await readFixtureMessage(third)
      assert.equal(thirdMessage.type, 'ready')
      assert.equal(thirdMessage.pid, third.child.pid)
      assert.ok(thirdMessage.url)
      await assertHealthy(thirdMessage.url)

      const thirdOwner = readOwnerRecord(workspacePath)
      assert.equal(thirdOwner.pid, third.child.pid)
      assert.notEqual(thirdOwner.epoch, firstOwner.epoch)

      third.child.stdin.end('close\n')
      const thirdExit = await waitForExit(third)
      assert.equal(thirdExit.code, 0, third.stderr.join(''))
      assert.equal(thirdExit.signal, null)
      assert.equal(fs.existsSync(ownerPath(workspacePath)), false)
    } finally {
      for (const fixture of fixtures) {
        if (
          fixture.child.exitCode === null &&
          fixture.child.signalCode === null
        ) {
          fixture.child.kill('SIGKILL')
        }
      }
      await Promise.all(
        fixtures.map((fixture) =>
          waitForExit(fixture, 5_000).catch(() => undefined),
        ),
      )
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  },
)

function spawnApiFixture(workspacePath: string): ApiFixtureProcess {
  const fixturePath = path.resolve(
    process.cwd(),
    'tests',
    'fixtures',
    'start-api-server-owner-child.ts',
  )
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fixturePath, workspacePath],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))
  return { child, stderr }
}

function readFixtureMessage(
  fixture: ApiFixtureProcess,
  timeoutMs = 10_000,
): Promise<ApiFixtureMessage> {
  const { child, stderr } = fixture
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timeout = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `Timed out waiting for API fixture ${child.pid}: ${stderr.join('')}`,
        ),
      )
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('exit', onEarlyExit)
    }
    const onData = (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      cleanup()
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as ApiFixtureMessage)
      } catch (error) {
        reject(error)
      }
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(
        new Error(
          `API fixture exited before reporting status (${code ?? signal}): ${stderr.join('')}`,
        ),
      )
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('exit', onEarlyExit)
  })
}

async function assertHealthy(url: string): Promise<void> {
  const response = await fetch(`${url}/health`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
}

function ownerPath(workspacePath: string): string {
  return path.join(
    workspacePath,
    TASK_QUEUE_CONTROL_DIRECTORY,
    TASK_QUEUE_OWNER_FILENAME,
  )
}

function readOwnerRecord(workspacePath: string): WorkspaceOwnerRecord {
  const parsed = JSON.parse(
    fs.readFileSync(ownerPath(workspacePath), 'utf8'),
  ) as Partial<WorkspaceOwnerRecord>
  assert.equal(typeof parsed.pid, 'number')
  assert.equal(typeof parsed.epoch, 'string')
  return parsed as WorkspaceOwnerRecord
}

function waitForExit(
  fixture: ApiFixtureProcess,
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const { child, stderr } = fixture
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    })
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `Timed out waiting for API fixture ${child.pid} to exit: ${stderr.join('')}`,
        ),
      )
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      resolve({ code, signal })
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    child.once('exit', onExit)
    child.once('error', onError)
  })
}
