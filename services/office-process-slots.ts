import { OFFICE_ACTIVE_JOBS, OFFICE_QUEUED_JOBS, OFFICE_QUEUE_TIMEOUT_MS, type OfficeFailure } from '../contracts/office-documents.js'
type Slot = { ok: true; release: () => void } | OfficeFailure
interface Waiting { readonly admit: () => void }
export class OfficeProcessSlots {
  private active = 0
  private readonly queue: Waiting[] = []
  acquire(signal: AbortSignal): Promise<Slot> {
    if (signal.aborted) return Promise.resolve({ ok: false, code: 'cancelled' })
    if (this.active < OFFICE_ACTIVE_JOBS) return Promise.resolve(this.slot())
    if (this.queue.length >= OFFICE_QUEUED_JOBS) return Promise.resolve({ ok: false, code: 'queue_full' })
    return new Promise((resolve) => {
      const finish = (result: Slot): void => {
        clearTimeout(timer); signal.removeEventListener('abort', abort)
        const index = this.queue.indexOf(waiting)
        if (index >= 0) this.queue.splice(index, 1)
        resolve(result)
      }
      const waiting: Waiting = { admit: () => finish(this.slot()) }
      const abort = (): void => finish({ ok: false, code: 'cancelled' })
      const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), OFFICE_QUEUE_TIMEOUT_MS)
      this.queue.push(waiting)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  private slot(): Slot {
    this.active += 1
    let released = false
    return { ok: true, release: () => {
      if (released) return
      released = true; this.active -= 1
      this.queue[0]?.admit()
    } }
  }
}
