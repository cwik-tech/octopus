import { OFFICE_ACTIVE_JOBS, OFFICE_CACHE_MAX_BYTES, OFFICE_QUEUE_TIMEOUT_MS, OFFICE_QUEUED_JOBS, type OfficeFailure, type OfficePreview } from '../contracts/office-documents.js'
export type OfficePreviewResult = OfficePreview | OfficeFailure
interface Job {
  readonly scope: string
  readonly key: string
  readonly controller: AbortController
  readonly run: (signal: AbortSignal) => Promise<OfficePreviewResult>
  readonly subscribers: Set<(result: OfficePreviewResult) => void>
  state: 'queued' | 'running' | 'finished'
  timer?: ReturnType<typeof setTimeout>
}
export class OfficePreviewJobs {
  private active = 0
  private readonly pending = new Map<string, Job>()
  private readonly queue: Job[] = []
  private readonly cache = new Map<string, { scope: string; value: OfficePreview; size: number }>()
  private cacheBytes = 0

  invalidate(scope: string): void {
    for (const [key, cached] of this.cache) if (cached.scope === scope) { this.cache.delete(key); this.cacheBytes -= cached.size }
    for (const job of this.pending.values()) if (job.scope === scope) {
      job.controller.abort()
      if (job.state === 'queued') this.complete(job, { ok: false, code: 'cancelled' })
    }
  }

  get(scope: string, key: string, signal: AbortSignal, run: (signal: AbortSignal) => Promise<OfficePreviewResult>): Promise<OfficePreviewResult> {
    if (signal.aborted) return Promise.resolve({ ok: false, code: 'cancelled' })
    const identity = JSON.stringify([scope, key])
    const cached = this.cache.get(identity)
    if (cached) return Promise.resolve(cached.value)
    let job = this.pending.get(identity)
    if (!job || job.controller.signal.aborted) {
      if (this.active >= OFFICE_ACTIVE_JOBS && this.queue.length >= OFFICE_QUEUED_JOBS) return Promise.resolve({ ok: false, code: 'queue_full' })
      job = { scope, key: identity, controller: new AbortController(), run, subscribers: new Set(), state: 'queued' }
      this.pending.set(identity, job)
    }
    const current = job
    return new Promise((resolve) => {
      const finish = (result: OfficePreviewResult): void => {
        signal.removeEventListener('abort', abort)
        current.subscribers.delete(finish)
        resolve(result)
      }
      const abort = (): void => {
        finish({ ok: false, code: 'cancelled' })
        if (current.subscribers.size === 0) {
          current.controller.abort()
          if (current.state === 'queued') this.complete(current, { ok: false, code: 'cancelled' })
        }
      }
      current.subscribers.add(finish)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      if (current.state !== 'queued' || this.queue.includes(current)) return
      if (this.active < OFFICE_ACTIVE_JOBS) this.start(current)
      else {
        this.queue.push(current)
        current.timer = setTimeout(() => this.complete(current, { ok: false, code: 'timeout' }), OFFICE_QUEUE_TIMEOUT_MS)
      }
    })
  }

  private start(job: Job): void {
    job.state = 'running'
    clearTimeout(job.timer)
    this.active += 1
    // Completion handles both success and rejection; callers own subscriptions.
    void job.run(job.controller.signal).then((result) => this.complete(job, result), () => this.complete(job, { ok: false, code: 'invalid_output' }))
  }

  private complete(job: Job, result: OfficePreviewResult): void {
    if (job.state === 'finished') return
    if (job.state === 'running' && !('ok' in result && result.code === 'cleanup_pending')) this.active -= 1
    job.state = 'finished'
    clearTimeout(job.timer)
    const index = this.queue.indexOf(job)
    if (index >= 0) this.queue.splice(index, 1)
    if (this.pending.get(job.key) === job) this.pending.delete(job.key)
    if (!job.controller.signal.aborted && !('ok' in result)) this.retain(job, result)
    for (const finish of job.subscribers) finish(result)
    const next = this.queue.shift()
    if (next && this.active < OFFICE_ACTIVE_JOBS) this.start(next)
    else if (next) this.queue.unshift(next)
  }

  private retain(job: Job, value: OfficePreview): void {
    const size = Buffer.byteLength(value.html)
    while (this.cacheBytes + size > OFFICE_CACHE_MAX_BYTES) {
      const oldest = this.cache.entries().next().value
      if (!oldest) break
      this.cache.delete(oldest[0]); this.cacheBytes -= oldest[1].size
    }
    if (size <= OFFICE_CACHE_MAX_BYTES) {
      this.cache.set(job.key, { scope: job.scope, value, size }); this.cacheBytes += size
    }
  }
}
