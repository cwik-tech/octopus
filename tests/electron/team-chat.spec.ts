/**
 * Selecting a team in Run chat.
 *
 * Phase 1: the chat sidebar offers an Agents/Teams switch, a team is launched
 * through its generated one-step wrapper workflow, and its replies stream into
 * the discussion workspace. A discussion team convenes a subset of its bench;
 * a chain team runs the whole bench in order.
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { replaceRequiredText } from '../support/config-rewrite.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const LINE_ONE_ANSWER =
  'Line one recommends a phased rollout of the assembly retooling.'
const LINE_TWO_ANSWER =
  'Line two confirms the phased rollout and adds a supplier contingency.'

const CONVENED = ['Spec Beta', 'Spec Zeta']
/** What a dispatched specialist's own persona says, used to hold its answer. */
const CONVENED_PROMPT_FRAGMENTS = [
  'You are spec-beta',
  'You are spec-zeta',
]

const NOT_CONVENED = [
  'Spec Alpha',
  'Spec Gamma',
  'Spec Delta',
  'Spec Epsilon',
  'Spec Eta',
]

async function makeFixtureProject(outputPath: (name: string) => string, name: string) {
  const workspacePath = outputPath(`${name}-workspace`)
  const projectRootPath = outputPath(`${name}-project`)
  const userDataPath = outputPath(`${name}-user-data`)
  const piStatePath = outputPath(`${name}-pi-state`)
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, 'tests', 'fixtures', 'team-chat-e2e'),
      projectRootPath,
      { recursive: true },
    ),
  ])
  // Team tier defaults no longer choose an agent's model. Pin the actual
  // fixture agents so these journeys never depend on a developer's settings.
  for (const agentId of await fs.readdir(path.join(projectRootPath, 'agents'))) {
    const agentFile = path.join(projectRootPath, 'agents', agentId, `${agentId}.md`)
    const prompt = await fs.readFile(agentFile, 'utf8')
    await fs.writeFile(agentFile, `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\n${prompt}`)
  }
  return { workspacePath, projectRootPath, userDataPath, piStatePath }
}

function launchEnv(paths: {
  projectRootPath: string
  userDataPath: string
  workspacePath: string
  piStatePath: string
}, baseUrl: string, key: string) {
  return {
    ...fixtureDesktopEnvironment({ ...process.env, PATH: '/usr/bin:/bin' }),
    NODE_ENV: 'test',
    OPENAI_API_KEY: key,
    OPENAI_BASE_URL: baseUrl,
    PI_CODING_AGENT_DIR: paths.piStatePath,
    PIPELINE_DESKTOP_PROJECT_ROOT: paths.projectRootPath,
    PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
    PIPELINE_DESKTOP_USER_DATA: paths.userDataPath,
    PIPELINE_DESKTOP_WORKSPACE_PATH: paths.workspacePath,
  }
}

test('internal receptionist resources stay absent from the live desktop pickers', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const paths = {
    projectRootPath: repoRoot,
    userDataPath: testInfo.outputPath('internal-reception-user-data'),
    workspacePath: testInfo.outputPath('internal-reception-workspace'),
    piStatePath: testInfo.outputPath('internal-reception-pi-state'),
  }
  await Promise.all([
    fs.mkdir(paths.userDataPath, { recursive: true }),
    fs.mkdir(paths.workspacePath, { recursive: true }),
    fs.mkdir(paths.piStatePath, { recursive: true }),
  ])
  const provider = await startDeterministicOpenAiServer()
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: launchEnv(paths, provider.baseUrl, 'internal-reception-key'),
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()

    await expect(page.getByText('Receptionist', { exact: true })).toHaveCount(0)
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await expect(
      page.getByRole('radiogroup', { name: 'Select Team' }),
    ).toBeVisible()
    await expect(
      page.getByRole('radio', { name: 'Reception Desk' }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('radio', { name: 'Problem Thinking Board' }),
    ).toBeVisible()
  } finally {
    await app.close()
    await provider.close()
  }
})

test('the chat sidebar offers Teams beside Agents and describes each team on hover', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const paths = await makeFixtureProject(
    (name) => testInfo.outputPath(name),
    'team-chat-tabs',
  )
  const provider = await startDeterministicOpenAiServer()
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: launchEnv(paths, provider.baseUrl, 'team-chat-tabs-key'),
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()

    // Agents is the default target, and rows no longer carry a description.
    const agentsTab = page.getByRole('tab', { name: 'Agents', exact: true })
    await expect(agentsTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('list', { name: 'Available agents' })).toBeVisible()
    await expect(
      page.getByText('deterministic team-chat E2E fixture'),
    ).toHaveCount(0)

    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await expect(
      page.getByRole('radiogroup', { name: 'Select Team' }),
    ).toBeVisible()

    // A team row carries its name and its description, the same row the
    // Create sidebar draws; the entry stage type is not part of it.
    await expect(page.getByRole('radio', { name: 'Board Team' })).toBeVisible()
    await expect(page.getByLabel('Board Team stage: discussion')).toHaveCount(0)
    await expect(page.getByLabel('Line Team stage: chain')).toHaveCount(0)
    await page
      .getByRole('button', { name: 'View description for Board Team' })
      .hover()
    // The Team catalog describes a Team by its `teams.yaml` entry
    // (domains/agent-generator/team-manager.ts listTeamRecords), not by the
    // `description` inside its team.yaml.
    await expect(
      page.getByText('Discussion board used by the team-chat E2E'),
    ).toBeVisible()
    // The description opens beside the row and covers it while the pointer
    // rests on it, so move away, as a person does, before picking a row.
    await page.getByRole('tab', { name: 'Teams', exact: true }).hover()
    await expect(
      page.getByText('Discussion board used by the team-chat E2E'),
    ).toHaveCount(0)

    // A team is one target: picking a second replaces the first.
    await page.getByRole('radio', { name: 'Board Team' }).click()
    await expect(page.getByRole('radio', { name: 'Board Team' })).toBeChecked()
    await page.getByRole('radio', { name: 'Line Team' }).click()
    await expect(page.getByRole('radio', { name: 'Line Team' })).toBeChecked()
    await expect(
      page.getByRole('radio', { name: 'Board Team' }),
    ).not.toBeChecked()
  } finally {
    await app.close()
    await provider.close()
  }
})

test('an unrunnable Team explains the same blocking issue in Run and Create', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const paths = await makeFixtureProject(
    (name) => testInfo.outputPath(name),
    'team-health',
  )
  const lineTeamPath = path.join(
    paths.projectRootPath,
    'teams',
    'line-team',
    'team.yaml',
  )
  await fs.writeFile(
    lineTeamPath,
    replaceRequiredText({
      file: lineTeamPath,
      pattern: '      sequence:\n        - line-one\n        - line-two',
      replacement: '      sequence: []',
      source: await fs.readFile(lineTeamPath, 'utf8'),
    }),
  )

  const provider = await startDeterministicOpenAiServer()
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: launchEnv(paths, provider.baseUrl, 'team-health-key'),
  })

  try {
    const page = await app.firstWindow({ timeout: 45_000 })
    const expectedIssue =
      "Chain stage 'run' requires at least one sequence agent to run."

    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    const runRow = page.getByRole('radio', {
      name: 'Line Team — Team issue',
      exact: true,
    })
    await expect(
      runRow.getByRole('img', { name: 'Team issue' }),
    ).toBeVisible({ timeout: 60_000 })
    await runRow.hover()
    await expect(page.getByRole('tooltip')).toContainText(expectedIssue)

    await page.getByRole('tab', { name: 'Create', exact: true }).click()
    await page
      .getByLabel('Resource type')
      .getByRole('tab', { name: 'Teams', exact: true })
      .click()
    const createSidebar = page.locator(
      '[data-slot="workspace-sidebar"][data-side="left"]',
    )
    const createRow = createSidebar.getByRole('button', {
      name: 'Line Team — Team issue',
      exact: true,
    })
    await expect(
      createRow.getByRole('img', { name: 'Team issue' }),
    ).toBeVisible({ timeout: 60_000 })
    await createRow.hover()
    await expect(page.getByRole('tooltip')).toContainText(expectedIssue)
  } finally {
    await app.close()
    await provider.close()
  }
})

test('a discussion team convenes a subset of its bench and only those reply', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const paths = await makeFixtureProject(
    (name) => testInfo.outputPath(name),
    'team-chat-board',
  )
  const boardTeamPath = path.join(
    paths.projectRootPath,
    'teams',
    'board-team',
    'team.yaml',
  )
  const withThreeRounds = replaceRequiredText({
    file: boardTeamPath,
    pattern: 'max_rounds: 1',
    replacement: 'max_rounds: 3',
    source: await fs.readFile(boardTeamPath, 'utf8'),
  })
  const withWarmupLevel = replaceRequiredText({
    file: boardTeamPath,
    pattern: 'levels:\n  - id: deliberation',
    replacement: [
      'levels:',
      '  - id: warmup',
      '    name: Warmup',
      '    order: 0',
      '    stage:',
      '      type: chain',
      '      sequence:',
      '        - board-lead',
      '      config:',
      '        handoff_format: markdown',
      '        constraints:',
      '          max_time_minutes: 2',
      '          agent_timeout_minutes: 1',
      '          max_budget_usd: 1',
      '        output:',
      '          format: warmup.md',
      '          user_review: false',
      '  - id: deliberation',
    ].join('\n'),
    source: withThreeRounds,
  })
  await fs.writeFile(
    boardTeamPath,
    replaceRequiredText({
      file: boardTeamPath,
      pattern: '  - id: deliberation\n    name: Deliberation\n    order: 0',
      replacement: '  - id: deliberation\n    name: Deliberation\n    order: 1',
      source: withWarmupLevel,
    }),
  )
  const provider = await startDeterministicOpenAiServer({
    // Hold exactly the two convened specialists, so the moment between the
    // lead's choice and their answers is observable.
    blockRequestsMatching: CONVENED_PROMPT_FRAGMENTS,
    matchers: [
      {
        // The ordinary-provider lead returns its one roster decision before
        // any participant is dispatched. Match its request by contract so an
        // unrelated session-title turn cannot consume the decision.
        match: 'Select the participants before any specialist runs.',
        text: JSON.stringify({
          agents: ['spec-beta', 'spec-zeta'],
          rosterRationale: {
            'spec-beta': 'Relevant desktop architecture perspective.',
            'spec-zeta': 'Relevant delivery-risk perspective.',
          },
        }),
      },
      {
        match: 'Completed specialist passes: 1',
        text: JSON.stringify({
          decision: 'continue',
          reason: 'The first pass identified options but did not challenge the downside case.',
          message: 'Challenge the downside case and converge on one recommendation.',
          targets: ['spec-beta', 'spec-zeta'],
        }),
      },
      {
        match: 'Completed specialist passes: 2',
        text: JSON.stringify({
          decision: 'complete',
          reason: 'The selected specialists have resolved the decision.',
          finalResponse: 'Lead synthesis: use a phased manufacturing investment with a supplier contingency.',
        }),
      },
    ],
  })
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: launchEnv(paths, provider.baseUrl, 'team-chat-board-key'),
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: 'Board Team' }).click()

    const participants = page.getByRole('complementary', {
      name: 'Team participants',
    })
    await expect(participants).toBeVisible({ timeout: 60_000 })
    await expect(participants.getByRole('heading')).toHaveText([
      'Discussion lead',
      'Selected participants',
      'Team',
    ])
    const discussionLead = participants
      .getByRole('heading', { name: 'Discussion lead' })
      .locator('xpath=..')
    const selectedParticipants = participants
      .getByRole('heading', { name: 'Selected participants' })
      .locator('xpath=..')
    const remainingTeam = participants
      .getByRole('heading', { name: 'Team', exact: true })
      .locator('xpath=..')
    // The configured lead and the whole bench, with the runtime each will use,
    // are readable before the user has said anything.
    await expect(discussionLead.getByText('Board Lead')).toBeVisible({
      timeout: 60_000,
    })
    await expect(
      discussionLead.getByLabel('Model: gpt-5.4-mini'),
    ).toHaveCount(1)
    await expect(selectedParticipants.locator('section')).toHaveCount(0)
    for (const agent of [...CONVENED, ...NOT_CONVENED]) {
      await expect(
        remainingTeam.getByText(agent, { exact: false }),
      ).toBeVisible({ timeout: 60_000 })
    }
    await expect(remainingTeam.getByLabel('Model: gpt-5.4-mini')).toHaveCount(
      CONVENED.length + NOT_CONVENED.length,
    )

    const composer = page.getByRole('textbox').first()
    await composer.fill('what should I invest in manufacturing in?')
    await composer.press('Enter')

    await expect(page.getByText('Task brief required')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add to Project' })).toHaveCount(0)
    // Wait on the Team-run state itself. The composer is also briefly disabled
    // while the message is being sent, which is a different, transient reason.
    await expect(composer).toHaveAttribute(
      'placeholder',
      'Wait for the current Team response to finish...',
      { timeout: 60_000 },
    )
    await expect(composer).toBeDisabled()

    // The wrapper workflow is materialized on demand for the selected team.
    await expect(async () => {
      const generated = await fs.readdir(
        path.join(paths.projectRootPath, 'workflows', 'user-generated'),
      )
      expect(generated).toContain('team-chat-board-team-d5ef5e0927f0.yaml')
    }).toPass({ timeout: 60_000 })

    await expect(participants).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText('Discussion Flow')).toHaveCount(0)
    await expect(page.getByText('Initial brief')).toHaveCount(0)

    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(
      chat.getByRole('status', { name: 'Spec Beta is thinking' }),
    ).toBeVisible({ timeout: 60_000 })
    const activeParticipant = participants
      .getByText('Spec Beta', { exact: true })
      .locator('xpath=ancestor::section[1]')
    await expect(activeParticipant).toHaveClass(/motion-safe:animate-pulse/)
    await expect(activeParticipant).toHaveClass(/border-orange-500\/60/)
    await expect(discussionLead.getByText('Board Lead')).toBeVisible()
    for (const agent of CONVENED) {
      await expect(
        selectedParticipants.getByText(agent, { exact: false }),
      ).toBeVisible()
    }
    for (const agent of NOT_CONVENED) {
      await expect(
        remainingTeam.getByText(agent, { exact: false }),
      ).toBeVisible()
    }

    // The lead says who it convened and why before any specialist answers.
    await expect(
      chat.getByText('Relevant desktop architecture perspective.'),
    ).toBeVisible({ timeout: 60_000 })
    await expect(
      chat.getByText('Relevant delivery-risk perspective.'),
    ).toBeVisible()

    provider.releaseBlockedResponses()

    // The lead requests a second pass, and every convened specialist contributes
    // in both passes without changing the locked roster.
    for (const agent of CONVENED) {
      await expect(chat.getByText(agent, { exact: true })).toHaveCount(2, {
        timeout: 120_000,
      })
    }
    // ...while the rest of the stable bench remains idle and never replies.
    for (const agent of NOT_CONVENED) {
      await expect(participants.getByText(agent, { exact: false })).toBeVisible()
      await expect(chat.getByText(agent, { exact: true })).toHaveCount(0)
    }

    await expect(chat.getByText('Round 1', { exact: true })).toHaveCount(0)
    await expect(chat.getByText('Round 2', { exact: true })).toHaveCount(0)
    await expect(
      chat.getByText('Challenge the downside case and converge on one recommendation.'),
    ).toHaveCount(1)
    await expect(
      chat.getByText(
        'Lead synthesis: use a phased manufacturing investment with a supplier contingency.',
      ),
    ).toHaveCount(1)

    // Answering does not move a card: membership was settled by the lead's
    // one selection and holds for the rest of the run.
    for (const agent of CONVENED) {
      await expect(
        selectedParticipants.getByText(agent, { exact: false }),
      ).toBeVisible()
      await expect(remainingTeam.getByText(agent, { exact: false })).toHaveCount(0)
    }
    for (const agent of NOT_CONVENED) {
      await expect(
        remainingTeam.getByText(agent, { exact: false }),
      ).toBeVisible()
    }

    const generatedWorkflow = await fs.readFile(
      path.join(
        paths.projectRootPath,
        'workflows',
        'user-generated',
        'team-chat-board-team-d5ef5e0927f0.yaml',
      ),
      'utf8',
    )
    expect(generatedWorkflow).not.toContain('max_rounds:')
    expect(generatedWorkflow).not.toContain('participants:')

    await expect.poll(
      () => latestTeamChatTaskStatus(page, 'board-team'),
      { timeout: 120_000 },
    ).toBe('done')
    // Session titling is its own contract with its own coverage; this journey
    // proves the Team roster, not what the session ends up called.
    await expect(composer).toBeEnabled()
    await expect(chat.getByText('board-result.md')).toHaveCount(0)
    await expect(
      chat.getByText('Done — final delivery below', { exact: false }),
    ).toHaveCount(0)

    await composer.fill('@')
    for (const agent of [...CONVENED, ...NOT_CONVENED]) {
      await expect(
        page.getByRole('option', { name: new RegExp(agent, 'i') }),
      ).toBeVisible()
    }

    // Fixed Team history disables target changes while Sessions remains usable.
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
    const navigation = page.getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('tablist', { name: 'Run navigation' })
    await expect(
      navigation.getByRole('tab', { name: 'Teams', exact: true }),
    ).toBeDisabled()
    await expect(navigation.getByRole('tab', { name: 'Agents', exact: true })).toBeDisabled()
    await expect(navigation.getByRole('tab', { name: 'Sessions', exact: true })).toBeEnabled()
    await expect(
      page.getByRole('button', { name: 'Show inspector' }),
    ).toHaveCount(0)
    await expect(participants).toBeVisible()
    await expect(discussionLead.getByText('Board Lead')).toBeVisible()
    await expect(remainingTeam.getByText('Spec Alpha')).toBeVisible()

  } finally {
    await app.close()
    await provider.close()
  }
})

test('a chain team runs its whole bench in sequence', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const paths = await makeFixtureProject(
    (name) => testInfo.outputPath(name),
    'team-chat-line',
  )
  const provider = await startDeterministicOpenAiServer()
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: launchEnv(paths, provider.baseUrl, 'team-chat-line-key'),
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: 'Line Team' }).click()

    // A chain team has no lead and convenes nobody, so the rail offers one
    // roster: the whole bench, with the runtime each step will use.
    const participants = page.getByRole('complementary', {
      name: 'Team participants',
    })
    await expect(participants).toBeVisible({ timeout: 60_000 })
    await expect(participants.getByRole('heading')).toHaveText(['Team'])
    await expect(participants.getByText('Line One')).toBeVisible()
    await expect(participants.getByText('Line Two')).toBeVisible()
    await expect(participants.getByLabel('Model: gpt-5.4-mini')).toHaveCount(2)

    const composer = page.getByRole('textbox').first()
    // Direct Team chat accepts an ordinary non-empty conversational prompt.
    await composer.fill('summarize these tradeoffs')
    await composer.press('Enter')

    await expect(async () => {
      const generated = await fs.readdir(
        path.join(paths.projectRootPath, 'workflows', 'user-generated'),
      )
      expect(generated).toContain('team-chat-line-team-747ca38a786b.yaml')
    }).toPass({ timeout: 60_000 })

    // No coordinator picks here — the whole bench runs in order. Chain steps
    // may use internal handoff files, but Team chat never publishes a
    // deliverable card unless the user explicitly asks for one.
    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect.poll(
      () => latestTeamChatTaskStatus(page, 'line-team'),
      { timeout: 120_000 },
    ).toBe('done')
    await expect(chat.getByText('line-result.md')).toHaveCount(0)
    await expect(
      chat.getByText('Done — final delivery below', { exact: false }),
    ).toHaveCount(0)

    // The launching prompt is persisted server-side, not merely optimistic, so
    // it survives a session switch or reload rather than dying with local state.
    const apiBaseUrl = await desktopApiBaseUrl(page)
    const { sessions } = (await (
      await fetch(`${apiBaseUrl}/sessions`)
    ).json()) as { sessions: Array<{ id: string }> }
    const persisted = (
      await Promise.all(
        sessions.map(async (session) => {
          const { messages } = (await (
            await fetch(`${apiBaseUrl}/sessions/${session.id}/messages`)
          ).json()) as { messages: Array<{ role: string; text: string }> }
          return messages
        }),
      )
    ).flat()
    expect(
      persisted.some(
        (message) =>
          message.role === 'user' &&
          message.text.includes('summarize these tradeoffs'),
      ),
    ).toBe(true)
  } finally {
    await app.close()
    await provider.close()
  }
})

test('every chain agent answer becomes a durable, attributed chat message', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const paths = await makeFixtureProject(
    (name) => testInfo.outputPath(name),
    'team-chat-line-messages',
  )
  // Content-matched so each answer belongs to a named agent regardless of how
  // many probe and coordinator requests surround the two chain dispatches.
  const provider = await startDeterministicOpenAiServer({
    matchers: [
      { match: 'You are line-one', text: LINE_ONE_ANSWER },
      { match: 'You are line-two', text: LINE_TWO_ANSWER },
    ],
  })
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: launchEnv(paths, provider.baseUrl, 'team-chat-line-messages-key'),
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: 'Line Team' }).click()

    const composer = page.getByRole('textbox').first()
    await composer.fill('summarize these tradeoffs')
    await composer.press('Enter')

    const chat = page.getByRole('region', { name: 'Run chat' })

    // Both chain steps speak in chat, under their own names.
    await expect(chat.getByText(LINE_ONE_ANSWER)).toBeVisible({ timeout: 120_000 })
    await expect(chat.getByText(LINE_TWO_ANSWER)).toBeVisible({ timeout: 120_000 })
    await expect(chat.getByText('Line One', { exact: true })).toHaveCount(1)
    await expect(chat.getByText('Line Two', { exact: true })).toHaveCount(1)

    await expect.poll(
      () => latestTeamChatTaskStatus(page, 'line-team'),
      { timeout: 120_000 },
    ).toBe('done')

    // A step that answered is never described as having sent its answer away.
    await expect(chat.getByTestId('stream-handoff')).toHaveCount(0)
    await expect(chat.getByText('answer went to', { exact: false })).toHaveCount(0)
    // Team chat still publishes no deliverable card of its own.
    await expect(chat.getByText('line-result.md')).toHaveCount(0)
    await expect(
      chat.getByText('Done — final delivery below', { exact: false }),
    ).toHaveCount(0)

    // The answers are durable: they come back after a reload rather than
    // living only in the local stream that produced them. Reloading opens a
    // fresh session by design, so the session that ran is reselected by its
    // own id — every session here is called "Untitled session", and clicking
    // by that name would be a coin toss between two different runs.
    const ranSessionId = await teamChatSessionId(page, 'line-team')
    const apiBaseUrl = await desktopApiBaseUrl(page)
    const restoredTitle = `Durable chain answers ${ranSessionId.slice(0, 8)}`
    const renamed = await fetch(`${apiBaseUrl}/sessions/${ranSessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: restoredTitle }),
    })
    expect(renamed.ok).toBe(true)

    await page.reload()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('button', { name: restoredTitle, exact: true }).click()

    const reloadedChat = page.getByRole('region', { name: 'Run chat' })
    await expect(reloadedChat.getByText(LINE_ONE_ANSWER)).toBeVisible({
      timeout: 60_000,
    })
    await expect(reloadedChat.getByText(LINE_TWO_ANSWER)).toBeVisible({
      timeout: 60_000,
    })
    await expect(reloadedChat.getByTestId('stream-handoff')).toHaveCount(0)
  } finally {
    await app.close()
    await provider.close()
  }
})

async function desktopApiBaseUrl(page: Page): Promise<string> {
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('pipeline-api-base-url'),
  )
  if (!baseUrl) throw new Error('Desktop API URL is unavailable')
  return baseUrl
}

/** The session that owns this team's newest Team-chat task. */
async function teamChatSessionId(page: Page, teamId: string): Promise<string> {
  const apiBaseUrl = await desktopApiBaseUrl(page)
  const { sessions } = (await (
    await fetch(`${apiBaseUrl}/sessions`)
  ).json()) as { sessions: Array<{ id: string }> }
  const owning = await Promise.all(
    sessions.map(async (session) => {
      const { tasks } = (await (
        await fetch(`${apiBaseUrl}/sessions/${session.id}/tasks`)
      ).json()) as {
        tasks: Array<{ createdAt: string; targetKind?: string; teamId?: string }>
      }
      return tasks
        .filter((task) => task.targetKind === 'team-chat' && task.teamId === teamId)
        .map((task) => ({ createdAt: task.createdAt, sessionId: session.id }))
    }),
  )
  const newest = owning
    .flat()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)
  if (!newest) throw new Error(`No Team-chat task found for team '${teamId}'`)
  return newest.sessionId
}

async function latestTeamChatTaskStatus(
  page: Page,
  teamId: string,
): Promise<string | null> {
  const apiBaseUrl = await desktopApiBaseUrl(page)
  const sessionsResponse = await fetch(`${apiBaseUrl}/sessions`)
  const sessionsPayload = (await sessionsResponse.json()) as {
    sessions: Array<{ id: string }>
  }
  const taskLists = await Promise.all(
    sessionsPayload.sessions.map(async (session) => {
      const response = await fetch(`${apiBaseUrl}/sessions/${session.id}/tasks`)
      return (await response.json()) as {
        tasks: Array<{
          createdAt: string
          status: string
          targetKind?: string
          teamId?: string
        }>
      }
    }),
  )
  return taskLists
    .flatMap((payload) => payload.tasks)
    .filter((task) => task.targetKind === 'team-chat' && task.teamId === teamId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)?.status ?? null
}

for (const scenario of [
  { name: 'selected Team lead, specialists, and synthesis consume the same frozen whole document', team: 'Board Team', prefix: 'board-document', final: 'The complete source contains TEAM_FINAL_FACT=47819.', answers: 1, minimumTurns: 4, roles: /Select the participants before any specialist runs\.|You are spec-beta|You are spec-zeta|Completed specialist passes:/ },
  { name: 'every chain Team agent consumes the same frozen whole document', team: 'Line Team', prefix: 'chain-document', final: 'The captured document contains TEAM_FINAL_FACT=47819.', answers: 2, minimumTurns: 2, roles: /You are line-one|You are line-two/ },
]) test(scenario.name, async ({}, testInfo) => {
  test.setTimeout(180_000)
  const paths = await makeFixtureProject((name) => testInfo.outputPath(name), scenario.prefix)
  const requests: string[] = []
  // Only the paid model is replaced, at the actual HTTP boundary.
  const provider = await startDeterministicOpenAiServer({ resolveTurn: (body) => {
    requests.push(body)
    if (body.includes('Review this fragment')) return { text: JSON.stringify({ evidence: body.includes('TEAM_FINAL_FACT=47819') ? ['TEAM_FINAL_FACT=47819'] : [] }) }
    if (body.includes('Select the participants before any specialist runs.')) return { text: JSON.stringify({ agents: ['spec-beta', 'spec-zeta'], rosterRationale: { 'spec-beta': 'Checks document evidence.', 'spec-zeta': 'Checks final conclusions.' } }) }
    if (body.includes('Completed specialist passes:')) return { text: JSON.stringify({ decision: 'complete', reason: 'Both specialists agree on the captured evidence.', message: null, targets: null, finalResponse: 'The complete source contains TEAM_FINAL_FACT=47819.' }) }
    return { text: 'The captured document contains TEAM_FINAL_FACT=47819.' }
  } })
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: launchEnv(paths, provider.baseUrl, 'team-document-key') })
  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click({ timeout: 90_000 })
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: scenario.team }).click()
    const chat = page.getByRole('region', { name: 'Run chat' })
    await chat.getByLabel('Upload files').setInputFiles({ name: 'whole-source.md', mimeType: 'text/markdown', buffer: Buffer.from('background '.repeat(8_000) + '\nTEAM_FINAL_FACT=47819') })
    await expect(chat.getByTestId('file-message-card')).toContainText('parsed', { timeout: 20_000 })
    await chat.getByRole('textbox').fill('Review the entire document and report TEAM_FINAL_FACT.')
    await chat.getByRole('textbox').press('Enter')
    await expect(chat.getByText(scenario.final, { exact: true })).toHaveCount(scenario.answers, { timeout: 90_000 })
    const turns = requests.filter((body) => !body.includes('Review this fragment') && scenario.roles.test(body))
    expect(turns.length).toBeGreaterThanOrEqual(scenario.minimumTurns)
    for (const body of turns) expect(body).toContain('TEAM_FINAL_FACT=47819')
    const references = turns.map((body) => new Set(body.match(/doc_[a-f0-9]{64}/g) ?? []))
    const shared = [...(references[0] ?? [])].filter((id) => references.every((ids) => ids.has(id)))
    expect(shared).toHaveLength(1)
    await expect(chat.getByTestId('file-message-card')).toContainText('text processed')
    await testInfo.attach('completed-team', { body: await page.screenshot(), contentType: 'image/png' })
  } finally { await app.close(); await provider.close() }
})
