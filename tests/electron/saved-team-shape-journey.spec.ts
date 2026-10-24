/**
 * Changing how a team that already exists works together, and running it.
 *
 * Until this, a shape could only be chosen before the build: a team that turned
 * out to need a discussion rather than a chain had to be described again from
 * scratch. This is the whole of that change as the user makes it — reopen the
 * saved team, choose differently, and run it — with the file on disk and the
 * run's own artifact read at the end.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
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
const PROPOSAL_POLICY_HEADING = '## RESOURCE_ARCHITECT_RESPONSE_SCHEMA'
const LEAD = 'clause-lead'
const SPOTTER = 'clause-spotter'
const TEAM_ID = 'clause-review'
const SPOTTER_ANSWER = 'Clause 7 caps liability at twelve months of fees.'
const FINAL_RESPONSE = 'The cap in clause 7 is the exposure that matters.'

function isProposalTurn(request: { systemPrompt?: string | undefined }): boolean {
  return (request.systemPrompt ?? '').includes(PROPOSAL_POLICY_HEADING)
}

function isConversationTurn(request: { systemPrompt?: string | undefined }): boolean {
  return (
    (request.systemPrompt ?? '').includes(ARCHITECT_MARKER) && !isProposalTurn(request)
  )
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

/** A chain of two, which is what the saved team starts as. */
function proposalJson(): string {
  return JSON.stringify({
    message: 'Here is a team for that.',
    warnings: [],
    outcome: {
      id: 'proposal',
      kind: 'team',
      team: {
        teamId: TEAM_ID,
        description: 'Reads a contract and reports what is risky.',
        tags: [],
        existingAgents: [
          { name: LEAD, role: 'Lead', rationale: 'Already available.' },
          { name: SPOTTER, role: 'Spotter', rationale: 'Already available.' },
        ],
        newAgents: [],
        documentDomains: null,
        questionsResolved: [],
        shape: {
          kind: 'chain',
          rationale: 'One after another seemed simplest.',
          depth: 'quick',
          order: [LEAD, SPOTTER],
        },
      },
    },
  })
}

interface Paths {
  projectRoot: string
  userDataPath: string
  workspacePath: string
}

async function seedProject(outputPath: (name: string) => string): Promise<Paths> {
  const projectRoot = outputPath('saved-shape-project')
  const userDataPath = outputPath('saved-shape-user-data')
  const workspacePath = outputPath('saved-shape-workspace')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(projectRoot, { recursive: true }),
  ])
  for (const name of [LEAD, SPOTTER]) {
    await writeAgentPersona(projectRoot, {
      name,
      description: `${name} persona.`,
      marker: `You are ${name}`,
    })
  }
  // The saved team this journey is about, written as the builder emits one.
  // Building it through the Architect first is setup, not the contract, and it
  // cost more than the journey itself.
  await fs.mkdir(path.join(projectRoot, 'teams', TEAM_ID), { recursive: true })
  await fs.writeFile(
    path.join(projectRoot, 'teams.yaml'),
    [
      `${TEAM_ID}:`,
      '  type: team',
      '  description: Reads a contract and reports what is risky.',
      `  team_path: ./teams/${TEAM_ID}`,
      '',
    ].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(projectRoot, 'teams', TEAM_ID, 'team.yaml'),
    [
      'team:',
      `  name: "${TEAM_ID}"`,
      '  description: Reads a contract and reports what is risky.',
      '  version: "0.1.0"',
      '  created_by: "team-builder"',
      '  created_by_orchestrator: "plan-1"',
      '  published_by: "plan-1@sha256:one"',
      '',
      'workspace:',
      '  path: ../../workspace',
      '  watch: false',
      '',
      'workflow:',
      '  entry_level: setup',
      '  invocation_modes:',
      '    - user',
      '  user_facing: true',
      // The brief a run hands the team. The builder emits it, and a team
      // without it has nothing to be given when it starts.
      '  input_contract:',
      '    artifacts:',
      '      - path: "incoming-brief.md"',
      '        required: true',
      '        description: Runtime brief for the generated team.',
      '  output_contract:',
      '    artifacts:',
      '      - path: "final-result.md"',
      '        required: true',
      '        description: Final result produced by the generated team.',
      '    completion_artifact: "final-result.md"',
      '',
      'agents:',
      `  - name: "${LEAD}"`,
      '    type: agent',
      '    role: Lead.',
      '    tools: []',
      `    agent_file: "../../agents/${LEAD}/${LEAD}.md"`,
      `  - name: "${SPOTTER}"`,
      '    type: agent',
      '    role: Spotter.',
      '    tools: []',
      `    agent_file: "../../agents/${SPOTTER}/${SPOTTER}.md"`,
      '    produces:',
      '      - path: "final-result.md"',
      '',
      'levels:',
      '  - id: setup',
      '    name: Setup',
      '    order: 0',
      '    stage:',
      '      type: chain',
      '      sequence:',
      `        - "${LEAD}"`,
      `        - "${SPOTTER}"`,
      '      config:',
      '        handoff_format: markdown',
      '        output:',
      '          format: "final-result.md"',
      '          user_review: false',
      '',
      'gates:',
      '  - from: setup',
      '    to: done',
      '    condition:',
      '      type: artifact_exists',
      '      artifact: "final-result.md"',
      '',
    ].join('\n'),
    'utf8',
  )
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

async function teamYaml(paths: Paths): Promise<string> {
  return fs.readFile(path.join(paths.projectRoot, 'teams', TEAM_ID, 'team.yaml'), 'utf8')
}

async function findRunArtifact(
  workspacePath: string,
  runId: string,
): Promise<string | null> {
  const entries = await fs.readdir(workspacePath, { withFileTypes: true, recursive: true })
  for (const entry of entries) {
    if (entry.isDirectory() || entry.name !== 'final-result.md') continue
    const full = path.join(entry.parentPath, entry.name)
    if (!full.includes(runId)) continue
    return fs.readFile(full, 'utf8')
  }
  return null
}

/**
 * The saved team's own roster editor.
 *
 * Its own slot, not a panel title: the finished creation card is still on
 * screen and lists the same members, and an unscoped match reads that instead.
 */
function savedRosterEditor(page: Page) {
  return page.locator('[data-slot="team-roster-editor"]')
}

async function openSavedTeam(page: Page): Promise<void> {
  const entry = page
    .getByRole('button', { name: new RegExp('^Clause Review\\b') })
    .first()
  await expect(entry).toBeVisible({ timeout: 60_000 })
  await entry.click()
  await expect(savedRosterEditor(page)).toBeVisible({ timeout: 60_000 })
}

async function desktopApiBaseUrl(page: Page): Promise<string> {
  return page.evaluate(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const base = hash.get('pipeline-api-base-url')
    if (!base) throw new Error('The desktop window carries no API base URL.')
    return base
  })
}

test('a saved team can be told to work together differently, and then runs that way', async ({}, testInfo) => {
  test.setTimeout(300_000)
  const paths = await seedProject((name) => testInfo.outputPath(name))
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          isConversationTurn(request) && lastUserMessage(request).includes('risky'),
        content: 'I have enough information to prepare a Team proposal.',
      },
      {
        match: (request) =>
          isConversationTurn(request) && lastUserMessage(request).includes('build it'),
        content: 'Understood — preparing the proposal for your review.\n[[proposal-requested]]',
      },
      { match: (request) => isProposalTurn(request), content: proposalJson() },
      // The team itself, running as the discussion it was changed into.
      {
        match: (request) =>
          (request.systemPrompt ?? '').includes(
            'Select the participants before any specialist runs.',
          ),
        content: JSON.stringify({
          agents: [SPOTTER],
          rosterRationale: { [SPOTTER]: 'Reads the clauses.' },
        }),
      },
      {
        match: (request) => (request.systemPrompt ?? '').includes(`You are ${SPOTTER}`),
        content: SPOTTER_ANSWER,
      },
      {
        match: (request) =>
          lastUserMessage(request).includes('Completed specialist passes: 1'),
        content: JSON.stringify({
          decision: 'complete',
          reason: 'The specialist answered the question.',
          finalResponse: FINAL_RESPONSE,
        }),
      },
    ],
  })
  await seedProviderSettings({
    userDataPath: paths.userDataPath,
    baseUrl: provider.url,
    defaultModel: APP_DEFAULT_MODEL,
    kind: 'lm-studio',
  })

  /** One launch of the app, always closed again. */
  const withApp = async (fn: (page: Page) => Promise<void>): Promise<void> => {
    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...desktopEnvironment(paths),
        OPENAI_API_KEY: 'saved-shape-key',
        OPENAI_BASE_URL: provider.url,
      },
    })
    try {
      await fn(await app.firstWindow())
    } finally {
      await app.close()
    }
  }

  // One cleanup for the fake server, around both launches: a failure in the
  // first must not leave it listening.
  try {
    await withApp(async (page) => {
      // It starts as a chain, which is what the saved team on disk says.
      await openCreate(page)
      expect(await teamYaml(paths)).toContain('type: chain')

      // Reopened as a saved team, and told to work together differently.
      await openSavedTeam(page)
      const roster = savedRosterEditor(page)
      await roster.getByRole('tab', { name: 'Group discussion' }).click()

      // The file itself, not only the screen.
      await expect
        .poll(async () => (await teamYaml(paths)).includes('type: discussion'), {
          timeout: 60_000,
        })
        .toBe(true)
      const changed = await teamYaml(paths)
      expect(changed).toContain(`coordinator: "${LEAD}"`)
      expect(changed).not.toContain('type: chain')
    })

    // A second launch, reading everything back from what the first one wrote.
    await withApp(async (page) => {
      await openCreate(page)
      await openSavedTeam(page)

      // The reopened editor states the arrangement before any control is
      // touched, and the option in effect is the one that was chosen.
      const roster = savedRosterEditor(page)
      await expect(roster).toContainText('They take turns discussing it')
      await expect(roster).toContainText('They go back and forth a few times')
      await expect(
        roster.getByRole('tab', { name: 'Group discussion' }),
      ).toHaveAttribute('aria-selected', 'true')
      await expect(
        roster.getByRole('tab', { name: 'One after another' }),
      ).toHaveAttribute('aria-selected', 'false')

      // And the team that was changed is the team that runs.
      await page.getByRole('tab', { name: 'Run', exact: true }).click()
      await page.getByRole('tab', { name: 'Teams', exact: true }).click()
      await page.getByRole('radio', { name: 'Clause Review' }).click()
      const composer = page.getByRole('textbox').first()
      await composer.fill('Which clause exposes me?')
      const dispatched = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          /\/sessions\/[^/]+\/messages$/u.test(new URL(response.url()).pathname),
        { timeout: 120_000 },
      )
      await composer.press('Enter')
      const dispatch = (await (await dispatched).json()) as {
        task: { id: string; sessionId: string; runId: string }
      }

      const chat = page.getByRole('region', { name: 'Run chat' })
      await expect(chat.getByText(SPOTTER_ANSWER, { exact: false })).toBeVisible({
        timeout: 120_000,
      })
      const apiBaseUrl = await desktopApiBaseUrl(page)
      await expect
        .poll(
          async () => {
            const response = await fetch(
              `${apiBaseUrl}/sessions/${dispatch.task.sessionId}/tasks/${dispatch.task.id}`,
              { signal: AbortSignal.timeout(15_000) },
            )
            if (!response.ok) return 'unreadable'
            const task = (await response.json()) as { status?: string }
            return task.status ?? 'unknown'
          },
          { timeout: 120_000 },
        )
        .toBe('done')

      const artifact = await findRunArtifact(paths.workspacePath, dispatch.task.runId)
      expect(artifact, 'the changed team wrote no final-result.md').not.toBeNull()
      expect(artifact ?? '').toContain(FINAL_RESPONSE)
    })
  } finally {
    await provider.close()
  }
})
