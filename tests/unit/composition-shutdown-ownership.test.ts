import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCompositionLifecycle,
  createRuntimeJournalOwnership,
  type LifecycleResource,
} from '../../server/composition.js'

/**
 * AC18: what may close, and when, once shutdown has begun.
 *
 * Two rules that only bite together.
 *
 * The journal registry belongs to the capability runtime for teardown
 * purposes. Runtime shutdown records an explicit decision for every attempt
 * that is still unsettled, and if that recording fails the journal must stay
 * open — otherwise the stream closes with nothing in it saying what happened.
 * Disposal continues past a failed resource so unrelated cleanup still runs,
 * which means these two cannot be independent entries in that list: the
 * registry would be closed straight after the runtime's failure was caught.
 *
 * And a disposal that failed has to be retryable, for the same reason the
 * finalizer is: the fault may be transient. Retrying must not re-dispose what
 * already succeeded.
 */

function recordingResource(
  name: string,
  log: string[],
  behaviour: { failTimes?: number } = {},
): LifecycleResource {
  let failuresLeft = behaviour.failTimes ?? 0
  return {
    name,
    dispose: async () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1
        log.push(`${name}:failed`)
        throw new Error(`${name} failed to dispose`)
      }
      log.push(name)
    },
  }
}

test('a failed runtime shutdown leaves its journal registry open', async () => {
  const log: string[] = []
  const ownership = createRuntimeJournalOwnership({
    runtime: {
      close: async () => {
        log.push('runtime:failed')
        throw new Error('finalization failed')
      },
    },
    registry: {
      close: async () => {
        log.push('registry')
      },
    },
  })

  await assert.rejects(
    Promise.resolve(ownership.dispose({ deadlineMs: Date.now() + 1_000 })),
    'the failure must reach whoever is shutting the process down',
  )
  assert.deepEqual(
    log,
    ['runtime:failed'],
    'the registry must not close over a decision that was never recorded',
  )
})

test('the journal registry closes once runtime shutdown succeeds', async () => {
  const log: string[] = []
  const ownership = createRuntimeJournalOwnership({
    runtime: {
      close: async (options) => {
        log.push(`runtime:${options?.deadlineMs === undefined ? 'no-deadline' : 'deadline'}`)
      },
    },
    registry: {
      close: async () => {
        log.push('registry')
      },
    },
  })

  await ownership.dispose({ deadlineMs: Date.now() + 1_000 })
  assert.deepEqual(
    log,
    ['runtime:deadline', 'registry'],
    'runtime first, with the shared deadline, and only then the registry',
  )
})

test('disposal retries what failed and leaves what succeeded alone', async () => {
  const log: string[] = []
  // Ownership order; disposal runs in reverse, so `late` goes first.
  const resources = [
    recordingResource('early', log),
    recordingResource('flaky', log, { failTimes: 1 }),
    recordingResource('late', log),
  ]
  const lifecycle = createCompositionLifecycle({
    startActions: [],
    activationActions: [],
    resourcesInOwnershipOrder: resources,
  })

  await assert.rejects(lifecycle.dispose(), 'the first failure is reported')
  assert.deepEqual(
    log,
    ['late', 'flaky:failed', 'early'],
    'unrelated resources still dispose either side of the failure',
  )

  log.length = 0
  await lifecycle.dispose()
  assert.deepEqual(
    log,
    ['flaky'],
    'a retry disposes only what had not succeeded — closing an already ' +
      'closed resource a second time is its own hazard',
  )
})
