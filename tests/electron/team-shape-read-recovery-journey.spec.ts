/**
 * A proposal whose revision the app could not read, and the way back from it.
 *
 * A team plan is built against the revision the card was rendered from, so
 * until that read lands there is nothing safe to build and nothing safe to
 * change. When the read failed, the card said nothing: Create stayed disabled,
 * the change control never appeared, and describing the team again was the only
 * way out — which throws away a proposal that was never what failed.
 *
 * The failure is injected at the network boundary and only for the first read.
 * Everything after it is the real thing: the second read reaches the app's own
 * API, and the build that follows writes a real team to disk.
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  APP_DEFAULT_MODEL,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
  writeAgentPersona,
} from './support/model-selection-fixture.js'

const ARCHITECT_MARKER = 'You are the Agent Architect'
const LEAD = 'intake-lead'
const CHECKER = 'intake-checker'
const TEAM_ID = 'intake-review'

/** The proposal, exactly as a provider would return it. */
function proposalJson(): string {
  return JSON.stringify({
    message: 'Here is a team for that.',
    warnings: [],
    outcome: {
      id: 'proposal-read-recovery',
      kind: 'team',
      team: {
        teamId: TEAM_ID,
        description: 'Takes an intake note and has it checked.',
        tags: [],
        existingAgents: [
          { name: LEAD, role: 'Lead', rationale: 'Already available.' },
          { name: CHECKER, role: 'Checker', rationale: 'Already available.' },
        ],
        newAgents: [],
        documentDomains: null,
        questionsResolved: [],
        shape: {
          kind: 'discussion',
          rationale: 'These two disagree usefully about what matters.',
          depth: 'standard',
          coordinator: LEAD,
          participants: [CHECKER],
        },
      },
    },
  })
}

function isArchitectTurn(request: { systemPrompt?: string | undefined }): boolean {
  return (request.systemPrompt ?? '').includes(ARCHITECT_MARKER)
}

function lastUserMessage(request: { body: Record<string, unknown> }): string {
  const messages = Array.isArray(request.body.messages) ? request.body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message &&
      typeof message === 'object' &&
      (message as { role?: unknown }).role === 'user'
    ) {
      const content = (message as { content?: unknown }).content
      return typeof content === 'string' ? content : ''
    }
  }
  return ''
}

interface Paths {
  projectRoot: string
  userDataPath: string
  workspacePath: string
}

async function seedProject(outputPath: (name: string) => string): Promise<Paths> {
  const projectRoot = outputPath('read-recovery-project')
  const userDataPath = outputPath('read-recovery-user-data')
  const workspacePath = outputPath('read-recovery-workspace')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(projectRoot, { recursive: true }),
  ])
  await fs.writeFile(path.join(projectRoot, 'teams.yaml'), '', 'utf8')
  // Both members exist, so once the revision can be read the build finishes.
  for (const name of [LEAD, CHECKER]) {
    await writeAgentPersona(projectRoot, {
      name,
      description: `${name} persona.`,
      marker: `You are ${name}`,
    })
  }
  return { projectRoot, userDataPath, workspacePath }
}

async function openCreate(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Create', exact: true }).click()
  await page
    .getByLabel('Resource type')
    .getByRole('tab', { name: 'Teams', exact: true })
    .click()
}

async function askArchitect(page: Page, brief: string): Promise<void> {
  const composer = page.getByPlaceholder('Describe the Agents or Team you need…')
  await expect(composer).toBeEnabled({ timeout: 60_000 })
  await composer.fill(brief)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
}

test('a proposal whose revision could not be read is recovered, and builds', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const paths = await seedProject((name) => testInfo.outputPath(name))

  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          isArchitectTurn(request) && lastUserMessage(request).includes('intake note'),
        content: 'I have enough information to prepare a Team proposal.',
      },
      {
        match: (request) =>
          isArchitectTurn(request) && lastUserMessage(request).includes('build it'),
        content:
          'Understood — preparing the proposal for your review.\n[[proposal-requested]]',
      },
      {
        match: (request) =>
          (request.systemPrompt ?? '').includes('## RESOURCE_ARCHITECT_RESPONSE_SCHEMA'),
        content: proposalJson(),
      },
    ],
  })
  await seedProviderSettings({
    userDataPath: paths.userDataPath,
    baseUrl: provider.url,
    defaultModel: APP_DEFAULT_MODEL,
    // Keyless LM Studio: the native tool route refuses a keyless
    // OpenAI-compatible connection.
    kind: 'lm-studio',
  })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...desktopEnvironment(paths),
      OPENAI_API_KEY: 'read-recovery-key',
      OPENAI_BASE_URL: provider.url,
      // The Architect's own reviewer is not scripted here, and an unreviewed
      // answer never prepares a proposal, so review is off, as in
      // create-conversation-navigation.spec.ts.
      PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: 'false',
    },
  })

  try {
    const page = await app.firstWindow()
    await openCreate(page)

    // The first read of this plan's revision, and only the first, is cut off
    // before it reaches the app. Everything after goes through untouched.
    let shapeReads = 0
    await page.route('**/create/resource-architect/plans/*/shape', async (route) => {
      shapeReads += 1
      if (shapeReads === 1 && route.request().method() === 'GET') {
        await route.abort('connectionrefused')
        return
      }
      await route.fallback()
    })

    await askArchitect(page, 'I need a team that takes an intake note and checks it.')
    await expect(
      page.getByText('I have enough information to prepare a Team proposal.'),
    ).toBeVisible({ timeout: 60_000 })
    await askArchitect(page, 'build it')

    const card = page.getByLabel(`Team ${TEAM_ID}`)
    await expect(card).toBeVisible({ timeout: 60_000 })

    // The card says what is wrong with it, and neither control is offered: a
    // plan whose revision is unknown cannot be built or changed.
    const shapeBlock = card.getByRole('region', { name: 'How they work together' })
    await expect(shapeBlock).toContainText(
      /could not be read, so how this team works together cannot be changed yet/i,
      { timeout: 60_000 },
    )
    await expect(page.getByRole('button', { name: /^Create$/ })).toBeDisabled()
    await expect(shapeBlock.getByRole('tablist')).toHaveCount(0)

    // Ask again. This read reaches the real API.
    await shapeBlock.getByRole('button', { name: 'Try again' }).click()

    await expect(shapeBlock).not.toContainText(/could not be read/i, { timeout: 60_000 })
    await expect(shapeBlock).toContainText('They take turns discussing it')
    await expect(shapeBlock.getByRole('tablist')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Create$/ })).toBeEnabled()

    // The same proposal builds. Nothing was described again: the Architect was
    // asked for one proposal and answered once.
    await page.getByRole('button', { name: /^Create$/ }).click()
    await expect(card.locator('[data-slot="card-action"]')).toContainText(
      /created|reused/i,
      { timeout: 120_000 },
    )

    const yaml = await fs.readFile(
      path.join(paths.projectRoot, 'teams', TEAM_ID, 'team.yaml'),
      'utf8',
    )
    // The team on disk is the one the recovered card described.
    expect(yaml).toContain('type: discussion')
    expect(yaml).toContain(LEAD)
    expect(yaml).toContain(CHECKER)
    expect(yaml).not.toContain('building: true')
    expect(yaml).toContain('published_by:')
    // Two reads: the one that was cut off, and the one the user asked for.
    expect(shapeReads).toBe(2)
  } finally {
    await app.close()
    await provider.close()
  }
})
