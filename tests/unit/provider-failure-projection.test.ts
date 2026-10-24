import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalJsonObject } from '../../contracts/canonical-json.js'
import type { ExecutionJournalEvent } from '../../contracts/execution-journal.js'
import {
  AGENT_TURN_COMPLETED_EVENT_TYPE,
  AGENT_TURN_FAILED_EVENT_TYPE,
  AGENT_TURN_PAYLOAD_SCHEMA_VERSION,
  AGENT_TURN_STREAM_KIND,
  buildAgentTurnCompletedPayload,
  buildAgentTurnFailedPayload,
} from '../../domains/agent-execution/agent-turn-journal.js'
import {
  activeProviderFailure,
  applyProviderFailure,
  clearProviderFailures,
  projectProviderFailure,
  pruneProviderFailures,
  providerFailureDiagnostic,
  type ProviderFailureSnapshot,
} from '../../domains/provider/provider-failure-projection.js'

/**
 * A key that runs out of credit mid-run is discovered by the run, not by a
 * ping. Nothing asks the provider again until someone opens a sidebar, so
 * without this the app knows an agent is dead and still draws it as healthy.
 *
 * The journal already records every failed turn with its classified kind. This
 * is a projection of those facts, not a second place they are written.
 */

const ASSIGNMENT_ID = 'assignment-1'
const TURN_ID = 'turn-1'
const REPLY_ID = 'reply-1'

function makeEvent(input: {
  readonly type: string
  readonly payload: CanonicalJsonObject
  readonly recordedAt?: string
  readonly streamKind?: string
}): ExecutionJournalEvent {
  return {
    schemaVersion: 1,
    eventId: `${ASSIGNMENT_ID}:agent-turn:${input.type}`,
    sequence: 2,
    recordedAt: input.recordedAt ?? '2026-09-11T10:00:00.000Z',
    scopeKind: 'assignment',
    scopeId: ASSIGNMENT_ID,
    tenantId: 'local',
    streamKind: input.streamKind ?? AGENT_TURN_STREAM_KIND,
    streamId: ASSIGNMENT_ID,
    streamRevision: 2,
    type: input.type,
    payloadSchemaVersion: AGENT_TURN_PAYLOAD_SCHEMA_VERSION,
    appendRequestDigest: 'digest',
    correlationId: TURN_ID,
    previousEventHash: 'previous',
    eventHash: 'hash',
    payload: input.payload,
  }
}

function failedEvent(
  failure: Parameters<typeof buildAgentTurnFailedPayload>[0]['failure'],
  recordedAt?: string,
): ExecutionJournalEvent {
  return makeEvent({
    type: AGENT_TURN_FAILED_EVENT_TYPE,
    ...(recordedAt === undefined ? {} : { recordedAt }),
    payload: buildAgentTurnFailedPayload({
      turnId: TURN_ID,
      replyId: REPLY_ID,
      route: 'direct-provider',
      failure,
    }),
  })
}

const EXHAUSTED_KEY = {
  layer: 'direct-provider',
  phase: 'provider-request',
  serviceCode: 'billing',
  providerKind: 'billing',
  provider: 'openai',
  model: 'gpt-5.4',
  httpStatus: 402,
  retryable: false,
} as const

const RATE_LIMITED = {
  layer: 'direct-provider',
  phase: 'provider-request',
  serviceCode: 'rate_limit',
  providerKind: 'rate_limit',
  provider: 'openai',
  model: 'gpt-5.4',
  httpStatus: 429,
  retryable: true,
} as const

test('a failed turn records which provider and model the failure was about', () => {
  const payload = buildAgentTurnFailedPayload({
    turnId: TURN_ID,
    replyId: REPLY_ID,
    route: 'direct-provider',
    failure: EXHAUSTED_KEY,
  })

  assert.deepEqual(payload['failure'], {
    layer: 'direct-provider',
    phase: 'provider-request',
    serviceCode: 'billing',
    providerKind: 'billing',
    provider: 'openai',
    model: 'gpt-5.4',
    httpStatus: 402,
    retryable: false,
  })
})

test('an exhausted key discovered by a run projects to one observation about that provider', () => {
  const observed = projectProviderFailure(failedEvent(EXHAUSTED_KEY))

  assert.deepEqual(observed, {
    provider: 'openai',
    model: 'gpt-5.4',
    kind: 'billing',
    observedAt: '2026-09-11T10:00:00.000Z',
  })
})

test('a failure about the request rather than the account projects to nothing', () => {
  // A prompt too long for one model says nothing about whether the provider
  // works. Projecting it would mark every agent on that provider as broken.
  const observed = projectProviderFailure(
    failedEvent({
      layer: 'direct-provider',
      phase: 'provider-request',
      serviceCode: 'context_limit',
      providerKind: 'context_limit',
      provider: 'openai',
      model: 'gpt-5.4',
      retryable: false,
    }),
  )

  assert.equal(observed, undefined)
})

test('an event that is not a failed agent turn projects to nothing', () => {
  assert.equal(
    projectProviderFailure(
      makeEvent({
        type: AGENT_TURN_COMPLETED_EVENT_TYPE,
        payload: buildAgentTurnCompletedPayload({
          turnId: TURN_ID,
          replyId: REPLY_ID,
          assistantMessageId: 'message-1',
          route: 'direct-provider',
        }),
      }),
    ),
    undefined,
  )
  assert.equal(
    projectProviderFailure(
      makeEvent({
        type: AGENT_TURN_FAILED_EVENT_TYPE,
        streamKind: 'workflow.state',
        payload: buildAgentTurnFailedPayload({
          turnId: TURN_ID,
          replyId: REPLY_ID,
          route: 'direct-provider',
          failure: EXHAUSTED_KEY,
        }),
      }),
    ),
    undefined,
  )
})

test('an exhausted key stays known until something clears it', () => {
  const observed = projectProviderFailure(failedEvent(EXHAUSTED_KEY))
  assert.ok(observed)
  const snapshot = applyProviderFailure({}, observed)

  // A day later, with nothing else having happened, the key is still dead.
  const target = { provider: 'openai', model: 'gpt-5.4' }
  assert.equal(
    activeProviderFailure(snapshot, target, new Date('2026-09-12T10:00:00.000Z'))
      ?.kind,
    'billing',
  )
  assert.equal(
    activeProviderFailure(
      clearProviderFailures(snapshot, target),
      target,
      new Date('2026-09-11T10:01:00.000Z'),
    ),
    undefined,
  )
})

test('a rate limit stops being reported once it has had time to reset', () => {
  const observed = projectProviderFailure(failedEvent(RATE_LIMITED))
  assert.ok(observed)
  const snapshot: ProviderFailureSnapshot = applyProviderFailure({}, observed)
  const target = { provider: 'openai', model: 'gpt-5.4' }

  assert.equal(
    activeProviderFailure(snapshot, target, new Date('2026-09-11T10:05:00.000Z'))
      ?.kind,
    'rate_limit',
  )
  assert.equal(
    activeProviderFailure(
      snapshot,
      target,
      new Date('2026-09-11T11:00:00.000Z'),
    ),
    undefined,
  )
})

test('one provider failure only marks the model it was observed on', () => {
  const observed = projectProviderFailure(failedEvent(EXHAUSTED_KEY))
  assert.ok(observed)
  const snapshot = applyProviderFailure({}, observed)
  const now = new Date('2026-09-11T10:01:00.000Z')

  assert.ok(
    activeProviderFailure(snapshot, { provider: 'openai', model: 'gpt-5.4' }, now),
  )
  assert.equal(
    activeProviderFailure(
      snapshot,
      { provider: 'anthropic', model: 'gpt-5.4' },
      now,
    ),
    undefined,
  )
})

test('a runtime-discovered failure states the agent, the provider, and the advice', () => {
  const observed = projectProviderFailure(failedEvent(EXHAUSTED_KEY))
  assert.ok(observed)

  assert.deepEqual(providerFailureDiagnostic(observed, { agentName: 'analyst' }), {
    severity: 'error',
    kind: 'billing',
    message:
      "Agent 'analyst' (openai): This provider account has no remaining quota " +
      'or credits. Check billing. Seen during a run on 2026-09-11.',
    subject: {
      agentName: 'analyst',
      provider: 'openai',
      model: 'gpt-5.4',
    },
  })
})

test('a transient runtime failure is a warning rather than a blocking error', () => {
  const observed = projectProviderFailure(failedEvent(RATE_LIMITED))
  assert.ok(observed)

  assert.equal(
    providerFailureDiagnostic(observed, { teamName: 'writing-team' }).severity,
    'warning',
  )
})

test('the newest observation for one provider and model replaces the older one', () => {
  const rateLimited = projectProviderFailure(
    failedEvent(RATE_LIMITED, '2026-09-11T10:00:00.000Z'),
  )
  const exhausted = projectProviderFailure(
    failedEvent(EXHAUSTED_KEY, '2026-09-11T10:30:00.000Z'),
  )
  assert.ok(rateLimited)
  assert.ok(exhausted)

  const snapshot = applyProviderFailure(
    applyProviderFailure({}, rateLimited),
    exhausted,
  )

  assert.equal(Object.keys(snapshot).length, 1)
  assert.equal(
    activeProviderFailure(
      snapshot,
      { provider: 'openai', model: 'gpt-5.4' },
      new Date('2026-09-11T10:31:00.000Z'),
    )?.kind,
    'billing',
  )
})

test('an older observation never overwrites a newer one during a replay', () => {
  // A projection is rebuilt by replaying journals, and journals are scanned in
  // whatever order the walk finds them. The fold has to be order-independent
  // or a rebuild would disagree with the live view.
  const rateLimited = projectProviderFailure(
    failedEvent(RATE_LIMITED, '2026-09-11T10:00:00.000Z'),
  )
  const exhausted = projectProviderFailure(
    failedEvent(EXHAUSTED_KEY, '2026-09-11T10:30:00.000Z'),
  )
  assert.ok(rateLimited)
  assert.ok(exhausted)

  const snapshot = applyProviderFailure(
    applyProviderFailure({}, exhausted),
    rateLimited,
  )

  assert.equal(
    activeProviderFailure(
      snapshot,
      { provider: 'openai', model: 'gpt-5.4' },
      new Date('2026-09-11T10:31:00.000Z'),
    )?.kind,
    'billing',
  )
})

/**
 * A usage limit that states when it ends can end by itself.
 *
 * The other account failures stand until something disproves them, because
 * nothing about a rejected key or an unpaid plan says when it stops being
 * true. A usage limit is different: the provider names the moment, and a badge
 * still reporting it an hour later is simply wrong. Without this the only way
 * out is a later allowance reading, which exists for Codex and for nothing
 * else.
 */

const LIMIT_WITH_RESET = {
  layer: 'direct-provider',
  phase: 'provider-request',
  serviceCode: 'usage_limit',
  providerKind: 'usage_limit',
  provider: 'codex',
  model: 'gpt-5.5',
  resetsAt: '2026-09-14T21:45:00.000Z',
  retryable: false,
} as const

const CODEX_TARGET = { provider: 'codex', model: 'gpt-5.5' }

test('a stated reset survives the journal into the derived view', () => {
  const observed = projectProviderFailure(
    failedEvent(LIMIT_WITH_RESET, '2026-09-12T02:05:31.717Z'),
  )

  assert.ok(observed)
  assert.equal(observed.kind, 'usage_limit')
  assert.equal(observed.resetsAt, '2026-09-14T21:45:00.000Z')
})

test('a usage limit is still reported right up to its stated reset', () => {
  const observed = projectProviderFailure(
    failedEvent(LIMIT_WITH_RESET, '2026-09-12T02:05:31.717Z'),
  )
  assert.ok(observed)
  const snapshot = applyProviderFailure({}, observed)

  assert.equal(
    activeProviderFailure(
      snapshot,
      CODEX_TARGET,
      new Date('2026-09-14T21:44:59.999Z'),
    )?.kind,
    'usage_limit',
  )
})

test('a usage limit stops being reported at its stated reset', () => {
  const observed = projectProviderFailure(
    failedEvent(LIMIT_WITH_RESET, '2026-09-12T02:05:31.717Z'),
  )
  assert.ok(observed)
  const snapshot = applyProviderFailure({}, observed)

  assert.equal(
    activeProviderFailure(
      snapshot,
      CODEX_TARGET,
      new Date('2026-09-14T21:45:00.000Z'),
    ),
    undefined,
    'the window it described is over',
  )
  assert.deepEqual(
    pruneProviderFailures(snapshot, new Date('2026-09-14T21:45:00.000Z')),
    {},
    'and a stored view stops carrying it',
  )
})

test('a usage limit that stated no reset still stands until disproved', () => {
  // The behaviour this repository already had, and the reason a reading is
  // still the only way out for a limit the provider said nothing about.
  const observed = projectProviderFailure(
    failedEvent(
      {
        layer: 'direct-provider',
        phase: 'provider-request',
        serviceCode: 'usage_limit',
        providerKind: 'usage_limit',
        provider: 'codex',
        model: 'gpt-5.5',
        retryable: false,
      },
      '2026-09-12T02:05:31.717Z',
    ),
  )
  assert.ok(observed)
  assert.equal(observed.resetsAt, undefined)

  assert.equal(
    activeProviderFailure(
      applyProviderFailure({}, observed),
      CODEX_TARGET,
      new Date('2027-01-01T00:00:00.000Z'),
    )?.kind,
    'usage_limit',
  )
})

test('a reset does not expire a failure about the account itself', () => {
  // An allowance window is the only thing a reset describes. A rejected key
  // does not come back because a clock struck, whatever a record claims.
  const observed = projectProviderFailure(
    failedEvent(
      { ...LIMIT_WITH_RESET, serviceCode: 'billing', providerKind: 'billing' },
      '2026-09-12T02:05:31.717Z',
    ),
  )
  assert.ok(observed)

  assert.equal(
    activeProviderFailure(
      applyProviderFailure({}, observed),
      CODEX_TARGET,
      new Date('2027-01-01T00:00:00.000Z'),
    )?.kind,
    'billing',
  )
})
