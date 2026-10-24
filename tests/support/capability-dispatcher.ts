import type {
  CapabilityDispatchEvent,
  CapabilityDispatcherPorts,
} from '../../contracts/capability-dispatch.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'

export function createCapabilityTestDispatcher(
  events: CapabilityDispatchEvent[] = [],
  overrides: CapabilityDispatcherPorts = {},
): CapabilityDispatcher {
  let attempt = 0
  return new CapabilityDispatcher({
    bindings: new CapabilityInvocationBindings({
      maxActivePerScope: 8,
      maxRetainedPerScope: 128,
    }),
    authority: { authorize: async () => ({ kind: 'allow' }) },
    policy: { evaluate: async () => ({ kind: 'allow' }) },
    budget: {
      preflight: async () => ({ kind: 'not-metered' }),
      reserve: async () => ({ reservationId: 'unexpected-test-reservation' }),
      settle: async () => ({ costTracked: false, budgetOverrun: false }),
      release: async () => undefined,
    },
    approval: {
      request: async (input) => {
        const interaction = {
          interactionId: `capability-test-interaction-${attempt + 1}`,
          reused: false,
        }
        await input.onInteraction(interaction)
        return { outcome: 'approved', interaction }
      },
    },
    evidence: { append: async (event) => { events.push(event) } },
    scheduler: new PerAuthorityCapabilityExecutionScheduler(),
    clock: { now: Date.now },
    ids: {
      nextAttemptId: () => {
        attempt += 1
        return `capability-test-attempt-${attempt}`
      },
    },
    ...overrides,
  })
}
