import {
  ExecutionJournalError,
  type ExecutionJournalAppendInput,
  type ExecutionJournalEvent,
} from '../contracts/execution-journal.js'
import type { ExecutionJournal } from './execution-journal.js'

/**
 * Shared stream-append path for the journal recorders (Phase 8 ADR §4).
 *
 * Recorders keep the stream revision in process, so another writer advancing
 * the same stream leaves that cache stale. A stale cache is a concurrency
 * conflict, and the journal reports the revision it actually holds, so the
 * append is retried once against that view. Only a conflict that survives the
 * refresh is surfaced — as a conflict, never as corruption, which callers
 * treat as an unrecoverable journal.
 */
export async function appendJournalStreamEvent(
  journal: ExecutionJournal,
  input: ExecutionJournalAppendInput,
): Promise<ExecutionJournalEvent> {
  let outcome = await journal.append(input)
  if (outcome.kind === 'revision-conflict') {
    outcome = await journal.append({
      ...input,
      expectedStreamRevision: outcome.actualRevision,
    })
  }
  switch (outcome.kind) {
    case 'appended':
    case 'already-accepted':
      return outcome.event
    case 'revision-conflict':
      throw new ExecutionJournalError(
        'revision_conflict',
        `Journal stream '${input.streamKind}/${input.streamId}' advanced concurrently: expected revision ${outcome.expectedRevision}, found ${outcome.actualRevision}.`,
      )
    case 'event-identity-conflict':
      throw new ExecutionJournalError(
        'event_identity_conflict',
        `Journal event identity '${outcome.eventId}' was reused with different content.`,
      )
  }
}
