/**
 * The parse queue of attached folders (docs/feature-local-folder-access.md,
 * "Scheduling and publishing").
 *
 * One queue serves the whole app, so at most two parser processes run at once
 * whatever the number of folders. Each folder keeps its own line of jobs and
 * the folders take turns, so one large folder can't hold back another. A job
 * asked for on demand, as `folder_read` does, moves to the front.
 *
 * A key names one parse of one file version. A second ask for a key that is
 * queued or running joins that job instead of starting another, so a
 * background parse and an on-demand read of the same version share one run.
 *
 * Each job gets an AbortSignal of its own. Cancelling drops a queued job at
 * once and aborts a running one, which keeps its slot until it has settled:
 * the process it started may still be running, and the limit counts processes.
 * The parser's own timeout stays with the launcher the job calls.
 *
 * A job starts inside the call that gives it a slot: `submit`, or the
 * settling of the job before it. So when a job's promise settles, the next
 * job has already started.
 */

export const FOLDER_PARSE_CONCURRENCY = 2

export interface FolderParseJob<T> {
  /** The folder the job belongs to; cancelling a folder cancels all of its jobs. */
  readonly folderKey: string
  /** One parse of one file version. A job with the same key, queued or running, is joined. */
  readonly key: string
  readonly run: (signal: AbortSignal) => Promise<T>
}

/** Resolves when `ms` have passed, or when `signal` aborts, whichever comes first. */
export type WaitLimit = (ms: number, signal: AbortSignal) => Promise<void>

export type WaitResult<T> =
  | { readonly kind: 'settled'; readonly value: T }
  | { readonly kind: 'waited_out' }
  | { readonly kind: 'cancelled' }

interface QueuedJob<T> {
  readonly folderKey: string
  readonly key: string
  readonly run: (signal: AbortSignal) => Promise<T>
  readonly controller: AbortController
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
  /** Set once the job is asked for on demand; the earliest ask runs first. */
  urgentOrder?: number
}

function abortError(): DOMException {
  return new DOMException('The parse was cancelled.', 'AbortError')
}

export class FolderParseQueue<T> {
  private readonly concurrency: number
  /** Jobs that can still be joined: queued, or running and not cancelled. */
  private readonly byKey = new Map<string, QueuedJob<T>>()
  /** Queued jobs, one line per folder. */
  private readonly lines = new Map<string, QueuedJob<T>[]>()
  private readonly running = new Set<QueuedJob<T>>()
  /** When each folder last had a job started; the folder waiting longest goes next. */
  private readonly lastStarted = new Map<string, number>()
  private starts = 0
  private urgentAsks = 0
  private idleWaiters: Array<() => void> = []

  constructor(options: { readonly concurrency?: number } = {}) {
    this.concurrency = options.concurrency ?? FOLDER_PARSE_CONCURRENCY
  }

  /**
   * Queue a job, or join the queued or running job with the same key. With
   * `urgent`, a queued job moves ahead of every job that was not asked for on
   * demand. A joined job keeps its own `run`.
   */
  submit(job: FolderParseJob<T>, options: { readonly urgent?: boolean } = {}): Promise<T> {
    const existing = this.byKey.get(job.key)
    if (existing) {
      if (options.urgent && existing.urgentOrder === undefined && !this.running.has(existing)) {
        this.removeQueued(existing)
        this.enqueueUrgent(existing)
      }
      return existing.promise
    }
    const queued = this.createJob(job)
    this.byKey.set(job.key, queued)
    if (options.urgent) this.enqueueUrgent(queued)
    else this.lineOf(job.folderKey).push(queued)
    this.pump()
    return queued.promise
  }

  /** Drop a queued job, or abort a running one. Its callers' promises reject with an AbortError. */
  cancel(key: string): void {
    const job = this.byKey.get(key)
    if (job) this.cancelJob(job)
  }

  /**
   * Cancel every job of a folder. Resolves once its running jobs have settled,
   * so nothing they start is still writing when the caller goes on.
   */
  async cancelFolder(folderKey: string): Promise<void> {
    for (const job of [...this.byKey.values()]) {
      if (job.folderKey === folderKey) this.cancelJob(job)
    }
    this.lastStarted.delete(folderKey)
    const running = [...this.running].filter((job) => job.folderKey === folderKey)
    await Promise.allSettled(running.map((job) => job.promise))
  }

  /**
   * Resolves once nothing is queued or running, a cancelled job that is still
   * running included, after the last job's callers have heard its outcome.
   */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  private isIdle(): boolean {
    return this.running.size === 0 && this.lines.size === 0
  }

  private createJob(job: FolderParseJob<T>): QueuedJob<T> {
    let resolve: (value: T) => void = () => undefined
    let reject: (error: unknown) => void = () => undefined
    const promise = new Promise<T>((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    // A background job may have no caller left to hear that it was cancelled.
    promise.catch(() => undefined)
    return {
      folderKey: job.folderKey,
      key: job.key,
      run: job.run,
      controller: new AbortController(),
      promise,
      resolve,
      reject,
    }
  }

  private cancelJob(job: QueuedJob<T>): void {
    if (this.byKey.get(job.key) === job) this.byKey.delete(job.key)
    if (this.running.has(job)) {
      job.controller.abort(abortError())
      return
    }
    this.removeQueued(job)
    job.reject(abortError())
    this.notifyIdle()
  }

  private lineOf(folderKey: string): QueuedJob<T>[] {
    let line = this.lines.get(folderKey)
    if (!line) {
      line = []
      this.lines.set(folderKey, line)
    }
    return line
  }

  /** Into its folder's line after the jobs already asked for on demand. */
  private enqueueUrgent(job: QueuedJob<T>): void {
    this.urgentAsks += 1
    job.urgentOrder = this.urgentAsks
    const line = this.lineOf(job.folderKey)
    const firstOrdinary = line.findIndex((queued) => queued.urgentOrder === undefined)
    line.splice(firstOrdinary === -1 ? line.length : firstOrdinary, 0, job)
  }

  private removeQueued(job: QueuedJob<T>): void {
    const line = this.lines.get(job.folderKey)
    if (!line) return
    const index = line.indexOf(job)
    if (index !== -1) line.splice(index, 1)
    if (line.length === 0) this.lines.delete(job.folderKey)
  }

  /**
   * The next job to run: the earliest on-demand ask at the head of any line,
   * otherwise the head of the line whose folder has waited longest since its
   * last start.
   */
  private takeNext(): QueuedJob<T> | undefined {
    let urgent: QueuedJob<T> | undefined
    let ordinary: QueuedJob<T> | undefined
    for (const [folderKey, line] of this.lines) {
      const head = line[0]
      if (!head) continue
      if (head.urgentOrder !== undefined) {
        if (urgent?.urgentOrder === undefined || head.urgentOrder < urgent.urgentOrder) urgent = head
      } else if (!ordinary || this.startedAt(folderKey) < this.startedAt(ordinary.folderKey)) {
        ordinary = head
      }
    }
    const chosen = urgent ?? ordinary
    if (chosen) this.removeQueued(chosen)
    return chosen
  }

  private startedAt(folderKey: string): number {
    return this.lastStarted.get(folderKey) ?? 0
  }

  private pump(): void {
    while (this.running.size < this.concurrency) {
      const job = this.takeNext()
      if (!job) return
      this.start(job)
    }
  }

  private start(job: QueuedJob<T>): void {
    this.running.add(job)
    this.starts += 1
    this.lastStarted.set(job.folderKey, this.starts)
    let outcome: Promise<T>
    try {
      outcome = job.run(job.controller.signal)
    } catch (error) {
      outcome = Promise.reject(error)
    }
    outcome.then(
      (value) => {
        this.release(job)
        job.resolve(value)
        this.notifyIdle()
      },
      (error: unknown) => {
        this.release(job)
        job.reject(error)
        this.notifyIdle()
      },
    )
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** Free the job's slot and start the next job before its callers hear the outcome. */
  private release(job: QueuedJob<T>): void {
    this.running.delete(job)
    if (this.byKey.get(job.key) === job) this.byKey.delete(job.key)
    this.pump()
  }
}

/** A wait limit on a real timer. */
export const timerWaitLimit: WaitLimit = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })

/**
 * Wait for `work` at most `ms`, as `folder_read` waits for a parse. Waiting out
 * or being cancelled leaves the work running. A rejection of `work` is thrown.
 */
export async function waitAtMost<T>(
  work: Promise<T>,
  ms: number,
  options: { readonly limit?: WaitLimit; readonly signal?: AbortSignal | undefined } = {},
): Promise<WaitResult<T>> {
  if (options.signal?.aborted) return { kind: 'cancelled' }
  const release = new AbortController()
  const limit = options.limit ?? timerWaitLimit
  const outcomes: Array<Promise<WaitResult<T>>> = [
    work.then((value) => ({ kind: 'settled', value })),
    limit(ms, release.signal).then(() => ({ kind: 'waited_out' })),
  ]
  const caller = options.signal
  let onAbort: (() => void) | undefined
  if (caller) {
    outcomes.push(new Promise<WaitResult<T>>((resolve) => {
      onAbort = () => resolve({ kind: 'cancelled' })
      caller.addEventListener('abort', onAbort, { once: true })
    }))
  }
  try {
    return await Promise.race(outcomes)
  } finally {
    release.abort()
    if (caller && onAbort) caller.removeEventListener('abort', onAbort)
  }
}
