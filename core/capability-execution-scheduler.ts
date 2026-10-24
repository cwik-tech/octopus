import type { CapabilityEffect } from '../contracts/capability-effect.js'
import { mayRunConcurrently } from '../contracts/capability-effect.js'
import type { CapabilityExecutionSchedulerPort } from '../contracts/capability-dispatch.js'

/**
 * Serializes only within one trusted authority scope. There is deliberately no
 * process-global lane: unrelated assignments cannot block each other.
 */
export class PerAuthorityCapabilityExecutionScheduler implements CapabilityExecutionSchedulerPort {
  private readonly scopeTails = new Map<string, Promise<void>>()

  async run<T>(input: {
    readonly scopeKey: string
    readonly effect: CapabilityEffect
    readonly signal: AbortSignal
    readonly operation: () => Promise<T>
  }): Promise<T> {
    if (input.signal.aborted) throw abortReason(input.signal)
    if (mayRunConcurrently(input.effect)) return input.operation()

    const previous = this.scopeTails.get(input.scopeKey) ?? Promise.resolve()
    let releaseSlot: (() => void) | undefined
    const slot = new Promise<void>((resolve) => {
      releaseSlot = resolve
    })
    const tail = previous.catch(() => undefined).then(() => slot)
    this.scopeTails.set(input.scopeKey, tail)

    try {
      await waitForTurn(previous, input.signal)
      if (input.signal.aborted) throw abortReason(input.signal)
      return await input.operation()
    } finally {
      releaseSlot?.()
      void tail.then(() => {
        if (this.scopeTails.get(input.scopeKey) === tail) {
          this.scopeTails.delete(input.scopeKey)
        }
      })
    }
  }
}

function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void previous.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
    )
  })
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException('Capability execution was cancelled.', 'AbortError')
}
