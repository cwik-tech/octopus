import assert from 'node:assert/strict'
import test from 'node:test'

import { ENGINE_EVENT_CATEGORIES } from '../../contracts/runtime-events.js'
import {
  classifyEngineEvent,
  engineEventClassificationCoverage,
} from '../../contracts/engine-event-classification.js'

/**
 * ADR §11 requires every legacy log family to be classified before its writer
 * moves. A family is either a canonical execution fact (journal it and derive
 * the legacy view), diagnostic telemetry (keep it out of the journal and stop
 * implying it is authoritative), or artifact/transcript content (keep the
 * content in its owned file and journal only a validated receipt).
 */

test('execution facts are the families that decide or gate execution', () => {
  for (const type of [
    'mcp.tool.requested',
    'mcp.tool.started',
    'mcp.tool.completed',
    'mcp.tool.failed',
    'mcp.tool.cancelled',
    'gate.transition',
    'mcp.approval.requested',
    'mcp.approval.resolved',
    'run.session_started',
  ]) {
    assert.equal(
      classifyEngineEvent({ category: 'tool', type }).kind,
      'execution-fact',
      type,
    )
  }
})

test('transcript and artifact content stays in its owned file', () => {
  assert.equal(
    classifyEngineEvent({ category: 'runtime', type: 'discussion.message' }).kind,
    'content',
    'raw discussion prose must never enter the canonical journal',
  )
  assert.equal(
    classifyEngineEvent({ category: 'artifact', type: 'artifact.written' }).kind,
    'content',
  )
})

test('progress reporting is diagnostic, not authoritative', () => {
  assert.equal(
    classifyEngineEvent({ category: 'agent', type: 'agent.progress' }).kind,
    'diagnostic',
  )
  assert.equal(
    classifyEngineEvent({ category: 'runtime', type: 'planning.status' }).kind,
    'diagnostic',
  )
})

test('an unclassified family fails closed rather than being guessed', () => {
  const unknown = classifyEngineEvent({
    category: 'runtime',
    type: 'something.brand_new',
  })
  assert.equal(unknown.kind, 'unclassified')
  // Migration must refuse to move a family nobody has classified: guessing
  // either loses an execution fact or leaks raw content into the journal.
  assert.equal(unknown.migratable, false)
})

test('every engine event category has a documented default', () => {
  const coverage = engineEventClassificationCoverage()
  for (const category of ENGINE_EVENT_CATEGORIES) {
    assert.ok(coverage.categoryDefaults[category], category)
  }
})

test('an unknown type in an execution-fact category still fails closed', () => {
  // A category default states intent, but it must not silently admit a family
  // nobody classified: `logDelegationEvent` accepts arbitrary event names, so
  // an unrecognized delegation type could otherwise be journaled as an
  // execution fact and carry raw payload content with it.
  for (const category of ['run', 'stage', 'gate', 'tool', 'delegation'] as const) {
    const classification = classifyEngineEvent({
      category,
      type: `${category}.newly_added_by_someone`,
    })
    assert.equal(classification.migratable, false, category)
    assert.equal(classification.kind, 'unclassified', category)
  }
})
