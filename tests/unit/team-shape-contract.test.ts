import test from 'node:test'
import assert from 'node:assert/strict'

import {
  depthRounds,
  teamShapeSchema,
  validateShapeAgainstRoster,
} from '../../contracts/schemas/team-shape.js'

/** A shape is only ever read after `safeParse`, so parse it the same way here. */
function parsed(value: unknown) {
  const result = teamShapeSchema.safeParse(value)
  assert.ok(result.success, JSON.stringify(result.error?.issues))
  return result.data
}

test('the schema accepts the three shapes and rejects a fourth', () => {
  assert.equal(
    teamShapeSchema.safeParse({
      kind: 'chain',
      rationale: 'One hands to the next.',
      depth: 'standard',
      order: ['alpha', 'beta'],
    }).success,
    true,
  )
  assert.equal(
    teamShapeSchema.safeParse({
      kind: 'discussion',
      rationale: 'They disagree usefully.',
      depth: 'standard',
      coordinator: 'lead',
      participants: ['alpha', 'beta'],
    }).success,
    true,
  )
  assert.equal(
    teamShapeSchema.safeParse({
      kind: 'review',
      rationale: 'One writes, one checks.',
      depth: 'quick',
      producer: 'writer',
      reviewer: 'checker',
    }).success,
    true,
  )
  assert.equal(
    teamShapeSchema.safeParse({
      kind: 'broadcast',
      rationale: 'Everyone at once.',
      depth: 'quick',
    }).success,
    false,
  )
})

// Roles are flattened onto each variant. The nested `roles: {...}` form an
// earlier draft proposed does not parse, and silently accepting it would let a
// proposal through with no roles at all.
test('a shape nesting its roles under `roles` does not parse', () => {
  assert.equal(
    teamShapeSchema.safeParse({
      kind: 'discussion',
      rationale: 'They disagree usefully.',
      depth: 'standard',
      roles: { coordinator: 'lead', participants: ['alpha'] },
    }).success,
    false,
  )
})

test('every variant requires a rationale and a known depth', () => {
  assert.equal(
    teamShapeSchema.safeParse({
      kind: 'chain', rationale: '', depth: 'standard', order: ['alpha'],
    }).success,
    false,
  )
  assert.equal(
    teamShapeSchema.safeParse({
      kind: 'chain', rationale: 'Ordered.', depth: 'exhaustive', order: ['alpha'],
    }).success,
    false,
  )
})

test('a discussion can offer more specialists than the lead selects for one conversation', () => {
  assert.equal(
    teamShapeSchema.safeParse({
      kind: 'discussion',
      rationale: 'The lead selects the relevant specialists.',
      depth: 'standard',
      coordinator: 'lead',
      participants: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    }).success,
    true,
  )
})

test('depth maps to bounded rounds, never to convergence', () => {
  assert.deepEqual(depthRounds('quick'), { rounds: 1, minRounds: 1 })
  assert.deepEqual(depthRounds('standard'), { rounds: 3, minRounds: 1 })
  assert.deepEqual(depthRounds('thorough'), { rounds: 5, minRounds: 1 })
})

test('a chain order must be a permutation of the roster', () => {
  const roster = ['alpha', 'beta']
  assert.deepEqual(
    validateShapeAgainstRoster(
      parsed({ kind: 'chain', rationale: 'r', depth: 'quick', order: ['beta', 'alpha'] }),
      roster,
    ),
    { ok: true },
  )
  // A name the roster does not have.
  assert.deepEqual(
    validateShapeAgainstRoster(
      parsed({ kind: 'chain', rationale: 'r', depth: 'quick', order: ['alpha', 'gamma'] }),
      roster,
    ),
    {
      ok: false,
      reason: 'Every name in the order must be on the roster.',
      offendingNames: ['gamma'],
    },
  )
  // A roster member left out of the order.
  assert.deepEqual(
    validateShapeAgainstRoster(
      parsed({ kind: 'chain', rationale: 'r', depth: 'quick', order: ['alpha'] }),
      roster,
    ),
    {
      ok: false,
      reason: 'Every team member must appear in exactly one role.',
      offendingNames: ['beta'],
    },
  )
  // The same name twice is not a permutation either.
  assert.deepEqual(
    validateShapeAgainstRoster(
      parsed({ kind: 'chain', rationale: 'r', depth: 'quick', order: ['alpha', 'alpha'] }),
      roster,
    ),
    {
      ok: false,
      reason: 'Every team member must appear in exactly one role.',
      offendingNames: ['alpha', 'beta'],
    },
  )
})

test('a discussion partitions the roster into one coordinator and the rest', () => {
  assert.deepEqual(
    validateShapeAgainstRoster(
      parsed({
        kind: 'discussion', rationale: 'r', depth: 'quick',
        coordinator: 'lead', participants: ['alpha', 'beta'],
      }),
      ['lead', 'alpha', 'beta'],
    ),
    { ok: true },
  )
  // The coordinator is also listed as a participant: the roster is not partitioned.
  assert.deepEqual(
    validateShapeAgainstRoster(
      parsed({
        kind: 'discussion', rationale: 'r', depth: 'quick',
        coordinator: 'lead', participants: ['lead', 'alpha'],
      }),
      ['lead', 'alpha'],
    ),
    {
      ok: false,
      reason: 'Every team member must appear in exactly one role.',
      offendingNames: ['lead'],
    },
  )
  // Fewer than two members cannot be a discussion.
  assert.deepEqual(
    validateShapeAgainstRoster(
      parsed({
        kind: 'discussion', rationale: 'r', depth: 'quick',
        coordinator: 'lead', participants: ['alpha'],
      }),
      ['lead'],
    ),
    {
      ok: false,
      reason: 'A discussion needs at least two team members.',
    },
  )
})

test('a review is exactly two distinct members, and the whole roster', () => {
  assert.deepEqual(
    validateShapeAgainstRoster(
      parsed({
        kind: 'review', rationale: 'r', depth: 'quick',
        producer: 'writer', reviewer: 'checker',
      }),
      ['writer', 'checker'],
    ),
    { ok: true },
  )
  assert.deepEqual(
    validateShapeAgainstRoster(
      parsed({
        kind: 'review', rationale: 'r', depth: 'quick',
        producer: 'writer', reviewer: 'writer',
      }),
      ['writer', 'checker'],
    ),
    {
      ok: false,
      reason: 'The writer and the checker must be different team members.',
      offendingNames: ['writer'],
    },
  )
  // A third agent would never run: a review stage has no membership list.
  assert.deepEqual(
    validateShapeAgainstRoster(
      parsed({
        kind: 'review', rationale: 'r', depth: 'quick',
        producer: 'writer', reviewer: 'checker',
      }),
      ['writer', 'checker', 'spare'],
    ),
    {
      ok: false,
      reason: 'A review team is one writer and one checker.',
      offendingNames: ['spare'],
    },
  )
})
