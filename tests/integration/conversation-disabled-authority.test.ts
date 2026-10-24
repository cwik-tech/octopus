/**
 * Journalling can be switched off. Authority cannot be switched off retroactively.
 *
 * The flag decides whether *new* activities are enrolled. It cannot decide that
 * an activity which already has a journal no longer has one: that journal is the
 * durable record a replay is classified against, and a restart with the flag
 * down would otherwise run the turn with no authority at all — appending nothing,
 * proving nothing, and quietly diverging from what is already on disk.
 *
 * Three states, and all three have to be told apart on the real filesystem:
 * nothing here, something here, and something here I cannot read. The third is
 * the one that matters most, because reading it as the first is how a damaged
 * activity becomes an unrecorded turn.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { CONVERSATION_TURN_STREAM_KIND } from '../../domains/conversations/conversation-turn-journal.js'
import {
  readRetentionDocument,
} from '../../services/conversation-terminal-ledger.js'
import { reserveConversationActivity } from '../../services/conversation-admission-reservation.js'
import { ConversationJournalInspectionService } from '../../services/conversation-journal-inspection.js'
import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import { ADMITS_EVERY_INSPECTION } from '../support/journal-inspection-authority.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const CASE_TIMEOUT_MS = 5_000
const DIGEST = 'd5'.repeat(32)

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
  return { directory, workspacePath, sessionId }
}

const owner = (sessionId: string) => ({
  kind: 'run-session' as const,
  conversationId: sessionId,
  sessionId,
})

const activitiesRoot = (workspacePath: string, sessionId: string) =>
  path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
  )

function makeRegistry(workspacePath: string, mode: 'authoritative' | 'disabled') {
  return new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode,
  })
}

/** A turn that started under an authoritative build, then the process ended. */
async function startEnrolledTurn(input: {
  readonly workspacePath: string
  readonly sessionId: string
  readonly turnId: string
}): Promise<void> {
  const registry = makeRegistry(input.workspacePath, 'authoritative')
  try {
    const recorder = await resolveConversationTurnJournalRecorder({
      registry,
      owner: owner(input.sessionId),
      turnId: input.turnId,
      workspacePath: input.workspacePath,
    })
    assert.ok(recorder)
    await recorder.recordStarted({
      surface: 'run-receptionist',
      userMessageId: `${input.turnId}:user`,
      requestDigest: DIGEST,
      expectedResponseCount: 1,
      origin: 'client',
    })
    await recorder.release()
  } finally {
    await registry.close()
  }
}

test(
  'disabled and genuinely absent writes nothing at all',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('disabled-absent-')
    const registry = makeRegistry(workspacePath, 'disabled')
    try {
      const recorder = await resolveConversationTurnJournalRecorder({
        registry,
        owner: owner(sessionId),
        turnId: randomUUID(),
        workspacePath,
      })
      assert.equal(recorder, undefined, 'nothing is enrolled, so nothing is journalled')
      assert.equal(
        fs.existsSync(activitiesRoot(workspacePath, sessionId)),
        false,
        'and a build with journalling off leaves no sidecars behind either — ' +
          'no admission document, no retention record, no directory',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'disabled but already enrolled continues the journal it has',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('disabled-enrolled-')
    const turnId = randomUUID()
    await startEnrolledTurn({ workspacePath, sessionId, turnId })

    // A slot left behind by a turn that never opened its activity. It is
    // exactly what reconciliation exists to reclaim — so if a disabled build
    // runs any housekeeping at all, this is what disappears.
    const stranded = randomUUID()
    assert.equal(
      (
        await reserveConversationActivity({
          workspacePath,
          owner: owner(sessionId),
          turnId: stranded,
        })
      ).kind,
      'reserved',
    )

    const sidecarBefore = fs.readFileSync(
      path.join(activitiesRoot(workspacePath, sessionId), '.unresolved.json'),
      'utf8',
    )

    const registry = makeRegistry(workspacePath, 'disabled')
    try {
      const recorder = await resolveConversationTurnJournalRecorder({
        registry,
        owner: owner(sessionId),
        turnId,
        workspacePath,
      })
      assert.ok(
        recorder,
        'a turn that already has a journal keeps it, whatever the flag says now',
      )
      await recorder.recordPrepared({
        assistantMessageIds: [`${turnId}:assistant:0`],
      })
      await recorder.recordCompleted({
        assistantMessageIds: [`${turnId}:assistant:0`],
      })

      const summary = await recorder.readSummary()
      assert.equal(summary.state, 'completed')
      await recorder.release()

      // The same journal, continued — not a second one alongside it.
      const reader = makeRegistry(workspacePath, 'authoritative')
      try {
        const snapshot = await reader.snapshot({
          owner: owner(sessionId),
          activityId: turnId,
          activityKind: 'turn',
        })
        assert.equal(snapshot.kind, 'read')
        const events = snapshot.kind === 'read' ? snapshot.events : []
        assert.deepEqual(
          events.map((event) => event.type),
          [
            'conversation.turn.started',
            'conversation.turn.prepared',
            'conversation.turn.completed',
          ],
          'one continuous stream across the restart',
        )
      } finally {
        await reader.close()
      }

      assert.equal(
        fs.readFileSync(
          path.join(activitiesRoot(workspacePath, sessionId), '.unresolved.json'),
          'utf8',
        ),
        sidecarBefore,
        'and a disabled build still runs no housekeeping over the conversation',
      )
      const document = await readRetentionDocument(
        activitiesRoot(workspacePath, sessionId),
      )
      assert.notEqual(document, 'damaged')
      assert.equal(
        document === 'damaged' ? false : document.openTurnIds.has(stranded),
        true,
        'the slot reconciliation would have reclaimed is untouched, because a ' +
          'build that is not journalling does not reconcile',
      )
      assert.equal(
        document === 'damaged' ? true : document.retained.length === 0,
        true,
        'and the completed turn was not recorded into a retention document ' +
          'this build is not maintaining',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'disabled with evidence it cannot read fails closed',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('disabled-damaged-')
    const turnId = randomUUID()
    await startEnrolledTurn({ workspacePath, sessionId, turnId })

    // The activity is plainly there and its manifest is not. That is neither
    // "nothing here" nor a journal this build can continue, and treating it as
    // the former would run the turn with no authority over an activity that
    // demonstrably has one.
    fs.rmSync(
      path.join(
        activitiesRoot(workspacePath, sessionId),
        turnId,
        '.runtime',
        'execution-journal',
        'manifest.json',
      ),
    )

    const registry = makeRegistry(workspacePath, 'disabled')
    try {
      await assert.rejects(
        resolveConversationTurnJournalRecorder({
          registry,
          owner: owner(sessionId),
          turnId,
          workspacePath,
        }),
        /unavailable/i,
        'damaged evidence is never read as absence',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

/** Where an activity's manifest lives, relative to its scope root. */
const MANIFEST_SEGMENTS = ['.runtime', 'execution-journal', 'manifest.json']

function manifestPath(
  workspacePath: string,
  sessionId: string,
  turnId: string,
): string {
  return path.join(
    activitiesRoot(workspacePath, sessionId),
    turnId,
    ...MANIFEST_SEGMENTS,
  )
}

test(
  'a link where an activity belongs is not read as nothing being there',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('disabled-linkdir-')
    const registry = makeRegistry(workspacePath, 'disabled')
    try {
      // A link whose target does not exist. Asking "does this path exist?"
      // answers no — it follows the link and finds nothing — so the activity
      // reads as absent and the turn runs with no authority, even though what
      // is on disk is plainly not nothing.
      const turnId = randomUUID()
      fs.mkdirSync(activitiesRoot(workspacePath, sessionId), { recursive: true })
      fs.symlinkSync(
        path.join(directory, 'no-such-target'),
        path.join(activitiesRoot(workspacePath, sessionId), turnId),
      )

      await assert.rejects(
        resolveConversationTurnJournalRecorder({
          registry,
          owner: owner(sessionId),
          turnId,
          workspacePath,
        }),
        /unavailable/i,
        'a link standing in for an activity is evidence, not absence',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a manifest that is a link or a directory is not an enrolled journal',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('disabled-linkman-')
    const linked = randomUUID()
    const foldered = randomUUID()
    await startEnrolledTurn({ workspacePath, sessionId, turnId: linked })
    await startEnrolledTurn({ workspacePath, sessionId, turnId: foldered })

    // Following a link here would let something outside this activity answer a
    // question about what is inside it — and answer it as "yes, enrolled".
    const elsewhere = path.join(directory, 'someone-elses-manifest.json')
    fs.writeFileSync(elsewhere, '{}', 'utf8')
    fs.rmSync(manifestPath(workspacePath, sessionId, linked))
    fs.symlinkSync(elsewhere, manifestPath(workspacePath, sessionId, linked))

    fs.rmSync(manifestPath(workspacePath, sessionId, foldered))
    fs.mkdirSync(manifestPath(workspacePath, sessionId, foldered))

    const registry = makeRegistry(workspacePath, 'disabled')
    try {
      for (const turnId of [linked, foldered]) {
        await assert.rejects(
          resolveConversationTurnJournalRecorder({
            registry,
            owner: owner(sessionId),
            turnId,
            workspacePath,
          }),
          /unavailable/i,
          'only a regular manifest file counts as a journal this build can continue',
        )
      }
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a path that cannot be examined is never reported as absent',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('disabled-unreadable-')
    const turnId = randomUUID()
    // Injected rather than produced by chmod: whether a permission bit actually
    // denies access depends on who the test runs as, and a check that quietly
    // stops checking on CI is worse than no check.
    const denied = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    })
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'disabled',
      inspectPath: async () => {
        throw denied
      },
    })
    try {
      await assert.rejects(
        resolveConversationTurnJournalRecorder({
          registry,
          owner: owner(sessionId),
          turnId,
          workspacePath,
        }),
        /unavailable/i,
        'an answer nobody could establish must not become "there is nothing here"',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'enrollment is decided by what is actually on disk, not by what exists',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('disabled-classify-')
    const healthy = randomUUID()
    const linkedManifest = randomUUID()
    const folderManifest = randomUUID()
    await startEnrolledTurn({ workspacePath, sessionId, turnId: healthy })
    await startEnrolledTurn({ workspacePath, sessionId, turnId: linkedManifest })
    await startEnrolledTurn({ workspacePath, sessionId, turnId: folderManifest })

    // Asked as "does this path exist?", every one of these answers yes, and the
    // activity reads as enrolled. What the answer has to depend on is what the
    // path *is*.
    const elsewhere = path.join(directory, 'a-real-file.json')
    fs.writeFileSync(elsewhere, '{}', 'utf8')
    fs.rmSync(manifestPath(workspacePath, sessionId, linkedManifest))
    fs.symlinkSync(elsewhere, manifestPath(workspacePath, sessionId, linkedManifest))
    fs.rmSync(manifestPath(workspacePath, sessionId, folderManifest))
    fs.mkdirSync(manifestPath(workspacePath, sessionId, folderManifest))

    const plainFile = randomUUID()
    fs.writeFileSync(
      path.join(activitiesRoot(workspacePath, sessionId), plainFile),
      'not an activity',
      'utf8',
    )

    const registry = makeRegistry(workspacePath, 'disabled')
    try {
      const classify = (turnId: string) =>
        registry.classifyActivityEnrollment({
          owner: owner(sessionId),
          activityId: turnId,
          activityKind: 'turn',
        })

      assert.equal(await classify(healthy), 'enrolled')
      assert.equal(await classify(randomUUID()), 'absent')
      assert.equal(
        await classify(plainFile),
        'indeterminate',
        'a file where an activity belongs is not an activity, and not nothing',
      )
      assert.equal(
        await classify(linkedManifest),
        'indeterminate',
        'a manifest that is a link lets something outside answer for what is inside',
      )
      assert.equal(
        await classify(folderManifest),
        'indeterminate',
        'and a directory named manifest.json is not a manifest',
      )

      // The one that is not merely damage. A link here resolves cleanly all the
      // way down to a real, valid manifest — another activity's — so every
      // question asked about the path answers yes, and this turn would be run
      // against a journal belonging to something else entirely.
      const redirected = randomUUID()
      fs.symlinkSync(
        path.join(activitiesRoot(workspacePath, sessionId), healthy),
        path.join(activitiesRoot(workspacePath, sessionId), redirected),
      )
      assert.equal(
        fs.existsSync(manifestPath(workspacePath, sessionId, redirected)),
        true,
        'the redirect really does resolve to a valid manifest',
      )
      assert.equal(
        await classify(redirected),
        'indeterminate',
        'a link is never followed into another activity’s journal',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'an activity that cannot be examined is not reported as already gone',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('disabled-deletefail-')
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
      inspectPath: async () => {
        throw denied
      },
    })
    try {
      // Retention advances past whatever deletion says is gone. Reporting an
      // activity nobody could examine as `absent` therefore does not just fail
      // to delete it — it moves the record past it, so nothing ever comes back
      // to it and it stays on disk with no reference to it anywhere.
      assert.equal(
        await registry.deleteActivity({
          owner: owner(sessionId),
          activityId: randomUUID(),
          activityKind: 'turn',
        }),
        'busy',
        'could-not-tell is not proof that there is nothing to forget',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'an operator report says whether journalling was on, not just that it is empty',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // "This conversation recorded nothing" and "nothing was being recorded"
    // are different facts and they look identical in a report that only
    // carries turns. The first is a conversation an operator can stop
    // investigating; the second is one where the evidence was never collected,
    // and reading it as the first is how a build with the flag down looks
    // healthy.
    const { directory, workspacePath, sessionId } = makeWorkspace('report-mode-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'disabled',
    })
    try {
      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        authority: ADMITS_EVERY_INSPECTION,
        registry,
      })
      const outcome = await inspection.inspectRunSession({ sessionId })
      assert.equal(outcome.kind, 'report')
      assert.deepEqual(outcome.kind === 'report' ? outcome.report.turns : ['?'], [])
      assert.equal(
        outcome.kind === 'report' ? outcome.report.journalMode : undefined,
        'disabled',
        'an empty report from a build that records nothing has to say so',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a report from a recording build says that too',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('report-mode-on-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        authority: ADMITS_EVERY_INSPECTION,
        registry,
      })
      const outcome = await inspection.inspectRunSession({ sessionId })
      assert.equal(outcome.kind, 'report')
      assert.equal(
        outcome.kind === 'report' ? outcome.report.journalMode : undefined,
        'authoritative',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a disabled build still reports the turns an enrolled activity already holds',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // The flag decides what is enrolled next, never what is already recorded.
    // A report that showed an empty conversation here because journalling is
    // off would be hiding the durable evidence the operator came for.
    const { directory, workspacePath, sessionId } = makeWorkspace('report-sticky-')
    const recording = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    const turnId = randomUUID()
    try {
      const recorder = await resolveConversationTurnJournalRecorder({
        registry: recording,
        owner: owner(sessionId),
        turnId,
        workspacePath,
      })
      assert.ok(recorder)
      await recorder.recordStarted({
        surface: 'run-receptionist',
        userMessageId: `${turnId}:user`,
        requestDigest: DIGEST,
        expectedResponseCount: 1,
        origin: 'client',
      })
      await recorder.release()
    } finally {
      await recording.close()
    }

    // The same workspace, reopened by a build that enrols nothing.
    const disabled = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'disabled',
    })
    try {
      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        authority: ADMITS_EVERY_INSPECTION,
        registry: disabled,
      })
      const outcome = await inspection.inspectRunSession({ sessionId })
      assert.equal(outcome.kind, 'report')
      const report = outcome.kind === 'report' ? outcome.report : undefined
      assert.equal(report?.journalMode, 'disabled')
      assert.deepEqual(
        report?.turns.map((turn) => [turn.activityId, turn.state]),
        [[turnId, 'started']],
        'a turn that was recorded is still reported by a build that records none',
      )
    } finally {
      await disabled.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
