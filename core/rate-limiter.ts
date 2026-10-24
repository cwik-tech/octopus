/**
 * Team Runtime — Rate Limiter
 *
 * Provides an async semaphore for concurrency limiting and a RateLimiter
 * that adds inter-dispatch delay on top of the semaphore.
 *
 * No external dependencies — pure async/promise patterns.
 */

import type { RateLimitConfig, RateLimiterInterface } from './types.js'

// ─── ConcurrencySemaphore ───────────────────────────────────────────────────

/**
 * Promise-queue based async semaphore.
 * Limits how many callers can be "inside" (have acquired) at once.
 * Additional callers queue up and are released in FIFO order.
 */
export class ConcurrencySemaphore {
  private _max: number
  private _current: number = 0
  private _queue: Array<() => void> = []

  constructor(maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error(`ConcurrencySemaphore: maxConcurrent must be >= 1, got ${maxConcurrent}`)
    }
    this._max = maxConcurrent
  }

  /**
   * Acquire a semaphore slot.
   * Resolves immediately if under capacity, otherwise queues until a slot opens.
   */
  acquire(): Promise<void> {
    if (this._current < this._max) {
      this._current++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this._queue.push(() => {
        this._current++
        resolve()
      })
    })
  }

  /**
   * Release a semaphore slot.
   * Decrements the active count and unblocks the next queued waiter (if any).
   */
  release(): void {
    if (this._current === 0) {
      throw new Error('ConcurrencySemaphore.release() called without an acquired slot')
    }
    this._current--
    const next = this._queue.shift()
    if (next) next()
  }

  /** Number of callers currently holding a slot. */
  get active(): number {
    return this._current
  }

  /** Number of callers waiting for a slot. */
  get pending(): number {
    return this._queue.length
  }
}

// ─── RateLimiter ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Rate limiter that wraps a ConcurrencySemaphore and adds an inter-dispatch
 * delay between acquisitions.
 *
 * Implements RateLimiterInterface from core/types.ts.
 */
export class RateLimiter implements RateLimiterInterface {
  private _semaphore: ConcurrencySemaphore
  private _delayMs: number
  private _lastDispatchTime: number = 0

  constructor(config: RateLimitConfig) {
    this._semaphore = new ConcurrencySemaphore(config.maxConcurrent)
    this._delayMs = config.delayBetweenMs
  }

  /**
   * Acquire the semaphore and enforce inter-dispatch delay.
   * Callers past maxConcurrent queue behind the semaphore first.
   * Once through the semaphore, the caller waits any remaining delay
   * since the last dispatch before proceeding.
   */
  async acquire(): Promise<void> {
    await this._semaphore.acquire()

    if (this._delayMs > 0) {
      const elapsed = Date.now() - this._lastDispatchTime
      if (elapsed < this._delayMs) {
        await sleep(this._delayMs - elapsed)
      }
    }

    this._lastDispatchTime = Date.now()
  }

  /** Release the semaphore slot. */
  release(): void {
    this._semaphore.release()
  }

  /**
   * Convenience wrapper — acquires, runs fn, then releases even if fn throws.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  /** Number of callers currently holding a slot. */
  get active(): number {
    return this._semaphore.active
  }

  /** Number of callers waiting for a slot. */
  get pending(): number {
    return this._semaphore.pending
  }
}
