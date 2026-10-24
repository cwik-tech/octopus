/**
 * An untargeted Run turn survives navigation and a desktop restart.
 *
 * The integration journey proves replay without a second provider request; what
 * it cannot prove is that the product actually shows the same conversation back
 * to the user after the window is closed and reopened. `ChatPanel` keeps
 * messages in renderer state and reloads them through the messages endpoint, so
 * this is the assertion that the durable transcript — not renderer memory — is
 * what the user sees.
 *
 * Deliberately not an artificial control: the turn is sent the way a user sends
 * one, and the check after restart is simply that both lines are there once.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  APP_DEFAULT_MODEL,
  FIXTURE_PROVIDER,
  desktopEnvironment,
  seedProviderSettings,
} from './support/model-selection-fixture.js'

/**
 * A phrase only the front door fixture's own system prompt carries.
 *
 * An untargeted Run turn is answered by the General Agent, not the setup
 * assistant, so this is the persona `writeFrontDoorFixture` writes.
 */
const CHAT_PROMPT_MARKER = 'Answer the question in one sentence.'
/** A phrase only the title helper's own system prompt carries. */
const TITLE_PROMPT_MARKER = 'session title that summarizes'
const GENERATED_TITLE = 'Reviewing The Supply Agreement Draft'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

/**
 * The General Agent, pointed at the fixture provider.
 *
 * Written before launch so desktop seeding keeps it: the seed copies only files
 * the project root does not already have, and the shipped persona names a CLI
 * provider these journeys have no server for. It names its own pair rather than
 * leaning on the app default, so the only default-use notice on the page is
 * the title's.
 */
async function writeFrontDoorFixture(projectRootPath: string): Promise<void> {
  const directory = path.join(projectRootPath, 'agents', 'general-agent')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'general-agent.md'),
    [
      '---',
      'name: general-agent',
      'description: Deterministic front door fixture.',
      `provider: ${FIXTURE_PROVIDER}`,
      `model: ${APP_DEFAULT_MODEL.id}`,
      'thinking: low',
      'system: true',
      '---',
      '',
      '# general-agent',
      '',
      CHAT_PROMPT_MARKER,
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * The assistant line the product actually kept.
 *
 * Deliberately not the scripted sentence. `buildPlanAlignedAssistantText`
 * rewrites the model's words against the revised run plan, so what the user
 * keeps is not what the fixture said — asserting the fixture's text was why
 * this journey failed intermittently while the durable state was correct every
 * time.
 */
async function persistedAssistantText(workspacePath: string): Promise<string> {
  const sessionsRoot = path.join(workspacePath, 'sessions')
  const entries = await fs
    .readdir(sessionsRoot, { withFileTypes: true })
    .catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const raw = await fs
      .readFile(path.join(sessionsRoot, entry.name, 'chat.jsonl'), 'utf8')
      .catch(() => '')
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      // Guarded, not asserted. These are bytes off a file this test did not
      // write, and a cast would turn whatever is there into a typed message.
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        continue
      }
      const role = Reflect.get(parsed, 'role')
      const text = Reflect.get(parsed, 'text')
      if (role === 'assistant' && typeof text === 'string') return text
    }
  }
  return ''
}

async function persistedSessionTitle(
  workspacePath: string,
  sessionId: string,
): Promise<string> {
  const raw = await fs.readFile(
    path.join(workspacePath, 'sessions', sessionId, 'session.json'),
    'utf8',
  )
  const metadata: unknown = JSON.parse(raw)
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new Error('the session record is not an object')
  }
  const title = Reflect.get(metadata, 'title')
  if (typeof title !== 'string') {
    throw new Error('the session record carries no title')
  }
  return title
}

/**
 * The pair this session actually recorded as having named it.
 *
 * Read from the durable record rather than from anything on screen, so the
 * assertion afterwards is that the page shows what was stored — not that two
 * renderings of the same guess agree.
 */
async function persistedTitleSelection(
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
  const selection = Reflect.get(first, 'selection')
  if (typeof selection !== 'object' || selection === null) return null
  if (Array.isArray(selection)) return null
  // Returned whole. The pair alone cannot say whether the model was the
  // application default or something a person picked, and that difference is
  // the entire point of the notice.
  const record: Record<string, unknown> = {}
  for (const key of ['provider', 'model', 'source', 'reason', 'caller']) {
    record[key] = Reflect.get(selection, key)
  }
  return record
}

/**
 * The one session this journey created.
 *
 * Refuses rather than picking the first of several: taking `[0]` of an
 * unexamined list is how a journey ends up asserting against whichever session
 * happened to sort first. `sessions/` also holds `.locks`, which is not one.
 */
async function onlySessionId(workspacePath: string): Promise<string> {
  const entries = await fs.readdir(path.join(workspacePath, 'sessions'), {
    withFileTypes: true,
  })
  const sessions = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
  if (sessions.length !== 1) {
    throw new Error(`expected exactly one session, found ${sessions.length}`)
  }
  const found = sessions[0]
  if (found === undefined) throw new Error('no session was created')
  return found
}

test('an untargeted Run turn reloads after navigation and after a restart', async ({}, testInfo) => {
  test.setTimeout(180_000)

  // One workspace and user-data directory, reused across both launches: that
  // reuse is what makes the second launch a restart rather than a fresh app.
  //
  // Nothing is selected, so the General Agent front door answers the turn.
  const paths = {
    projectRootPath: testInfo.outputPath('receptionist-reload-project'),
    userDataPath: testInfo.outputPath('receptionist-reload-user-data'),
    workspacePath: testInfo.outputPath('receptionist-reload-workspace'),
    piStatePath: testInfo.outputPath('receptionist-reload-pi-state'),
  }

  // Claimed by who is asking, so request order cannot hand the General Agent
  // the title's answer or the other way round.
  const replyText = 'Reloaded from the durable transcript.'
  const provider = await startFakeChatCompletionsServer({
    script: [
      // The chat turn is claimed twice with the same answer: its buffered
      // tool-capable round, and the streamed tool-free request that follows
      // when the turn has a live display. The buffered copy is discarded then.
      {
        content: replyText,
        match: (request) =>
          !request.stream && (request.systemPrompt?.includes(CHAT_PROMPT_MARKER) ?? false),
      },
      {
        content: replyText,
        match: (request) =>
          request.stream && (request.systemPrompt?.includes(CHAT_PROMPT_MARKER) ?? false),
      },
      {
        content: GENERATED_TITLE,
        match: (request) =>
          request.systemPrompt?.includes(TITLE_PROMPT_MARKER) ?? false,
      },
      { content: 'Unclaimed fixture answer.' },
    ],
  })

  await Promise.all([
    fs.mkdir(path.join(paths.projectRootPath, 'agents'), { recursive: true }),
    fs.mkdir(path.join(paths.projectRootPath, 'workflows'), { recursive: true }),
    fs.mkdir(paths.workspacePath, { recursive: true }),
    fs.mkdir(paths.piStatePath, { recursive: true }),
    // Seeded the way Settings writes it. With no chosen default the front desk
    // answers with its offline fallback, which echoes the question back — so the
    // question appeared twice on the page and this journey failed on a count it
    // was right to make. An API key in the environment is not a chosen default.
    seedProviderSettings({
      userDataPath: paths.userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
      kind: 'lm-studio',
    }),
  ])
  await Promise.all([
    fs.writeFile(path.join(paths.projectRootPath, 'teams.yaml'), '', 'utf8'),
    fs.writeFile(
      path.join(paths.projectRootPath, 'workflows', 'registry.yaml'),
      '',
      'utf8',
    ),
  ])
  await writeFrontDoorFixture(paths.projectRootPath)
  const question = 'Reload me after a restart please'

  try {
    const first = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...desktopEnvironment({
          projectRoot: paths.projectRootPath,
          userDataPath: paths.userDataPath,
          workspacePath: paths.workspacePath,
        }),
        PI_CODING_AGENT_DIR: paths.piStatePath,
      },
    })
    let sessionTitle = ''
    let assistantText = ''
    try {
      const page = await first.firstWindow()
      await page.getByRole('tab', { name: 'Run', exact: true }).click()
      // The Run target decides which endpoint the composer posts to. With
      // nothing selected on the Workflows target the turn is untargeted, and
      // the General Agent answers it.
      await page.getByRole('tab', { name: 'Workflows', exact: true }).click()

      const composer = page.getByRole('textbox').first()
      await composer.click()
      await composer.fill(question)
      await composer.press('Enter')

      await expect(page.getByText(question, { exact: false })).toBeVisible({
        timeout: 60_000,
      })
      // Whether the General Agent was reached is the first thing to know: a turn
      // that never got an answer and a turn whose answer was lost look the same
      // on screen, and only one of them is this test's problem. Counting every
      // request would not say this — catalog traffic alone satisfies that.
      await expect
        .poll(
          () =>
            provider.requests.filter((request) =>
              request.systemPrompt?.includes(CHAT_PROMPT_MARKER) ?? false,
            ).length,
          { timeout: 60_000 },
        )
        .toBeGreaterThan(0)
      // Not the scripted sentence: `buildPlanAlignedAssistantText` rewrites the
      // model's words against the revised run plan, so what the user keeps is
      // not what the fixture said. The persisted line is the thing that had to
      // survive, so that is what is asserted — read from the transcript rather
      // than guessed at.
      await expect
        .poll(() => persistedAssistantText(paths.workspacePath), {
          timeout: 60_000,
        })
        .not.toBe('')
      assistantText = await persistedAssistantText(paths.workspacePath)
      // The model's own words, not the offline fallback. That fallback echoes
      // the question back, so a journey that accepted it would be asserting
      // against a reply no provider ever gave.
      expect(assistantText).toContain(replyText)
      expect(assistantText).not.toContain('Receptionist offline fallback')
      await expect(
        page.getByText(assistantText.slice(0, 40), { exact: false }),
      ).toBeVisible({ timeout: 60_000 })

      // Navigate away and back: renderer state is discarded, the transcript is
      // not, so the same two lines must come back from the server.
      await page.getByRole('tab', { name: 'Create', exact: true }).click()
      await page.getByRole('tab', { name: 'Run', exact: true }).click()
      await expect(page.getByText(question, { exact: false })).toHaveCount(1)

      // Read the title from the durable session record rather than scraping a
      // row. Scraping picked up whatever `li` happened to be first, so after a
      // restart the click sometimes opened the freshly created empty session
      // instead of this one — which is why this test was intermittently red.
      const sessionsRoot = path.join(paths.workspacePath, 'sessions')
      // `sessions/` also holds a `.locks` directory, which is not a session.
      const entries = await fs.readdir(sessionsRoot, { withFileTypes: true })
      const onlySession = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)[0]
      if (onlySession === undefined) throw new Error('no session was created')
      // Title generation follows the chat response. Reading immediately after
      // the assistant appears can still return "Untitled session"; after the
      // restart that would match the fresh startup session instead of this
      // durable conversation. Wait for this exact session record to settle
      // before using its user-visible title to reopen it.
      await expect
        .poll(
          () => persistedSessionTitle(paths.workspacePath, onlySession),
          { timeout: 60_000 },
        )
        .not.toBe('Untitled session')
      sessionTitle = await persistedSessionTitle(
        paths.workspacePath,
        onlySession,
      )
    } finally {
      await first.close()
    }

    // Restart the desktop process against the same workspace.
    const second = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...desktopEnvironment({
          projectRoot: paths.projectRootPath,
          userDataPath: paths.userDataPath,
          workspacePath: paths.workspacePath,
        }),
        PI_CODING_AGENT_DIR: paths.piStatePath,
      },
    })
    try {
      const page = await second.firstWindow()
      await page.getByRole('tab', { name: 'Run', exact: true }).click()

      // A restart opens a new draft rather than restoring the last one, so
      // the prior conversation is reached the way a user would reach it: from
      // the Sessions list in the sidebar. That the transcript is *there* to be
      // reopened is the point of this journey.
      const primaryNavigation = page.getByRole('complementary', {
        name: 'Primary navigation',
      })
      // The recent-session group renders as a bare list with no heading
      // (`run-sessions-sidebar.tsx:160`), so there is no 'Recent' label to wait
      // for — waiting for one only delayed this journey until it timed out on
      // markup that never existed. The row itself is the thing that has to be
      // there, and it is asserted directly below.
      //
      // By the name a user reads, not by the element that happens to wrap it.
      // `li` matched whatever markup the sidebar used and would keep passing if
      // the row stopped being operable at all.
      //
      // Anchored at the start of the name: the row's own controls — "Project
      // actions for <title>", "Delete session <title>" — contain the title as
      // well, so an unanchored match is ambiguous, and settling that with
      // `.first()` is how this test used to click whichever row came first.
      const priorSession = primaryNavigation.getByRole('button', {
        name: new RegExp(`^${sessionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      })
      await expect(priorSession).toBeVisible({ timeout: 60_000 })
      await priorSession.click()
      await page.getByRole('tab', { name: 'Workflows', exact: true }).click()

      await expect(page.getByText(question, { exact: false })).toHaveCount(1, {
        timeout: 60_000,
      })
      // The reply came back too, so what reloaded is the exchange and not just
      // the user's half of it.
      await expect(
        page.getByText(assistantText.slice(0, 40), { exact: false }),
      ).toBeVisible({ timeout: 60_000 })
    } finally {
      await second.close()
    }
  } finally {
    await provider.close()
  }
})

/**
 * Session naming keeps its diagnostic record while informational cards stay hidden.
 *
 * Naming a session is the application's own work, not the answering Agent's,
 * so it runs on the one application default. Check the record written by the
 * service and the chat before and after reopening the session.
 *
 * Deliberately on the Workflows target with nothing selected, so the turn is
 * untargeted and the General Agent answers it. Agents is the default target and
 * posts to the selected-agent endpoint, which has its own journey.
 *
 * The default is seeded the way Settings writes it. An API key in the
 * environment is not a chosen default — a missing stored one resolves to unset
 * (`services/provider-settings-service.ts:1075`) — and with none chosen there is
 * no pair to record and nothing to show.
 */
test('an untargeted Run turn records its naming model without cards after reopening', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const paths = {
    projectRootPath: testInfo.outputPath('receptionist-title-project'),
    userDataPath: testInfo.outputPath('receptionist-title-user-data'),
    workspacePath: testInfo.outputPath('receptionist-title-workspace'),
  }

  // Claimed by who is asking, never by what they asked for. The model is the
  // behaviour under test, so a caller that named the wrong one still gets its
  // own answer and the mistake shows up as a wrong model rather than a timeout.
  const provider = await startFakeChatCompletionsServer({
    script: [
      // The chat turn is claimed twice with the same answer: its buffered
      // tool-capable round, and the streamed tool-free request that follows
      // when the turn has a live display. The buffered copy is discarded then.
      {
        content: 'The supply agreement has been reviewed.',
        match: (request) =>
          !request.stream && (request.systemPrompt?.includes(CHAT_PROMPT_MARKER) ?? false),
      },
      {
        content: 'The supply agreement has been reviewed.',
        match: (request) =>
          request.stream && (request.systemPrompt?.includes(CHAT_PROMPT_MARKER) ?? false),
      },
      {
        content: GENERATED_TITLE,
        match: (request) =>
          request.systemPrompt?.includes(TITLE_PROMPT_MARKER) ?? false,
      },
      { content: 'Unclaimed fixture answer.' },
    ],
  })

  await Promise.all([
    // Only the front door fixture: a selected Agent would send the composer to
    // the selected-agent endpoint instead of the untargeted turn this covers.
    writeFrontDoorFixture(paths.projectRootPath),
    fs.mkdir(path.join(paths.projectRootPath, 'workflows'), { recursive: true }),
    fs.mkdir(paths.workspacePath, { recursive: true }),
    seedProviderSettings({
      userDataPath: paths.userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
      kind: 'lm-studio',
    }),
  ])
  await Promise.all([
    fs.writeFile(path.join(paths.projectRootPath, 'teams.yaml'), '', 'utf8'),
    fs.writeFile(
      path.join(paths.projectRootPath, 'workflows', 'registry.yaml'),
      '',
      'utf8',
    ),
  ])

  const question = 'Review the attached supply agreement please'

  try {
    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: desktopEnvironment({
        projectRoot: paths.projectRootPath,
        userDataPath: paths.userDataPath,
        workspacePath: paths.workspacePath,
      }),
    })
    try {
      const page = await app.firstWindow()
      await page.getByRole('tab', { name: 'Run', exact: true }).click()
      await page.getByRole('tab', { name: 'Workflows', exact: true }).click()

      const composer = page.getByRole('textbox').first()
      await composer.click()
      await composer.fill(question)
      await composer.press('Enter')

      await expect(page.getByText(question, { exact: false })).toBeVisible({
        timeout: 60_000,
      })

      const sessionId = await onlySessionId(paths.workspacePath)
      // The record has to exist before anything is asserted about the page, and
      // it is what the page is then checked against.
      await expect
        .poll(() => persistedTitleSelection(paths.workspacePath, sessionId), {
          timeout: 60_000,
        })
        .not.toBeNull()
      const recorded = await persistedTitleSelection(paths.workspacePath, sessionId)
      if (recorded === null) throw new Error('no title selection was recorded')
      // Stated independently as well as joined, and including the provenance:
      // nobody touched the model picker in this journey, so the pair can only
      // have come from the one application default. Recording it as a person's
      // explicit choice would be a false account of who decided — and the
      // notice reads differently for the two, so the page would say the wrong
      // thing as well.
      expect(recorded).toEqual({
        provider: FIXTURE_PROVIDER,
        model: APP_DEFAULT_MODEL.id,
        source: 'app-default',
        reason: 'agent-default',
        caller: 'title',
      })

      await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

      const rendered = testInfo.outputPath('receptionist-title-notice.png')
      await page.screenshot({ path: rendered })
      await testInfo.attach('receptionist-title-notice', {
        path: rendered,
        contentType: 'image/png',
      })

      // ── Reopened. Renderer state is discarded; the record is not ──────────
      await expect
        .poll(() => persistedSessionTitle(paths.workspacePath, sessionId), {
          timeout: 60_000,
        })
        .not.toBe('Untitled session')
      const sessionTitle = await persistedSessionTitle(paths.workspacePath, sessionId)
      await page.reload()
      await page.getByRole('tab', { name: 'Run', exact: true }).click()
      const primaryNavigation = page.getByRole('complementary', {
        name: 'Primary navigation',
      })
      // Anchored at the start of the name: the row's own controls carry the
      // title too, so an unanchored match is ambiguous.
      const priorSession = primaryNavigation.getByRole('button', {
        name: new RegExp(`^${sessionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      })
      await expect(priorSession).toBeVisible({ timeout: 60_000 })
      await priorSession.click()
      await page.getByRole('tab', { name: 'Workflows', exact: true }).click()

      await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
    } finally {
      await app.close()
    }
  } finally {
    await provider.close()
  }
})
