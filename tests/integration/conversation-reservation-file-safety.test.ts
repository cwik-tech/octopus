/**
 * Directory checks do not protect files.
 *
 * The activities root is verified segment by segment, which stops a redirected
 * *directory*. The admission index, its cursor, and the temporary file a write
 * renames from are all plain files inside that verified directory, and any of
 * them can be replaced by a link. Reading through one leaks whatever it points
 * at into an authority decision; writing through one puts this process's data
 * somewhere it does not own.
 *
 * So each is opened without following links, and a link where a file belongs is
 * refused rather than resolved.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import {
  reconcileConversationReservations,
  reserveConversationActivity,
} from '../../services/conversation-admission-reservation.js'

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  const activitiesRoot = path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
  )
  fs.mkdirSync(activitiesRoot, { recursive: true, mode: 0o700 })
  return { directory, workspacePath, sessionId, activitiesRoot }
}

const owner = (sessionId: string) => ({
  kind: 'run-session' as const,
  conversationId: sessionId,
  sessionId,
})

test('a symlinked admission index is refused, not read through', async () => {
  const { directory, workspacePath, sessionId, activitiesRoot } =
    makeWorkspace('reservation-file-index-')
  try {
    // Somewhere this process has no business reading. Following the link would
    // let its contents decide whether new work is admitted.
    const elsewhere = path.join(directory, 'elsewhere.json')
    fs.writeFileSync(elsewhere, JSON.stringify({ turnIds: [] }), 'utf8')
    fs.symlinkSync(elsewhere, path.join(activitiesRoot, '.unresolved.json'))

    const outcome = await reserveConversationActivity({
      workspacePath,
      owner: owner(sessionId),
      turnId: randomUUID(),
    })
    assert.equal(
      outcome.kind,
      'indeterminate',
      'an index that is a link cannot be trusted to answer an admission question',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('reconciliation does not write its cursor through a planted link', async () => {
  const { directory, workspacePath, sessionId, activitiesRoot } =
    makeWorkspace('reservation-file-cursor-')
  const registry = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  try {
    // Reconciliation is the only thing that moves the rotation cursor, and the
    // cursor now lives in the retention document — so what has to refuse a link
    // is the document write, on the path reconciliation takes.
    const reserved = await reserveConversationActivity({
      workspacePath,
      owner: owner(sessionId),
      turnId: randomUUID(),
    })
    assert.equal(reserved.kind, 'reserved')

    // A sentinel that cannot be mistaken for anything this build writes.
    const elsewhere = path.join(directory, 'elsewhere-document')
    fs.writeFileSync(elsewhere, 'SENTINEL', 'utf8')
    fs.symlinkSync(elsewhere, path.join(activitiesRoot, '.unresolved.json.tmp'))

    await reconcileConversationReservations({
      workspacePath,
      owner: owner(sessionId),
      registry,
      limit: 1,
    })

    assert.equal(
      fs.readFileSync(elsewhere, 'utf8'),
      'SENTINEL',
      'nothing was written through the staging link',
    )
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a planted temporary target does not capture the index write', async () => {
  const { directory, workspacePath, sessionId, activitiesRoot } =
    makeWorkspace('reservation-file-temp-')
  try {
    // The staging name is fixed, because the conversation lock already means
    // there is no concurrent writer to collide with. So the test can plant
    // exactly the file production will write, and what is being proven is that
    // the write refuses a link rather than that the name was hard to guess.
    const elsewhere = path.join(directory, 'captured.json')
    fs.writeFileSync(elsewhere, 'untouched', 'utf8')
    fs.symlinkSync(elsewhere, path.join(activitiesRoot, '.unresolved.json.tmp'))

    const outcome = await reserveConversationActivity({
      workspacePath,
      owner: owner(sessionId),
      turnId: randomUUID(),
    })
    assert.equal(
      outcome.kind,
      'indeterminate',
      'a write that cannot be made safely fails the admission rather than proceeding',
    )

    assert.equal(
      fs.readFileSync(elsewhere, 'utf8'),
      'untouched',
      'the index write did not follow a planted link',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
