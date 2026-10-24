/**
 * Looking at an activity must not change it.
 *
 * Inspection and reconciliation both read journals they do not own: an operator
 * asking what happened, and a later turn deciding whether a slot may go back.
 * Both went through `acquire`, which opens the journal the way a writer does —
 * creating a missing `journal.jsonl`, and truncating a torn tail back to its
 * last acknowledged record.
 *
 * So looking at a damaged activity repaired it, and the evidence that it was
 * damaged went with the repair. Worse, the repair made it readable, so the very
 * next answer said it was fine.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { inspectReservedActivity } from '../../services/conversation-admission-reservation.js'
import { ConversationJournalInspectionService } from '../../services/conversation-journal-inspection.js'
import { ADMITS_EVERY_INSPECTION } from '../support/journal-inspection-authority.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import { writeBulkTerminalActivities } from '../support/bulk-conversation-activities.js'

const CASE_TIMEOUT_MS = 15_000
const SESSION_ID = '00000000-0000-4000-8000-00000000aaaa'
const ACTIVITY_ID = '00000000-0000-4000-8000-000000000000'

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(path.join(workspacePath, 'sessions', SESSION_ID), { recursive: true })
  writeBulkTerminalActivities({
    workspacePath,
    sessionId: SESSION_ID,
    tenantId: 'local',
    count: 1,
    firstTerminalAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
  })
  return { directory, workspacePath }
}

const owner = {
  kind: 'run-session' as const,
  conversationId: SESSION_ID,
  sessionId: SESSION_ID,
}

function journalDirectory(workspacePath: string): string {
  return path.join(
    workspacePath,
    'sessions',
    SESSION_ID,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    ACTIVITY_ID,
    '.runtime',
    'execution-journal',
  )
}

/** Every regular file under the activity, by content, so a repair is visible. */
function fingerprint(workspacePath: string): string {
  const root = journalDirectory(workspacePath)
  const digest = createHash('sha256')
  for (const name of fs.readdirSync(root).sort()) {
    const full = path.join(root, name)
    if (!fs.statSync(full).isFile()) continue
    digest.update(name)
    digest.update(fs.readFileSync(full))
  }
  return digest.digest('hex')
}

function makeRegistry(workspacePath: string) {
  return new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
}

test(
  'reconciliation reads a damaged activity without repairing it',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    for (const [why, damage] of [
      ['a journal that is not there', (root: string) => {
        fs.rmSync(path.join(root, 'journal.jsonl'))
      }],
      ['a record that stops mid-write', (root: string) => {
        fs.appendFileSync(path.join(root, 'journal.jsonl'), '{"eventId":"half-')
      }],
    ] as const) {
      const { directory, workspacePath } = makeWorkspace('peek-readonly-')
      const registry = makeRegistry(workspacePath)
      try {
        damage(journalDirectory(workspacePath))
        const before = fingerprint(workspacePath)

        const verdict = await inspectReservedActivity({
          registry,
          owner,
          turnId: ACTIVITY_ID,
        })
        assert.equal(
          verdict.kind,
          'unreadable',
          `'${why}' was reported as something actionable`,
        )
        assert.equal(
          fingerprint(workspacePath),
          before,
          `'${why}' was repaired by the act of looking at it`,
        )
      } finally {
        await registry.close()
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
  },
)

test(
  'an operator report reads a damaged activity without repairing it',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeWorkspace('peek-report-')
    const registry = makeRegistry(workspacePath)
    try {
      fs.rmSync(path.join(journalDirectory(workspacePath), 'journal.jsonl'))
      const before = fingerprint(workspacePath)

      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        authority: ADMITS_EVERY_INSPECTION,
        registry,
      })
      const outcome = await inspection.inspectRunSession({ sessionId: SESSION_ID })
      assert.equal(outcome.kind, 'report')
      if (outcome.kind !== 'report') return
      assert.equal(
        outcome.report.turns[0]?.integrity,
        'unreadable',
        'a journal that cannot be opened is reported as such',
      )
      assert.equal(
        fingerprint(workspacePath),
        before,
        'and looking at it left it exactly as it was',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
