/**
 * The durable record of the one stage entry a Team host has admitted.
 *
 * A host that is interrupted between levels has to be able to say what it had
 * already decided: which level it was about to enter, on which visit, on which
 * exact provider/model pair, and how far that entry had got. Recovery is only
 * as conservative as this record is honest, so the reader is the contract that
 * matters most — an admission it cannot read whole must be refused rather than
 * normalised into something clean-looking, and refused *distinctly* from a
 * checkpoint that was written by a build with no admissions at all. Those two
 * lead to opposite decisions: one fails the run closed, the other resumes it
 * the way every run resumed before this record existed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decideHostEntryResume,
  readHostEntryAdmission,
  serializeHostEntryAdmission,
  type HostEntryAdmission,
} from '../../contracts/host-entry-admission.js'
import type { ModelSelectionRecord } from '../../contracts/agent-model-selection.js'

function makeSelection(
  overrides: Partial<ModelSelectionRecord> = {},
): ModelSelectionRecord {
  return {
    provider: 'lm-studio',
    model: 'loopback-b',
    source: 'app-default',
    reason: 'agent-default',
    caller: 'agent',
    ...overrides,
  }
}

function makeAdmission(
  overrides: Partial<HostEntryAdmission> = {},
): HostEntryAdmission {
  return {
    levelId: 'review',
    visit: 1,
    state: 'pending',
    selection: makeSelection(),
    ...overrides,
  }
}

test('an admission survives being written and read back', () => {
  const admission = makeAdmission()

  const reading = readHostEntryAdmission(
    JSON.parse(JSON.stringify(serializeHostEntryAdmission(admission))),
  )

  assert.deepEqual(reading, { kind: 'admission', admission })
})

test('each of the three states round-trips', () => {
  for (const state of ['pending', 'dispatching', 'settled'] as const) {
    const admission = makeAdmission({ state })
    const reading = readHostEntryAdmission(
      JSON.parse(JSON.stringify(serializeHostEntryAdmission(admission))),
    )
    assert.deepEqual(
      reading,
      { kind: 'admission', admission },
      `state '${state}' must survive the round trip`,
    )
  }
})

test('a checkpoint with no admission at all reads as absent, not as invalid', () => {
  // The legacy case: a checkpoint written before this record existed. It must
  // lead to the behaviour every run had before, not to a refusal.
  assert.deepEqual(readHostEntryAdmission(undefined), { kind: 'absent' })
})

test('an admission that is present but unreadable is invalid, never absent', () => {
  // Normalising a corrupt record to "nothing was admitted" is the one answer
  // that is always wrong: it turns a run whose next step cannot be established
  // into one that looks like it never had a next step, and then replays it.
  const unreadable: readonly unknown[] = [
    null,
    'review',
    42,
    [],
    {},
    { levelId: 'review', visit: 1, state: 'pending' },
    { levelId: 'review', visit: 1, selection: makeSelection() },
    { levelId: '', visit: 1, state: 'pending', selection: makeSelection() },
    { levelId: '   ', visit: 1, state: 'pending', selection: makeSelection() },
    { visit: 1, state: 'pending', selection: makeSelection() },
  ]

  for (const value of unreadable) {
    const reading = readHostEntryAdmission(value)
    assert.equal(
      reading.kind,
      'invalid',
      `${JSON.stringify(value)} must be refused as invalid`,
    )
  }
})

test('a visit that is not a whole count is refused', () => {
  // The visit is half the entry's identity. A fractional, negative or
  // non-numeric visit cannot name the attempt this admission belongs to, and a
  // recovery that matched on it anyway could re-enter a level's earlier visit.
  for (const visit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
    const reading = readHostEntryAdmission({
      levelId: 'review',
      visit,
      state: 'pending',
      selection: makeSelection(),
    })
    assert.equal(
      reading.kind,
      'invalid',
      `visit ${String(visit)} must be refused`,
    )
  }
})

test('a state outside the three the runtime writes is refused', () => {
  for (const state of ['queued', 'started', 'PENDING', '', null, 7]) {
    const reading = readHostEntryAdmission({
      levelId: 'review',
      visit: 0,
      state,
      selection: makeSelection(),
    })
    assert.equal(
      reading.kind,
      'invalid',
      `state ${String(state)} must be refused`,
    )
  }
})

test('a selection that cannot be read whole makes the whole admission invalid', () => {
  // The pair is the point of the record. Half a selection would let a recovery
  // resume on a pair nobody admitted, which is the substitution this whole
  // project exists to prevent — so it is refused here rather than repaired.
  const brokenSelections: readonly unknown[] = [
    { provider: 'lm-studio' },
    { provider: 'lm-studio', model: 'loopback-b' },
    makeSelection({ source: 'team' as ModelSelectionRecord['source'] }),
    makeSelection({ reason: 'catalog-order' as ModelSelectionRecord['reason'] }),
    makeSelection({ caller: 'host' as ModelSelectionRecord['caller'] }),
    { ...makeSelection(), requestedProvider: 'anthropic' },
    { ...makeSelection(), requestedProvider: '' , requestedModel: 'x' },
  ]

  for (const selection of brokenSelections) {
    const reading = readHostEntryAdmission({
      levelId: 'review',
      visit: 1,
      state: 'pending',
      selection,
    })
    assert.equal(
      reading.kind,
      'invalid',
      `selection ${JSON.stringify(selection)} must be refused`,
    )
  }
})

test('an approved retry pair survives, because the admission is what dispatch reads', () => {
  // A selection can legitimately carry the pair an approved retry displaced.
  // Dropping it here would leave the recovered attempt unable to say what it
  // was originally asked to run.
  const admission = makeAdmission({
    selection: makeSelection({
      reason: 'user-approved-retry',
      requestedProvider: 'anthropic',
      requestedModel: 'claude-haiku-4-5',
    }),
  })

  const reading = readHostEntryAdmission(
    JSON.parse(JSON.stringify(serializeHostEntryAdmission(admission))),
  )

  assert.deepEqual(reading, { kind: 'admission', admission })
})

test('fields the runtime never wrote are refused rather than ignored', () => {
  // A record carrying something this build does not understand was written by
  // something else. Reading past it would mean acting on a decision only half
  // of which is understood.
  const reading = readHostEntryAdmission({
    levelId: 'review',
    visit: 1,
    state: 'pending',
    selection: makeSelection(),
    resumeCount: 2,
  })

  assert.equal(reading.kind, 'invalid')
})

// ── The resume rule ──────────────────────────────────────────────────────────

const HERE = { levelId: 'review', visit: 1 }

function decideFor(
  admission: HostEntryAdmission,
  position: { readonly levelId: string | undefined; readonly visit: number } = HERE,
): ReturnType<typeof decideHostEntryResume> {
  return decideHostEntryResume({ kind: 'admission', admission }, position)
}

test('a run with nothing admitted starts the way every run started before', () => {
  assert.equal(decideHostEntryResume({ kind: 'absent' }, HERE), 'start')
})

test('a record that cannot be read refuses, rather than starting', () => {
  // The record that would say whether a turn was already handed over is
  // exactly the one that is unreadable, so there is no safe way to continue.
  assert.equal(
    decideHostEntryResume({ kind: 'invalid' }, HERE),
    'refuse_unreadable',
  )
})

test('the entry this level is owed is resumed', () => {
  assert.equal(decideFor(makeAdmission({ state: 'pending' })), 'resume')
})

test('an entry that was handed over is refused as indeterminate', () => {
  assert.equal(
    decideFor(makeAdmission({ state: 'dispatching' })),
    'refuse_indeterminate',
  )
})

test('an entry whose turn already ended leaves the run to start normally', () => {
  assert.equal(decideFor(makeAdmission({ state: 'settled' })), 'start')
})

test('a record for a level the run has left is discarded once that level is recorded complete', () => {
  // Refusing on a record the run is genuinely past would be permanent: nothing
  // later clears a record whose level the run will not return to, so every
  // restart would refuse for ever. What makes it safe to forget is the admitted
  // level's own recorded completion — evidence keyed by id, not by the position
  // the checkpoint restores.
  for (const state of ['pending', 'dispatching', 'settled'] as const) {
    assert.equal(
      decideHostEntryResume(
        { kind: 'admission', admission: makeAdmission({ levelId: 'draft', state }) },
        { levelId: 'review', visit: 1, admittedLevel: { completed: true, visit: 1 } },
      ),
      'discard_stale',
      `a completed level's '${state}' record must be discarded`,
    )
  }
})

test('a record from an earlier visit to this level is discarded too', () => {
  // A loopback re-enters a level and starts a new visit. An admission from the
  // previous visit describes work the run has already been round once, and the
  // level's own visit count is what says so.
  for (const state of ['pending', 'dispatching'] as const) {
    assert.equal(
      decideHostEntryResume(
        { kind: 'admission', admission: makeAdmission({ visit: 0, state }) },
        { levelId: 'review', visit: 1, admittedLevel: { completed: false, visit: 1 } },
      ),
      'discard_stale',
      `a '${state}' record from visit 0 must not match visit 1`,
    )
  }
})

test('a run that is on no level at all refuses rather than forgetting the record', () => {
  // No position to compare against is not proof of anything, least of all that
  // the admitted level finished.
  assert.equal(
    decideFor(makeAdmission({ state: 'pending' }), {
      levelId: undefined,
      visit: 0,
    }),
    'refuse_changed_definition',
  )
})

// ── An index is not an identity ──────────────────────────────────────────────

/**
 * What the run records about the level an admission names.
 *
 * The position a checkpoint restores is an *index* into whatever level list the
 * process booted with, so "the run is not on the admitted level" can mean two
 * completely different things: the run genuinely moved on, or somebody edited
 * `team.yaml` and the index now denotes a different level. Only the first is a
 * reason to forget the record, and only id-keyed evidence can tell them apart.
 */
function at(
  levelId: string | undefined,
  visit: number,
  admittedLevel?: { completed: boolean; visit: number },
): Parameters<typeof decideHostEntryResume>[1] {
  return admittedLevel === undefined
    ? { levelId, visit }
    : { levelId, visit, admittedLevel }
}

test('a record for a level the run has provably completed is discarded', () => {
  // The safe half of the old rule, kept: the admitted level's own recorded
  // state says it finished, and that state is keyed by id, so it survives any
  // reordering of the level list.
  for (const state of ['pending', 'dispatching', 'settled'] as const) {
    assert.equal(
      decideHostEntryResume(
        { kind: 'admission', admission: makeAdmission({ levelId: 'draft', state }) },
        at('review', 0, { completed: true, visit: 1 }),
      ),
      'discard_stale',
      `a completed level's '${state}' record must be discarded`,
    )
  }
})

test('a record from a visit the level has already been round again is discarded', () => {
  assert.equal(
    decideHostEntryResume(
      { kind: 'admission', admission: makeAdmission({ visit: 0, state: 'dispatching' }) },
      at('review', 1, { completed: false, visit: 1 }),
    ),
    'discard_stale',
  )
})

test('a record for a level the run has not left is refused, not discarded', () => {
  // Inserting a level ahead of this one shifts the saved index, so the run
  // boots believing it is somewhere else — while the admitted level's own
  // recorded state still says it is active and on the same visit. Nothing here
  // proves that level finished, so nothing may be dispatched and the record
  // must survive for someone to look at.
  for (const state of ['pending', 'dispatching'] as const) {
    assert.equal(
      decideHostEntryResume(
        { kind: 'admission', admission: makeAdmission({ state }) },
        at('inserted', 0, { completed: false, visit: 1 }),
      ),
      'refuse_changed_definition',
      `a '${state}' record for an unfinished level must be refused`,
    )
  }
})

test('a record for a level this definition no longer has at all is refused', () => {
  assert.equal(
    decideHostEntryResume(
      { kind: 'admission', admission: makeAdmission({ state: 'pending' }) },
      at('draft', 0, undefined),
    ),
    'refuse_changed_definition',
  )
})

test('a record for the level the run is on is decided by its state, as before', () => {
  assert.equal(
    decideHostEntryResume(
      { kind: 'admission', admission: makeAdmission({ state: 'pending' }) },
      at('review', 1, { completed: false, visit: 1 }),
    ),
    'resume',
  )
  assert.equal(
    decideHostEntryResume(
      { kind: 'admission', admission: makeAdmission({ state: 'dispatching' }) },
      at('review', 1, { completed: false, visit: 1 }),
    ),
    'refuse_indeterminate',
  )
})
