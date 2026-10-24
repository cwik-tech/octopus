/** Scheduled artifact naming retains its model-selection record without displaying a model-default card. */
import { _electron as electron, expect, test } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  ANALYST_MODEL,
  APP_DEFAULT_MODEL,
  FIXTURE_PROVIDER,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
} from './support/model-selection-fixture.js'

const SCHEDULED_AGENT = 'artifact-filename-agent'
/** A phrase only the naming helper's own system prompt carries. */
const NAMING_PROMPT_MARKER = 'session title that summarizes'
const GENERATED_TITLE = 'Detached Worker Provider Readiness'

/**
 * Disabled on purpose.
 *
 * This journey fires it deliberately with Run now. An enabled schedule would
 * also be eligible to fire on wall-clock time, which would put work in flight
 * that this test never asked for.
 */
const SEEDED_SCHEDULE = {
  version: 1,
  schedules: [
    {
      id: 'sch_00000000-0000-4000-8000-000000000001',
      name: 'Artifact filename nightly',
      kind: 'agent',
      target: SCHEDULED_AGENT,
      prompt: 'Produce a concise report about detached worker provider readiness.',
      cron: '0 9 * * *',
      timezone: 'America/Detroit',
      scheduleLabel: 'Every day at 09:00',
      overlap: 'skip',
      notifyOnFailure: false,
      enabled: false,
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    },
  ],
}

/** The session this schedule's fire is using, from its own durable record. */
async function pendingFireSessionId(workspacePath: string): Promise<string | null> {
  const raw = await fs
    .readFile(path.join(workspacePath, 'task-queue', 'schedules.json'), 'utf8')
    .catch(() => '')
  if (raw === '') return null
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return null
  const schedules = Reflect.get(parsed, 'schedules')
  if (!Array.isArray(schedules)) return null
  for (const entry of schedules) {
    if (typeof entry !== 'object' || entry === null) continue
    if (Reflect.get(entry, 'id') !== SEEDED_SCHEDULE.schedules[0]?.id) continue
    const runtime = Reflect.get(entry, 'runtime')
    if (typeof runtime !== 'object' || runtime === null) return null
    const pendingFire = Reflect.get(runtime, 'pendingFire')
    const lastSessionId = Reflect.get(runtime, 'lastSessionId')
    if (typeof pendingFire === 'object' && pendingFire !== null) {
      const sessionId = Reflect.get(pendingFire, 'sessionId')
      if (typeof sessionId === 'string') return sessionId
    }
    return typeof lastSessionId === 'string' ? lastSessionId : null
  }
  return null
}

/** The name this exact session goes by, so it can be reopened as itself. */
async function persistedSessionTitle(
  workspacePath: string,
  sessionId: string,
): Promise<string> {
  const raw = await fs.readFile(
    path.join(workspacePath, 'sessions', sessionId, 'session.json'),
    'utf8',
  )
  const metadata: unknown = JSON.parse(raw)
  if (typeof metadata !== 'object' || metadata === null) {
    throw new Error('the session record is not an object')
  }
  const title = Reflect.get(metadata, 'title')
  if (typeof title !== 'string') throw new Error('the session record carries no title')
  return title
}

/** The pair this fire recorded as having named its artifact. */
async function recordedSelection(
  workspacePath: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const raw = await fs
    .readFile(path.join(workspacePath, 'sessions', sessionId, 'session.json'), 'utf8')
    .catch(() => '')
  if (raw === '') return null
  const metadata: unknown = JSON.parse(raw)
  if (typeof metadata !== 'object' || metadata === null) return null
  const attempts = Reflect.get(metadata, 'titleAttempts')
  if (!Array.isArray(attempts) || attempts.length === 0) return null
  const first: unknown = attempts[0]
  if (typeof first !== 'object' || first === null) return null
  if (Reflect.get(first, 'operation') !== 'scheduled-filename') return null
  const selection = Reflect.get(first, 'selection')
  if (typeof selection !== 'object' || selection === null || Array.isArray(selection)) {
    return null
  }
  const record: Record<string, unknown> = {}
  for (const key of ['provider', 'model', 'source', 'reason', 'caller']) {
    record[key] = Reflect.get(selection, key)
  }
  return record
}

test('a scheduled run records its artifact naming model without cards after reopening', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        content: GENERATED_TITLE,
        match: (request) => request.systemPrompt?.includes(NAMING_PROMPT_MARKER) ?? false,
      },
      { content: '# Result\n\nDetached worker provider ready.\n' },
    ],
  })

  const userDataPath = testInfo.outputPath('artifact-filename-user-data')
  const workspacePath = testInfo.outputPath('artifact-filename-workspace')
  const projectRoot = testInfo.outputPath('artifact-filename-project')
  await Promise.all([
    fs.mkdir(path.join(workspacePath, 'task-queue'), { recursive: true }),
    fs.mkdir(path.join(projectRoot, 'agents', SCHEDULED_AGENT), { recursive: true }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
    }),
  ])
  // A target the scheduler can resolve, on a pair of its own. Its choice is not
  // default use, so the only thing running on the application default here is
  // the naming — and if that ever stopped being true, this fixture would show
  // it rather than absorb it.
  await fs.writeFile(
    path.join(projectRoot, 'agents', SCHEDULED_AGENT, `${SCHEDULED_AGENT}.md`),
    [
      '---',
      `name: ${SCHEDULED_AGENT}`,
      'description: Agent targeted by the artifact-filename schedule.',
      `provider: ${FIXTURE_PROVIDER}`,
      `model: ${ANALYST_MODEL.id}`,
      '---',
      '',
      'Produce the requested report.',
      '',
    ].join('\n'),
  )
  await fs.writeFile(
    path.join(workspacePath, 'task-queue', 'schedules.json'),
    `${JSON.stringify(SEEDED_SCHEDULE, null, 2)}\n`,
  )

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow({ timeout: 45_000 })
    await page.getByRole('button', { name: /^Schedule & Batches/ }).click()
    await expect(page.getByText('Artifact Filename Nightly', { exact: true })).toBeVisible({
      timeout: 30_000,
    })

    // Fired deliberately. Run now opens the session the fire admitted.
    await page.getByRole('button', { name: 'Run now' }).first().click()

    // The record has to exist before anything is asserted about the page.
    await expect
      .poll(() => pendingFireSessionId(workspacePath), { timeout: 90_000 })
      .not.toBeNull()
    const sessionId = await pendingFireSessionId(workspacePath)
    expect(sessionId).not.toBeNull()
    if (sessionId === null) throw new Error('the fire recorded no session')

    await expect
      .poll(() => recordedSelection(workspacePath, sessionId), { timeout: 90_000 })
      .not.toBeNull()
    // Stated independently as well as joined: nobody picked a model for a
    // schedule, so this can only have come from the one application default.
    expect(await recordedSelection(workspacePath, sessionId)).toEqual({
      provider: FIXTURE_PROVIDER,
      model: APP_DEFAULT_MODEL.id,
      source: 'app-default',
      reason: 'agent-default',
      caller: 'title',
    })

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    const rendered = testInfo.outputPath('artifact-filename-notice.png')
    await page.screenshot({ path: rendered })
    await testInfo.attach('artifact-filename-notice', {
      path: rendered,
      contentType: 'image/png',
    })

    // ── Reopened. Renderer state is discarded; the record is not ────────────
    // Reopened by the exact session this fire recorded, read from its own
    // metadata. Clicking whichever row matched a name would be a different
    // session's notice on a bad day.
    const sessionTitle = await persistedSessionTitle(workspacePath, sessionId)
    await page.reload()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page
      .locator('[data-slot="workspace-sidebar"][data-side="left"]')
      .getByRole('button', {
        name: new RegExp(`^${sessionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      })
      .click()

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
  } finally {
    await app.close()
    await provider.close()
  }
})
