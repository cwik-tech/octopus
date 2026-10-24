/**
 * Admission has to be a reservation, not a survey.
 *
 * Two properties a scan cannot provide, whatever it scans:
 *
 * Bounded cost. A healthy conversation accumulates activities, and reading all
 * of them on every turn makes the newest turn pay for the entire history — the
 * same growth that per-activity journals exist to avoid.
 *
 * Atomicity. Counting and then claiming are two steps, so two turns can both
 * read one-under-the-cap and both proceed. The cap is then not a cap; it is a
 * number that is usually right.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const DIGEST = 'e5'.repeat(32)

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
  return { directory, workspacePath, sessionId }
}

/**
 * An unresolved turn, taken through the real admission path.
 *
 * Seeding orphan journals would leave the reservation authority ignorant of
 * them, which tests a state the product never produces: a turn takes its slot
 * before it opens its activity.
 */
async function seedUnresolved(
  registry: WorkspaceConversationJournalRegistry,
  workspacePath: string,
  sessionId: string,
  turnId: string,
  maxUnresolved: number,
): Promise<void> {
  const recorder = await resolveConversationTurnJournalRecorder({
    registry,
    owner: { kind: 'run-session', conversationId: sessionId, sessionId },
    turnId,
    workspacePath,
    maxUnresolved,
  })
  assert.ok(recorder)
  await recorder.recordStarted({
    surface: 'run-receptionist',
    userMessageId: `${turnId}:user`,
    requestDigest: DIGEST,
    expectedResponseCount: 1,
    origin: 'client',
  })
  // Released as a request would release it; the slot stays taken because the
  // turn never reached a terminal.
  await recorder.release()
}

test('admitting a turn does not read the whole conversation history', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('conversation-admit-cost-')
  let reads = 0
  const registry = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const counting = new Proxy(registry, {
    get(target, property, receiver) {
      if (property === 'snapshot') {
        return async (...args: Parameters<typeof registry.snapshot>) => {
          reads += 1
          return registry.snapshot(...args)
        }
      }
      return Reflect.get(target, property, receiver) as unknown
    },
  })
  try {
    // A conversation with real history, taken through the real path.
    for (let index = 0; index < 40; index += 1) {
      await seedUnresolved(
        registry,
        workspacePath,
        sessionId,
        randomUUID(),
        200,
      )
    }

    reads = 0
    await resolveConversationTurnJournalRecorder({
      registry: counting,
      owner: { kind: 'run-session', conversationId: sessionId, sessionId },
      turnId: randomUUID(),
      workspacePath,
    }).catch(() => undefined)

    assert.equal(
      reads <= 8,
      true,
      `admitting one turn read ${reads} activities; the newest turn must not pay for the whole history`,
    )
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('two different turns cannot both take the last admission slot', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('conversation-admit-race-')
  const registry = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const owner = {
    kind: 'run-session' as const,
    conversationId: sessionId,
    sessionId,
  }
  try {
    // One under the cap of 3, so exactly one more turn may be admitted.
    for (let index = 0; index < 2; index += 1) {
      await seedUnresolved(registry, workspacePath, sessionId, randomUUID(), 3)
    }

    const attempt = (turnId: string) =>
      resolveConversationTurnJournalRecorder({
        registry,
        owner,
        turnId,
        workspacePath,
        maxUnresolved: 3,
      }).then(
        async (recorder) => {
          await recorder?.release()
          return 'admitted' as const
        },
        () => 'refused' as const,
      )

    const [first, second] = await Promise.all([
      attempt(randomUUID()),
      attempt(randomUUID()),
    ])

    assert.deepEqual(
      [first, second].filter((outcome) => outcome === 'admitted').length,
      1,
      'counting and then claiming lets both through; only a reservation does not',
    )
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a slot is not leaked when the activity cannot be opened', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('conversation-admit-leak-')
  const registry = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const owner = {
    kind: 'run-session' as const,
    conversationId: sessionId,
    sessionId,
  }
  try {
    // The window between taking a slot and opening the activity. A turn that
    // dies here — or whose journal simply cannot be opened — must not hold a
    // slot forever, or a conversation slowly refuses all new work.
    const failing = new Proxy(registry, {
      get(target, property, receiver) {
        if (property === 'acquire') {
          return async () => {
            throw new Error('journal unavailable')
          }
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })

    await assert.rejects(
      resolveConversationTurnJournalRecorder({
        registry: failing,
        owner,
        turnId: randomUUID(),
        workspacePath,
        maxUnresolved: 1,
      }),
    )

    // A cap of one, so a leaked slot is the difference between working and
    // refusing everything from here on.
    const first = await resolveConversationTurnJournalRecorder({
      registry,
      owner,
      turnId: randomUUID(),
      workspacePath,
      maxUnresolved: 1,
    })
    assert.ok(first, 'the failed turn released its slot')
    await first.release()
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a slot reserved by a turn that never existed is eventually healed', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('conversation-admit-heal-')
  const registry = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const owner = {
    kind: 'run-session' as const,
    conversationId: sessionId,
    sessionId,
  }
  try {
    // A process that died between reserving and opening leaves exactly this:
    // an index naming a turn with no activity behind it. No visible failure
    // ever happened, so nothing gave the slot back.
    const activitiesRoot = path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    )
    fs.mkdirSync(activitiesRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(activitiesRoot, '.unresolved.json'),
      // Named the way a turn is named. A record holding anything else is one
      // this build did not write, and reading it as damaged would prove
      // something other than the healing under test.
      JSON.stringify({ turnIds: [randomUUID()] }),
      { encoding: 'utf8', mode: 0o600 },
    )

    // A cap of one: the ghost is holding the only slot.
    const recorder = await resolveConversationTurnJournalRecorder({
      registry,
      owner,
      turnId: randomUUID(),
      workspacePath,
      maxUnresolved: 1,
    })
    assert.ok(
      recorder,
      'a reservation with no activity behind it must not hold a slot forever',
    )
    await recorder.release()
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an unreadable reserved activity keeps its slot rather than releasing it', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('conversation-admit-unreadable-')
  const registry = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const owner = {
    kind: 'run-session' as const,
    conversationId: sessionId,
    sessionId,
  }
  try {
    // A real reserved turn, then damage its journal. "I cannot read this" is
    // not "this is finished": releasing the slot on an unreadable activity
    // makes the cap fail open exactly when something is already wrong.
    const damagedTurn = randomUUID()
    await seedUnresolved(registry, workspacePath, sessionId, damagedTurn, 1)
    fs.rmSync(
      path.join(
        workspacePath,
        'sessions',
        sessionId,
        CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
        damagedTurn,
        '.runtime',
        'execution-journal',
        'manifest.json',
      ),
    )

    // The cap is one and the damaged turn holds it. A new turn must be refused.
    await assert.rejects(
      resolveConversationTurnJournalRecorder({
        registry,
        owner,
        turnId: randomUUID(),
        workspacePath,
        maxUnresolved: 1,
      }),
      'an unreadable activity must not hand its slot away',
    )
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
