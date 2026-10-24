/**
 * Conversation activities are startup-critical, not just operator UI.
 *
 * Discovery feeds the activation preflight, the preflight feeds tenant-pin
 * reconciliation, and `startWorkspaceExecutionJournal` is awaited unguarded
 * from the API composition, the detached session worker and the Team runtime.
 * So a conversation journal that cannot be read, or that is sealed to another
 * tenant, has to be accounted for before a workspace is pinned — otherwise the
 * new scope would be durable state sitting outside tenant protection.
 *
 * These are the cases that decide it: healthy activities stay `ready`, a
 * foreign tenant is refused, and an unreadable one blocks and names its owner.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { computeGenesisEventHash } from '../../core/execution-journal.js'
import { writeBulkTerminalActivities } from '../support/bulk-conversation-activities.js'
import { inspectWorkspaceActivationReadiness } from '../../services/execution-journal-preflight.js'
import { formatPreflightReport } from '../../scripts/execution-journal-preflight.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

/**
 * A uuid-shaped activity id that still sorts by index.
 *
 * An activity is named by a uuid; a fixture that names one anything else is not
 * seeding an activity at all. Ordered by index so "past the page bound" is a
 * position this test can name.
 */
function orderedActivityId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function makeWorkspace(prefix: string): { directory: string; workspacePath: string } {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(workspacePath, { recursive: true })
  return { directory, workspacePath }
}

/** Publish one real conversation activity, the way a turn would. */
async function seedActivity(input: {
  readonly workspacePath: string
  readonly sessionId: string
  readonly activityId: string
  readonly tenantId: string
}): Promise<void> {
  fs.mkdirSync(path.join(input.workspacePath, 'sessions', input.sessionId), {
    recursive: true,
  })
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

/**
 * A correctly bound manifest for one activity.
 *
 * The registry binds `scopeId` to the activity that owns it, so a fixture must
 * write a manifest per activity rather than copying one. The genesis hash is
 * computed from the same identity, so what is seeded is what the registry would
 * itself have written — a fixture that would fail to open is not evidence of
 * normal retained volume.
 */
function seedBoundManifest(input: {
  workspacePath: string
  sessionId: string
  activityId: string
  tenantId: string
  template: Record<string, unknown>
}): void {
  const identity = {
    scopeKind: 'conversation' as const,
    scopeId: input.activityId,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    conversationId: input.sessionId,
    activityKind: 'turn' as const,
  }
  const manifest = {
    ...input.template,
    scopeId: input.activityId,
    tenantId: input.tenantId,
    initialPreviousEventHash: computeGenesisEventHash(identity),
  }
  const target = path.join(
    input.workspacePath,
    'sessions',
    input.sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    input.activityId,
    '.runtime',
    'execution-journal',
  )
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

function activityJournalDirectory(
  workspacePath: string,
  sessionId: string,
  activityId: string,
): string {
  return path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    activityId,
    '.runtime',
    'execution-journal',
  )
}

test('healthy conversation activities leave a workspace ready to pin', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-preflight-ready-')
  const sessionId = randomUUID()
  try {
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

    const report = await inspectWorkspaceActivationReadiness({ workspacePath, environmentTenantId: 'local' })
    assert.equal(report.verdict, 'ready', JSON.stringify(report.problems))
    assert.equal(report.pinnableTenantId, 'local')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a conversation activity sealed to another tenant refuses the pin', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-preflight-tenant-')
  const sessionId = randomUUID()
  try {
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
      tenantId: 'someone-else',
    })

    const report = await inspectWorkspaceActivationReadiness({ workspacePath, environmentTenantId: 'local' })
    assert.equal(
      report.pinnableTenantId,
      undefined,
      'two tenants in one workspace cannot resolve to a pinnable tenant',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an unreadable conversation activity blocks startup and names its owner', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-preflight-blocked-')
  const sessionId = randomUUID()
  const activityId = randomUUID()
  try {
    await seedActivity({ workspacePath, sessionId, activityId, tenantId: 'local' })

    // Durable state nobody can read is not an absent journal.
    fs.rmSync(
      path.join(
        activityJournalDirectory(workspacePath, sessionId, activityId),
        'manifest.json',
      ),
    )

    const report = await inspectWorkspaceActivationReadiness({ workspacePath, environmentTenantId: 'local' })
    assert.equal(report.verdict, 'blocked')
    const problem = report.problems.find(
      (candidate) => candidate.conversationScope?.activityId === activityId,
    )
    assert.ok(problem, 'the blocked verdict names the conversation activity')
    assert.equal(problem.kind, 'indeterminate')
    assert.equal(problem.conversationScope?.sessionId, sessionId)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a manifest below an activity that claims another scope is refused', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-preflight-scope-')
  const sessionId = randomUUID()
  const activityId = randomUUID()
  try {
    await seedActivity({ workspacePath, sessionId, activityId, tenantId: 'local' })

    const manifestPath = path.join(
      activityJournalDirectory(workspacePath, sessionId, activityId),
      'manifest.json',
    )
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >
    manifest.scopeKind = 'assignment'
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')

    const report = await inspectWorkspaceActivationReadiness({ workspacePath, environmentTenantId: 'local' })
    assert.equal(report.verdict, 'blocked')
    assert.ok(
      report.problems.some(
        (candidate) => candidate.conversationScope?.activityId === activityId,
      ),
      'a mislabelled manifest is reported against its activity',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a workspace with no conversations is unaffected', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-preflight-none-')
  try {
    fs.mkdirSync(path.join(workspacePath, 'sessions', randomUUID()), {
      recursive: true,
    })
    const report = await inspectWorkspaceActivationReadiness({ workspacePath, environmentTenantId: 'local' })
    assert.equal(report.verdict, 'ready')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a workspace with more conversations than one page still starts', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-preflight-volume-')
  const sessionId = randomUUID()
  try {
    // Complete activities, not manifest copies. Startup opens every journal it
    // finds, so a fixture that only has name plates is not a fixture for a
    // healthy workspace — it is one for a broken one, and using it as evidence
    // of volume is what let manifest-only activities pass startup at all.
    fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
    const written = writeBulkTerminalActivities({
      workspacePath,
      sessionId,
      tenantId: 'local',
      // One past the page bound, which is exactly where a workspace used to
      // stop booting.
      count: 501,
      firstTerminalAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
    })
    assert.equal(written.length, 501)

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })
    assert.equal(
      report.verdict,
      'ready',
      `holding many conversations is normal, not a reason to refuse startup: ${JSON.stringify(report.problems)}`,
    )
    assert.equal(report.pinnableTenantId, 'local')
    assert.equal(
      report.journalCount >= 501,
      true,
      'the count an operator is shown includes the conversations that were walked',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an unreadable activity past the page bound still blocks', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-preflight-deep-')
  const sessionId = randomUUID()
  try {
    const template = randomUUID()
    await seedActivity({
      workspacePath,
      sessionId,
      activityId: template,
      tenantId: 'local',
    })
    const activitiesRoot = path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    )
    const template_ = JSON.parse(
      fs.readFileSync(
        path.join(
          activityJournalDirectory(workspacePath, sessionId, template),
          'manifest.json',
        ),
        'utf8',
      ),
    ) as Record<string, unknown>
    for (let index = 0; index < 520; index += 1) {
      seedBoundManifest({
        workspacePath,
        sessionId,
        activityId: orderedActivityId(index),
        tenantId: 'local',
        template: template_,
      })
    }

    // Damage one that sorts well past the page bound. Paging the list must not
    // page the safety check.
    const damaged = orderedActivityId(510)
    fs.rmSync(
      path.join(
        activitiesRoot,
        damaged,
        '.runtime',
        'execution-journal',
        'manifest.json',
      ),
    )

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })
    assert.equal(report.verdict, 'blocked')
    assert.ok(
      report.problems.some(
        (candidate) => candidate.conversationScope?.activityId === damaged,
      ),
      'an activity beyond the first page is still examined',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a foreign tenant past the reported page still refuses the pin', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-preflight-deep-tenant-')
  const sessionId = randomUUID()
  try {
    // 520 local activities, then one real activity sealed to another tenant
    // whose id sorts last. Deriving tenant agreement from the reported page
    // would never see it — which is the whole point of the pin.
    const template = randomUUID()
    await seedActivity({
      workspacePath,
      sessionId,
      activityId: template,
      tenantId: 'local',
    })
    const activitiesRoot = path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    )
    const template_ = JSON.parse(
      fs.readFileSync(
        path.join(
          activityJournalDirectory(workspacePath, sessionId, template),
          'manifest.json',
        ),
        'utf8',
      ),
    ) as Record<string, unknown>
    for (let index = 0; index < 520; index += 1) {
      seedBoundManifest({
        workspacePath,
        sessionId,
        activityId: orderedActivityId(index),
        tenantId: 'local',
        template: template_,
      })
    }

    await seedActivity({
      workspacePath,
      sessionId,
      activityId: orderedActivityId(9_999),
      tenantId: 'someone-else',
    })

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })
    assert.equal(
      report.pinnableTenantId,
      undefined,
      'a foreign tenant beyond the page must still be seen',
    )
    assert.equal(
      report.tenantIds.includes('someone-else'),
      true,
      'and it must be named in the report',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an activity whose manifest names another activity is refused', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-manifest-binding-')
  const sessionId = randomUUID()
  try {
    const template = randomUUID()
    await seedActivity({
      workspacePath,
      sessionId,
      activityId: template,
      tenantId: 'local',
    })
    const activitiesRoot = path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    )
    const template_ = JSON.parse(
      fs.readFileSync(
        path.join(
          activityJournalDirectory(workspacePath, sessionId, template),
          'manifest.json',
        ),
        'utf8',
      ),
    ) as Record<string, unknown>

    // A manifest copied under another activity id. The registry binds scopeId
    // to the activity it belongs to, so this is durable state whose identity
    // disagrees with where it lives — not a second healthy activity. Reading it
    // as enrolled would let a workspace look pinnable on the strength of
    // journals that cannot be opened.
    const impostor = randomUUID()
    const target = path.join(activitiesRoot, impostor, '.runtime', 'execution-journal')
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(target, 'manifest.json'),
      JSON.stringify(template_),
      { encoding: 'utf8', mode: 0o600 },
    )

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })
    assert.equal(
      report.verdict,
      'blocked',
      'a manifest bound to another activity cannot be treated as healthy',
    )
    assert.ok(
      report.problems.some(
        (candidate) => candidate.conversationScope?.activityId === impostor,
      ),
      'and the mismatch is reported against the activity holding it',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a manifest that disagrees with its identity in any field is refused', async () => {
  const cases: { name: string; corrupt: (manifest: Record<string, unknown>) => void }[] = [
    {
      name: 'sessionId',
      corrupt: (manifest) => {
        manifest.sessionId = randomUUID()
      },
    },
    {
      name: 'conversationId',
      corrupt: (manifest) => {
        manifest.conversationId = randomUUID()
      },
    },
    {
      name: 'activityKind',
      corrupt: (manifest) => {
        manifest.activityKind = 'planning-attempt'
      },
    },
    {
      name: 'missing activityKind',
      corrupt: (manifest) => {
        delete manifest.activityKind
      },
    },
    {
      name: 'schemaVersion',
      corrupt: (manifest) => {
        manifest.schemaVersion = 99
      },
    },
  ]

  for (const testCase of cases) {
    const { directory, workspacePath } = makeWorkspace(
      `conversation-manifest-${testCase.name.replace(/\s+/g, '-')}-`,
    )
    const sessionId = randomUUID()
    const activityId = randomUUID()
    try {
      await seedActivity({ workspacePath, sessionId, activityId, tenantId: 'local' })
      const manifestPath = path.join(
        activityJournalDirectory(workspacePath, sessionId, activityId),
        'manifest.json',
      )
      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, 'utf8'),
      ) as Record<string, unknown>
      testCase.corrupt(manifest)
      fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')

      const report = await inspectWorkspaceActivationReadiness({
        workspacePath,
        environmentTenantId: 'local',
      })
      assert.equal(
        report.verdict,
        'blocked',
        `a manifest with a wrong ${testCase.name} must block the pin`,
      )
      assert.ok(
        report.problems.some(
          (candidate) => candidate.conversationScope?.activityId === activityId,
        ),
        `and be reported against its activity (${testCase.name})`,
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
})


test('a conversation whose journal cannot be opened blocks activation', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-preflight-journal-')
  const sessionId = randomUUID()
  try {
    // A manifest is a name plate. Startup used to stop there, so an activity
    // with a perfectly good manifest and a journal that is missing, truncated,
    // hash-broken or over its bounds still read as enrolled — and a workspace
    // full of journals nothing can open would pin its tenant and start.
    fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
    const activitiesRoot = path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    )

    const healthy = '00000000-0000-4000-8000-000000000001'
    writeBulkTerminalActivities({
      workspacePath,
      sessionId,
      tenantId: 'local',
      count: 1,
      firstTerminalAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
    })

    const damaged: readonly [string, (journalPath: string) => void][] = [
      ['no journal at all', (journalPath) => fs.rmSync(journalPath)],
      [
        'a line that is not a record',
        (journalPath) => fs.appendFileSync(journalPath, 'not a journal line\n'),
      ],
      [
        'a hash chain that does not hold',
        (journalPath) => {
          const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n')
          const first: unknown = JSON.parse(lines[0] ?? '{}')
          const tampered =
            typeof first === 'object' && first !== null
              ? { ...first, eventHash: 'ab'.repeat(32) }
              : {}
          fs.writeFileSync(
            journalPath,
            `${[JSON.stringify(tampered), ...lines.slice(1)].join('\n')}\n`,
          )
        },
      ],
    ]

    for (const [index, [why, damage]] of damaged.entries()) {
      const activityId = `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`
      writeBulkTerminalActivities({
        workspacePath,
        sessionId,
        tenantId: 'local',
        count: 1,
        firstTerminalAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
      })
      // The bulk helper names its own activities, so copy one into place under
      // the id this case needs and damage that copy.
      const template = path.join(activitiesRoot, '00000000-0000-4000-8000-000000000000')
      const target = path.join(activitiesRoot, activityId)
      fs.cpSync(template, target, { recursive: true })
      const manifestPath = path.join(
        target,
        '.runtime',
        'execution-journal',
        'manifest.json',
      )
      const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      fs.writeFileSync(
        manifestPath,
        `${JSON.stringify({
          ...(typeof manifest === 'object' && manifest !== null ? manifest : {}),
          scopeId: activityId,
        })}\n`,
      )
      damage(path.join(target, '.runtime', 'execution-journal', 'journal.jsonl'))

      const report = await inspectWorkspaceActivationReadiness({
        workspacePath,
        environmentTenantId: 'local',
      })
      assert.equal(
        report.verdict,
        'blocked',
        `'${why}' was accepted: ${report.problems.map((p) => p.detail).join(' | ')}`,
      )
      fs.rmSync(target, { recursive: true, force: true })
    }

    // And the healthy one on its own still starts, so the rule is about the
    // journal rather than about conversations existing.
    assert.notEqual(healthy, '')
    const healthyReport = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })
    assert.equal(
      healthyReport.verdict,
      'ready',
      `a complete activity must still pass: ${healthyReport.problems
        .map((problem) => problem.detail)
        .join(' | ')}`,
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the operator command prints which conversation a problem is about', async () => {
  const { directory, workspacePath } = makeWorkspace('conversation-preflight-cli-')
  const sessionId = randomUUID()
  const activityId = randomUUID()
  try {
    await seedActivity({ workspacePath, sessionId, activityId, tenantId: 'local' })
    fs.rmSync(
      path.join(
        activityJournalDirectory(workspacePath, sessionId, activityId),
        'manifest.json',
      ),
    )

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })
    // The report knows which conversation it is. The command an operator
    // actually runs is where they find out — and it only ever rendered the
    // assignment triple, so a conversation problem printed with no locator at
    // all and left them a workspace-wide search.
    const printed = formatPreflightReport(report)
    assert.match(
      printed,
      new RegExp(`\\[conversation:${sessionId}/${activityId}\\]`),
      `the command named no conversation:\n${printed}`,
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
