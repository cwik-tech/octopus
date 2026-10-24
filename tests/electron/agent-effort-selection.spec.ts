/**
 * Choosing how hard an Agent thinks, all the way to the provider.
 *
 * The failure this journey exists to catch is a setting that looks applied
 * everywhere except where it matters: the control shows a level, the file
 * stores it, the screen still shows it after a restart — and the request that
 * reaches the provider carries nothing. So the last assertion here is against
 * the body the fake provider actually received, not against anything the
 * application says about itself.
 *
 * It also covers the two states that are not levels. An Agent that names no
 * level follows the application default, stored as an absence; the provider's
 * own default is a separate, explicit choice that sends no effort setting at
 * all. Those three answers are what the control offers, and they are different
 * things rather than points on one scale.
 */
import {
  _electron as electron,
  expect,
  test,
  type Page,
} from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  FIXTURE_PROVIDER,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
  writeAgentPersona,
  type FixtureModel,
} from './support/model-selection-fixture.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

const THINKER = { name: 'effort-thinker', label: 'Effort Thinker' }
const THINKER_MARKER = 'MARKER-EFFORT-THINKER'

/** A model whose reported range reaches above the three historic levels. */
const DEEP_MODEL: FixtureModel = {
  id: 'fake/deep-model',
  name: 'Fake Deep Model',
  supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
}

function leftSidebar(page: Page) {
  return page.locator('[data-slot="workspace-sidebar"][data-side="left"]')
}

async function openAgentInCreate(page: Page, agentLabel: string): Promise<void> {
  await page.getByRole('tab', { name: 'Create', exact: true }).click()
  await page
    .getByLabel('Resource type')
    .getByRole('tab', { name: 'Agents', exact: true })
    .click()
  await leftSidebar(page)
    .getByRole('button', { name: new RegExp(`^${agentLabel}\\b`) })
    .first()
    .click()
}

/** The persona file as it stands on disk, which is the durable answer. */
async function personaOnDisk(
  projectRoot: string,
  agentName: string,
): Promise<string> {
  return fs.readFile(
    path.join(projectRoot, 'agents', agentName, `${agentName}.md`),
    'utf8',
  )
}

/**
 * Address one Agent and send the turn, through the mention menu as it is.
 *
 * The menu takes typing focus when it opens: `chat-panel.tsx` renders its
 * `PopoverContent` with `initialFocus={searchRef}`, pointing at the separate
 * "Search agents to mention" combobox. So everything typed after the `@` goes
 * into that search field rather than into the composer, and dismissing the menu
 * leaves a bare `@` behind with no agent attached. A turn sent that way is
 * addressed to nobody in particular and the General Agent answers it, which is
 * how an earlier version of this journey silently tested the wrong agent.
 *
 * The agent is therefore chosen from the menu by its exact name, and the
 * composer is checked before the question is sent. Asserting the addressee
 * here, rather than only at the end, is what turns "the reply looked right"
 * into "this Agent was asked".
 */
async function askAgent(
  page: Page,
  agent: { readonly name: string; readonly label: string },
  question: string,
): Promise<void> {
  const composer = page.getByPlaceholder('Send a message...')
  await composer.click()
  await composer.pressSequentially('@')

  const search = page.getByRole('combobox', { name: 'Search agents to mention' })
  await expect(search).toBeFocused()
  await search.fill(agent.name)

  const menu = page.getByRole('listbox', { name: 'Agent mentions' })
  await menu.getByRole('option', { name: agent.label, exact: true }).click()
  await expect(composer).toHaveValue(`@${agent.name} `)

  await composer.pressSequentially(question)
  await composer.press('Enter')
}

/** Where this run's frames go, created once and reported as it is used. */
let evidenceDirectory: string | undefined

/**
 * Save a frame for a human to look at, when a run asks for one.
 *
 * Off unless `PIPELINE_EFFORT_EVIDENCE` is set, and never written inside the
 * repository even then. Screenshots are how a person checks a rendering
 * decision; they are not source, they go stale the moment the layout changes,
 * and a binary that lands in history is one nobody can review. So the frames
 * go to an operating-system temporary directory and the path is printed for
 * whoever asked for them.
 */
async function captureEvidence(page: Page, name: string): Promise<void> {
  if (!process.env.PIPELINE_EFFORT_EVIDENCE?.trim()) return
  evidenceDirectory ??= await fs.mkdtemp(
    path.join(os.tmpdir(), 'pipeline-effort-evidence-'),
  )
  const file = path.join(evidenceDirectory, `${name}.png`)
  await page.screenshot({ path: file })
  console.log(`[evidence] ${file}`)
}

async function openRunSession(page: Page, title: string): Promise<void> {
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await leftSidebar(page)
    .getByRole('button', { name: new RegExp(`^${title}\\b`) })
    .first()
    .click()
}

/**
 * The menu for a pair whose range nobody publishes.
 *
 * Claude Code prints no per-model list, so its aliases reached the editor with
 * an empty menu while their range was fully documented. This opens the real
 * control on a real Agent and reads what it offers.
 */
test('a Claude Code alias offers the levels its documentation lists', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const provider = await startFakeChatCompletionsServer({ script: [{ content: 'ok' }] })
  const workspacePath = testInfo.outputPath('claude-effort-workspace')
  const projectRoot = testInfo.outputPath('claude-effort-project')
  const userDataPath = testInfo.outputPath('claude-effort-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    writeAgentPersona(projectRoot, {
      name: 'claude-thinker',
      description: 'Runs on Claude Code.',
      marker: 'MARKER-CLAUDE-THINKER',
      provider: 'claude',
      model: 'opus',
      thinking: null,
    }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      models: [DEEP_MODEL],
      defaultModel: DEEP_MODEL,
    }),
  ])

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await openAgentInCreate(page, 'Claude Thinker')

    const effort = page.getByRole('combobox', { name: 'Agent effort' })
    await expect(effort).toHaveText(/Application default/i, { timeout: 30_000 })
    await effort.click()

    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      await expect(
        page.getByRole('option', { name: level, exact: true }),
      ).toBeVisible({ timeout: 20_000 })
    }
    await expect(page.getByRole('option', { name: 'Provider default' })).toBeVisible()
    await captureEvidence(page, 'claude-code-alias-effort-menu')
  } finally {
    await app.close()
    await provider.close()
  }
})

/**
 * The menu for a provider that has no catalogue group at all.
 *
 * `openai` is neither a local CLI nor a configured connection, so nothing in
 * the catalogue describes it. An Agent naming it had an empty menu while its
 * model's range was fully documented, which is what the capability list beside
 * the catalogue exists to carry.
 */
test('a native API model offers the levels its own documentation lists', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const provider = await startFakeChatCompletionsServer({ script: [{ content: 'ok' }] })
  const workspacePath = testInfo.outputPath('openai-effort-workspace')
  const projectRoot = testInfo.outputPath('openai-effort-project')
  const userDataPath = testInfo.outputPath('openai-effort-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    writeAgentPersona(projectRoot, {
      name: 'openai-thinker',
      description: 'Runs on the OpenAI API.',
      marker: 'MARKER-OPENAI-THINKER',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      thinking: null,
    }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      models: [DEEP_MODEL],
      defaultModel: DEEP_MODEL,
    }),
  ])

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await openAgentInCreate(page, 'Openai Thinker')

    const effort = page.getByRole('combobox', { name: 'Agent effort' })
    await expect(effort).toHaveText(/Application default/i, { timeout: 30_000 })
    await effort.click()

    // `off` is the point of this pair: this model documents `none`, and a menu
    // without it cannot ask for no reasoning at all.
    for (const level of ['off', 'low', 'medium', 'high', 'xhigh', 'max']) {
      await expect(
        page.getByRole('option', { name: level, exact: true }),
      ).toBeVisible({ timeout: 20_000 })
    }
    await captureEvidence(page, 'native-openai-effort-menu')
  } finally {
    await app.close()
    await provider.close()
  }
})

test('an effort chosen in the editor is stored, survives a restart, and reaches the provider', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const provider = await startFakeChatCompletionsServer({
    script: [{ content: 'Thought about it.' }],
  })

  const workspacePath = testInfo.outputPath('effort-workspace')
  const projectRoot = testInfo.outputPath('effort-project')
  const userDataPath = testInfo.outputPath('effort-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    writeAgentPersona(projectRoot, {
      name: THINKER.name,
      description: 'Thinks as hard as it is told to.',
      marker: THINKER_MARKER,
      provider: FIXTURE_PROVIDER,
      model: DEEP_MODEL.id,
      // Names no level, so it starts out following the application default.
      thinking: null,
    }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      models: [DEEP_MODEL],
      defaultModel: DEEP_MODEL,
      // Keyless LM Studio: the native tool route refuses a keyless
      // OpenAI-compatible connection.
      kind: 'lm-studio',
    }),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  await sessionStore.createSession({ title: 'Effort Journey' })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await openAgentInCreate(page, THINKER.label)

    // A combobox rather than a button: this control is the shared Select
    // primitive, where the model control beside it is its own picker.
    const effort = page.getByRole('combobox', { name: 'Agent effort' })
    await expect(effort).toHaveText(/Application default/i, { timeout: 30_000 })

    await effort.click()
    await page.getByRole('option', { name: 'xhigh', exact: true }).click()

    // Written to the Agent's own file, which is what makes the choice travel
    // with the Agent rather than living in this installation's settings.
    await expect
      .poll(async () => personaOnDisk(projectRoot, THINKER.name), {
        timeout: 20_000,
      })
      .toMatch(/^thinking: xhigh$/m)

    // Reloaded rather than re-rendered: the control has to read the file, not
    // whatever the renderer was still holding.
    await page.reload()
    await openAgentInCreate(page, THINKER.label)
    await expect(
      page.getByRole('combobox', { name: 'Agent effort' }),
    ).toHaveText(/xhigh/, { timeout: 30_000 })

    await captureEvidence(page, 'agent-editor-effort-xhigh')

    await openRunSession(page, 'Effort Journey')
    await askAgent(page, THINKER, 'Say something')

    await expect(
      page.getByRole('region', { name: 'Run chat' })
        .getByRole('log')
        .getByText('Thought about it.'),
    ).toBeVisible({ timeout: 60_000 })

    // The assertion the rest of the journey exists to reach: what the provider
    // was actually asked for.
    const turn = provider.requests.find(
      (request) => request.systemPrompt?.includes(THINKER_MARKER) ?? false,
    )
    expect(turn, 'the thinker\'s own request').toBeTruthy()
    expect(turn?.body.reasoning_effort).toBe('xhigh')

    await captureEvidence(page, 'run-chat-reply-after-xhigh-turn')
  } finally {
    await app.close()
    await provider.close()
  }
})
