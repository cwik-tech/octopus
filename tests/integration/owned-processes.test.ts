import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test, type TestContext } from 'node:test'

import { processesWorkingUnder, stopProcessCarrying, stopProcessesWorkingUnder } from '../support/owned-processes.js'

// These processes stand in for what a desktop journey leaves behind: a Pi
// child that renamed itself, working in a folder the journey created. Each
// leads its own process group, as a Team child does, so a signal aimed at the
// wrong process or group would end one it should not.

/** Bound for a child to say it is ready, or to exit once it has been ended. */
const CHILD_BOUND_MS = 10_000

interface RenamedProcess {
  readonly child: ChildProcess
  /** Resolves when the process has exited, however it ended. */
  readonly exited: Promise<unknown>
}

interface StartOptions {
  readonly extraArgs?: readonly string[]
  readonly keepTitle?: boolean
}

interface Scene {
  /** The folder a journey would own. */
  readonly root: string
  /** A folder inside it, as an assignment folder is. */
  readonly inside: string
  /** A folder beside it, which it does not own. */
  readonly sibling: string
  /**
   * Starts a process in `cwd` and returns once it says it is ready. It renames
   * itself `pi` unless `keepTitle` is set, which keeps its command line, and
   * with it `extraArgs`, visible to `ps`.
   */
  start(cwd: string, options?: StartOptions): Promise<RenamedProcess>
}

/**
 * The folders and processes of one test, with one cleanup that owns them.
 *
 * The cleanup ends every process the test started and waits for each to exit
 * before it removes the folders. If one does not exit in time, the folders are
 * kept and the cleanup fails, naming it.
 */
async function scene(t: TestContext): Promise<Scene> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-processes-'))
  const root = path.join(base, 'journey')
  const inside = path.join(root, 'workspace', 'assignment')
  const sibling = path.join(base, 'sibling')
  for (const directory of [inside, sibling]) fs.mkdirSync(directory, { recursive: true })
  const started: RenamedProcess[] = []

  t.after(async () => {
    for (const { child } of started) {
      if (stillRunning(child)) child.kill('SIGKILL')
    }
    const results = await Promise.allSettled(
      started.map(({ child, exited }) => withinBound(exited, `process ${String(child.pid)} to exit`)),
    )
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) {
      throw new AggregateError(failures, `Processes this test started did not exit; ${base} is kept`)
    }
    fs.rmSync(base, { recursive: true, force: true })
  })

  return {
    root,
    inside,
    sibling,
    async start(cwd, options = {}) {
      const rename = options.keepTitle ? '' : "process.title = 'pi'; "
      const child = spawn(
        process.execPath,
        // `--` ends Node's own options, as the task launcher does, so the
        // extra arguments reach the script instead of being read as flags.
        [
          '-e',
          `${rename}process.stdin.on('data', (line) => process.stdout.write(line)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`,
          '--',
          ...(options.extraArgs ?? []),
        ],
        { cwd, detached: true, stdio: ['pipe', 'pipe', 'ignore'] },
      )
      // A write to a process that has been killed fails; that is not a test error.
      child.stdin.on('error', () => undefined)
      const renamed = { child, exited: once(child, 'exit') }
      started.push(renamed)
      const stdout = child.stdout
      assert.ok(stdout)
      // A child that exits before it is ready fails the start at once,
      // rather than leaving the wait with nothing to finish it.
      const [chunk]: unknown[] = await Promise.race([
        once(stdout, 'data', {
          signal: AbortSignal.any([t.signal, AbortSignal.timeout(CHILD_BOUND_MS)]),
        }),
        renamed.exited.then(() => {
          throw new Error(`process ${String(child.pid)} exited before it was ready`)
        }),
      ])
      assert.equal(String(chunk).trim(), 'ready')
      return renamed
    },
  }
}

/** Waits for `promise`, failing after the child bound with `description`. */
async function withinBound<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), CHILD_BOUND_MS)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}

function commandOf(pid: number): string {
  return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
}

/** Whether a process at `pid` still has `marker` on its command line. */
function stillCarries(pid: number, marker: string): boolean {
  try {
    return commandOf(pid).includes(marker)
  } catch (error) {
    // `ps` exits 1 with nothing to say when no process has this pid.
    if (error instanceof Error && 'status' in error && error.status === 1) return false
    throw error
  }
}

function requirePid(child: ChildProcess): number {
  assert.ok(child.pid !== undefined)
  return child.pid
}

function stillRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

/**
 * Whether the process still answers: it echoes a line written to it. A
 * process that was killed cannot, and its exit settles this as false, so a
 * signal that has not yet been reported as an exit still counts.
 */
async function stillAnswers({ child, exited }: RenamedProcess): Promise<boolean> {
  const { stdin, stdout } = child
  assert.ok(stdin && stdout)
  const reply = once(stdout, 'data', { signal: AbortSignal.timeout(CHILD_BOUND_MS) })
    .then(([chunk]: unknown[]) => String(chunk).includes('ping'))
  stdin.write('ping\n')
  return Promise.race([reply, exited.then(() => false)])
}

test('processes working at a test folder or inside it are found by working directory, even when they call themselves pi', async (t) => {
  const { root, inside, sibling, start } = await scene(t)
  const atRoot = await start(root)
  const within = await start(inside)
  const outside = await start(sibling)
  // Their titles no longer say what they are.
  assert.equal(commandOf(requirePid(atRoot.child)), 'pi')

  const found = processesWorkingUnder(root).map((entry) => entry.pid).sort((a, b) => a - b)

  assert.deepEqual(found, [requirePid(atRoot.child), requirePid(within.child)].sort((a, b) => a - b))
  assert.ok(!found.includes(requirePid(outside.child)))
})

test('stopping the processes working under a test folder ends those at its root and inside it, and leaves a sibling folder running', async (t) => {
  const { root, inside, sibling, start } = await scene(t)
  const atRoot = await start(root)
  const within = await start(inside)
  const outside = await start(sibling)

  await stopProcessesWorkingUnder(root)

  // Nothing is left working in the folder, and both processes that were
  // there have exited; the one next to it has not.
  assert.deepEqual(processesWorkingUnder(root), [])
  await withinBound(Promise.all([atRoot.exited, within.exited]), 'the stopped processes to exit')
  assert.equal(await stillAnswers(outside), true, 'the process in the sibling folder was stopped')
})

test('a process is stopped only while its command line carries the marker it was started with', async (t) => {
  const { sibling, start } = await scene(t)
  const marker = '--runtime-process-identity=owned-attempt'
  const marked = await start(sibling, { keepTitle: true, extraArgs: [marker] })
  const pid = requirePid(marked.child)
  assert.ok(commandOf(pid).includes(marker))

  await stopProcessCarrying(pid, marker)

  // Once it returns, no process at that pid carries the marker any more.
  assert.equal(stillCarries(pid, marker), false, `process ${pid} still carries its marker`)
  await withinBound(marked.exited, 'the marked process to exit')
})

test('a process whose command line carries another marker is left running', async (t) => {
  const { sibling, start } = await scene(t)
  const other = await start(sibling, { keepTitle: true, extraArgs: ['--runtime-process-identity=another-attempt'] })

  await stopProcessCarrying(requirePid(other.child), '--runtime-process-identity=owned-attempt')

  assert.equal(await stillAnswers(other), true, 'a process carrying another marker was stopped')
})
