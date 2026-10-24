/**
 * The application default effort, chosen in Settings and obeyed by a turn.
 *
 * Three claims, and each fails differently if it is wrong: the choice is saved
 * where a restart can find it; an Agent that names no level runs at it; and an
 * Agent that names one is untouched by it. The last assertion of each turn is
 * the request the provider received, because a setting that only changes what
 * the screen says is not a setting.
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  startFakeChatCompletionsServer,
  type FakeChatCompletionsServer,
} from '../support/fake-chat-completions-server.js'
import {
  FIXTURE_PROVIDER,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
  writeAgentPersona,
  type FixtureModel,
} from './support/model-selection-fixture.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

const DEEP_MODEL: FixtureModel = {
  id: 'fake/deep-model',
  name: 'Fake Deep Model',
  supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
}

const INHERITOR = { name: 'effort-inheritor', label: 'Effort Inheritor' }
const PINNED = { name: 'effort-pinned', label: 'Effort Pinned' }
const INHERITOR_MARKER = 'MARKER-EFFORT-INHERITOR'
const PINNED_MARKER = 'MARKER-EFFORT-PINNED'

let evidenceDirectory: string | undefined

/** A frame for a human, in temporary storage and never in the repository. */
async function captureEvidence(page: Page, name: string): Promise<void> {
  if (!process.env.PIPELINE_EFFORT_EVIDENCE?.trim()) return
  evidenceDirectory ??= await fs.mkdtemp(
    path.join(os.tmpdir(), 'pipeline-effort-evidence-'),
  )
  const file = path.join(evidenceDirectory, `${name}.png`)
  await page.screenshot({ path: file })
  console.log(`[evidence] ${file}`)
}

function leftSidebar(page: Page) {
  return page.locator('[data-slot="workspace-sidebar"][data-side="left"]')
}

async function openRunSession(page: Page, title: string): Promise<void> {
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await leftSidebar(page)
    .getByRole('button', { name: new RegExp(`^${title}\\b`) })
    .first()
    .click()
}

/** Address one Agent through the mention menu, as a person does. */
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
  await page
    .getByRole('listbox', { name: 'Agent mentions' })
    .getByRole('option', { name: agent.label, exact: true })
    .click()
  await expect(composer).toHaveValue(`@${agent.name} `)
  await composer.pressSequentially(question)
  await composer.press('Enter')
}

function effortFor(
  provider: FakeChatCompletionsServer,
  marker: string,
): unknown {
  return provider.requests.find(
    (request) => request.systemPrompt?.includes(marker) ?? false,
  )?.body.reasoning_effort
}

test('a default effort chosen in Settings survives a restart and governs the Agents that name none', async ({}, testInfo) => {
  test.setTimeout(240_000)

  const provider = await startFakeChatCompletionsServer({
    script: [{ content: 'Considered.' }],
  })
  const workspacePath = testInfo.outputPath('default-effort-workspace')
  const projectRoot = testInfo.outputPath('default-effort-project')
  const userDataPath = testInfo.outputPath('default-effort-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    writeAgentPersona(projectRoot, {
      name: INHERITOR.name,
      description: 'Names no effort level.',
      marker: INHERITOR_MARKER,
      provider: FIXTURE_PROVIDER,
      model: DEEP_MODEL.id,
      thinking: null,
    }),
    writeAgentPersona(projectRoot, {
      name: PINNED.name,
      description: 'Names its own effort level.',
      marker: PINNED_MARKER,
      provider: FIXTURE_PROVIDER,
      model: DEEP_MODEL.id,
      thinking: 'low',
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
  await sessionStore.createSession({ title: 'Default Effort Journey' })

  const environment = desktopEnvironment({ projectRoot, userDataPath, workspacePath })
  // The fake provider is closed in one outer `finally`, so a failure in the
  // first launch cannot leave its HTTP server listening for the rest of the run.
  try {
    const first = await electron.launch({ args: ['.'], cwd: repoRoot, env: environment })
    try {
      const page = await first.firstWindow()

      // ── The user chooses a default effort in Settings ─────────────────────
      await page.getByLabel('Settings', { exact: true }).click()
      await expect(page.getByRole('heading', { name: 'AI Providers' })).toBeVisible()
      const control = page.getByRole('combobox', { name: 'Default effort' })
      await expect(control).toHaveText(/medium/i, { timeout: 30_000 })
      await control.click()
      await page.getByRole('option', { name: 'xhigh', exact: true }).click()
      await expect(control).toHaveText(/xhigh/, { timeout: 30_000 })
      await captureEvidence(page, 'settings-default-effort-xhigh')
    } finally {
      await first.close()
    }

    // ── It is still there after a restart ────────────────────────────────────
    const second = await electron.launch({ args: ['.'], cwd: repoRoot, env: environment })
    try {
      const page = await second.firstWindow()
      await page.getByLabel('Settings', { exact: true }).click()
      await expect(page.getByRole('heading', { name: 'AI Providers' })).toBeVisible()
      await expect(
        page.getByRole('combobox', { name: 'Default effort' }),
      ).toHaveText(/xhigh/, {
        timeout: 30_000,
      })
      await page.keyboard.press('Escape')

      // ── An Agent that names no level runs at it ──────────────────────────
      await openRunSession(page, 'Default Effort Journey')
      await askAgent(page, INHERITOR, 'Say something')
      await expect(
        page.getByRole('region', { name: 'Run chat' }).getByRole('log').getByText('Considered.'),
      ).toBeVisible({ timeout: 60_000 })
      expect(effortFor(provider, INHERITOR_MARKER)).toBe('xhigh')

      // ── An Agent that names one is untouched ─────────────────────────────
      await askAgent(page, PINNED, 'Say something too')
      await expect
        .poll(() => effortFor(provider, PINNED_MARKER), { timeout: 60_000 })
        .toBe('low')
    } finally {
      await second.close()
    }
  } finally {
    await provider.close()
  }
})
