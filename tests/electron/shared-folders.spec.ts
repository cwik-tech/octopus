import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WorkspaceProjectMembershipStore } from '../../domains/projects/project-membership-store.js'
import { WorkspaceProjectStore } from '../../domains/projects/project-store.js'
import { WorkspaceProjectService } from '../../domains/projects/workspace-project-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  isProviderHealthProbe,
  startFakeChatCompletionsServer,
  type FakeChatCompletionsRequest,
} from '../support/fake-chat-completions-server.js'
import { launchDesktop as launchFixtureDesktop } from './support/desktop-launch.js'
import { startFakeAnthropicMessagesServer } from './support/fake-anthropic-messages-server.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Local folder access in the desktop app (docs/feature-local-folder-access.md).
 *
 * Only the model is replaced, at its HTTP boundary. The native dialog is the
 * one other stand-in: it answers with a real temporary folder, and the main
 * process still resolves it and records the grant.
 */

const CHAT_TITLE = 'Folder header journey'
const CONNECTION_ID = 'shared-folders-fixture'
const MODEL_ID = 'shared-folders/fixture-model'
/** Known only to the file on disk, so it can reach the model by one route alone. */
const FILE_SENTENCE = 'The rehearsal moves to the boathouse, code LF11-QUINCE-7.'
const ANSWER = 'LF11-ANSWER: the plan was read from the attached folder.'

test('a folder added from the chat header lets the next turn read a known .md file, and the folder is still attached after the app restarts', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const userDataPath = testInfo.outputPath('shared-folders-user-data')
  const workspacePath = testInfo.outputPath('shared-folders-workspace')
  const projectRoot = testInfo.outputPath('shared-folders-project')
  await Promise.all([userDataPath, workspacePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))
  // Outside the app data and the workspace, which the API refuses to share.
  const userFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-shared-folder-'))
  await fs.mkdir(path.join(userFolder, 'notes'))
  await fs.writeFile(path.join(userFolder, 'notes', 'plan.md'), `# Plan\n\n${FILE_SENTENCE}\n`, 'utf8')
  // Written before launch so desktop seeding keeps it: the shipped front door
  // follows the app default, and this one names the fixture outright.
  await writeFrontDoorFixture(projectRoot)
  // Titled, so no title request is made, and found by its ID throughout.
  const session = await new FileSystemSessionStore(workspacePath).createSession({ title: CHAT_TITLE })

  // The first tool round of the turn asks for the file. The folder ID exists
  // only once the folder is attached, so it is filled in then.
  const readArguments: Record<string, unknown> = { path: 'notes/plan.md' }
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          !isProviderHealthProbe(request) &&
          offeredToolNames(request).includes('folder_read') &&
          toolResultContents(request).length === 0,
        toolCalls: [{ id: 'call-read-plan', name: 'folder_read', arguments: readArguments }],
      },
      { content: ANSWER, deltas: [ANSWER] },
    ],
  })
  let app: ElectronApplication | undefined
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    await writeProviderSettings(userDataPath, provider.url)
    app = await launchDesktop({ userDataPath, workspacePath, projectRoot })
    await replaceDirectoryDialog(app, userFolder)
    const page = await app.firstWindow()
    const chat = await openChat(page, CHAT_TITLE)

    await chat.getByRole('button', { name: 'Add folder', exact: true }).click()
    await expect(chat.getByRole('button', { name: 'Attached folders (1)', exact: true })).toBeVisible()
    const folders = await listSessionFolders(await rendererApiBaseUrl(page), session.id)
    expect(folders.map((folder) => folder.path)).toEqual([await fs.realpath(userFolder)])
    readArguments.folder = folders[0]?.id

    await chat.getByRole('textbox').fill('What does my plan say about the rehearsal?')
    await chat.getByRole('textbox').press('Enter')
    await expect(chat.getByText(ANSWER).first()).toBeVisible({ timeout: 60_000 })

    const turnRequests = provider.requests.filter((request) => !isProviderHealthProbe(request))
    const readResults = turnRequests.filter((request) =>
      toolResultContents(request).some((content) => content.includes(FILE_SENTENCE)))
    expect(readResults.length, 'the file reached the model as a tool result').toBeGreaterThan(0)
    for (const request of readResults) {
      expect(request.model, 'the turn ran on the fixture model, not a real provider').toBe(MODEL_ID)
    }
    for (const request of turnRequests) {
      expect(promptText(request), 'file contents never enter the prompt').not.toContain(FILE_SENTENCE)
    }

    await app.close()
    app = undefined
    app = await launchDesktop({ userDataPath, workspacePath, projectRoot })
    const reopened = await openChat(await app.firstWindow(), CHAT_TITLE)
    await expect(reopened.getByRole('button', { name: 'Attached folders (1)', exact: true })).toBeVisible()
  } catch (error) {
    primaryFailure = { error }
  }
  const launched = app
  await finishWithTeardown(primaryFailure, [
    ...(launched ? [() => launched.close()] : []),
    () => provider.close(),
    () => fs.rm(userFolder, { recursive: true, force: true }),
  ])
})

const PROJECT_NAME = 'Folder project journey'
const PROJECT_CHAT_TITLE = 'Project folder chat'
/** Known only to the file on disk, so it can reach the model by one route alone. */
const PROJECT_FILE_SENTENCE = 'The kiln opens on Thursday, code LF10-MARIGOLD-4.'
const PROJECT_ANSWER = 'LF10-ANSWER: the schedule was read from the project folder.'

test('a folder added in Library appears in an existing project chat\'s header popover under the project, and that chat\'s next turn reads a known file from it with no folder selection sent', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const userDataPath = testInfo.outputPath('project-folders-user-data')
  const workspacePath = testInfo.outputPath('project-folders-workspace')
  const projectRoot = testInfo.outputPath('project-folders-project')
  await Promise.all([userDataPath, workspacePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))
  await writeFrontDoorFixture(projectRoot)
  // The chat exists, and is in the project, before the folder does.
  const { session } = await seedProjectChat(workspacePath, PROJECT_NAME, PROJECT_CHAT_TITLE)
  // Outside the app data and the workspace, which the API refuses to share.
  const userFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-project-folder-'))
  await fs.mkdir(path.join(userFolder, 'notes'))
  await fs.writeFile(path.join(userFolder, 'notes', 'schedule.md'), `# Schedule\n\n${PROJECT_FILE_SENTENCE}\n`, 'utf8')
  const folderPath = await fs.realpath(userFolder)
  const folderLabel = path.basename(folderPath)

  // The folder ID exists only once Library has added the folder, so it is
  // filled in then.
  const readArguments: Record<string, unknown> = { path: 'notes/schedule.md' }
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          !isProviderHealthProbe(request) &&
          offeredToolNames(request).includes('folder_read') &&
          toolResultContents(request).length === 0,
        toolCalls: [{ id: 'call-read-schedule', name: 'folder_read', arguments: readArguments }],
      },
      { content: PROJECT_ANSWER, deltas: [PROJECT_ANSWER] },
    ],
  })
  let app: ElectronApplication | undefined
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    await writeProviderSettings(userDataPath, provider.url)
    app = await launchDesktop({ userDataPath, workspacePath, projectRoot })
    await replaceDirectoryDialog(app, userFolder)
    const page = await app.firstWindow()
    const apiBaseUrl = await rendererApiBaseUrl(page)
    const turnPosts = recordTurnPosts(page, session.id)

    await page.getByRole('tab', { name: 'Library', exact: true }).click()
    await page.getByRole('button', { name: `Open ${PROJECT_NAME}`, exact: true }).click()
    const sharedFolders = page.getByRole('region', { name: 'Shared folders', exact: true })
    await sharedFolders.getByRole('button', { name: 'Add folder', exact: true }).click()
    await expect(sharedFolders.getByText(folderLabel, { exact: true })).toBeVisible()
    const folders = await listSessionFolders(apiBaseUrl, session.id)
    expect(folders.map((folder) => folder.path), 'the chat gets the project folder').toEqual([folderPath])
    const folderId = folders[0]?.id
    if (!folderId) throw new Error('The chat lists no folder ID.')
    readArguments.folder = folderId

    const chat = await openChat(page, PROJECT_CHAT_TITLE)
    await chat.getByRole('button', { name: 'Attached folders (1)', exact: true }).click()
    const fromProject = page.getByRole('list', { name: `From project "${PROJECT_NAME}"`, exact: true })
    await expect(fromProject.getByText(folderLabel, { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(fromProject).toHaveCount(0)

    await chat.getByRole('textbox').fill('When does the kiln open?')
    await chat.getByRole('textbox').press('Enter')
    await expect(chat.getByText(PROJECT_ANSWER).first()).toBeVisible({ timeout: 60_000 })

    const turnRequests = provider.requests.filter((request) => !isProviderHealthProbe(request))
    const readResults = turnRequests.filter((request) =>
      toolResultContents(request).some((content) => content.includes(PROJECT_FILE_SENTENCE)))
    expect(readResults.length, 'the file reached the model as a tool result').toBeGreaterThan(0)
    for (const request of readResults) {
      expect(request.model, 'the turn ran on the fixture model, not a real provider').toBe(MODEL_ID)
    }
    expect(turnPosts.length, 'the renderer sent the turn').toBeGreaterThan(0)
    for (const body of turnPosts) {
      expect(keysOf(body).filter((key) => /folder/i.test(key)), 'the turn request names no folders').toEqual([])
      const sent = JSON.stringify(body)
      expect(sent, 'the turn request carries no folder ID').not.toContain(folderId)
      expect(sent, 'the turn request carries no folder path').not.toContain(folderPath)
    }
  } catch (error) {
    primaryFailure = { error }
  }
  const launched = app
  await finishWithTeardown(primaryFailure, [
    ...(launched ? [() => launched.close()] : []),
    () => provider.close(),
    () => fs.rm(userFolder, { recursive: true, force: true }),
  ])
})

const MOVE_PROJECT_NAME = 'Folder move project'
const MOVED_CHAT_TITLE = 'Folder chat on the move'

test('an open chat moved into a project shows the project\'s folder in its header, and shows none once it is moved out', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const userDataPath = testInfo.outputPath('moved-chat-user-data')
  const workspacePath = testInfo.outputPath('moved-chat-workspace')
  const projectRoot = testInfo.outputPath('moved-chat-project')
  await Promise.all([userDataPath, workspacePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))
  await writeFrontDoorFixture(projectRoot)
  // The chat starts outside the project. No turn is sent, so no model is needed.
  const { session } = await seedChatBesideProject(workspacePath, MOVE_PROJECT_NAME, MOVED_CHAT_TITLE)
  // Outside the app data and the workspace, which the API refuses to share.
  const userFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-moved-chat-folder-'))
  const folderPath = await fs.realpath(userFolder)
  const folderLabel = path.basename(folderPath)
  let app: ElectronApplication | undefined
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    app = await launchDesktop({ userDataPath, workspacePath, projectRoot })
    await replaceDirectoryDialog(app, userFolder)
    const page = await app.firstWindow()
    const apiBaseUrl = await rendererApiBaseUrl(page)

    await page.getByRole('tab', { name: 'Library', exact: true }).click()
    await page.getByRole('button', { name: `Open ${MOVE_PROJECT_NAME}`, exact: true }).click()
    const sharedFolders = page.getByRole('region', { name: 'Shared folders', exact: true })
    await sharedFolders.getByRole('button', { name: 'Add folder', exact: true }).click()
    await expect(sharedFolders.getByText(folderLabel, { exact: true })).toBeVisible()

    const chat = await openChat(page, MOVED_CHAT_TITLE)
    await expect(chat.getByRole('button', { name: 'Add folder', exact: true })).toBeVisible()
    const sessionActions = page
      .getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('button', { name: `Session actions for ${MOVED_CHAT_TITLE}`, exact: true })
      .first()
    const assignment = page.getByRole('dialog', { name: 'Add to Project' })

    // Moved in from the sidebar while the chat stays open.
    await sessionActions.click()
    await page.getByRole('menuitem', { name: 'Add to Project', exact: true }).click()
    await assignment.getByRole('button', { name: MOVE_PROJECT_NAME, exact: true }).click()
    await expect(assignment).toHaveCount(0)
    const foldersInProject = await listSessionFolders(apiBaseUrl, session.id)
    expect(foldersInProject.map((folder) => folder.path), 'the next turn gets the project folder').toEqual([folderPath])
    await chat.getByRole('button', { name: 'Attached folders (1)', exact: true }).click()
    const fromProject = page.getByRole('list', { name: `From project "${MOVE_PROJECT_NAME}"`, exact: true })
    await expect(fromProject.getByText(folderLabel, { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(fromProject).toHaveCount(0)

    // Moved out again, still open.
    await sessionActions.click()
    await page.getByRole('menuitem', { name: 'Assign to Different Project', exact: true }).click()
    await assignment.getByRole('button', { name: 'Remove from project', exact: true }).click()
    await expect(assignment).toHaveCount(0)
    expect(await listSessionFolders(apiBaseUrl, session.id), 'the next turn gets no folder').toEqual([])
    await expect(chat.getByRole('button', { name: 'Add folder', exact: true })).toBeVisible()
    await expect(chat.getByRole('button', { name: /^Attached folders/ })).toHaveCount(0)
  } catch (error) {
    primaryFailure = { error }
  }
  const launched = app
  await finishWithTeardown(primaryFailure, [
    ...(launched ? [() => launched.close()] : []),
    () => fs.rm(userFolder, { recursive: true, force: true }),
  ])
})

const PDF_CHAT_TITLE = 'Folder PDF journey'
/** A small text PDF the file parser's own tests use. */
const PDF_FIXTURE = path.join(repoRoot, 'file-parser', 'tests', 'fixtures', 'malformed-trailer.pdf')
/** Printed inside the PDF only: it can reach the model only once the PDF has been parsed. */
const PDF_SENTENCE = 'patented soil water retention technology'
const PDF_ANSWER = 'LF06-ANSWER: the business plan was searched in the attached folder.'

test('a folder holding a PDF shows Indexing, then Ready with its file count, and the next turn reads text inside the PDF through the folder tools', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const userDataPath = testInfo.outputPath('pdf-folder-user-data')
  const workspacePath = testInfo.outputPath('pdf-folder-workspace')
  const projectRoot = testInfo.outputPath('pdf-folder-project')
  await Promise.all([userDataPath, workspacePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))
  // Outside the app data and the workspace, which the API refuses to share.
  const userFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-pdf-folder-'))
  await fs.mkdir(path.join(userFolder, 'Board packs'))
  await fs.copyFile(PDF_FIXTURE, path.join(userFolder, 'Board packs', 'business plan.pdf'))
  const folderLabel = path.basename(await fs.realpath(userFolder))
  const before = await snapshotTree(userFolder)
  await writeFrontDoorFixture(projectRoot)
  // Titled, so no title request is made, and found by its ID throughout.
  const session = await new FileSystemSessionStore(workspacePath).createSession({ title: PDF_CHAT_TITLE })

  // A search reads only text the index has already parsed, so a hit means the
  // indexing the folder showed is what put the PDF's text within reach. The
  // folder ID exists only once the folder is attached, so it is filled in then.
  const searchArguments: Record<string, unknown> = { query: 'soil water retention' }
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          !isProviderHealthProbe(request) &&
          offeredToolNames(request).includes('folder_search') &&
          toolResultContents(request).length === 0,
        toolCalls: [{ id: 'call-search-pdf', name: 'folder_search', arguments: searchArguments }],
      },
      { content: PDF_ANSWER, deltas: [PDF_ANSWER] },
    ],
  })
  let app: ElectronApplication | undefined
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    await writeProviderSettings(userDataPath, provider.url)
    app = await launchDesktop({ userDataPath, workspacePath, projectRoot })
    await replaceDirectoryDialog(app, userFolder)
    const page = await app.firstWindow()
    const chat = await openChat(page, PDF_CHAT_TITLE)

    await chat.getByRole('button', { name: 'Add folder', exact: true }).click()
    await chat.getByRole('button', { name: 'Attached folders (1)', exact: true }).click()
    const folderRow = page
      .getByRole('list', { name: 'This chat only', exact: true })
      .getByRole('listitem')
      .filter({ hasText: folderLabel })
    await expect(folderRow.getByText(/\bIndexing\b/)).toBeVisible()
    await expect(folderRow.getByText('1 file · Ready', { exact: true })).toBeVisible({ timeout: 60_000 })
    await page.keyboard.press('Escape')
    const folders = await listSessionFolders(await rendererApiBaseUrl(page), session.id)
    searchArguments.folder = folders[0]?.id

    await chat.getByRole('textbox').fill('What technology does the business plan describe?')
    await chat.getByRole('textbox').press('Enter')
    await expect(chat.getByText(PDF_ANSWER).first()).toBeVisible({ timeout: 60_000 })

    // The turn's last request carries every tool result of the turn.
    const turnRequests = provider.requests.filter((request) => !isProviderHealthProbe(request))
    const lastRequest = turnRequests.at(-1)
    const results = lastRequest ? toolResultContents(lastRequest) : []
    expect(results, 'one folder_search result reached the model').toHaveLength(1)
    expect(results[0], 'the search found the sentence inside the PDF').toMatch(
      /^Board packs\/business plan\.pdf:\d+: .*patented soil water retention technology/m,
    )
    for (const request of turnRequests) {
      expect(request.model, 'the turn ran on the fixture model, not a real provider').toBe(MODEL_ID)
      expect(promptText(request), 'document text never enters the prompt').not.toContain(PDF_SENTENCE)
    }
    expect(await snapshotTree(userFolder), "nothing was written inside the user's folder").toEqual(before)
  } catch (error) {
    primaryFailure = { error }
  }
  const launched = app
  await finishWithTeardown(primaryFailure, [
    ...(launched ? [() => launched.close()] : []),
    () => provider.close(),
    () => fs.rm(userFolder, { recursive: true, force: true }),
  ])
})

const MOVED_FOLDER_CHAT_TITLE = 'Folder moved away journey'
/** A chat with no folders, where the person is while a folder changes. */
const OTHER_CHAT_TITLE = 'Unrelated chat'

test('a folder moved away while attached shows Folder not found in the chat popover, with a warning on the header button', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const userDataPath = testInfo.outputPath('moved-folder-user-data')
  const workspacePath = testInfo.outputPath('moved-folder-workspace')
  const projectRoot = testInfo.outputPath('moved-folder-project')
  await Promise.all([userDataPath, workspacePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))
  await writeFrontDoorFixture(projectRoot)
  // No turn is sent, so no model is needed. The second chat is where the
  // person is while the folder moves.
  const sessions = new FileSystemSessionStore(workspacePath)
  await sessions.createSession({ title: MOVED_FOLDER_CHAT_TITLE })
  await sessions.createSession({ title: OTHER_CHAT_TITLE })
  // Outside the app data and the workspace, which the API refuses to share.
  const userFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-moved-folder-'))
  await fs.writeFile(path.join(userFolder, 'plan.md'), '# Plan\n', 'utf8')
  const folderLabel = path.basename(await fs.realpath(userFolder))
  const movedTo = `${userFolder}-moved`
  let app: ElectronApplication | undefined
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    app = await launchDesktop({ userDataPath, workspacePath, projectRoot })
    await replaceDirectoryDialog(app, userFolder)
    const page = await app.firstWindow()
    const chat = await openChat(page, MOVED_FOLDER_CHAT_TITLE)
    const folderRow = page
      .getByRole('list', { name: 'This chat only', exact: true })
      .getByRole('listitem')
      .filter({ hasText: folderLabel })

    await chat.getByRole('button', { name: 'Add folder', exact: true }).click()
    await chat.getByRole('button', { name: 'Attached folders (1)', exact: true }).click()
    await expect(folderRow.getByText('1 file · Ready', { exact: true })).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Escape')

    // Moved in Finder while the person works in another chat. A chat reads
    // its folders, with their statuses, when it is opened.
    await openChat(page, OTHER_CHAT_TITLE)
    await fs.rename(userFolder, movedTo)
    const returned = await openChat(page, MOVED_FOLDER_CHAT_TITLE)

    const warned = returned.getByRole('button', { name: 'Attached folders (1), 1 needs attention', exact: true })
    await expect(warned).toBeVisible()
    await warned.click()
    await expect(folderRow.getByText('Folder not found', { exact: true })).toBeVisible()
  } catch (error) {
    primaryFailure = { error }
  }
  const launched = app
  await finishWithTeardown(primaryFailure, [
    ...(launched ? [() => launched.close()] : []),
    () => fs.rm(userFolder, { recursive: true, force: true }),
    () => fs.rm(movedTo, { recursive: true, force: true }),
  ])
})

const OPEN_FOLDER_CHAT_TITLE = 'Open folder journey'

test('clicking a folder\'s name in the chat popover opens that folder in the file manager', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const userDataPath = testInfo.outputPath('open-folder-user-data')
  const workspacePath = testInfo.outputPath('open-folder-workspace')
  const projectRoot = testInfo.outputPath('open-folder-project')
  await Promise.all([userDataPath, workspacePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))
  await writeFrontDoorFixture(projectRoot)
  await new FileSystemSessionStore(workspacePath).createSession({ title: OPEN_FOLDER_CHAT_TITLE })
  const userFolder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-open-folder-')))
  await fs.writeFile(path.join(userFolder, 'plan.md'), '# Plan\n', 'utf8')
  const folderLabel = path.basename(userFolder)
  let app: ElectronApplication | undefined
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    app = await launchDesktop({ userDataPath, workspacePath, projectRoot })
    await replaceDirectoryDialog(app, userFolder)
    // Record what reaches the operating system instead of opening Finder.
    await app.evaluate(({ shell }) => {
      const opens: string[] = []
      Reflect.set(globalThis, 'sharedFolderOpens', opens)
      shell.openPath = async (folderPath: string) => {
        opens.push(folderPath)
        return ''
      }
    })
    const page = await app.firstWindow()
    const chat = await openChat(page, OPEN_FOLDER_CHAT_TITLE)

    await chat.getByRole('button', { name: 'Add folder', exact: true }).click()
    await chat.getByRole('button', { name: 'Attached folders (1)', exact: true }).click()
    await page
      .getByRole('list', { name: 'This chat only', exact: true })
      .getByRole('button', { name: new RegExp(`^Show ${folderLabel} in `) })
      .click()

    await expect.poll(() => launchedApp(app).evaluate(() => {
      const opens: unknown = Reflect.get(globalThis, 'sharedFolderOpens')
      return Array.isArray(opens) ? opens : []
    })).toEqual([userFolder])
  } catch (error) {
    primaryFailure = { error }
  }
  const launched = app
  await finishWithTeardown(primaryFailure, [
    ...(launched ? [() => launched.close()] : []),
    () => fs.rm(userFolder, { recursive: true, force: true }),
  ])
})

function launchedApp(app: ElectronApplication | undefined): ElectronApplication {
  if (!app) throw new Error('The desktop app was not launched.')
  return app
}

const REVOKED_CHAT_TITLE = 'Folder revoked journey'
/** Known only to the file on disk, so it can reach the model by one route alone. */
const REVOKED_FILE_SENTENCE = 'The vault opens at dawn, code LF12-HEMLOCK-9.'
const REVOKED_ANSWER = 'LF12-ANSWER: the folder could not be read.'

test('revoking a shared folder in Settings shows Access removed for that folder in the chat popover, and the next turn\'s tool call is refused', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const userDataPath = testInfo.outputPath('revoked-folder-user-data')
  const workspacePath = testInfo.outputPath('revoked-folder-workspace')
  const projectRoot = testInfo.outputPath('revoked-folder-project')
  await Promise.all([userDataPath, workspacePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))
  await writeFrontDoorFixture(projectRoot)
  // Titled, so no title request is made, and found by its ID throughout.
  const sessions = new FileSystemSessionStore(workspacePath)
  const session = await sessions.createSession({ title: REVOKED_CHAT_TITLE })
  await sessions.createSession({ title: OTHER_CHAT_TITLE })
  // Outside the app data and the workspace, which the API refuses to share.
  const userFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-revoked-folder-'))
  await fs.mkdir(path.join(userFolder, 'notes'))
  await fs.writeFile(path.join(userFolder, 'notes', 'vault.md'), `# Vault\n\n${REVOKED_FILE_SENTENCE}\n`, 'utf8')
  const folderPath = await fs.realpath(userFolder)
  const folderLabel = path.basename(folderPath)

  // The turn's first tool round asks for the file, as it would before the
  // revocation. The folder ID exists only once the folder is attached.
  const readArguments: Record<string, unknown> = { path: 'notes/vault.md' }
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          !isProviderHealthProbe(request) &&
          offeredToolNames(request).includes('folder_read') &&
          toolResultContents(request).length === 0,
        toolCalls: [{ id: 'call-read-vault', name: 'folder_read', arguments: readArguments }],
      },
      { content: REVOKED_ANSWER, deltas: [REVOKED_ANSWER] },
    ],
  })
  let app: ElectronApplication | undefined
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    await writeProviderSettings(userDataPath, provider.url)
    app = await launchDesktop({ userDataPath, workspacePath, projectRoot })
    await replaceDirectoryDialog(app, userFolder)
    const page = await app.firstWindow()
    const chat = await openChat(page, REVOKED_CHAT_TITLE)
    await chat.getByRole('button', { name: 'Add folder', exact: true }).click()
    await expect(chat.getByRole('button', { name: 'Attached folders (1)', exact: true })).toBeVisible()
    const folders = await listSessionFolders(await rendererApiBaseUrl(page), session.id)
    readArguments.folder = folders[0]?.id

    // Revoked in Settings while the person works in another chat. A chat
    // reads its folders, with their statuses, when it is opened.
    await openChat(page, OTHER_CHAT_TITLE)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Shared folders', exact: true })
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Shared folders', exact: true })
      .click()
    await settings.getByRole('button', { name: `Revoke ${folderPath}`, exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: 'Revoke folder access?', exact: true })
    await confirmation.getByRole('button', { name: 'Revoke folder access', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await expect(settings.getByText('No folders have been shared with agents.', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    const returned = await openChat(page, REVOKED_CHAT_TITLE)

    await returned.getByRole('button', { name: 'Attached folders (1), 1 needs attention', exact: true }).click()
    const folderRow = page
      .getByRole('list', { name: 'This chat only', exact: true })
      .getByRole('listitem')
      .filter({ hasText: folderLabel })
    await expect(folderRow.getByText('Access removed', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    await returned.getByRole('textbox').fill('What does my vault note say?')
    await returned.getByRole('textbox').press('Enter')
    await expect(returned.getByText(REVOKED_ANSWER).first()).toBeVisible({ timeout: 60_000 })

    // The turn's last request carries every tool result of the turn.
    const turnRequests = provider.requests.filter((request) => !isProviderHealthProbe(request))
    const lastRequest = turnRequests.at(-1)
    const results = lastRequest ? toolResultContents(lastRequest) : []
    expect(results, 'one folder_read result reached the model').toHaveLength(1)
    expect(results[0], 'the tool call was refused').toContain('Access to this folder was removed')
    for (const request of turnRequests) {
      expect(request.model, 'the turn ran on the fixture model, not a real provider').toBe(MODEL_ID)
      const sent = JSON.stringify(request.body.messages)
      expect(sent, 'no text of the file reached the model').not.toContain('opens at dawn')
      expect(sent, 'no text of the file reached the model').not.toContain('LF12-HEMLOCK-9')
    }
  } catch (error) {
    primaryFailure = { error }
  }
  const launched = app
  await finishWithTeardown(primaryFailure, [
    ...(launched ? [() => launched.close()] : []),
    () => provider.close(),
    () => fs.rm(userFolder, { recursive: true, force: true }),
  ])
})

const NO_TOOLS_CHAT_TITLE = 'Folder notice journey'
const NO_TOOLS_AGENT: { readonly name: string; readonly label: string } = { name: 'plain-reader', label: 'Plain Reader' }
/** In the Agent's instructions, so the fake endpoint knows the turn is this Agent's. */
const NO_TOOLS_PERSONA = 'You are plain-reader. Answer from the folder map.'
const NO_TOOLS_MODEL_ID = 'fake-claude'
/** A key only the loopback Messages endpoint below ever sees. */
const NO_TOOLS_API_KEY = 'shared-folders-anthropic-key-loopback-only'
const NO_TOOLS_ANSWER = 'LF09-ANSWER: I can see the folder name, not its files.'
const FOLDER_TOOLS_NOTICE =
  "This model can see folder names but can't open files. Use a model with tool support to work with folder contents."

test('a chat whose agent cannot use tools shows the no-tools notice after a turn with folders', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const userDataPath = testInfo.outputPath('no-tools-user-data')
  const workspacePath = testInfo.outputPath('no-tools-workspace')
  const projectRoot = testInfo.outputPath('no-tools-project')
  await Promise.all([userDataPath, workspacePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))
  // Titled, so no title request is made.
  await new FileSystemSessionStore(workspacePath).createSession({ title: NO_TOOLS_CHAT_TITLE })
  // Outside the app data and the workspace, which the API refuses to share.
  const userFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-no-tools-folder-'))
  await fs.writeFile(path.join(userFolder, 'plan.md'), '# Plan\n', 'utf8')

  await writeFrontDoorFixture(projectRoot)
  const anthropic = await startFakeAnthropicMessagesServer({
    turns: [{ persona: NO_TOOLS_PERSONA, chunks: [NO_TOOLS_ANSWER] }],
  })
  // The app default stays on the fixture connection, which has tools, so a
  // turn that left the Anthropic lane would land here and show.
  const provider = await startFakeChatCompletionsServer({ script: [] })
  let app: ElectronApplication | undefined
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    await writePlainReaderAgent(projectRoot, anthropic.messagesUrl)
    await writeProviderSettings(userDataPath, provider.url)
    app = await launchDesktop({
      userDataPath,
      workspacePath,
      projectRoot,
      env: { ANTHROPIC_API_KEY: NO_TOOLS_API_KEY },
    })
    await replaceDirectoryDialog(app, userFolder)
    const page = await app.firstWindow()
    const chat = await openChat(page, NO_TOOLS_CHAT_TITLE)
    await chat.getByRole('button', { name: 'Add folder', exact: true }).click()
    await expect(chat.getByRole('button', { name: 'Attached folders (1)', exact: true })).toBeVisible()
    const notice = chat.getByRole('status').filter({ hasText: FOLDER_TOOLS_NOTICE })
    await expect(notice, 'no notice before a turn').toHaveCount(0)

    await askAgent(chat, page, NO_TOOLS_AGENT, 'What does my plan say?')
    await expect(chat.getByText(NO_TOOLS_ANSWER).first()).toBeVisible({ timeout: 60_000 })
    await expect(notice).toBeVisible()

    expect(anthropic.requests.length, 'the turn reached the loopback Anthropic endpoint').toBeGreaterThan(0)
    for (const request of anthropic.requests) {
      expect(request.model, 'the turn ran on the fixture model').toBe(NO_TOOLS_MODEL_ID)
      expect(request.apiKey, 'only the fixture key was sent').toBe(NO_TOOLS_API_KEY)
    }
    expect(
      provider.requests.filter((request) => !isProviderHealthProbe(request)),
      'no turn went to the connection with tools',
    ).toEqual([])
  } catch (error) {
    primaryFailure = { error }
  }
  const launched = app
  await finishWithTeardown(primaryFailure, [
    ...(launched ? [() => launched.close()] : []),
    () => anthropic.close(),
    () => provider.close(),
    () => fs.rm(userFolder, { recursive: true, force: true }),
  ])
})

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

async function openChat(page: Page, title: string) {
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page
    .getByRole('complementary', { name: 'Primary navigation' })
    .getByRole('button', { name: new RegExp(`^${title}\\b`) })
    .first()
    .click()
  const chat = page.getByRole('region', { name: 'Run chat' })
  await expect(chat.getByText(title, { exact: true })).toBeVisible()
  return chat
}

/** A titled chat, so no title request is made, inside a new active project. */
async function seedProjectChat(workspacePath: string, projectName: string, chatTitle: string) {
  const projects = new WorkspaceProjectService({
    projectStore: new WorkspaceProjectStore({ workspacePath }),
    membershipStore: new WorkspaceProjectMembershipStore({ workspacePath }),
    sessionStore: new FileSystemSessionStore(workspacePath),
  })
  const project = await projects.createProject({ name: projectName })
  const session = await projects.createSession({ title: chatTitle, projectId: project.id })
  return { project, session }
}

/** A titled chat in no project, beside a new active project it can be moved into. */
async function seedChatBesideProject(workspacePath: string, projectName: string, chatTitle: string) {
  const projects = new WorkspaceProjectService({
    projectStore: new WorkspaceProjectStore({ workspacePath }),
    membershipStore: new WorkspaceProjectMembershipStore({ workspacePath }),
    sessionStore: new FileSystemSessionStore(workspacePath),
  })
  const project = await projects.createProject({ name: projectName })
  const session = await projects.createSession({ title: chatTitle })
  return { project, session }
}

/** The body of every message the renderer posts to this chat, whichever route sends it. */
function recordTurnPosts(page: Page, sessionId: string): unknown[] {
  const route = new RegExp(`/sessions/${sessionId}(/agent-chat)?/messages$`)
  const bodies: unknown[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && route.test(new URL(request.url()).pathname)) {
      bodies.push(request.postDataJSON())
    }
  })
  return bodies
}

/** Every key in a JSON value, at any depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf)
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([key, entry]) => [key, ...keysOf(entry)])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestMessages(request: FakeChatCompletionsRequest): unknown[] {
  const messages = request.body.messages
  return Array.isArray(messages) ? messages : []
}

function toolResultContents(request: FakeChatCompletionsRequest): string[] {
  return requestMessages(request).flatMap((message) =>
    isRecord(message) && message.role === 'tool' && typeof message.content === 'string' ? [message.content] : [])
}

/** Everything the request carries except tool results: the system prompt, the user's turn and the history. */
function promptText(request: FakeChatCompletionsRequest): string {
  return JSON.stringify(requestMessages(request).filter((message) => !isRecord(message) || message.role !== 'tool'))
}

/** Every entry under `root` with its size and modification time; equal snapshots mean nothing was written. */
async function snapshotTree(root: string): Promise<string[]> {
  const rows = [`.|dir|${(await fs.stat(root)).mtimeMs}`]
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    const fullPath = path.join(entry.parentPath, entry.name)
    const stat = await fs.lstat(fullPath)
    rows.push(`${path.relative(root, fullPath)}|${stat.isDirectory() ? 'dir' : String(stat.size)}|${stat.mtimeMs}`)
  }
  return rows.sort()
}

function offeredToolNames(request: FakeChatCompletionsRequest): string[] {
  const tools = request.body.tools
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool: unknown) => {
    const fn = isRecord(tool) ? tool.function : undefined
    return isRecord(fn) && typeof fn.name === 'string' ? [fn.name] : []
  })
}

async function listSessionFolders(
  apiBaseUrl: string,
  sessionId: string,
): Promise<Array<{ readonly id: string; readonly path: string }>> {
  const response = await fetch(`${apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/folders`)
  expect(response.status).toBe(200)
  const payload: unknown = await response.json()
  const folders = isRecord(payload) && Array.isArray(payload.folders) ? payload.folders : []
  return folders.flatMap((folder: unknown) =>
    isRecord(folder) && typeof folder.id === 'string' && typeof folder.path === 'string'
      ? [{ id: folder.id, path: folder.path }]
      : [])
}

async function rendererApiBaseUrl(page: Page): Promise<string> {
  await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
  const hash = await page.evaluate(() => window.location.hash.slice(1))
  const value = new URLSearchParams(hash).get('pipeline-api-base-url')
  if (!value) throw new Error('Desktop renderer did not expose its API base URL.')
  return value
}

async function replaceDirectoryDialog(app: ElectronApplication, selectedPath: string): Promise<void> {
  await app.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folderPath] })
  }, selectedPath)
}

/** The shipped front door's shape, on a provider this test answers for. */
async function writeFrontDoorFixture(projectRoot: string): Promise<void> {
  const directory = path.join(projectRoot, 'agents', 'general-agent')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'general-agent.md'),
    [
      '---',
      'name: general-agent',
      'description: General Agent, the Run front door.',
      'tier: orchestration',
      `provider: connection:${CONNECTION_ID}`,
      `model: ${MODEL_ID}`,
      'thinking: low',
      'system: true',
      '---',
      '',
      '# General Agent',
      '',
      'Answer the question.',
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * An Agent on the direct Anthropic lane, which has no tool lane in chat
 * (`domains/mcp/mcp-provider-support.ts`). Not the front door: the front door
 * follows the app default, and an Agent named in a turn runs on its own model.
 * The endpoint is a loopback fake named in the Agent's own provider options;
 * the key is set in the launch, never in the file.
 */
async function writePlainReaderAgent(projectRoot: string, messagesUrl: string): Promise<void> {
  const directory = path.join(projectRoot, 'agents', NO_TOOLS_AGENT.name)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, `${NO_TOOLS_AGENT.name}.md`),
    [
      '---',
      `name: ${NO_TOOLS_AGENT.name}`,
      'description: Answers from the folder map alone.',
      'tier: execution',
      'provider: anthropic',
      `model: ${NO_TOOLS_MODEL_ID}`,
      'thinking: low',
      `provider_options: ${JSON.stringify({ base_url: messagesUrl })}`,
      '---',
      '',
      `# ${NO_TOOLS_AGENT.label}`,
      '',
      NO_TOOLS_PERSONA,
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * Addresses one Agent through the mention menu and sends the turn. The menu
 * takes focus when it opens, so the Agent is picked there by its exact label,
 * and the composer is checked before sending: a bare `@` would go to the
 * front door instead.
 */
async function askAgent(
  chat: Locator,
  page: Page,
  agent: { readonly name: string; readonly label: string },
  question: string,
): Promise<void> {
  const composer = chat.getByRole('textbox')
  await composer.click()
  await composer.pressSequentially('@')
  const search = page.getByRole('combobox', { name: 'Search agents to mention' })
  await expect(search).toBeFocused()
  await search.fill(agent.name)
  await page.getByRole('listbox', { name: 'Agent mentions' }).getByRole('option', { name: agent.label, exact: true }).click()
  await expect(composer).toHaveValue(`@${agent.name} `)
  await composer.pressSequentially(question)
  await composer.press('Enter')
}

/**
 * The fixture model, in the catalog and stored as the default, on a keyless
 * `lm-studio` connection: the native tool route an Agent chat turn takes
 * refuses a keyless `openai-compatible` one.
 */
async function writeProviderSettings(userDataPath: string, baseUrl: string): Promise<void> {
  await fs.writeFile(
    path.join(userDataPath, 'provider-settings.json'),
    JSON.stringify({
      version: 1,
      connections: [
        {
          id: CONNECTION_ID,
          kind: 'lm-studio',
          name: 'Shared folders fixture',
          baseUrl: `${baseUrl}/v1`,
          enabled: true,
          status: 'connected',
          models: [{ id: MODEL_ID, name: 'Shared Folders Fixture', enabled: true, capabilities: ['chat'] }],
        },
      ],
      cliEnabled: {},
      cliModelEnabled: {},
      defaultModel: { provider: `connection:${CONNECTION_ID}`, model: MODEL_ID },
    }),
    'utf8',
  )
}

async function launchDesktop(options: {
  readonly userDataPath: string
  readonly workspacePath: string
  readonly projectRoot: string
  /** A fixture key the journey's model lane reads from the environment. */
  readonly env?: Readonly<Record<string, string>>
}): Promise<ElectronApplication> {
  return launchFixtureDesktop({
    userDataPath: options.userDataPath,
    workspacePath: options.workspacePath,
    env: { NODE_ENV: 'test', PIPELINE_DESKTOP_PROJECT_ROOT: options.projectRoot, ...options.env },
  })
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
