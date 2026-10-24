/**
 * The one stage entry a Team host has admitted, written down.
 *
 * A Team host enters each level by queuing a stage entry and handing it to Pi.
 * Until this record existed, none of that was durable: the transition persisted
 * its destination before the entry that would enter it was created
 * (`team-runtime/level-lifecycle.ts`), the queue itself lived only in memory
 * (`domains/runtime/follow-up.ts`), and the entry was removed from that queue
 * one line before a `void` send. So an interrupted host could not tell "queued
 * and never sent" from "sent, and a turn may already have run and charged a
 * model" — and its restart re-queued the level's opening entry either way.
 *
 * This is what makes those two distinguishable. It is deliberately small: one
 * admission at a time, because the queue hands over one entry at a time; an
 * identity, a state, and the pair the entry was admitted with.
 *
 * Only stage entries are admitted. A runtime notice enters no level, decides no
 * model, and — in the case of a tool-failure notice — is not reconstructible
 * from durable state at all.
 */

import {
  readModelSelectionRecord,
  type ModelSelectionRecord,
} from './agent-model-selection.js'

/**
 * How far the admitted entry got, in the vocabulary this repository already
 * uses for a durable dispatch (`contracts/durable-dispatch.ts:32`).
 *
 * `dispatching` is the one that matters. It is the analogue of `started`, and
 * `core/durable-dispatch.ts:82` already states the rule it implies: a crash
 * between the start barrier and any terminal record leaves the outcome
 * unproven, and recovery must treat it as indeterminate rather than repeat it.
 */
export type HostEntryAdmissionState = 'pending' | 'dispatching' | 'settled'

const ADMISSION_STATES: readonly HostEntryAdmissionState[] = [
  'pending',
  'dispatching',
  'settled',
]

const ADMISSION_FIELDS: readonly string[] = [
  'levelId',
  'visit',
  'state',
  'selection',
]

export interface HostEntryAdmission {
  /**
   * The level this entry enters, by id.
   *
   * An id rather than the checkpoint's own `currentLevelIndex`, because an
   * index is only meaningful against one `team.yaml`: editing the level list
   * between the write and the read would silently re-point a resume at a
   * different stage.
   */
  readonly levelId: string
  /**
   * Which visit to that level this admission belongs to, from
   * `LevelState.visitCount`.
   *
   * A loopback re-enters a level and starts a new visit. Without this, an
   * admission left by an earlier visit would match the later one and resume
   * work the run had already moved past.
   */
  readonly visit: number
  readonly state: HostEntryAdmissionState
  /**
   * The pair this entry was admitted with, as every other model use is
   * recorded.
   *
   * Immutable on purpose. The ordinary resolution reads the application default
   * out of this process's environment
   * (`domains/provider/default-model-selection.ts`), so a recovered entry that
   * re-resolved would silently run on whatever default the *new* launch was
   * given. Resuming means resuming on the pair that was admitted.
   */
  readonly selection: ModelSelectionRecord
}

/**
 * What a checkpoint's admission field turned out to be.
 *
 * `absent` and `invalid` are deliberately different answers, because they lead
 * to opposite decisions. Absent is a checkpoint written by a build that had no
 * admissions, and means "recover the way every run recovered before this
 * existed". Invalid is a record that was written and cannot be read, and means
 * "this host cannot establish what it was about to do" — which fails closed.
 * Collapsing the second into the first would turn a corrupt record into a
 * clean-looking one and replay the work it could not read.
 */
export type HostEntryAdmissionReading =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'admission'; readonly admission: HostEntryAdmission }

export function serializeHostEntryAdmission(
  admission: HostEntryAdmission,
): Record<string, unknown> {
  return {
    levelId: admission.levelId,
    visit: admission.visit,
    state: admission.state,
    selection: { ...admission.selection },
  }
}

export function readHostEntryAdmission(
  value: unknown,
): HostEntryAdmissionReading {
  if (value === undefined) return { kind: 'absent' }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'invalid' }
  }
  const record = value as Record<string, unknown>

  // A field this build does not understand was written by something that knew
  // more than this one does. Reading past it would mean acting on half a
  // decision.
  if (Object.keys(record).some((key) => !ADMISSION_FIELDS.includes(key))) {
    return { kind: 'invalid' }
  }

  const levelId = record.levelId
  if (typeof levelId !== 'string' || !levelId.trim()) return { kind: 'invalid' }

  const visit = record.visit
  if (
    typeof visit !== 'number' ||
    !Number.isInteger(visit) ||
    visit < 0
  ) {
    return { kind: 'invalid' }
  }

  const state = record.state
  if (
    typeof state !== 'string' ||
    !ADMISSION_STATES.some((allowed) => allowed === state)
  ) {
    return { kind: 'invalid' }
  }

  // The same reader every other persisted selection goes through, so a record
  // that would be refused in history is refused here too — including a field
  // that is present but unreadable, and half a displaced pair.
  const selection = readModelSelectionRecord(record.selection)
  if (!selection) return { kind: 'invalid' }

  return {
    kind: 'admission',
    admission: {
      levelId,
      visit,
      state: state as HostEntryAdmissionState,
      selection,
    },
  }
}

// ── The resume rule ──────────────────────────────────────────────────────────

/**
 * What a process starting on a saved run may do about the entry it finds.
 *
 * Pure, and separate from doing it, because the rule is the part that has to be
 * right in every combination and the effects are the part that needs a process
 * to observe. Four answers, and the difference between them is the whole of
 * this phase's conservatism.
 */
export type HostEntryResumeDecision =
  /** Nothing admitted, or an entry whose turn already ended. Start as usual. */
  | 'start'
  /** This exact entry is owed a dispatch. Send it once, on its recorded pair. */
  | 'resume'
  /**
   * The entry was handed over and its outcome cannot be established.
   *
   * It may have started a turn that called tools, published messages and
   * charged a model, or it may never have left. Do not repeat it.
   */
  | 'refuse_indeterminate'
  /**
   * A record was written and cannot be read.
   *
   * Distinct from nothing having been written: the record that would say
   * whether a turn was already handed over is exactly the one that is
   * unreadable, so the run cannot be started safely either.
   */
  | 'refuse_unreadable'
  /**
   * A record for work the run has provably finished with.
   *
   * Not ambiguous, and not a reason to refuse: the admitted level's *own*
   * recorded state says it completed, or that level has since been round
   * again on a later visit. Forget it and carry on; nothing later would ever
   * clear a record whose level the run will not return to.
   */
  | 'discard_stale'
  /**
   * The run is not on the admitted level, and nothing proves it ever left.
   *
   * The position a checkpoint restores is an *index* into whatever level list
   * this process booted with. Insert a level ahead of the admitted one and the
   * same index denotes something else entirely — so "the run is somewhere else"
   * is not, on its own, evidence that the admitted level finished. Treating it
   * as evidence is how an interrupted level gets forgotten and the level now
   * sitting at that index gets dispatched in its place.
   *
   * Refused rather than discarded, and the record is left exactly as it is.
   */
  | 'refuse_changed_definition'

/**
 * Where the run is, and what it records about the level an admission names.
 *
 * `levelId`/`visit` are the position the run booted into. `admittedLevel` is
 * the state of the *admission's own* level, looked up by id rather than by
 * index — it is the only evidence here that survives an edited level list, and
 * absent when this definition has no such level at all.
 */
export interface HostEntryPosition {
  readonly levelId: string | undefined
  readonly visit: number
  readonly admittedLevel?: {
    readonly completed: boolean
    readonly visit: number
  }
}

export function decideHostEntryResume(
  reading: HostEntryAdmissionReading,
  position: HostEntryPosition,
): HostEntryResumeDecision {
  if (reading.kind === 'absent') return 'start'
  if (reading.kind === 'invalid') return 'refuse_unreadable'

  const { admission } = reading
  const here =
    position.levelId !== undefined &&
    admission.levelId === position.levelId &&
    admission.visit === position.visit
  if (here) {
    switch (admission.state) {
      case 'pending':
        return 'resume'
      case 'dispatching':
        return 'refuse_indeterminate'
      case 'settled':
        return 'start'
    }
  }

  // Somewhere else. Which of the two reasons it is has to be settled from
  // evidence keyed by level id, because the position itself is not.
  const admitted = position.admittedLevel
  if (!admitted) return 'refuse_changed_definition'
  if (admitted.completed) return 'discard_stale'
  if (admitted.visit > admission.visit) return 'discard_stale'
  return 'refuse_changed_definition'
}
