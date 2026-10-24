/**
 * A stored operation keeps the identity it was stored under.
 *
 * Recovery matches a saved operation against the receipt written when it ran,
 * and that match is a digest over the whole operation. So what the reader
 * *drops* changes identity as surely as what it changes: an operation saved
 * before authoring retired `tier` would come back hashing differently, and its
 * own evidence would be refused as describing some other operation.
 *
 * This is the compatibility boundary §5 keeps separate from authoring. Nothing
 * here says a grade may be authored — the request schemas refuse one, the
 * output schema does not describe one, and no writer emits one. It says a
 * record already on disk is read back as what it is.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { PlannedAgentSpec } from '../../contracts/agent-generator.js'
import type {
  ResourceStandaloneAgentsPlan,
  ResourceUpdatePlan,
} from '../../contracts/resource-architect.js'
import { parseResourceArchitectPlanRecord } from '../../server/resource-architect-durable-records.js'
import { digestResourceUpdateOperation } from '../../domains/resource-architect/resource-update-operation-digest.js'

/** An operation as a run saved it, before the field was retired. */
function storedPlan(): unknown {
  return {
    id: 'plan-legacy',
    kind: 'resource_updates',
    operations: [
      {
        kind: 'add_team_agents',
        target: { kind: 'team', id: 'contract-review-team' },
        expectedRevision: `sha256:${'a'.repeat(64)}`,
        libraryAgentsToAdd: [
          {
            name: 'scoping-lawyer',
            role: 'Scope reviewer',
            tier: 'strategic',
            rationale: 'Reuse.',
          },
        ],
        newAgentsToCreate: [],
      },
    ],
  }
}

test('an operation saved with a grade hashes the same after it is read back', () => {
  const raw = storedPlan() as {
    operations: Parameters<typeof digestResourceUpdateOperation>[0][]
  }
  const before = digestResourceUpdateOperation(raw.operations[0]!)

  const parsed = parseResourceArchitectPlanRecord(storedPlan())
  assert.ok(parsed, 'the stored plan no longer reads back at all')
  assert.equal(parsed.kind, 'resource_updates')
  if (parsed.kind !== 'resource_updates') return
  const after = digestResourceUpdateOperation(parsed.operations[0]!)

  assert.equal(
    after,
    before,
    'reading a stored operation changed the identity its receipt was written under',
  )
})

/** A new Agent as a plan written after card summaries existed stores it. */
function storedAgentWithSummary(): PlannedAgentSpec {
  return {
    name: 'renewal-risk-reviewer',
    role: 'Renewal risk reviewer',
    summary: 'Flags supplier renewal clauses worth renegotiating.',
    description: 'BRIEF-MARKER: read every renewal clause and list its notice window.',
    rationale: 'No existing Agent reviews renewal terms.',
  }
}

/** A standalone plan written after card summaries existed. */
function storedStandalonePlanWithSummary(): ResourceStandaloneAgentsPlan {
  return { id: 'plan-current', kind: 'standalone_agents', agents: [storedAgentWithSummary()] }
}

/** A Team update plan written after card summaries existed. */
function storedUpdatePlanWithSummary(): ResourceUpdatePlan {
  return {
    id: 'plan-current',
    kind: 'resource_updates',
    operations: [{
      kind: 'add_team_agents',
      target: { kind: 'team', id: 'supplier-review-team' },
      expectedRevision: `sha256:${'b'.repeat(64)}`,
      libraryAgentsToAdd: [],
      newAgentsToCreate: [storedAgentWithSummary()],
    }],
  }
}

test('a plan saved with card summaries reads back exactly, so its identity survives a restart', () => {
  for (const stored of [storedStandalonePlanWithSummary(), storedUpdatePlanWithSummary()]) {
    const parsed = parseResourceArchitectPlanRecord(structuredClone(stored))

    assert.deepEqual(parsed, stored, `${stored.kind} lost a field on the way back from disk`)
  }
  const raw = storedUpdatePlanWithSummary()
  const parsed = parseResourceArchitectPlanRecord(storedUpdatePlanWithSummary())
  assert.ok(parsed?.kind === 'resource_updates')
  assert.equal(
    digestResourceUpdateOperation(parsed.operations[0]!),
    digestResourceUpdateOperation(raw.operations[0]!),
  )
})

test('an update operation saved before card summaries reads back without one and keeps its identity', () => {
  const { summary: _absentBeforeSummaries, ...legacyAgent } = storedAgentWithSummary()
  const stored = storedUpdatePlanWithSummary()
  const [operation] = stored.operations
  assert.ok(operation?.kind === 'add_team_agents')
  const legacy = {
    ...stored,
    operations: [{ ...operation, newAgentsToCreate: [legacyAgent] }],
  }
  const before = digestResourceUpdateOperation(legacy.operations[0]!)

  const parsed = parseResourceArchitectPlanRecord(structuredClone(legacy))

  assert.deepEqual(parsed, legacy, 'the legacy operation came back in a different shape')
  assert.ok(parsed?.kind === 'resource_updates')
  assert.equal(
    digestResourceUpdateOperation(parsed.operations[0]!),
    before,
    'reading an operation saved before summaries changed the identity its receipt names',
  )
})

test('a stored summary is optional for a legacy plan but refused when it is not text', () => {
  const { summary: _absentBeforeSummaries, ...legacyAgent } = storedAgentWithSummary()
  const legacy = { ...storedStandalonePlanWithSummary(), agents: [legacyAgent] }
  const readLegacy = parseResourceArchitectPlanRecord(structuredClone(legacy))
  assert.ok(readLegacy?.kind === 'standalone_agents', 'a plan saved before summaries no longer loads')
  assert.equal('summary' in readLegacy.agents[0]!, false)

  const malformed = {
    ...storedStandalonePlanWithSummary(),
    agents: [{ ...storedAgentWithSummary(), summary: 7 }],
  }
  assert.equal(parseResourceArchitectPlanRecord(malformed), null)
})

// The next turn echoes the plan on screen back as `currentPlan`, and that
// request refuses a blank summary. A blank one read from disk would load, then
// stop the conversation on the next message, so the reader refuses it too.
test('a stored summary that is blank is refused like one that is not text', () => {
  for (const summary of ['', '   ']) {
    const blank = {
      ...storedStandalonePlanWithSummary(),
      agents: [{ ...storedAgentWithSummary(), summary }],
    }
    assert.equal(
      parseResourceArchitectPlanRecord(blank),
      null,
      `the stored summary ${JSON.stringify(summary)} was accepted`,
    )
  }
})
