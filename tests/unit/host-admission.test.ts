/**
 * Moving the host's one admitted stage entry.
 *
 * The rule about *which* entry a restart may act on is pure and tested beside
 * the record (`tests/unit/host-entry-admission.test.ts`). These are the
 * mutations, and what matters about every one of them is that it is exact: the
 * slot holds one admission, several levels' worth of events arrive at it, and a
 * mutation that acted on the wrong one would either mark work finished that was
 * never sent or resurrect work the run had left behind.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  admitHostEntry,
  discardHostEntry,
  hostEntryForLevel,
  markHostEntryDispatching,
  pendingHostEntryFor,
  revertHostEntryToPending,
  settleHostEntry,
} from '../../domains/runtime/host-admission.js'
import { createRuntimeContext } from '../../domains/runtime/runtime-context.js'
import type { RuntimeContext } from '../../domains/runtime/runtime-context.js'
import type { ModelSelectionRecord } from '../../contracts/agent-model-selection.js'

const SELECTION: ModelSelectionRecord = {
  provider: 'lm-studio',
  model: 'loopback-b',
  source: 'app-default',
  reason: 'agent-default',
  caller: 'agent',
}

function makeCtx(): { ctx: RuntimeContext; persists: () => number } {
  const ctx = createRuntimeContext({} as RuntimeContext['pi'])
  let persisted = 0
  ctx.persistRuntimeState = () => {
    persisted += 1
  }
  return { ctx, persists: () => persisted }
}

function admitted(): { ctx: RuntimeContext; persists: () => number } {
  const made = makeCtx()
  admitHostEntry(made.ctx, {
    levelId: 'review',
    visit: 1,
    selection: SELECTION,
  })
  return made
}

test('admitting records the entry without writing anything', () => {
  // The caller writes the destination and this record together; persisting here
  // would split the one write that makes them inseparable into two.
  const { ctx, persists } = admitted()

  assert.deepEqual(ctx.state.hostEntryAdmission, {
    levelId: 'review',
    visit: 1,
    state: 'pending',
    selection: SELECTION,
  })
  assert.equal(persists(), 0)
})

test('a settle for the level whose turn ended records that it ended', () => {
  const { ctx, persists } = admitted()
  markHostEntryDispatching(ctx, 'review')

  settleHostEntry(ctx, 'review')

  assert.equal(ctx.state.hostEntryAdmission?.state, 'settled')
  assert.equal(persists(), 2)
})

test('a settle for another level leaves this one alone', () => {
  // What a handover looks like from here: the slot already holds the
  // destination's admission, and the level that just settled is the previous
  // one. Marking that settled would say the next level's entry had finished
  // before it was ever sent.
  const { ctx } = admitted()
  markHostEntryDispatching(ctx, 'review')

  settleHostEntry(ctx, 'draft')

  assert.equal(ctx.state.hostEntryAdmission?.state, 'dispatching')
})

test('a settle with no level at all settles nothing', () => {
  const { ctx } = admitted()
  markHostEntryDispatching(ctx, 'review')

  settleHostEntry(ctx, null)

  assert.equal(ctx.state.hostEntryAdmission?.state, 'dispatching')
})

test('an entry that was never handed over cannot be settled', () => {
  const { ctx } = admitted()

  settleHostEntry(ctx, 'review')

  assert.equal(ctx.state.hostEntryAdmission?.state, 'pending')
})

test('a dispatch for another level does not move this one', () => {
  const { ctx, persists } = admitted()

  markHostEntryDispatching(ctx, 'draft')

  assert.equal(ctx.state.hostEntryAdmission?.state, 'pending')
  assert.equal(persists(), 0)
})

test('a revert for another level does not put this one back', () => {
  const { ctx } = admitted()
  markHostEntryDispatching(ctx, 'review')

  revertHostEntryToPending(ctx, 'draft')

  assert.equal(ctx.state.hostEntryAdmission?.state, 'dispatching')
})

test('discarding writes, so a record dropped in memory is dropped on disk', () => {
  const { ctx, persists } = admitted()

  discardHostEntry(ctx)

  assert.equal(ctx.state.hostEntryAdmission, undefined)
  assert.equal(persists(), 1)
})

test('discarding nothing writes nothing', () => {
  const { ctx, persists } = makeCtx()

  discardHostEntry(ctx)

  assert.equal(persists(), 0)
})

test('the entry owed a dispatch is found only for its own level and visit', () => {
  // Identity is the pair, not the level alone. A loopback re-enters a level on
  // a new visit, and an admission from the previous visit describes work the
  // run has already been round once.
  const { ctx } = admitted()

  assert.ok(pendingHostEntryFor(ctx, 'review', 1))
  assert.equal(pendingHostEntryFor(ctx, 'review', 2), undefined)
  assert.equal(pendingHostEntryFor(ctx, 'draft', 1), undefined)
  assert.equal(pendingHostEntryFor(ctx, undefined, 1), undefined)
})

test('the record of how a level was entered outlives its entry\'s turn', () => {
  // The pair a level was entered on does not change when a turn ends, and a
  // level can take more than one turn. Keying this on `dispatching` alone would
  // describe the first turn from the record and the second from a fresh
  // resolution — which, after a restart, is a different pair.
  const { ctx } = admitted()

  assert.equal(hostEntryForLevel(ctx, 'review')?.state, 'pending')
  markHostEntryDispatching(ctx, 'review')
  assert.equal(hostEntryForLevel(ctx, 'review')?.state, 'dispatching')
  settleHostEntry(ctx, 'review')
  assert.equal(hostEntryForLevel(ctx, 'review')?.selection.model, 'loopback-b')

  assert.equal(hostEntryForLevel(ctx, 'draft'), undefined)
  assert.equal(hostEntryForLevel(ctx, null), undefined)
})

test('a runtime with no durable state moves its record without writing', () => {
  // The extension-callback tests own no process and set no persist hook.
  // Nothing here may depend on having one.
  const ctx = createRuntimeContext({} as RuntimeContext['pi'])
  admitHostEntry(ctx, { levelId: 'review', visit: 0, selection: SELECTION })

  markHostEntryDispatching(ctx, 'review')
  settleHostEntry(ctx, 'review')
  discardHostEntry(ctx)

  assert.equal(ctx.state.hostEntryAdmission, undefined)
})

// ── A level can take more than one turn ──────────────────────────────────────

test('a second entry for a level whose turn already ended puts it back in flight', () => {
  // A level is not finished when its opening turn settles. A tool-failure
  // notice or a failed completion gate hands the host another entry for the
  // same level, and that turn calls tools and a provider exactly like the
  // first. Leaving the record `settled` across it would mean a crash there
  // reads as "nothing outstanding" — and the restart would replay a level whose
  // coordinator may already have acted.
  const { ctx, persists } = admitted()
  markHostEntryDispatching(ctx, 'review')
  settleHostEntry(ctx, 'review')
  assert.equal(ctx.state.hostEntryAdmission?.state, 'settled')

  markHostEntryDispatching(ctx, 'review')

  assert.equal(ctx.state.hostEntryAdmission?.state, 'dispatching')
  assert.equal(
    ctx.state.hostEntryAdmission?.selection.model,
    'loopback-b',
    'the second turn runs on the pair the level was entered on, not a fresh one',
  )
  assert.equal(ctx.state.hostEntryAdmission?.visit, 1)
  // Admitting does not write; the three state moves do.
  assert.equal(persists(), 3)
})

test('putting an already in-flight record back in flight writes nothing', () => {
  const { ctx, persists } = admitted()
  markHostEntryDispatching(ctx, 'review')
  const writesAfterFirst = persists()

  markHostEntryDispatching(ctx, 'review')

  assert.equal(ctx.state.hostEntryAdmission?.state, 'dispatching')
  assert.equal(persists(), writesAfterFirst)
})
