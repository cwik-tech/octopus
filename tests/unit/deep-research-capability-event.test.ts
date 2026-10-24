/**
 * The capability blocker as it reaches the durable event log.
 *
 * Contract: the publisher persists the cause and remediation its caller
 * derived, verbatim, beside the recorded codes. Nothing in the event layer
 * decides what the failure means — that belongs to the Deep Research discovery
 * signal, which owns the codes.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  SEARCH_CAPABILITY_BLOCKED_EVENT_TYPE,
  publishSearchCapabilityBlockedEvent,
} from '../../domains/acquisition/acquisition-events.js'
import {
  describeDeepResearchDiscoveryFailure,
  describeDeepResearchDiscoveryRemediation,
} from '../../domains/deep-research/deep-research-discovery-signal.js'

function publish(input: {
  readonly failureCodes: readonly string[]
  readonly cause: string
  readonly remediation: string
}): Record<string, unknown> {
  const assignmentPath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'capability-event-')),
  )
  try {
    publishSearchCapabilityBlockedEvent({
      assignmentPath,
      sessionId: 'session-one',
      laneIds: ['lane-1'],
      providerPriority: ['exa', 'brave'],
      ...input,
    })
    const event = fs
      .readFileSync(path.join(assignmentPath, 'logs', 'engine-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((candidate) => candidate.type === SEARCH_CAPABILITY_BLOCKED_EVENT_TYPE)
    assert.ok(event, 'the capability blocker was published')
    return event.payload as Record<string, unknown>
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
}

test('the event carries the recorded codes and the caller-derived cause', () => {
  const failureCodes = [{ code: 'internal', count: 5 }]
  const payload = publish({
    failureCodes: ['internal'],
    cause: describeDeepResearchDiscoveryFailure(failureCodes),
    remediation: describeDeepResearchDiscoveryRemediation(failureCodes),
  })

  assert.deepEqual(payload.failure_codes, ['internal'])
  assert.match(String(payload.cause), /`internal`/)
  assert.doesNotMatch(
    String(payload.remediation),
    /Exa or Brave Search API key/i,
    'buying a key cannot fix an unreadable settings file',
  )
})

test('a genuinely unconfigured provider still asks for a credential', () => {
  const failureCodes = [{ code: 'not_configured', count: 2 }]
  const payload = publish({
    failureCodes: ['not_configured'],
    cause: describeDeepResearchDiscoveryFailure(failureCodes),
    remediation: describeDeepResearchDiscoveryRemediation(failureCodes),
  })

  assert.deepEqual(payload.failure_codes, ['not_configured'])
  assert.match(String(payload.remediation), /Exa or Brave Search API key/)
})

test('an empty web and an exhausted budget never ask for a credential', () => {
  for (const code of ['no_results', 'access_challenge', 'budget_exhausted']) {
    assert.doesNotMatch(
      describeDeepResearchDiscoveryRemediation([{ code, count: 1 }]),
      /Exa or Brave Search API key/i,
      `${code} is not a missing credential`,
    )
  }
})
