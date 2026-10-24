/**
 * When a failed explicit model may be offered a new attempt on the app default.
 *
 * The rule is deliberately conservative. Failing is not permission to substitute
 * a model, an offer is only made where a fresh attempt is provably safe, and
 * missing evidence is refused rather than assumed harmless. Every branch here
 * is a decision that costs money or repeats a side effect if it is wrong.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AppDefaultModelState } from '../../contracts/agent-model-selection.js'
import {
  readApprovedModelChoiceAuthorization,
  resolveAuthorizedAgentModelChoice,
  type ApprovedModelChoiceAuthorization,
  decideModelChoice,
  deriveExecutionToolEffectEvidence,
  deriveToolEffectEvidence,
  modelChoiceOfferId,
  modelFailurePhaseFor,
  evaluateModelChoiceEligibility,
  readModelChoiceAcceptance,
  type ModelChoiceOffer,
} from '../../contracts/model-choice.js'

const AVAILABLE_DEFAULT: AppDefaultModelState = {
  status: 'available',
  provider: 'connection:abc',
  model: 'gpt-5.4-mini',
}

const FAILED_CHOICE = { provider: 'anthropic', model: 'claude-sonnet-4-6' }

function eligibleInput(overrides: Record<string, unknown> = {}) {
  return {
    failedChoice: FAILED_CHOICE,
    failureKind: 'authentication' as const,
    remainingSameModelRetries: 0,
    toolEffectEvidence: 'none-observed' as const,
    appDefault: AVAILABLE_DEFAULT,
    ...overrides,
  }
}

test('an unusable explicit model with no side effects may be offered the app default', () => {
  assert.deepEqual(evaluateModelChoiceEligibility(eligibleInput()), {
    eligible: true,
    reason: 'missing-credential',
    proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
  })
})

test('an unknown model and a rejected request are both offerable', () => {
  assert.equal(
    evaluateModelChoiceEligibility(eligibleInput({ failureKind: 'not_found' }))
      .reason,
    'unknown-model',
  )
  assert.equal(
    evaluateModelChoiceEligibility(
      eligibleInput({ failureKind: 'invalid_request' }),
    ).reason,
    'provider-rejected',
  )
})

test('bounded retries of the same model come first', () => {
  // Substituting a model while the policy would still retry the chosen one
  // would take the choice away from the user for a failure that may not
  // recur.
  assert.deepEqual(
    evaluateModelChoiceEligibility(
      eligibleInput({ remainingSameModelRetries: 1 }),
    ),
    { eligible: false, reason: 'same-model-retry-remains' },
  )
})

test('a transient failure is not a reason to change models', () => {
  for (const failureKind of ['rate_limit', 'overloaded', 'timeout', 'unavailable']) {
    assert.deepEqual(
      evaluateModelChoiceEligibility(eligibleInput({ failureKind })),
      { eligible: false, reason: 'failure-not-model-specific' },
      failureKind,
    )
  }
})

test('a cancelled attempt is not a failed model', () => {
  assert.deepEqual(
    evaluateModelChoiceEligibility(eligibleInput({ failureKind: 'cancelled' })),
    { eligible: false, reason: 'failure-not-model-specific' },
  )
})

test('any tool dispatch in the affected invocation blocks the offer', () => {
  // Evaluated across the whole logical invocation, including earlier provider
  // rounds. A rejected final request does not prove nothing ran.
  assert.deepEqual(
    evaluateModelChoiceEligibility(
      eligibleInput({ toolEffectEvidence: 'dispatch-started' }),
    ),
    { eligible: false, reason: 'unsafe-to-repeat' },
  )
})

test('missing effect evidence is refused, not assumed harmless', () => {
  assert.deepEqual(
    evaluateModelChoiceEligibility(
      eligibleInput({ toolEffectEvidence: 'unknown' }),
    ),
    { eligible: false, reason: 'unsafe-to-repeat' },
  )
})

test('there is nothing to offer without an application default', () => {
  assert.deepEqual(
    evaluateModelChoiceEligibility(
      eligibleInput({ appDefault: { status: 'unset' } }),
    ),
    { eligible: false, reason: 'no-app-default' },
  )
})

test('an unavailable default is not offered as a way out', () => {
  assert.deepEqual(
    evaluateModelChoiceEligibility(
      eligibleInput({
        appDefault: {
          status: 'unavailable',
          provider: 'connection:abc',
          model: 'gpt-5.4-mini',
        },
      }),
    ),
    { eligible: false, reason: 'no-app-default' },
  )
})

test('a default equal to the failed pair is not presented as switching models', () => {
  assert.deepEqual(
    evaluateModelChoiceEligibility(
      eligibleInput({
        appDefault: {
          status: 'available',
          provider: FAILED_CHOICE.provider,
          model: FAILED_CHOICE.model,
        },
      }),
    ),
    { eligible: false, reason: 'default-equals-failed-choice' },
  )
})

// ─── Approving one offer ────────────────────────────────────────────────────

const OFFER: ModelChoiceOffer = {
  offerId: 'offer-1',
  scope: { kind: 'chat', sessionId: 'session-1', turnId: 'turn-1' },
  agentName: 'reviewer',
  expectedRevision: 'revision-1',
  failedChoice: FAILED_CHOICE,
  proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
  reason: 'missing-credential',
}

function decisionInput(overrides: Record<string, unknown> = {}) {
  return {
    offer: OFFER,
    acceptance: { offerId: 'offer-1', idempotencyKey: 'key-1' },
    currentRevision: 'revision-1',
    appDefault: AVAILABLE_DEFAULT,
    eligibility: evaluateModelChoiceEligibility(eligibleInput()),
    acceptedIdempotencyKeys: [] as readonly string[],
    ...overrides,
  }
}

test('approving an offer authorizes exactly the pair the user was shown', () => {
  assert.deepEqual(decideModelChoice(decisionInput()), {
    ok: true,
    selection: {
      provider: 'connection:abc',
      model: 'gpt-5.4-mini',
      source: 'app-default',
      reason: 'user-approved-retry',
      originalChoice: FAILED_CHOICE,
    },
  })
})

test('an offer nobody made authorizes nothing', () => {
  assert.deepEqual(decideModelChoice(decisionInput({ offer: undefined })), {
    ok: false,
    error: { code: 'offer-not-found', message: 'That model choice is no longer available.' },
  })
})

test('an acceptance for a different offer is refused', () => {
  const result = decideModelChoice(
    decisionInput({ acceptance: { offerId: 'offer-2', idempotencyKey: 'key-1' } }),
  )
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'offer-not-found')
})

test('a stale tab cannot approve work against state that has moved on', () => {
  const result = decideModelChoice(decisionInput({ currentRevision: 'revision-2' }))
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'stale-revision')
})

test('a default that changed after the offer requires a refreshed offer', () => {
  // The user approved a specific pair. Running a different one would execute
  // something they were never shown.
  const result = decideModelChoice(
    decisionInput({
      appDefault: {
        status: 'available',
        provider: 'connection:abc',
        model: 'gpt-5.6-sol',
      },
    }),
  )
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'default-changed')
})

test('an attempt that stopped being eligible is refused at approval time', () => {
  const result = decideModelChoice(
    decisionInput({
      eligibility: evaluateModelChoiceEligibility(
        eligibleInput({ toolEffectEvidence: 'dispatch-started' }),
      ),
    }),
  )
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'no-longer-eligible')
})

test('the same approval twice starts one attempt', () => {
  const result = decideModelChoice(
    decisionInput({ acceptedIdempotencyKeys: ['key-1'] }),
  )
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'already-accepted')
})

test('an acceptance cannot smuggle a model of its own', () => {
  // The only thing an approval says is "yes, the pair you showed me". A
  // payload naming a model would be an arbitrary override API.
  assert.deepEqual(
    readModelChoiceAcceptance({
      offerId: 'offer-1',
      idempotencyKey: 'key-1',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
    }),
    undefined,
  )
  assert.deepEqual(
    readModelChoiceAcceptance({ offerId: 'offer-1', idempotencyKey: 'key-1' }),
    { offerId: 'offer-1', idempotencyKey: 'key-1' },
  )
})

test('an acceptance missing its identity is refused', () => {
  for (const value of [
    null,
    'offer-1',
    {},
    { offerId: 'offer-1' },
    { idempotencyKey: 'key-1' },
    { offerId: '', idempotencyKey: 'key-1' },
  ]) {
    assert.equal(readModelChoiceAcceptance(value), undefined, JSON.stringify(value))
  }
})

// ─── Reading the durable chat record ────────────────────────────────────────

test('only a pre-dispatch credential failure proves nothing ran', () => {
  // "Before a request could be built" is the one phase that proves no tool
  // could have been dispatched. Every other phase leaves the question open,
  // and an open question is answered `unknown`, never "probably fine".
  assert.equal(
    deriveToolEffectEvidence({ failurePhase: 'credential', assignmentCount: 0 }),
    'none-observed',
  )
  for (const failurePhase of ['request', 'response', 'decode'] as const) {
    assert.equal(
      deriveToolEffectEvidence({ failurePhase, assignmentCount: 0 }),
      'unknown',
      failurePhase,
    )
  }
})

test('an assignment that ran leaves the question open even before dispatch', () => {
  assert.equal(
    deriveToolEffectEvidence({ failurePhase: 'credential', assignmentCount: 1 }),
    'unknown',
  )
})

test('a record with no provider failure at all says unknown', () => {
  assert.equal(deriveToolEffectEvidence({ assignmentCount: 0 }), 'unknown')
})

test('the chat failure vocabulary maps onto the same eligibility rule', () => {
  assert.equal(
    evaluateModelChoiceEligibility(
      eligibleInput({ failureKind: 'credential_missing' }),
    ).reason,
    'missing-credential',
  )
  assert.equal(
    evaluateModelChoiceEligibility(
      eligibleInput({ failureKind: 'provider_unsupported' }),
    ).reason,
    'unknown-model',
  )
  // An HTTP status alone does not say the model is the problem.
  assert.deepEqual(
    evaluateModelChoiceEligibility(eligibleInput({ failureKind: 'http_status' })),
    { eligible: false, reason: 'failure-not-model-specific' },
  )
})

test('an offer identity binds the exact pair, agent, turn and revision', () => {
  const base = {
    scope: { kind: 'chat' as const, sessionId: 'session-1', turnId: 'turn-1' },
    agentName: 'reviewer',
    expectedRevision: 'revision-1',
    proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
  }
  const identity = modelChoiceOfferId(base)

  assert.equal(identity, modelChoiceOfferId({ ...base }))
  for (const changed of [
    { ...base, agentName: 'other' },
    { ...base, expectedRevision: 'revision-2' },
    {
      ...base,
      proposedDefault: { provider: 'connection:abc', model: 'gpt-5.6-sol' },
    },
    {
      ...base,
      scope: { kind: 'chat' as const, sessionId: 'session-1', turnId: 'turn-2' },
    },
  ]) {
    assert.notEqual(modelChoiceOfferId(changed), identity, JSON.stringify(changed))
  }
})

test('only the adapter saying it sent nothing proves no tool ran', () => {
  // A reply always runs on an assignment, so the conversation record alone
  // proves nothing. The failure *phase* proves nothing either: it is a
  // category, and a provider can fail to authenticate having already run. The
  // one positive fact is the adapter's own claim that it refused before making
  // the request.
  assert.equal(
    deriveExecutionToolEffectEvidence({
      failurePhase: 'provider-request',
      dispatched: false,
    }),
    'none-observed',
  )
  for (const failurePhase of [
    'provider-resolution',
    'tool-discovery',
    'provider-request',
    'artifact-publication',
    'assistant-persistence',
  ] as const) {
    assert.equal(
      deriveExecutionToolEffectEvidence({ failurePhase }),
      'unknown',
      failurePhase,
    )
  }
  assert.equal(
    deriveExecutionToolEffectEvidence({ failurePhase: 'tool-execution' }),
    'dispatch-started',
  )
  assert.equal(deriveExecutionToolEffectEvidence({}), 'unknown')
})

test('a dispatched attempt is unknown however early its failure was filed', () => {
  // The case this rule exists for: an adapter that authenticated late, or ran
  // for a while and reported a credential failure at exit.
  assert.equal(
    deriveExecutionToolEffectEvidence({
      failurePhase: 'provider-resolution',
      dispatched: true,
    }),
    'unknown',
  )
})

test('an executed tool call blocks the offer whatever the phase says', () => {
  assert.equal(
    deriveExecutionToolEffectEvidence({
      failurePhase: 'provider-resolution',
      dispatched: false,
      executedToolCallCount: 1,
    }),
    'dispatch-started',
  )
})

test('a failure that could not even reach a request is recorded before the request phase', () => {
  // The phase is what proves nothing ran. A credential problem that is filed
  // under `provider-request` makes an unsent request look like a sent one.
  assert.equal(
    modelFailurePhaseFor('authentication'),
    'provider-resolution',
  )
  assert.equal(modelFailurePhaseFor('configuration'), 'provider-resolution')
  assert.equal(modelFailurePhaseFor('billing'), 'provider-resolution')
  assert.equal(modelFailurePhaseFor('timeout'), 'provider-request')
  assert.equal(modelFailurePhaseFor('server_error'), 'provider-request')
})

// ─── One-shot authorization ─────────────────────────────────────────────────
//
// An approved retry inside a run has to reach the process that dispatches the
// agent. What travels is an authorization, not a configuration: it names one
// offer, one agent and the exact pair the user was shown, and the resolver
// honours it only when all three still describe the situation the user
// approved. It is deliberately not a team setting — nothing merges it into a
// team config, and it applies to one invocation.

const AUTHORIZATION: ApprovedModelChoiceAuthorization = {
  offerId: 'offer-1',
  agentName: 'reviewer',
  failedChoice: { provider: 'anthropic', model: 'claude-opus-4-6' },
  proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
}

const AUTHORIZED_DEFAULT: AppDefaultModelState = {
  status: 'available',
  provider: 'connection:abc',
  model: 'gpt-5.4-mini',
}

test('an authorization runs the named agent on the pair the user approved', () => {
  const result = resolveAuthorizedAgentModelChoice({
    agentName: 'reviewer',
    agentChoice: { mode: 'explicit', provider: 'anthropic', model: 'claude-opus-4-6' },
    authorization: AUTHORIZATION,
    appDefault: AUTHORIZED_DEFAULT,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.ok ? result.selection : undefined, {
    provider: 'connection:abc',
    model: 'gpt-5.4-mini',
    source: 'app-default',
    reason: 'user-approved-retry',
    originalChoice: { provider: 'anthropic', model: 'claude-opus-4-6' },
  })
})

test('an authorization applies to the one agent it names and no other', () => {
  const result = resolveAuthorizedAgentModelChoice({
    agentName: 'summarizer',
    agentChoice: { mode: 'explicit', provider: 'anthropic', model: 'claude-opus-4-6' },
    authorization: AUTHORIZATION,
    appDefault: AUTHORIZED_DEFAULT,
  })

  // Not an error: this agent simply runs the way it always would.
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.selection.source : undefined, 'agent')
})

test("an agent whose own pair changed since the offer is not covered by it", () => {
  // Consent was given for one pair failing. A different pair is a different
  // situation the user never saw.
  const result = resolveAuthorizedAgentModelChoice({
    agentName: 'reviewer',
    agentChoice: { mode: 'explicit', provider: 'anthropic', model: 'claude-sonnet-4-6' },
    authorization: AUTHORIZATION,
    appDefault: AUTHORIZED_DEFAULT,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.ok ? result.selection : undefined, {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    source: 'agent',
    reason: 'explicit-agent-choice',
  })
})

test("an agent that kept its model but changed provider is not covered either", () => {
  // Provider and model are one selection. Matching on the model alone would
  // let an approval for one vendor authorize a call to another.
  const result = resolveAuthorizedAgentModelChoice({
    agentName: 'reviewer',
    agentChoice: { mode: 'explicit', provider: 'claude', model: 'claude-opus-4-6' },
    authorization: AUTHORIZATION,
    appDefault: AUTHORIZED_DEFAULT,
  })

  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.selection.source : undefined, 'agent')
  assert.equal(result.ok ? result.selection.provider : undefined, 'claude')
})

test('a default that kept its model but moved provider is refused', () => {
  const result = resolveAuthorizedAgentModelChoice({
    agentName: 'reviewer',
    agentChoice: { mode: 'explicit', provider: 'anthropic', model: 'claude-opus-4-6' },
    authorization: AUTHORIZATION,
    appDefault: {
      status: 'available',
      provider: 'connection:other',
      model: 'gpt-5.4-mini',
    },
  })

  assert.equal(result.ok, false)
  assert.equal(!result.ok ? result.error.code : undefined, 'stale-approval')
})

test('an application default that moved after the approval is refused', () => {
  // The approval named a pair. Running on whatever the default happens to be
  // now would execute a model the user never saw.
  const result = resolveAuthorizedAgentModelChoice({
    agentName: 'reviewer',
    agentChoice: { mode: 'explicit', provider: 'anthropic', model: 'claude-opus-4-6' },
    authorization: AUTHORIZATION,
    appDefault: {
      status: 'available',
      provider: 'connection:abc',
      model: 'gpt-5.6-sol',
    },
  })

  assert.equal(result.ok, false)
  assert.equal(!result.ok ? result.error.code : undefined, 'stale-approval')
})

test('an agent already in app-default mode is unaffected by an authorization', () => {
  // There is nothing to displace, and labelling it a user-approved retry would
  // put consent in history for a decision nobody had to make.
  const result = resolveAuthorizedAgentModelChoice({
    agentName: 'reviewer',
    agentChoice: { mode: 'app-default' },
    authorization: AUTHORIZATION,
    appDefault: AUTHORIZED_DEFAULT,
  })

  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.selection.reason : undefined, 'agent-default')
})

test('no authorization leaves every agent exactly as it was', () => {
  const result = resolveAuthorizedAgentModelChoice({
    agentName: 'reviewer',
    agentChoice: { mode: 'explicit', provider: 'anthropic', model: 'claude-opus-4-6' },
    appDefault: AUTHORIZED_DEFAULT,
  })

  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.selection.source : undefined, 'agent')
})

test('an authorization read from an untrusted payload is refused unless complete', () => {
  for (const payload of [
    null,
    'authorized',
    { offerId: 'offer-1', agentName: 'reviewer' },
    { ...AUTHORIZATION, offerId: '' },
    { ...AUTHORIZATION, failedChoice: { provider: 'anthropic' } },
    { ...AUTHORIZATION, proposedDefault: { model: 'gpt-5.4-mini' } },
  ]) {
    assert.equal(
      readApprovedModelChoiceAuthorization(payload),
      undefined,
      JSON.stringify(payload),
    )
  }
  assert.deepEqual(
    readApprovedModelChoiceAuthorization({ ...AUTHORIZATION }),
    AUTHORIZATION,
  )
})

// ─── Invocation-scoped permission ───────────────────────────────────────────
//
// Consent is for one invocation, not for an Agent. A step where the same Agent
// speaks more than once must not have one approval cover every one of its
// attempts, so the authorization names the invocation it was given for and the
// resolver refuses any other.

const INVOCATION_AUTHORIZATION: ApprovedModelChoiceAuthorization = {
  offerId: 'offer-1',
  agentName: 'reviewer',
  logicalInvocationId: 'invocation-1',
  failedChoice: { provider: 'anthropic', model: 'claude-opus-4-6' },
  proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
}

test('an approval covers the invocation it was given for', () => {
  const result = resolveAuthorizedAgentModelChoice({
    agentName: 'reviewer',
    logicalInvocationId: 'invocation-1',
    agentChoice: { mode: 'explicit', provider: 'anthropic', model: 'claude-opus-4-6' },
    authorization: INVOCATION_AUTHORIZATION,
    appDefault: AUTHORIZED_DEFAULT,
  })

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.selection.reason, 'user-approved-retry')
})

test('a second invocation of the same agent is not covered', () => {
  // The same agent, the same pair, the same approved default — and an attempt
  // the user was never asked about.
  const result = resolveAuthorizedAgentModelChoice({
    agentName: 'reviewer',
    logicalInvocationId: 'invocation-2',
    agentChoice: { mode: 'explicit', provider: 'anthropic', model: 'claude-opus-4-6' },
    authorization: INVOCATION_AUTHORIZATION,
    appDefault: AUTHORIZED_DEFAULT,
  })

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.selection.source, 'agent')
})

test('an invocation-scoped approval is refused where the invocation is unknown', () => {
  // A dispatch that cannot say which invocation it belongs to cannot be shown
  // to be the one approved.
  const result = resolveAuthorizedAgentModelChoice({
    agentName: 'reviewer',
    agentChoice: { mode: 'explicit', provider: 'anthropic', model: 'claude-opus-4-6' },
    authorization: INVOCATION_AUTHORIZATION,
    appDefault: AUTHORIZED_DEFAULT,
  })

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.selection.source, 'agent')
})

test('an authorization that names no invocation still covers its agent', () => {
  // Chat approvals address one turn and one speaker, so they carry no
  // invocation id. Requiring one there would break the path that works.
  const result = resolveAuthorizedAgentModelChoice({
    agentName: 'reviewer',
    logicalInvocationId: 'invocation-9',
    agentChoice: { mode: 'explicit', provider: 'anthropic', model: 'claude-opus-4-6' },
    authorization: AUTHORIZATION,
    appDefault: AUTHORIZED_DEFAULT,
  })

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.selection.reason, 'user-approved-retry')
})
