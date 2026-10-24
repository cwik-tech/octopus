import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FolderParseQueue,
  waitAtMost,
  type FolderParseJob,
} from '../../domains/shared-folders/folder-parse-queue.js'

/**
 * The parse queue of attached folders (docs/feature-local-folder-access.md,
 * "Scheduling and publishing"; LF-15 for the queue itself).
 *
 * Jobs here are plain functions held open by deferred promises, so each test
 * decides exactly when a parse finishes. The queue starts a job inside the
 * call that frees its slot, which lets every check read what has started
 * without waiting on time.
 */

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/** Jobs that record when they start and finish only when the test says so. */
class GatedJobs {
  readonly started: string[] = []
  private readonly gates = new Map<string, Deferred<string>>()
  private readonly signals = new Map<string, AbortSignal>()

  /** `run` names one run in `started` and in the controls below; it defaults to the key. */
  job(folderKey: string, key: string, run = key): FolderParseJob<string> {
    return {
      folderKey,
      key,
      run: (signal) => {
        this.started.push(run)
        this.signals.set(run, signal)
        const gate = deferred<string>()
        this.gates.set(run, gate)
        return gate.promise
      },
    }
  }

  finish(run: string): void {
    const gate = this.gates.get(run)
    if (!gate) throw new Error(`${run} has not started`)
    gate.resolve(`parsed ${run}`)
  }

  fail(run: string, error: Error): void {
    const gate = this.gates.get(run)
    if (!gate) throw new Error(`${run} has not started`)
    gate.reject(error)
  }

  signal(run: string): AbortSignal {
    const signal = this.signals.get(run)
    if (!signal) throw new Error(`${run} has not started`)
    return signal
  }
}

test('a job asked for twice runs once, and both callers get its result', async () => {
  const queue = new FolderParseQueue<string>()
  const jobs = new GatedJobs()

  const background = queue.submit(jobs.job('folder-a', 'report.pdf@1'))
  const onDemand = queue.submit(jobs.job('folder-a', 'report.pdf@1'), { urgent: true })
  assert.deepEqual(jobs.started, ['report.pdf@1'])
  jobs.finish('report.pdf@1')

  assert.deepEqual(await Promise.all([background, onDemand]), ['parsed report.pdf@1', 'parsed report.pdf@1'])
})

test('at most two jobs run at once across every folder, and the next starts when one settles', async () => {
  const queue = new FolderParseQueue<string>()
  const jobs = new GatedJobs()

  const first = queue.submit(jobs.job('folder-a', 'a1'))
  void queue.submit(jobs.job('folder-b', 'b1'))
  void queue.submit(jobs.job('folder-c', 'c1'))
  assert.deepEqual(jobs.started, ['a1', 'b1'], 'The third job waits for a free slot')

  jobs.finish('a1')
  await first
  assert.deepEqual(jobs.started, ['a1', 'b1', 'c1'])
})

test('a job that fails frees its slot, and only its own callers see the failure', async () => {
  const queue = new FolderParseQueue<string>()
  const jobs = new GatedJobs()

  const failing = queue.submit(jobs.job('folder-a', 'a1'))
  void queue.submit(jobs.job('folder-a', 'a2'))
  const waiting = queue.submit(jobs.job('folder-a', 'a3'))
  jobs.fail('a1', new Error('File parser timed out after 300000ms'))

  await assert.rejects(failing, /timed out/)
  assert.deepEqual(jobs.started, ['a1', 'a2', 'a3'])
  jobs.finish('a3')
  assert.equal(await waiting, 'parsed a3')
})

test('a job asked for on demand runs before the jobs queued ahead of it in its folder', async () => {
  const queue = new FolderParseQueue<string>()
  const jobs = new GatedJobs()

  const first = queue.submit(jobs.job('folder-a', 'a1'))
  void queue.submit(jobs.job('folder-a', 'a2'))
  void queue.submit(jobs.job('folder-a', 'a3'))
  void queue.submit(jobs.job('folder-a', 'a4'))
  void queue.submit(jobs.job('folder-a', 'a4'), { urgent: true })

  jobs.finish('a1')
  await first
  assert.deepEqual(jobs.started, ['a1', 'a2', 'a4'])
})

test('a folder with a long queue takes turns with a folder that queued later', async () => {
  const queue = new FolderParseQueue<string>()
  const jobs = new GatedJobs()

  const first = queue.submit(jobs.job('folder-a', 'a1'))
  void queue.submit(jobs.job('folder-a', 'a2'))
  void queue.submit(jobs.job('folder-a', 'a3'))
  void queue.submit(jobs.job('folder-a', 'a4'))
  void queue.submit(jobs.job('folder-b', 'b1'))

  jobs.finish('a1')
  await first
  assert.deepEqual(jobs.started, ['a1', 'a2', 'b1'])
})

test('cancelling a folder drops its queued jobs, aborts its running one, and leaves other folders running', async () => {
  const queue = new FolderParseQueue<string>()
  const jobs = new GatedJobs()

  const running = queue.submit(jobs.job('folder-a', 'a1'))
  void queue.submit(jobs.job('folder-b', 'b1'))
  const queued = queue.submit(jobs.job('folder-a', 'a2'))
  const other = queue.submit(jobs.job('folder-b', 'b2'))

  const cancelled = queue.cancelFolder('folder-a')
  await assert.rejects(queued, { name: 'AbortError' })
  assert.equal(jobs.signal('a1').aborted, true, 'The running job is told to stop')
  assert.equal(jobs.signal('b1').aborted, false)

  jobs.fail('a1', new DOMException('File parser was aborted', 'AbortError'))
  await cancelled
  await assert.rejects(running, { name: 'AbortError' })
  assert.deepEqual(jobs.started, ['a1', 'b1', 'b2'], 'The freed slot goes to the other folder; a2 never runs')
  jobs.finish('b2')
  assert.equal(await other, 'parsed b2')
})

test('cancelling a folder resolves only once its running job has settled', async () => {
  const queue = new FolderParseQueue<string>()
  const jobs = new GatedJobs()
  const order: string[] = []

  void queue.submit(jobs.job('folder-a', 'a1')).then(
    () => order.push('job settled'),
    () => order.push('job settled'),
  )
  const cancelled = queue.cancelFolder('folder-a').then(() => order.push('cancel resolved'))
  jobs.finish('a1')
  await cancelled

  assert.deepEqual(order, ['job settled', 'cancel resolved'])
})

test('a key cancelled while its job still runs can be asked for again and runs anew', async () => {
  const queue = new FolderParseQueue<string>()
  const jobs = new GatedJobs()

  void queue.submit(jobs.job('folder-a', 'a1', 'first run'))
  const cancelled = queue.cancelFolder('folder-a')
  const again = queue.submit(jobs.job('folder-a', 'a1', 'second run'))
  assert.deepEqual(jobs.started, ['first run', 'second run'], 'The second ask does not join the cancelled job')

  jobs.fail('first run', new DOMException('File parser was aborted', 'AbortError'))
  await cancelled
  jobs.finish('second run')
  assert.equal(await again, 'parsed second run')
})

test('a wait that reaches its limit answers that it waited out, and the job keeps running', async () => {
  const queue = new FolderParseQueue<string>()
  const jobs = new GatedJobs()
  const limitReached = deferred<undefined>()
  const requested: number[] = []

  const job = queue.submit(jobs.job('folder-a', 'a1'))
  const waited = waitAtMost(job, 60_000, {
    limit: (ms) => {
      requested.push(ms)
      return limitReached.promise
    },
  })
  limitReached.resolve(undefined)

  assert.deepEqual(await waited, { kind: 'waited_out' })
  assert.deepEqual(requested, [60_000])
  assert.equal(jobs.signal('a1').aborted, false, 'Waiting out does not stop the parse')
  jobs.finish('a1')
  assert.equal(await job, 'parsed a1')
})

test('a wait gets the result when the job settles first, and its timer is released', async () => {
  const queue = new FolderParseQueue<string>()
  const jobs = new GatedJobs()
  let timerSignal: AbortSignal | undefined

  const job = queue.submit(jobs.job('folder-a', 'a1'))
  const waited = waitAtMost(job, 60_000, {
    limit: (_ms, signal) => {
      timerSignal = signal
      return new Promise<void>(() => undefined)
    },
  })
  jobs.finish('a1')

  assert.deepEqual(await waited, { kind: 'settled', value: 'parsed a1' })
  assert.equal(timerSignal?.aborted, true)
})

test('a wait whose caller is cancelled answers cancelled without stopping the job', async () => {
  const queue = new FolderParseQueue<string>()
  const jobs = new GatedJobs()
  const caller = new AbortController()

  const job = queue.submit(jobs.job('folder-a', 'a1'))
  const waited = waitAtMost(job, 60_000, {
    signal: caller.signal,
    limit: () => new Promise<void>(() => undefined),
  })
  caller.abort()

  assert.deepEqual(await waited, { kind: 'cancelled' })
  assert.equal(jobs.signal('a1').aborted, false)
})

test('the queue reports idle only once every job has settled, a cancelled one still running included', async () => {
  const queue = new FolderParseQueue<string>()
  const jobs = new GatedJobs()
  const order: string[] = []

  const first = queue.submit(jobs.job('folder-a', 'a1')).catch(() => order.push('a1 settled'))
  const second = queue.submit(jobs.job('folder-a', 'a2'))
  const third = queue.submit(jobs.job('folder-b', 'b1')).then(() => order.push('b1 settled'))
  queue.cancel('a1')
  const idle = queue.whenIdle().then(() => order.push('idle'))

  jobs.finish('a2')
  await second
  jobs.finish('b1')
  await third
  jobs.fail('a1', new DOMException('File parser was aborted', 'AbortError'))
  await Promise.all([first, idle])

  assert.deepEqual(order, ['b1 settled', 'a1 settled', 'idle'])
})

test('an idle queue reports idle at once', async () => {
  await new FolderParseQueue<string>().whenIdle()
})
