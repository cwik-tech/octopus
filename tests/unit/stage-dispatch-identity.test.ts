import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import { buildStageDispatchInvocationId } from '../../core/stage-dispatch-identity.js'

const base = {
  sessionId: 'session-1',
  levelId: 'draft',
  visitCount: 0,
  stageType: 'chain',
  slot: 'step:2',
  target: 'writer',
}

test('the same slot on a re-executed stage keeps its dispatch identity', () => {
  assert.equal(
    buildStageDispatchInvocationId(base),
    buildStageDispatchInvocationId({ ...base }),
  )
})

test('a different slot, visit, or agent is a different dispatch', () => {
  const identities = new Set([
    buildStageDispatchInvocationId(base),
    buildStageDispatchInvocationId({ ...base, slot: 'step:3' }),
    buildStageDispatchInvocationId({ ...base, visitCount: 1 }),
    buildStageDispatchInvocationId({ ...base, target: 'editor' }),
    buildStageDispatchInvocationId({ ...base, levelId: 'review' }),
    buildStageDispatchInvocationId({ ...base, stageType: 'broadcast' }),
  ])
  assert.equal(identities.size, 6)
})

test('an identity cannot be built from a missing part', () => {
  for (const missing of ['sessionId', 'levelId', 'stageType', 'slot', 'target']) {
    assert.throws(
      () => buildStageDispatchInvocationId({ ...base, [missing]: '  ' }),
      /Stage dispatch identity requires/,
      missing,
    )
  }
  assert.throws(
    () => buildStageDispatchInvocationId({ ...base, visitCount: -1 }),
    /visit count/,
  )
})

/**
 * The guard that keeps the defect from coming back. Without a logical id the
 * dispatcher falls back to `randomUUID()` per execution, so a re-run publishes
 * the same contribution under a new identity and the reader sees it twice.
 */
test('every engine that publishes durable messages supplies a dispatch identity', () => {
  const engines = ['chain', 'broadcast', 'pipeline', 'review', 'discussion']
  const missing = engines.filter((engine) => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'engines', `${engine}.ts`),
      'utf8',
    )
    return (
      source.includes('publishAcceptedTeamChatMessage') &&
      !source.includes('logicalInvocationId')
    )
  })
  assert.deepEqual(missing, [])
})
