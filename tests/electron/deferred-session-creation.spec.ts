/**
 * Opening the app costs nothing.
 *
 * The desktop used to write a session to disk on every launch, and again on
 * every press of New, leaving a sidebar full of `Untitled session` rows nobody
 * had ever typed into. These journeys prove the replacement from the outside:
 * the conversation on screen is real to the user and absent from disk until
 * they do something with it, and the moment they do, exactly one session
 * appears — without the composer losing what they were writing.
 *
 * Asserted against the workspace directory rather than the sidebar, because
 * "was anything persisted" is the actual question and the filesystem is the
 * only place that answers it truthfully.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { APP_DEFAULT_MODEL, seedProviderSettings } from './support/model-selection-fixture.js'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Session directories on disk, which is what "persisted" means here. */
async function persistedSessionIds(workspacePath: string): Promise<string[]> {
  const sessionsDir = path.join(workspacePath, 'sessions')
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  return entries
    .filter((entry) => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

async function launchDesktop(params: {
  userDataPath: string
  workspacePath: string
  projectRoot: string
}): Promise<{
  app: ElectronApplication
  page: Page
  /** Closes the app, then its provider; each step runs even if one fails. */
  teardown: readonly (() => Promise<unknown>)[]
}> {
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null
  // A sent message is persisted only once its turn is admitted on a model.
  // The General Agent names none, so an application default has to exist,
  // written the way Settings writes it, on a keyless LM Studio connection: the
  // native tool route refuses a keyless OpenAI-compatible one. It lives in the
  // user data folder, not the workspace, so it is not a persisted session.
  // The reply is not what these journeys check.
  const provider = await startFakeChatCompletionsServer({
    script: [{ content: 'Noted.', deltas: ['Noted.'] }],
  })
  // From here the server is owned. A failure in seeding, launching or opening
  // the first window closes whatever was started and is rethrown with any
  // teardown error beside it; a launch that succeeds hands both to the caller.
  let app: ElectronApplication | undefined
  try {
    await seedProviderSettings({
      userDataPath: params.userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
      kind: 'lm-studio',
    })
    app = await electron.launch({
      args: executablePath ? [] : ['.'],
      cwd: repoRoot,
      ...(executablePath ? { executablePath } : {}),
      env: {
        ...fixtureDesktopEnvironment(),
        PIPELINE_DESKTOP_E2E: '1',
        ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
        PIPELINE_DESKTOP_PROJECT_ROOT: params.projectRoot,
        PIPELINE_DESKTOP_USER_DATA: params.userDataPath,
        PIPELINE_DESKTOP_WORKSPACE_PATH: params.workspacePath,
        TEAM_RUNTIME_TASK_RUNNER_DRY_RUN: '1',
      },
    })
    // The first launch after a build pays for a cold start, and Playwright's
    // default 30s is not always enough for it on a loaded machine.
    const page = await app.firstWindow({ timeout: 90_000 })
    const launched = app
    return {
      app: launched,
      page,
      teardown: [() => launched.close(), () => provider.close()],
    }
  } catch (error) {
    const launched = app
    await finishWithTeardown({ error }, [
      ...(launched ? [() => launched.close()] : []),
      () => provider.close(),
    ])
    // Not reached: with a primary failure, finishWithTeardown always throws.
    throw error
  }
}

/**
 * Runs every teardown step even when an earlier one fails, then rethrows the
 * journey's own failure with any teardown errors beside it, never instead of
 * it.
 */
async function finishWithTeardown(
  primaryFailure: { readonly error: unknown } | undefined,
  steps: readonly (() => Promise<unknown>)[],
): Promise<void> {
  const teardownErrors: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      teardownErrors.push(error)
    }
  }
  if (primaryFailure && teardownErrors.length > 0) {
    throw new AggregateError(
      [primaryFailure.error, ...teardownErrors],
      'The journey failed, and so did its teardown',
    )
  }
  if (primaryFailure) throw primaryFailure.error
  if (teardownErrors.length > 0) {
    throw new AggregateError(teardownErrors, 'The journey passed, but its teardown failed')
  }
}

/**
 * Fresh directories per call. A retry or a repeat must not inherit the
 * workspace of the attempt before it, or "nothing was persisted" would be a
 * claim about the wrong run.
 */
async function makePaths(outputPath: (name: string) => string): Promise<{
  userDataPath: string
  workspacePath: string
  projectRoot: string
}> {
  const unique = randomUUID().slice(0, 8)
  const paths = {
    userDataPath: outputPath(`deferred-user-data-${unique}`),
    workspacePath: outputPath(`deferred-workspace-${unique}`),
    projectRoot: outputPath(`deferred-project-${unique}`),
  }
  await Promise.all([
    fs.mkdir(paths.userDataPath, { recursive: true }),
    fs.mkdir(paths.workspacePath, { recursive: true }),
    fs.mkdir(paths.projectRoot, { recursive: true }),
  ])
  return paths
}

/** The composer is the last textbox on screen. */
function composerOf(page: Page) {
  return page.getByRole('textbox').last()
}

test('launching the desktop and pressing New persist nothing until the chat is used', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const paths = await makePaths((name) => testInfo.outputPath(name))
  const { app, page, teardown } = await launchDesktop(paths)

  // Every request the renderer makes about a specific session. A draft has no
  // session on the server, so any of these would be a 404 — and a poll that
  // 404s forever is how the first version of this change stalled the window.
  const sessionScopedRequests: string[] = []
  page.on('request', (request) => {
    const match = /\/sessions\/[^/]+\/.+$/.exec(new URL(request.url()).pathname)
    if (match) sessionScopedRequests.push(match[0])
  })

  let primaryFailure: { readonly error: unknown } | undefined
  try {
    // The chat is usable the moment the window opens.
    await expect(composerOf(page)).toBeVisible()
    expect(await persistedSessionIds(paths.workspacePath)).toEqual([])
    await page.waitForTimeout(3_000)
    expect(sessionScopedRequests).toEqual([])

    // New replaces the draft rather than persisting one, however often it is
    // pressed. This is the leak the change exists to stop.
    for (let press = 0; press < 3; press += 1) {
      await page.keyboard.press(
        process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
      )
      await expect(composerOf(page)).toBeVisible()
    }
    expect(await persistedSessionIds(paths.workspacePath)).toEqual([])

    // Typing alone is still not a decision to keep anything.
    const composer = composerOf(page)
    await composer.click()
    await composer.fill('Remember this line')
    expect(await persistedSessionIds(paths.workspacePath)).toEqual([])

    // Sending is. Exactly one session appears, and it holds the message.
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => (await persistedSessionIds(paths.workspacePath)).length, {
        timeout: 30_000,
      })
      .toBe(1)

    const [sessionId] = await persistedSessionIds(paths.workspacePath)
    expect(sessionId).toBeDefined()
    if (!sessionId) throw new Error('the send persisted no session')
    await expect
      .poll(
        async () =>
          (
            await fs
              .readFile(
                path.join(paths.workspacePath, 'sessions', sessionId, 'chat.jsonl'),
                'utf8',
              )
              .catch(() => '')
          ).includes('Remember this line'),
        { timeout: 30_000 },
      )
      .toBe(true)

    // The transcript the user is looking at is that same conversation, still
    // mounted — the send did not swap the panel out from under them.
    await expect(page.getByText('Remember this line')).toBeVisible()
  } catch (error) {
    primaryFailure = { error }
  }
  await finishWithTeardown(primaryFailure, teardown)
})

test('a relaunch after an unused draft leaves the sidebar empty', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const paths = await makePaths((name) => testInfo.outputPath(`relaunch-${name}`))

  for (let launch = 0; launch < 2; launch += 1) {
    const { app, page, teardown } = await launchDesktop(paths)
    let primaryFailure: { readonly error: unknown } | undefined
    try {
      await expect(composerOf(page)).toBeVisible()
      // Nothing accumulates across launches, which is the shape of the reported
      // defect: one dead session per open.
      expect(await persistedSessionIds(paths.workspacePath)).toEqual([])
      await expect(page.getByText('No sessions yet.')).toBeVisible()
    } catch (error) {
      primaryFailure = { error }
    }
    await finishWithTeardown(primaryFailure, teardown)
  }
})

test('a create whose response is lost is retried onto the same session', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const paths = await makePaths((name) => testInfo.outputPath(`retry-${name}`))
  const { app, page, teardown } = await launchDesktop(paths)

  // The dangerous shape: the server persisted the session and the answer never
  // arrived. The retry must be handed back what it already made rather than
  // colliding with it or making a second one.
  let dropNextResponse = true
  await page.route('**/sessions', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    const response = await route.fetch()
    if (dropNextResponse) {
      dropNextResponse = false
      await route.abort('connectionreset')
      return
    }
    await route.fulfill({ response })
  })

  let primaryFailure: { readonly error: unknown } | undefined
  try {
    await expect(composerOf(page)).toBeVisible()

    const composer = composerOf(page)
    await composer.click()
    await composer.fill('First attempt loses its answer')
    await page.keyboard.press('Enter')

    // The dropped answer left a session on disk that the client does not yet
    // know it owns.
    await expect
      .poll(async () => (await persistedSessionIds(paths.workspacePath)).length, {
        timeout: 30_000,
      })
      .toBe(1)
    const [afterDrop] = await persistedSessionIds(paths.workspacePath)
    expect(afterDrop).toBeDefined()
    if (!afterDrop) throw new Error('the dropped create persisted nothing')

    // The retry replays onto that same session: still one, same id.
    await composerOf(page).click()
    await composerOf(page).fill('Second attempt succeeds')
    await page.keyboard.press('Enter')

    await expect
      .poll(
        async () =>
          (
            await fs
              .readFile(
                path.join(paths.workspacePath, 'sessions', afterDrop, 'chat.jsonl'),
                'utf8',
              )
              .catch(() => '')
          ).includes('Second attempt succeeds'),
        { timeout: 30_000 },
      )
      .toBe(true)
    expect(await persistedSessionIds(paths.workspacePath)).toEqual([afterDrop])
  } catch (error) {
    primaryFailure = { error }
  }
  await finishWithTeardown(primaryFailure, teardown)
})

test('attaching a file to a fresh draft creates one session that holds it', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const paths = await makePaths((name) => testInfo.outputPath(`attach-${name}`))
  const { app, page, teardown } = await launchDesktop(paths)

  let primaryFailure: { readonly error: unknown } | undefined
  try {
    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(composerOf(page)).toBeVisible()
    expect(await persistedSessionIds(paths.workspacePath)).toEqual([])

    // Attaching is intent: the file has to be stored against something.
    await chat.getByLabel('Upload files').setInputFiles([
      {
        name: 'draft-context.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('context attached before any message'),
      },
    ])

    await expect
      .poll(async () => (await persistedSessionIds(paths.workspacePath)).length, {
        timeout: 30_000,
      })
      .toBe(1)
    const [sessionId] = await persistedSessionIds(paths.workspacePath)
    expect(sessionId).toBeDefined()
    if (!sessionId) throw new Error('the attach persisted no session')
    await expect
      .poll(
        async () =>
          (
            await fs
              .readdir(
                path.join(paths.workspacePath, 'sessions', sessionId, 'inputs'),
              )
              .catch(() => [] as string[])
          ).includes('draft-context.txt'),
        { timeout: 30_000 },
      )
      .toBe(true)
  } catch (error) {
    primaryFailure = { error }
  }
  await finishWithTeardown(primaryFailure, teardown)
})

test('starting a new chat mid-upload keeps the file with the conversation it belongs to', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const paths = await makePaths((name) => testInfo.outputPath(`race-${name}`))
  const { app, page, teardown } = await launchDesktop(paths)

  // The race only exists while the create is in flight, and on loopback it
  // otherwise finishes before a person could press anything. The response is
  // held until the test has done the racing part, so the window is opened
  // deliberately rather than waited for.
  let createReached: (() => void) | undefined
  const createStarted = new Promise<void>((resolve) => {
    createReached = resolve
  })
  let releaseCreate: (() => void) | undefined
  const createReleased = new Promise<void>((resolve) => {
    releaseCreate = resolve
  })
  await page.route('**/sessions', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    const response = await route.fetch()
    createReached?.()
    await createReleased
    await route.fulfill({ response })
  })

  let primaryFailure: { readonly error: unknown } | undefined
  try {
    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(composerOf(page)).toBeVisible()

    await chat.getByLabel('Upload files').setInputFiles([
      {
        name: 'raced-context.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('attached just before the user moved on'),
      },
    ])
    await createStarted
    // The composer the user is leaving. Holding the node itself is what makes
    // the swap observable: New replaces the conversation, so this exact element
    // is detached, and waiting for that is an event rather than a guess about
    // how long React takes.
    const outgoingComposer = await composerOf(page).elementHandle()
    expect(outgoingComposer).not.toBeNull()
    if (!outgoingComposer) throw new Error('the composer was not on screen')

    // Without waiting for the upload to settle, the user starts a new chat.
    // Pressed rather than typed: cmd-K is deliberately ignored while focus is
    // in an input, and `setInputFiles` leaves the file input focused.
    await page
      .getByRole('group', { name: 'Left window actions' })
      .getByRole('button', { name: 'New chat', exact: true })
      .click()
    await outgoingComposer.waitForElementState('hidden')
    await outgoingComposer.dispose()

    // The user starts writing in the replacement, which is now the only
    // composer on screen. This text is the observable: if the resolving upload
    // announced its own conversation, the panel would switch back to it and
    // take this with it.
    const unsentDraftText = 'text typed into the replacement draft'
    const replacementComposer = composerOf(page)
    await replacementComposer.fill(unsentDraftText)

    // Only now does the create come back, to a client that has moved on.
    releaseCreate?.()

    // The conversation the file belongs to still becomes real and keeps it.
    await expect
      .poll(async () => (await persistedSessionIds(paths.workspacePath)).length, {
        timeout: 30_000,
      })
      .toBe(1)
    const [sessionId] = await persistedSessionIds(paths.workspacePath)
    expect(sessionId).toBeDefined()
    if (!sessionId) throw new Error('the raced attach persisted no session')
    await expect
      .poll(
        async () =>
          (
            await fs
              .readdir(
                path.join(paths.workspacePath, 'sessions', sessionId, 'inputs'),
              )
              .catch(() => [] as string[])
          ).includes('raced-context.txt'),
        { timeout: 30_000 },
      )
      .toBe(true)

    // Asserted after the file is on disk, so the create has definitely settled
    // and any re-selection it would have caused has had its chance to happen.
    // The user is still in the chat they moved to, with their text intact.
    await expect(composerOf(page)).toHaveValue(unsentDraftText)
    await expect(chat.getByTestId('file-message-card')).toHaveCount(0)
    expect(await persistedSessionIds(paths.workspacePath)).toEqual([sessionId])
  } catch (error) {
    primaryFailure = { error }
  }
  await finishWithTeardown(primaryFailure, teardown)
})

test('renaming a fresh draft creates one session under that name', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const paths = await makePaths((name) => testInfo.outputPath(`rename-${name}`))
  const { app, page, teardown } = await launchDesktop(paths)

  let primaryFailure: { readonly error: unknown } | undefined
  try {
    await expect(composerOf(page)).toBeVisible()
    expect(await persistedSessionIds(paths.workspacePath)).toEqual([])

    // Naming a conversation is a decision to keep it.
    await page.getByRole('button', { name: 'Edit session title' }).click()
    const titleField = page.getByRole('textbox', { name: 'Session title' })
    await titleField.fill('Named before it existed')
    await titleField.press('Enter')

    await expect
      .poll(async () => (await persistedSessionIds(paths.workspacePath)).length, {
        timeout: 30_000,
      })
      .toBe(1)
    const [sessionId] = await persistedSessionIds(paths.workspacePath)
    expect(sessionId).toBeDefined()
    if (!sessionId) throw new Error('the rename persisted no session')
    await expect
      .poll(
        async () =>
          (
            await fs
              .readFile(
                path.join(paths.workspacePath, 'sessions', sessionId, 'session.json'),
                'utf8',
              )
              .catch(() => '')
          ).includes('Named before it existed'),
        { timeout: 30_000 },
      )
      .toBe(true)
  } catch (error) {
    primaryFailure = { error }
  }
  await finishWithTeardown(primaryFailure, teardown)
})
