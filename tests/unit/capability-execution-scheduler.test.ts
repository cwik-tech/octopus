import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hostAuditedParallelReadEffect,
  serialCapabilityEffect,
} from '../../contracts/capability-effect.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'

test('serial effects in the same authority scope execute one at a time', async () => {
  const scheduler = new PerAuthorityCapabilityExecutionScheduler()
  const firstMayFinish = deferred<void>()
  const firstStarted = deferred<void>()
  const stages: string[] = []

  const first = scheduler.run({
    scopeKey: 'scope-1',
    effect: serialCapabilityEffect('mutating'),
    signal: new AbortController().signal,
    operation: async () => {
      stages.push('first.started')
      firstStarted.resolve()
      await firstMayFinish.promise
      stages.push('first.finished')
      return 'first'
    },
  })
  await firstStarted.promise
  const second = scheduler.run({
    scopeKey: 'scope-1',
    effect: serialCapabilityEffect('read-only'),
    signal: new AbortController().signal,
    operation: async () => {
      stages.push('second.started')
      return 'second'
    },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(stages, ['first.started'])
  firstMayFinish.resolve()
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.deepEqual(stages, [
    'first.started',
    'first.finished',
    'second.started',
  ])
})

test('serial effects in different authority scopes do not share a global lane', async () => {
  const scheduler = new PerAuthorityCapabilityExecutionScheduler()
  const firstMayFinish = deferred<void>()
  const firstStarted = deferred<void>()
  let secondStarted = false

  const first = scheduler.run({
    scopeKey: 'scope-1',
    effect: serialCapabilityEffect('mutating'),
    signal: new AbortController().signal,
    operation: async () => {
      firstStarted.resolve()
      await firstMayFinish.promise
    },
  })
  await firstStarted.promise
  const second = scheduler.run({
    scopeKey: 'scope-2',
    effect: serialCapabilityEffect('mutating'),
    signal: new AbortController().signal,
    operation: async () => {
      secondStarted = true
    },
  })
  await second

  assert.equal(secondStarted, true)
  firstMayFinish.resolve()
  await first
})

test('host-audited parallel reads in one scope can execute concurrently', async () => {
  const scheduler = new PerAuthorityCapabilityExecutionScheduler()
  const firstMayFinish = deferred<void>()
  const firstStarted = deferred<void>()
  let secondStarted = false

  const first = scheduler.run({
    scopeKey: 'scope-1',
    effect: hostAuditedParallelReadEffect(),
    signal: new AbortController().signal,
    operation: async () => {
      firstStarted.resolve()
      await firstMayFinish.promise
    },
  })
  await firstStarted.promise
  const second = scheduler.run({
    scopeKey: 'scope-1',
    effect: hostAuditedParallelReadEffect(),
    signal: new AbortController().signal,
    operation: async () => {
      secondStarted = true
    },
  })
  await second

  assert.equal(secondStarted, true)
  firstMayFinish.resolve()
  await first
})

test('an aborted queued serial operation never reaches its executor', async () => {
  const scheduler = new PerAuthorityCapabilityExecutionScheduler()
  const firstMayFinish = deferred<void>()
  const firstStarted = deferred<void>()
  const queuedController = new AbortController()
  let queuedExecuted = false

  const first = scheduler.run({
    scopeKey: 'scope-1',
    effect: serialCapabilityEffect('mutating'),
    signal: new AbortController().signal,
    operation: async () => {
      firstStarted.resolve()
      await firstMayFinish.promise
    },
  })
  await firstStarted.promise
  const queued = scheduler.run({
    scopeKey: 'scope-1',
    effect: serialCapabilityEffect('mutating'),
    signal: queuedController.signal,
    operation: async () => {
      queuedExecuted = true
    },
  })
  queuedController.abort(new DOMException('cancelled while queued', 'AbortError'))
  firstMayFinish.resolve()

  await first
  await assert.rejects(
    queued,
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
  assert.equal(queuedExecuted, false)
})

function deferred<T>() {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value?: T) => {
      if (!resolvePromise) throw new Error('Deferred resolve is unavailable')
      resolvePromise(value as T)
    },
  }
}
