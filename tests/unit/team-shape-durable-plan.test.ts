/**
 * A shape that does not survive the disk is a shape the build will not use.
 *
 * The plan record is re-read from its file whenever this process did not
 * already hold it — after a restart, and on any read that misses the in-memory
 * map. A reader that drops the field would turn the user's chosen discussion
 * back into a chain at exactly the moment nobody is watching.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parseResourceArchitectPlanRecord } from '../../server/resource-architect-durable-records.js'
import { ResourceArchitectStore } from '../../server/resource-architect-store.js'

function storedTeamPlan(shape: unknown): Record<string, unknown> {
  return {
    id: 'plan-1',
    kind: 'team',
    team: {
      teamId: 'debate-team',
      description: 'A team that argues about a decision.',
      tags: [],
      existingAgents: [],
      newAgents: [],
      questionsResolved: [],
      shape,
    },
  }
}

test('a stored shape is read back exactly as it was written', () => {
  const shape = {
    kind: 'discussion',
    rationale: 'They disagree usefully.',
    depth: 'thorough',
    coordinator: 'lead',
    participants: ['alpha', 'beta'],
  }
  const parsed = parseResourceArchitectPlanRecord(storedTeamPlan(shape))
  assert.ok(parsed?.kind === 'team')
  assert.deepEqual(parsed.team.shape, shape)
})

// A file can hold anything, but a malformed shape is not the same as a plan
// that never had one. Failing the whole record would make the plan vanish
// behind a 404 and lose every agent in it, so the record still loads and the
// bad shape is marked rejected for the build and the amendment endpoint to
// refuse by name.
test('a stored shape the contract does not accept is marked rejected, not dropped', () => {
  for (const bad of [
    { kind: 'broadcast', rationale: 'r', depth: 'quick' },
    { kind: 'review', rationale: 'r', depth: 'quick', producer: 'a' },
    'discussion',
    42,
  ]) {
    const parsed = parseResourceArchitectPlanRecord(storedTeamPlan(bad))
    assert.ok(parsed?.kind === 'team', JSON.stringify(bad))
    // The plan is still reachable: its agents are not lost to one bad field.
    assert.equal(parsed.team.teamId, 'debate-team')
    // And it does not read as "no shape chosen", which would build a chain.
    assert.equal(parsed.team.shape, undefined, JSON.stringify(bad))
    assert.equal(parsed.team.shapeRejected, true, JSON.stringify(bad))
  }
})

// Every plan written before shapes existed has no such field, and each one
// still has to load and build the chain it was planned as.
test('a plan file written before shapes existed still loads', () => {
  const record = storedTeamPlan(undefined)
  delete (record.team as Record<string, unknown>).shape
  const parsed = parseResourceArchitectPlanRecord(record)
  assert.ok(parsed?.kind === 'team')
  assert.equal(parsed.team.shape, undefined)
  // Absence is not rejection. This plan builds the chain it was planned as.
  assert.equal(parsed.team.shapeRejected, undefined)
  assert.equal(parsed.team.teamId, 'debate-team')
})

test('a stored shape of explicit null reads as no shape, not as a rejection', () => {
  const parsed = parseResourceArchitectPlanRecord(storedTeamPlan(null))
  assert.ok(parsed?.kind === 'team')
  assert.equal(parsed.team.shape, undefined)
  assert.equal(parsed.team.shapeRejected, undefined)
})

// The rejection marker only works if it survives the round trip a real store
// makes: written to disk by one process, read back by the next. A save that
// dropped it would turn a rejected record into a legacy one on restart, and the
// build would quietly produce the chain instead of refusing.
test('a repaired plan reloads as repaired, and an unrepaired one reloads as rejected', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-shape-'))
  try {
    const shape = {
      kind: 'discussion' as const,
      rationale: 'They disagree usefully.',
      depth: 'standard' as const,
      coordinator: 'lead',
      participants: ['spotter'],
    }
    const base = {
      id: 'plan-1',
      kind: 'team' as const,
      team: {
        teamId: 'debate-team',
        description: 'A team that argues.',
        tags: [],
        existingAgents: [{ name: 'lead', role: 'Lead', rationale: 'Reuse.' }],
        newAgents: [{
          name: 'spotter',
          role: 'Spotter',
          description: 'Finds risk.',
          rationale: 'Needed.',
        }],
        questionsResolved: [],
      },
    }

    const writer = new ResourceArchitectStore(workspace)
    await writer.savePlan({ ...base, team: { ...base.team, shapeRejected: true } })
    // A fresh store, so the record is read from the file rather than served
    // from the writer's own memory.
    const rejected = await new ResourceArchitectStore(workspace).getPlan('plan-1')
    assert.ok(rejected?.kind === 'team')
    assert.equal(rejected.team.shapeRejected, true)
    assert.equal(rejected.team.shape, undefined)

    await writer.savePlan({ ...base, team: { ...base.team, shape } })
    const repaired = await new ResourceArchitectStore(workspace).getPlan('plan-1')
    assert.ok(repaired?.kind === 'team')
    assert.deepEqual(repaired.team.shape, shape)
    assert.equal(repaired.team.shapeRejected, undefined)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
