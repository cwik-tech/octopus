/**
 * What still works when no application default has been chosen.
 *
 * An installation can have usable providers and no default selected — nothing
 * forces one, and Settings starts that way. The composer used to read its own
 * picker to decide whether a turn could run at all, and that picker shows the
 * application default when nobody has chosen anything. So with none set the
 * whole surface went dead: a turn addressed to an Agent naming its own provider
 * and model was refused for want of a default it would never have used, and the
 * model picker — the one control that could have supplied a pair — was disabled
 * by the very absence it exists to fix. Nothing said why.
 *
 * Only a real desktop run can settle this. The composer's state, the routing,
 * the API and the provider all have to agree, and a component test can prove
 * what was *sent* but not what the server then did with it.
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  ANALYST_MODEL,
  FIXTURE_PROVIDER,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
  writeAgentPersona,
} from './support/model-selection-fixture.js'

const REVIEWER_MARKER = 'PERSONA-MARKER-availability-reviewer'
const ANSWER = 'The supply agreement has been reviewed.'
/**
 * What the front desk actually says when nothing has been selected for it.
 *
 * The exact sentence the server produces, not a paraphrase: this is the reply a
 * person reads, and a looser match would pass for some other refusal.
 */
const NO_MODEL_NOTICE = 'No application default model is selected'

async function askAgent(page: Page, agentName: string, question: string): Promise<void> {
  const composer = page.getByRole('textbox').last()
  await composer.click()
  await composer.pressSequentially('@')
  // The mention list opens with focus in its own search box, so the Agent is
  // searched and picked there (agent-mentions.spec.ts), not typed after the @.
  await expect(page.getByRole('listbox', { name: 'Agent mentions' })).toBeVisible({
    timeout: 20_000,
  })
  const search = page.getByRole('combobox', { name: 'Search agents to mention' })
  await search.fill(agentName)
  await search.press('Enter')
  await expect(composer).toHaveValue(`@${agentName} `)
  await composer.pressSequentially(question)
  await composer.press('Enter')
}

test('an Agent on its own model runs with no application default, and the front desk says why it cannot', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const provider = await startFakeChatCompletionsServer({
    script: [
      // One reply is two requests: the tool round, then the streamed final
      // one (agent-model-selection.spec.ts, `answeredBy`).
      {
        content: ANSWER,
        match: (request) => (request.systemPrompt?.includes(REVIEWER_MARKER) ?? false) && !request.stream,
      },
      {
        content: ANSWER,
        match: (request) => (request.systemPrompt?.includes(REVIEWER_MARKER) ?? false) && request.stream,
      },
      { content: 'Unclaimed fixture answer.' },
    ],
  })

  const workspacePath = testInfo.outputPath('availability-workspace')
  const projectRoot = testInfo.outputPath('availability-project')
  const userDataPath = testInfo.outputPath('availability-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    writeAgentPersona(projectRoot, {
      name: 'reviewer',
      description: 'Reviews contracts on its own pair.',
      marker: REVIEWER_MARKER,
      provider: FIXTURE_PROVIDER,
      model: ANALYST_MODEL.id,
    }),
    // Connections and models, and deliberately no default among them. This is
    // the configuration the whole journey is about.
    // Keyless LM Studio: the native tool route refuses a keyless
    // OpenAI-compatible connection.
    seedProviderSettings({ userDataPath, baseUrl: provider.url, kind: 'lm-studio' }),
  ])

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()

    // The way out of a missing default is to choose a model, so the control
    // that chooses one may not be disabled by its absence.
    await expect(page.getByLabel('Run chat model')).toBeEnabled({ timeout: 60_000 })

    // ── A named Agent, on its own pair, with no default anywhere ───────────
    await askAgent(page, 'reviewer', 'Review the attached supply agreement.')

    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(chat.getByRole('log').getByText(ANSWER)).toBeVisible({ timeout: 60_000 })

    // Read from the provider's own record: the Agent ran on the model its own
    // file names, and nothing was substituted for the missing default.
    const modelsFor = (marker: string): (string | undefined)[] =>
      provider.requests
        .filter((request) => request.systemPrompt?.includes(marker))
        .map((request) => request.model)
    // Both of the reply's requests, the tool round and the streamed one.
    expect(modelsFor(REVIEWER_MARKER)).toEqual([ANALYST_MODEL.id, ANALYST_MODEL.id])

    const rendered = testInfo.outputPath('agent-runs-without-default.png')
    await chat.screenshot({ path: rendered })
    await testInfo.attach('agent-runs-without-default', {
      path: rendered,
      contentType: 'image/png',
    })
  } finally {
    await app.close()
    await provider.close()
  }
})

test('the front desk says why it cannot run when no application default is set', async ({}, testInfo) => {
  test.setTimeout(180_000)

  // Nothing is scripted for this turn on purpose. Reaching a model at all would
  // be the failure: there is no pair to reach for, and inventing one is what
  // this refuses to do.
  const provider = await startFakeChatCompletionsServer({
    script: [{ content: 'Nothing here should ever be asked for.' }],
  })

  const workspacePath = testInfo.outputPath('front-desk-workspace')
  const projectRoot = testInfo.outputPath('front-desk-project')
  const userDataPath = testInfo.outputPath('front-desk-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    // Empty of agents, so the composer posts to the front desk rather than to
    // the selected-agent endpoint.
    fs.mkdir(path.join(projectRoot, 'agents'), { recursive: true }),
    fs.mkdir(path.join(projectRoot, 'workflows'), { recursive: true }),
    seedProviderSettings({ userDataPath, baseUrl: provider.url }),
  ])
  await Promise.all([
    fs.writeFile(path.join(projectRoot, 'teams.yaml'), '', 'utf8'),
    fs.writeFile(path.join(projectRoot, 'workflows', 'registry.yaml'), '', 'utf8'),
  ])

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click()

    const composer = page.getByRole('textbox').first()
    await expect(composer).toBeEnabled({ timeout: 60_000 })
    await composer.fill('Set something up for me.')
    await composer.press('Enter')

    // It answers, and what it says is that nothing is selected — a refusal a
    // person can act on, rather than a model nobody chose being used quietly.
    await expect(page.getByText(NO_MODEL_NOTICE, { exact: false })).toBeVisible({
      timeout: 60_000,
    })
    // And nothing was spent finding that out. No model was reached for the
    // turn, and none for naming the session either.
    expect(provider.requests).toHaveLength(0)

    const rendered = testInfo.outputPath('front-desk-without-default.png')
    await page.getByRole('region', { name: 'Run chat' }).screenshot({ path: rendered })
    await testInfo.attach('front-desk-without-default', {
      path: rendered,
      contentType: 'image/png',
    })
  } finally {
    await app.close()
    await provider.close()
  }
})
