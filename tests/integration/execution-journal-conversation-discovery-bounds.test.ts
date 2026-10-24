/**
 * Discovery has to stay bounded in what it returns and honest about what it did
 * not see.
 *
 * The walk itself must reach every activity — a foreign tenant or an unreadable
 * journal anywhere in a workspace has to block the pin. What must not grow
 * without limit is the *result*: the reported candidate list, the tenant set,
 * and the count of unreadable activities are all things a caller holds in
 * memory and a route may serialize.
 *
 * And where a bound is hit, activation has to fail closed rather than describe
 * a workspace it only partly summarised.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import {
  ExecutionJournalInspectionService,
  CONVERSATION_DISCOVERY_MAX_TENANTS,
  CONVERSATION_DISCOVERY_MAX_UNREADABLE,
  CONVERSATION_RETAINED_CAP,
} from '../../services/execution-journal-inspection.js'
import { CONVERSATION_MAX_PROJECTED_IDS } from '../../domains/conversations/conversation-turn-retention-policy.js'
import { inspectWorkspaceActivationReadiness } from '../../services/execution-journal-preflight.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
  return { directory, workspacePath, sessionId }
}

/**
 * A uuid-shaped activity id that still sorts by index.
 *
 * An activity is named by a uuid — that is the identity the path resolver, the
 * retention record, this walk and the operator report all agree on — so a
 * fixture that names one anything else is not seeding an activity at all.
 * Ordered by index so a page bound returns a predictable slice.
 */
function orderedActivityId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

/** One correctly bound activity: the manifest names its own activity id. */
async function seedActivity(input: {
  workspacePath: string
  sessionId: string
  activityId: string
  tenantId: string
}): Promise<void> {
  const registry = new WorkspaceConversationJournalRegistry({
    workspacePath: input.workspacePath,
    tenantId: input.tenantId,
    mode: 'authoritative',
  })
  const lease = await registry.acquire({
    owner: {
      kind: 'run-session',
      conversationId: input.sessionId,
      sessionId: input.sessionId,
    },
    activityId: input.activityId,
    activityKind: 'turn',
  })
  assert.ok(lease)
  await lease.release()
  await registry.close()
}

function damage(
  workspacePath: string,
  sessionId: string,
  activityId: string,
): void {
  fs.rmSync(
    path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
      activityId,
      '.runtime',
      'execution-journal',
      'manifest.json',
    ),
  )
}

test('the reported candidate list never exceeds one page', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('discovery-page-')
  try {
    // Half readable, half not. These were collected into separate lists and
    // concatenated, so the result could reach twice the limit.
    for (let index = 0; index < 12; index += 1) {
      const activityId = orderedActivityId(index)
      await seedActivity({ workspacePath, sessionId, activityId, tenantId: 'local' })
      if (index % 2 === 0) damage(workspacePath, sessionId, activityId)
    }

    const service = new ExecutionJournalInspectionService({
      workspacePath,
      authority: { authorize: async () => true },
    })
    const discovery = await service.discoverJournals({ limit: 4 })
    assert.equal(
      discovery.conversationCandidates.length <= 4,
      true,
      `a page of 4 returned ${discovery.conversationCandidates.length} candidates`,
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the tenant set is bounded, and overflowing it fails closed', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('discovery-tenants-')
  try {
    // More distinct tenants than the aggregate may hold. A workspace like this
    // is already wrong; what matters is that it cannot make discovery grow
    // without limit, and cannot be summarised as pinnable.
    for (let index = 0; index <= CONVERSATION_DISCOVERY_MAX_TENANTS + 2; index += 1) {
      await seedActivity({
        workspacePath,
        sessionId,
        activityId: orderedActivityId(index),
        tenantId: `tenant-${index}`,
      })
    }

    const service = new ExecutionJournalInspectionService({
      workspacePath,
      authority: { authorize: async () => true },
    })
    const discovery = await service.discoverJournals({})
    assert.equal(
      discovery.conversationTenantIdsBounded.length <= CONVERSATION_DISCOVERY_MAX_TENANTS,
      true,
      'the tenant aggregate is bounded',
    )
    assert.equal(
      discovery.conversationTenantsOverflowed,
      true,
      'and says it could not hold them all',
    )

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'tenant-0',
    })
    assert.equal(
      report.verdict,
      'blocked',
      'a tenant set that could not be summarised cannot support a pin',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the operator count reports every enrolled activity, not the page', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('discovery-count-')
  try {
    for (let index = 0; index < 9; index += 1) {
      await seedActivity({
        workspacePath,
        sessionId,
        activityId: orderedActivityId(index),
        tenantId: 'local',
      })
    }

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
      limit: 3,
    })
    assert.equal(
      report.enrolledJournalCount,
      9,
      `an operator was told ${report.enrolledJournalCount} of 9 enrolled activities`,
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the walk stops at the retained cap instead of counting past it', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('discovery-cap-')
  try {
    // More activities than a conversation may retain. Startup must not pay to
    // examine them all merely to report how many there are: the fact that the
    // cap was exceeded is the whole answer, and it is available at the bound.
    for (let index = 0; index < 12; index += 1) {
      await seedActivity({
        workspacePath,
        sessionId,
        activityId: orderedActivityId(index),
        tenantId: 'local',
      })
    }

    const service = new ExecutionJournalInspectionService({
      workspacePath,
      authority: { authorize: async () => true },
    })
    const discovery = await service.discoverJournals({
      limit: 4,
      conversationRetainedCap: 5,
    })

    assert.equal(
      discovery.conversationRetainedCapExceeded,
      true,
      'the walk reports that the conversation is over its retained cap',
    )
    assert.equal(
      discovery.conversationCount <= 6,
      true,
      `the walk examined ${discovery.conversationCount} activities; it must stop at the cap, not count the rest`,
    )

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
      conversationRetainedCap: 5,
    })
    assert.equal(
      report.verdict,
      'blocked',
      'a conversation past its retained cap cannot support a pin',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test(
  'entries that are not activities cannot make the walk unbounded',
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('discovery-raw-')
    try {
      // Bounding what a walk *keeps* is not bounding what it *reads*. A
      // directory can be filled with things that are not activities — links,
      // plain files — and a scan that filters them before counting still pulls
      // every one of them, and records every link, before a single activity
      // counts toward its page. Whoever can write into a workspace can make
      // startup pay for as much of that as they like.
      const activities = path.join(
        workspacePath,
        'sessions',
        sessionId,
        CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
      )
      fs.mkdirSync(activities, { recursive: true })
      const elsewhere = path.join(directory, 'elsewhere')
      fs.mkdirSync(elsewhere, { recursive: true })
      for (let index = 0; index < 2_000; index += 1) {
        fs.symlinkSync(elsewhere, path.join(activities, `link-${index}`))
      }
      // A real activity behind them, which the bound may well never reach.
      await seedActivity({
        workspacePath,
        sessionId,
        activityId: randomUUID(),
        tenantId: 'local',
      })

      const service = new ExecutionJournalInspectionService({
        workspacePath,
        authority: { authorize: async () => true },
      })
      const discovery = await service.discoverJournals({ limit: 4 })

      assert.equal(
        discovery.unreadablePaths.length <= CONVERSATION_DISCOVERY_MAX_UNREADABLE,
        true,
        `the unreadable list grew to ${discovery.unreadablePaths.length}, which is ` +
          `whatever someone chose to put in the directory`,
      )
      assert.equal(
        discovery.conversationScanOverflowed,
        true,
        'a walk that stopped short has to say so rather than look complete',
      )

      // And a workspace this walk could not describe cannot be pinned from it.
      const report = await inspectWorkspaceActivationReadiness({
        workspacePath,
        environmentTenantId: 'local',
      })
      assert.equal(
        report.verdict,
        'blocked',
        'nothing here describes the workspace, so nothing here can activate it',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a directory stuffed with plain files stops the walk and blocks activation',
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('discovery-rawfiles-')
    try {
      // Links at least leave a trace: each one is recorded as unaccounted for,
      // so a wall of them is visible in the unreadable list. Plain files leave
      // none — they are simply skipped — so nothing about them is reported and
      // the only thing that can notice them is a bound on how much is read.
      const activities = path.join(
        workspacePath,
        'sessions',
        sessionId,
        CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
      )
      fs.mkdirSync(activities, { recursive: true })
      for (let index = 0; index < 2_000; index += 1) {
        fs.writeFileSync(path.join(activities, `filler-${index}`), '', 'utf8')
      }
      await seedActivity({
        workspacePath,
        sessionId,
        activityId: randomUUID(),
        tenantId: 'local',
      })

      const service = new ExecutionJournalInspectionService({
        workspacePath,
        authority: { authorize: async () => true },
      })
      const discovery = await service.discoverJournals({ limit: 4 })

      assert.deepEqual(
        discovery.unreadablePaths,
        [],
        'nothing here is unreadable, which is exactly why the fault list cannot ' +
          'be what notices it',
      )
      assert.equal(
        discovery.conversationScanOverflowed,
        true,
        'the walk stopped reading, and has to say so on its own account',
      )

      const report = await inspectWorkspaceActivationReadiness({
        workspacePath,
        environmentTenantId: 'local',
      })
      assert.equal(
        report.verdict,
        'blocked',
        'a workspace this walk did not finish reading cannot be pinned from it',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test('a conversation the retention contract permits is not called incomplete', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('discovery-healthy-')
  try {
    // Retention permits far more activities than a bound on raw entries would
    // naturally sit at, so a bound chosen below it turns a perfectly legal
    // conversation into a workspace that cannot be activated. What has to be
    // bounded is the part a caller controls independently of the contract —
    // entries that are not activities — not the activities themselves.
    const activities = path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    )
    fs.mkdirSync(activities, { recursive: true })
    for (let index = 0; index < 1_200; index += 1) {
      fs.mkdirSync(path.join(activities, orderedActivityId(index)))
    }

    const service = new ExecutionJournalInspectionService({
      workspacePath,
      authority: { authorize: async () => true },
    })
    const discovery = await service.discoverJournals({})
    assert.equal(
      discovery.conversationScanOverflowed,
      false,
      'a conversation inside its retention bounds was reported as unreadable',
    )

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })
    assert.notEqual(
      report.verdict,
      'blocked',
      'and a workspace that is within its own limits still activates',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a stuffed sessions directory is not silently walked past', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('discovery-sessions-')
  try {
    // The activities listing is not the only one a caller can fill. Sessions,
    // runs and assignments are read the same way, and a bound that reports
    // nothing when it stops leaves the walk looking complete while an entire
    // session goes unseen.
    await seedActivity({
      workspacePath,
      sessionId,
      activityId: randomUUID(),
      tenantId: 'local',
    })
    const sessionsRoot = path.join(workspacePath, 'sessions')
    for (let index = 0; index < 2_000; index += 1) {
      fs.writeFileSync(path.join(sessionsRoot, `filler-${index}`), '', 'utf8')
    }

    const service = new ExecutionJournalInspectionService({
      workspacePath,
      authority: { authorize: async () => true },
    })
    const discovery = await service.discoverJournals({})
    assert.equal(
      discovery.conversationScanOverflowed,
      true,
      'a listing that stopped short must say so wherever it happened',
    )

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })
    assert.equal(report.verdict, 'blocked')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('directories alone can make a listing unbounded, and must not', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('discovery-dirs-')
  try {
    // Bounding the entries a listing steps over says nothing about the ones it
    // keeps. Sessions, runs and assignments have no page bound at all, so a
    // workspace holding a million session directories is enumerated in full —
    // and directories are exactly what a stuffed-with-files test cannot catch,
    // because files are the part that was already bounded.
    const sessionsRoot = path.join(workspacePath, 'sessions')
    for (let index = 0; index < 12; index += 1) {
      fs.mkdirSync(path.join(sessionsRoot, `session-${String(index).padStart(3, '0')}`), {
        recursive: true,
      })
    }
    await seedActivity({
      workspacePath,
      sessionId,
      activityId: randomUUID(),
      tenantId: 'local',
    })

    const service = new ExecutionJournalInspectionService({
      workspacePath,
      authority: { authorize: async () => true },
    })
    // A small ceiling injected rather than ten thousand directories seeded: the
    // bound is what is being tested, not the number it happens to sit at.
    const discovery = await service.discoverJournals({ hierarchyScanCeiling: 4 })
    assert.equal(
      discovery.conversationScanOverflowed,
      true,
      'a listing that stopped short of the directories it holds must say so',
    )

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
      hierarchyScanCeiling: 4,
    })
    assert.equal(report.verdict, 'blocked')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the activity ceiling leaves room for every activity retention permits', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('discovery-ceiling-')
  try {
    // The two bounds have to compose: whatever ceiling makes the activities
    // listing finite must still sit above the retained cap, or the finiteness
    // bound becomes a second, lower cap that rejects legal conversations.
    const activities = path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    )
    fs.mkdirSync(activities, { recursive: true })
    for (let index = 0; index < 40; index += 1) {
      fs.mkdirSync(path.join(activities, `activity-${String(index).padStart(4, '0')}`))
    }

    const service = new ExecutionJournalInspectionService({
      workspacePath,
      authority: { authorize: async () => true },
    })
    const discovery = await service.discoverJournals({
      conversationRetainedCap: 64,
      hierarchyScanCeiling: 4,
    })
    assert.equal(
      discovery.conversationScanOverflowed,
      false,
      'forty activities under a retained cap of sixty-four is a legal conversation',
    )
    assert.equal(discovery.conversationRetainedCapExceeded, false)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})


test('the walk accepts exactly what admission can create, and no more', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('discovery-exact-cap-')
  try {
    // The two limits have to name the same number. Admission reserves
    // projection capacity for every turn it accepts, so the retained turns and
    // the open ones fit inside one bound — and that bound is the largest number
    // of activity directories production can legitimately create.
    const activities = path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    )
    fs.mkdirSync(activities, { recursive: true })
    // Counted from what admission permits, not from the walk's own constant.
    // Seeding from the walk's number would make this test move with it, and the
    // whole point is that the two have to name the same thing.
    assert.equal(
      CONVERSATION_RETAINED_CAP,
      CONVERSATION_MAX_PROJECTED_IDS,
      'the walk permits exactly what admission can create',
    )
    for (let index = 0; index < CONVERSATION_MAX_PROJECTED_IDS; index += 1) {
      fs.mkdirSync(path.join(activities, orderedActivityId(index)))
    }

    const service = new ExecutionJournalInspectionService({
      workspacePath,
      authority: { authorize: async () => true },
    })
    assert.equal(
      (await service.discoverJournals({})).conversationRetainedCapExceeded,
      false,
      'a conversation at exactly what admission permits is not over any cap',
    )

    fs.mkdirSync(
      path.join(activities, orderedActivityId(CONVERSATION_MAX_PROJECTED_IDS)),
    )
    assert.equal(
      (await service.discoverJournals({})).conversationRetainedCapExceeded,
      true,
      'and one more than that is',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})


test('an oversized or redirected manifest is judged without being read whole', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('discovery-manifest-')
  try {
    // A manifest is a small, fixed document. Measuring it and then reading it
    // are two operations, and reading whatever is there now against a bound
    // taken a moment ago is how a bound stops bounding — so the read itself is
    // what has to be bounded, and it must not follow a link to get there.
    const oversized = randomUUID()
    const redirected = randomUUID()
    await seedActivity({ workspacePath, sessionId, activityId: oversized, tenantId: 'local' })
    await seedActivity({ workspacePath, sessionId, activityId: redirected, tenantId: 'local' })

    const manifestOf = (activityId: string) =>
      path.join(
        workspacePath,
        'sessions',
        sessionId,
        CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
        activityId,
        '.runtime',
        'execution-journal',
        'manifest.json',
      )
    // Valid JSON, valid manifest, and four mebibytes of it. Filler that fails
    // to parse would be refused by the parser and prove nothing about the
    // bound; this one is refused only if the read itself is bounded.
    const realManifest: unknown = JSON.parse(
      fs.readFileSync(manifestOf(oversized), 'utf8'),
    )
    fs.writeFileSync(
      manifestOf(oversized),
      JSON.stringify({
        ...(typeof realManifest === 'object' && realManifest !== null
          ? realManifest
          : {}),
        padding: 'z'.repeat(4 * 1024 * 1024),
      }),
      'utf8',
    )

    const planted = path.join(directory, 'someone-elses-manifest.json')
    fs.writeFileSync(planted, fs.readFileSync(manifestOf(redirected)))
    fs.rmSync(manifestOf(redirected))
    fs.symlinkSync(planted, manifestOf(redirected))

    const service = new ExecutionJournalInspectionService({
      workspacePath,
      authority: { authorize: async () => true },
    })
    const discovery = await service.discoverJournals({})
    for (const activityId of [oversized, redirected]) {
      const candidate = discovery.conversationCandidates.find(
        (entry) => entry.activityId === activityId,
      )
      assert.ok(candidate, `${activityId} was not reported at all`)
      assert.equal(
        candidate.state,
        'indeterminate',
        'a manifest this build will not read is not a healthy activity',
      )
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})


test('a workspace-wide budget stops a walk that would never end', async () => {
  const { directory, workspacePath } = makeWorkspace('discovery-budget-')
  try {
    // Each conversation is bounded and each session listing is bounded, and
    // neither bounds their product: ten thousand sessions holding ten thousand
    // activities each is a hundred million journals to open, every one of them
    // inside its own limit. Startup needs a budget for the walk itself.
    for (let session = 0; session < 3; session += 1) {
      const sessionId = `00000000-0000-4000-8000-${String(session).padStart(12, '0')}`
      fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
      await seedActivity({
        workspacePath,
        sessionId,
        activityId: randomUUID(),
        tenantId: 'local',
      })
      await seedActivity({
        workspacePath,
        sessionId,
        activityId: randomUUID(),
        tenantId: 'local',
      })
    }

    const service = new ExecutionJournalInspectionService({
      workspacePath,
      authority: { authorize: async () => true },
    })
    // Injected so the budget is testable without a hundred million activities.
    const discovery = await service.discoverJournals({ workspaceActivityBudget: 3 })
    assert.equal(
      discovery.conversationScanOverflowed,
      true,
      'a walk that stopped on its budget has not described the workspace',
    )

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
      workspaceActivityBudget: 3,
    })
    assert.equal(report.verdict, 'blocked')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * The two ways an entry can wear an activity's name without being one.
 *
 * A wall of two thousand links blocks because the scan runs out of budget,
 * which says nothing about whether a single one is noticed — and a single one
 * is the case that actually happens.
 */
const IMPOSTOR_SHAPES = [
  {
    name: 'file',
    create: (entryPath: string) => {
      fs.writeFileSync(entryPath, '', 'utf8')
    },
  },
  {
    name: 'symlink',
    create: (entryPath: string, directory: string) => {
      fs.symlinkSync(path.join(directory, 'elsewhere'), entryPath)
    },
  },
] as const

for (const shape of IMPOSTOR_SHAPES) {
  test(
    `a ${shape.name} wearing an activity name is unaccounted for, not filler`,
    async () => {
      const { directory, workspacePath, sessionId } = makeWorkspace(
        `discovery-shaped-${shape.name}-`,
      )
      try {
        // `notes.txt` is something somebody dropped in the directory; a uuid is
        // what an activity is called. An entry under that name holding
        // something that is not an activity is either half-written or
        // deliberate, and both mean an activity is unaccounted for — so
        // stepping over it as filler describes a conversation this walk cannot
        // actually describe.
        const activities = path.join(
          workspacePath,
          'sessions',
          sessionId,
          CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
        )
        fs.mkdirSync(activities, { recursive: true })
        const shaped = randomUUID()
        shape.create(path.join(activities, shaped), directory)
        fs.writeFileSync(path.join(activities, 'notes.txt'), '', 'utf8')
        await seedActivity({
          workspacePath,
          sessionId,
          activityId: randomUUID(),
          tenantId: 'local',
        })

        const service = new ExecutionJournalInspectionService({
          workspacePath,
          authority: { authorize: async () => true },
        })
        const discovery = await service.discoverJournals({ limit: 4 })

        assert.deepEqual(
          discovery.unreadablePaths.map((entry) => path.basename(entry.path)),
          [shaped],
          `the activity-shaped ${shape.name} is named, and the ordinary file is not`,
        )

        const report = await inspectWorkspaceActivationReadiness({
          workspacePath,
          environmentTenantId: 'local',
        })
        assert.equal(
          report.verdict,
          'blocked',
          'a conversation holding something that is not the activity it is ' +
            'named after has not been described',
        )
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    },
  )
}

test('a directory that is not named like an activity does not consume the cap', async () => {
  // Whoever can write into a workspace can drop folders beside the activities:
  // an editor's backup, a `notes` directory, a half-finished copy. None of them
  // is a turn. Counting them against the retained cap means a handful of stray
  // folders makes a healthy conversation read as past its limit — and a
  // conversation past its limit blocks the tenant pin, so a workspace stops
  // booting over a directory nobody meant as an activity.
  const { directory, workspacePath, sessionId } = makeWorkspace('discovery-strays-')
  try {
    await seedActivity({
      workspacePath,
      sessionId,
      activityId: randomUUID(),
      tenantId: 'local',
    })
    const activities = path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    )
    for (const name of ['notes', 'backup', 'drafts', 'tmp-copy', 'old']) {
      fs.mkdirSync(path.join(activities, name), { recursive: true })
    }

    const service = new ExecutionJournalInspectionService({
      workspacePath,
      authority: { authorize: async () => true },
    })
    const discovery = await service.discoverJournals({
      limit: 10,
      conversationRetainedCap: 3,
    })

    assert.equal(
      discovery.conversationRetainedCapExceeded,
      false,
      'five folders that are not activities do not put a one-turn conversation ' +
        'over its retained cap',
    )
    assert.equal(discovery.conversationCount, 1)

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
      conversationRetainedCap: 3,
    })
    assert.notEqual(
      report.verdict,
      'blocked',
      'and nothing here stops the workspace being pinned',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
