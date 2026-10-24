/**
 * The Create half of item 10's journey: describe a problem, see how the team
 * will work together and why, disagree with it, and build what the card says.
 *
 * The creation journeys do not construct a decoded plan, seed a team.yaml, or
 * hand the card props. The Architect's answer arrives over the provider boundary
 * as JSON, the
 * renderer decodes it, and the file the build writes is read off disk at the
 * end. That chain is the feature: a shape that is proposed but not carried, or
 * carried but not emitted, fails somewhere along it.
 *
 * The first journey here stops at the team the build produced. The two that
 * follow it take that same team further: one runs it and reads back what its
 * lead concluded, and one runs it as a workflow step and reads back the
 * discussion itself rather than a summary of it.
 *
 * Exact YAML formatting is deliberately not asserted here — the emitter unit
 * tests carry that. This asserts the stage the user chose.
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { z } from 'zod'
import { sharedFolderViewSchema } from '../../contracts/shared-folders.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  APP_DEFAULT_MODEL,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
  writeAgentPersona,
} from './support/model-selection-fixture.js'

const ARCHITECT_MARKER = 'You are the Agent Architect'

/** The two library Agents the Architect is told to reuse. */
const RISK_LEAD = 'risk-lead'
const RISK_SPOTTER = 'risk-spotter'

/**
 * The proposal, exactly as a provider would return it.
 *
 * A discussion whose coordinator and participant partition the roster, so the
 * shape is valid against the team it describes. The rationale is the sentence
 * the card shows under the headline.
 */
function proposalJson(
  shape?: Record<string, unknown>,
  roster: readonly string[] = [RISK_LEAD, RISK_SPOTTER],
): string {
  return JSON.stringify({
    message: 'Here is a team for that.',
    warnings: [],
    outcome: {
      id: 'proposal',
      kind: 'team',
      team: {
        teamId: 'contract-risk-review',
        description: 'Reads a contract and reports what is risky.',
        tags: [],
        existingAgents: roster.map((name) => ({
          name, role: name === RISK_LEAD ? 'Lead' : 'Contract specialist',
          rationale: 'Already available.',
        })),
        newAgents: [],
        documentDomains: null,
        questionsResolved: [],
        shape: shape ?? {
          kind: 'discussion',
          rationale: 'These agents disagree usefully about what counts as risky.',
          depth: 'standard',
          coordinator: RISK_LEAD,
          participants: [RISK_SPOTTER],
        },
      },
    },
  })
}

/**
 * Whether this request is an Architect turn rather than an Agent's own.
 *
 * Matched positively. Authoring prompts embed the personas they are writing
 * about, so a negative test against an Agent's marker would classify an
 * Architect request as that Agent's.
 */
function isArchitectTurn(request: { systemPrompt?: string | undefined }): boolean {
  return (request.systemPrompt ?? '').includes(ARCHITECT_MARKER)
}

/**
 * Whether this request is asking for a structured proposal.
 *
 * The Architect's own persona names the schema, so the name alone matches any
 * of its turns. Only the proposal policy carries the heading.
 */
function isProposalTurn(request: { systemPrompt?: string | undefined }): boolean {
  return (request.systemPrompt ?? '').includes('## RESOURCE_ARCHITECT_RESPONSE_SCHEMA')
}

/**
 * The most recent user message, which is the one the turn is answering.
 *
 * `FakeChatCompletionsRequest.userMessage` is the *first* user message
 * (`tests/support/fake-chat-completions-server.ts:214`), so a second turn can
 * never be told apart by it.
 */
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

async function seedProject(
  outputPath: (name: string) => string,
  roster: readonly string[] = [RISK_LEAD, RISK_SPOTTER],
): Promise<{
  projectRoot: string
  userDataPath: string
  workspacePath: string
}> {
  const projectRoot = outputPath('shape-journey-project')
  const userDataPath = outputPath('shape-journey-user-data')
  const workspacePath = outputPath('shape-journey-workspace')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(projectRoot, { recursive: true }),
  ])
  await fs.writeFile(path.join(projectRoot, 'teams.yaml'), '', 'utf8')
  for (const name of roster) {
    await writeAgentPersona(projectRoot, {
      name,
      description: `${name} persona.`,
      marker: `You are ${name}`,
    })
  }
  return { projectRoot, userDataPath, workspacePath }
}

/** The team.yaml the build wrote, or a readable failure. */
async function builtTeamYaml(projectRoot: string, teamId: string): Promise<string> {
  return fs.readFile(path.join(projectRoot, 'teams', teamId, 'team.yaml'), 'utf8')
}

/**
 * The declared artifact this run wrote, found under the run's own directory.
 *
 * Scoped to the run id from the dispatch, so a stale or concurrent run's file
 * cannot stand in for it.
 */
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

async function desktopApiBaseUrl(page: Page): Promise<string> {
  return page.evaluate(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const base = hash.get('pipeline-api-base-url')
    if (!base) throw new Error('The desktop window carries no API base URL.')
    return base
  })
}

async function openCreate(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Create', exact: true }).click()
  await page
    .getByLabel('Resource type')
    .getByRole('tab', { name: 'Teams', exact: true })
    .click()
}

/** Sends one brief to the Architect the way the composer does. */
async function askArchitect(page: Page, brief: string): Promise<void> {
  const composer = page.getByPlaceholder('Describe the Agents or Team you need…')
  await expect(composer).toBeEnabled({ timeout: 60_000 })
  await composer.fill(brief)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
}

test('a proposed discussion is shown with its reason, changed, and built as the chosen shape', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const paths = await seedProject((name) => testInfo.outputPath(name))

  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        // Turn one is a conversation, answered in prose. The Architect only
        // asks for a proposal when its own reply ends with the marker
        // `extractProposalRequest` looks for
        // (`resource-architect-llm.ts:425-449`).
        match: (request) =>
          isArchitectTurn(request) && lastUserMessage(request).includes('reads a contract'),
        content: 'I have enough information to prepare a Team proposal.\n\n```mermaid\ngraph LR\nWriter-->Critic\nCritic-->Writer\n```',
      },
      {
        // Turn two asks for the proposal, with the marker that requests it.
        match: (request) =>
          isArchitectTurn(request) && lastUserMessage(request).includes('build it'),
        content:
          'Understood — preparing the proposal for your review.\n[[proposal-requested]]',
      },
      {
        // The proposal turn itself, recognised by the response contract the
        // Architect sends with it rather than by arrival order.
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
      ...desktopEnvironment({
        projectRoot: paths.projectRoot,
        userDataPath: paths.userDataPath,
        workspacePath: paths.workspacePath,
      }),
      // The Agent runtime resolves its provider from the environment, so the
      // team this journey builds must be able to reach the same fixture the
      // Architect does.
      OPENAI_API_KEY: 'shape-journey-key',
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

    await askArchitect(
      page,
      'I need a team that reads a contract and tells me what is risky.',
    )
    await expect(
      page.getByText('I have enough information to prepare a Team proposal.'),
    ).toBeVisible({ timeout: 60_000 })
    // A proposal is a second turn. The first is a conversation, exactly as
    // `agents-and-teams-creation.spec.ts:228-238` drives it.
    await askArchitect(page, 'build it')

    // The shape, in words, with the Architect's reason under it.
    const shapeBlock = page.getByRole('region', { name: 'How they work together' })
    await expect(shapeBlock).toBeVisible({ timeout: 60_000 })
    await expect(shapeBlock).toContainText('They take turns discussing it')
    await expect(shapeBlock).toContainText('disagree usefully')
    // And the difference between the two run modes is stated, not left to be
    // discovered after the first run.
    await expect(shapeBlock).toContainText('A workflow run saves the full discussion')
    await expect(shapeBlock.getByRole('tab')).toHaveCount(3)
    await expect(shapeBlock.getByRole('tab', { name: 'Group discussion' })).toHaveAttribute('aria-selected', 'true')
    await expect(shapeBlock).toContainText('Lead: Risk Lead.')
    await expect(page.getByText('mermaid', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('interaction-choices.png') })

    // Disagree with it.
    await shapeBlock.getByRole('tab', { name: 'One after another' }).click()
    await expect(shapeBlock).toContainText('Each builds on the last')
    await expect(shapeBlock.getByRole('tab', { name: 'One after another' })).toHaveAttribute('aria-selected', 'true')
    await expect(shapeBlock).toContainText('Starts with: Risk Lead. Final result: Risk Spotter. No separate lead.')
    // A chain has no rounds, so the card stops promising them.
    await expect(shapeBlock).not.toContainText('back and forth')

    // Build what the card now says.
    await page.getByRole('button', { name: /^Create$/ }).click()

    // The Team's **own** terminal status, not any text in its card. Each roster
    // row carries its own status too, and the two library Agents here are
    // reused immediately — so matching anywhere in the card would clear this
    // barrier while the roster was still being assembled.
    const teamCard = page.getByLabel('Team contract-risk-review')
    await expect(
      teamCard.locator('[data-slot="card-action"]'),
    ).toContainText(/created|reused/i, { timeout: 120_000 })

    const yaml = await builtTeamYaml(paths.projectRoot, 'contract-risk-review')
    // The stage the user chose, in the file the team runs from.
    expect(yaml).toContain('type: chain')
    expect(yaml).not.toContain('type: discussion')
    // Both members reached the roster, so the team that was built is the team
    // that was described.
    expect(yaml).toContain('risk-lead')
    expect(yaml).toContain('risk-spotter')
  } finally {
    await app.close()
    await provider.close()
  }
})

/**
 * A registered single-step workflow whose step runs the generated team.
 *
 * A workflow is the only way to reach the non-Team-Chat branch from the
 * product: `POST /sessions/:id/tasks` with a `teamId` always goes through
 * `launchSessionTeamTask`, which sets `targetKind: "team-chat"`
 * (`server/routes/sessions.ts:1681-1722`, `services/team-launch-service.ts:285`).
 * The team id is known before the build because the proposal names it.
 */
async function seedTeamWorkflow(projectRoot: string, teamId: string): Promise<void> {
  const templates = path.join(projectRoot, 'workflows', 'templates')
  await fs.mkdir(templates, { recursive: true })
  await fs.writeFile(
    path.join(projectRoot, 'workflows', 'registry.yaml'),
    [
      'contract-risk-workflow:',
      '  description: Runs the generated review team once.',
      '  template_path: ./templates/contract-risk-workflow.yaml',
      '',
    ].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(templates, 'contract-risk-workflow.yaml'),
    [
      'workflow:',
      '  id: contract-risk-workflow',
      '  description: Run the generated team once, as a workflow.',
      '  input:',
      '    artifact: incoming-request.md',
      '  steps:',
      '    - id: discuss',
      '      type: team',
      `      team: ${teamId}`,
      '      input_artifact: incoming-brief.md',
      '      result_artifact: final-result.md',
      '      recovery_policy: manual',
      '  output:',
      '    from_step: discuss',
      '    artifact: final-result.md',
      '  on_blocked: stop',
      '  on_failed: stop',
      '',
    ].join('\n'),
    'utf8',
  )
}

/** What the coordinator answers once the specialists have spoken. */
const FINAL_RESPONSE = 'The indemnity clause is the one that exposes you.'
const SPOTTER_ANSWER = 'Clause 7 shifts unlimited liability onto you.'

/** One distinct contribution per round a normal workflow run makes. */
const WORKFLOW_ROUNDS = [
  'Round one: clause 7 shifts unlimited liability onto you.',
  'Round two: clause 11 has no cap on consequential loss.',
  'Round three: clause 7 is the one to renegotiate first.',
] as const

type FakeRequest = { systemPrompt?: string | undefined; body: Record<string, unknown> }

test('an eight-member team switches to discussion and its lead selects a specialist beyond the first five', async ({}, testInfo) => {
  test.setTimeout(240_000)
  const roster = [
    RISK_LEAD, 'web-researcher', 'michigan-specialist', 'ip-counsel',
    'privacy-counsel', 'leverage-strategist', 'writer', RISK_SPOTTER,
  ]
  const paths = await seedProject((name) => testInfo.outputPath(name), roster)

  // The provider is paid and nondeterministic, so replace only its HTTP boundary.
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          isArchitectTurn(request) && lastUserMessage(request).includes('reads a contract'),
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
        // A chain is proposed here. The user chooses the discussion, so what
        // runs below is the *amended* shape, not the one the model suggested.
        content: proposalJson({
          kind: 'chain',
          rationale: 'One after another seemed simplest.',
          depth: 'standard',
          order: roster,
        }, roster),
      },
      // From here the team itself is running. Ordinary provider replies, no
      // tool-call script: the coordinator selects, the specialist speaks, and
      // the coordinator concludes.
      {
        match: (request) =>
          !isArchitectTurn(request) &&
          (request.systemPrompt ?? '').includes(
            'Select the participants before any specialist runs.',
          ),
        content: JSON.stringify({
          agents: [RISK_SPOTTER],
          rosterRationale: { [RISK_SPOTTER]: 'Reads the clauses.' },
        }),
      },
      {
        match: (request) =>
          !isArchitectTurn(request) &&
          (request.systemPrompt ?? '').includes('You are risk-spotter'),
        content: SPOTTER_ANSWER,
      },
      {
        // The pass count reaches the lead in the **user** message, not the
        // system prompt (`delegated-discussion-autostart.ts:428-430`). Matching
        // the system prompt for it never fired, and the lead's continuation
        // turn got an empty reply.
        match: (request) =>
          !isArchitectTurn(request) &&
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
    // Keyless LM Studio: the native tool route refuses a keyless
    // OpenAI-compatible connection.
    kind: 'lm-studio',
  })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...desktopEnvironment({
        projectRoot: paths.projectRoot,
        userDataPath: paths.userDataPath,
        workspacePath: paths.workspacePath,
      }),
      OPENAI_API_KEY: 'shape-journey-key',
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

    await askArchitect(
      page,
      'I need a team that reads a contract and tells me what is risky.',
    )
    await expect(
      page.getByText('I have enough information to prepare a Team proposal.'),
    ).toBeVisible({ timeout: 60_000 })
    await askArchitect(page, 'build it')

    // A chain was proposed. The user disagrees and chooses the discussion, and
    // that amended shape is what has to run.
    const shapeBlock = page.getByRole('region', { name: 'How they work together' })
    await expect(shapeBlock).toBeVisible({ timeout: 60_000 })
    await expect(shapeBlock).toContainText('Each builds on the last')
    await shapeBlock.getByRole('tab', { name: 'Group discussion' }).click()
    await expect(shapeBlock).toContainText('They take turns discussing it')
    await expect(shapeBlock).toContainText('Lead: Risk Lead.')
    await expect(shapeBlock.getByRole('tab', { name: 'Group discussion' })).toHaveAttribute('aria-selected', 'true')
    await shapeBlock.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('large-team-discussion.png') })

    await page.getByRole('button', { name: /^Create$/ }).click()
    const teamCard = page.getByLabel('Team contract-risk-review')
    await expect(
      teamCard.locator('[data-slot="card-action"]'),
    ).toContainText(/created|reused/i, { timeout: 120_000 })

    // The emitted team is a discussion, and now it is run.
    const yaml = await builtTeamYaml(paths.projectRoot, 'contract-risk-review')
    expect(yaml).toContain('type: discussion')
    expect(yaml).toContain(`coordinator: "${RISK_LEAD}"`)

    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: 'Contract Risk Review' }).click()

    const composer = page.getByRole('textbox').first()
    await composer.fill('Which clause exposes me?')
    // Registered before the submit, so the dispatch cannot be missed. Its body
    // names the exact task, session and run this message started
    // (`session-client.ts:1209-1223`), which is what scopes every assertion
    // below to *this* run rather than whichever one a scan finds first.
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
    // The specialist the coordinator selected actually spoke.
    await expect(chat.getByText(SPOTTER_ANSWER, { exact: false })).toBeVisible({
      timeout: 120_000,
    })
    // And the lead's conclusion is what the user is left with.
    await expect(chat.getByText(FINAL_RESPONSE, { exact: false })).toBeVisible({
      timeout: 120_000,
    })

    // Text on screen is not publication. The run has to reach its terminal
    // successful state and the declared artifact has to exist, for *this* task.
    const apiBaseUrl = await desktopApiBaseUrl(page)
    await expect
      .poll(
        async () => {
          const response = await fetch(
            `${apiBaseUrl}/sessions/${dispatch.task.sessionId}/tasks/${dispatch.task.id}`,
          )
          if (!response.ok) return 'unreadable'
          // The route answers with the task itself, not a wrapper
          // (`server/routes/sessions.ts:1052-1062`).
          const task = (await response.json()) as { status?: string }
          return task.status ?? 'unknown'
        },
        { timeout: 120_000 },
      )
      // `done` is the successful terminal status (`contracts/sessions.ts:412`).
      .toBe('done')

    const artifact = await findRunArtifact(paths.workspacePath, dispatch.task.runId)
    expect(artifact, 'the run wrote no final-result.md').not.toBeNull()
    expect(artifact ?? '').toContain(FINAL_RESPONSE)
  } finally {
    await app.close()
    await provider.close()
  }
})

test('the same team run as a workflow saves the discussion itself, not the summary', async ({}, testInfo) => {
  test.setTimeout(240_000)
  const paths = await seedProject((name) => testInfo.outputPath(name))
  await seedTeamWorkflow(paths.projectRoot, 'contract-risk-review')

  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          isArchitectTurn(request) && lastUserMessage(request).includes('reads a contract'),
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
      {
        match: (request) =>
          !isArchitectTurn(request) &&
          (request.systemPrompt ?? '').includes(
            'Select the participants before any specialist runs.',
          ),
        content: JSON.stringify({
          agents: [RISK_SPOTTER],
          rosterRationale: { [RISK_SPOTTER]: 'Reads the clauses.' },
        }),
      },
      // A normal workflow run loops to `max_rounds`, which the standard depth
      // sets to three (`engines/discussion.ts:362-367`, `team-shape.ts:77-78`).
      // Each matched entry is consumed once, so all three rounds are scripted
      // with distinct text rather than the depth being reduced to fit one.
      ...WORKFLOW_ROUNDS.map((content) => ({
        match: (request: FakeRequest) =>
          !isArchitectTurn(request) &&
          (request.systemPrompt ?? '').includes('You are risk-spotter'),
        content,
      })),
      // No lead-completion turn: outside Team Chat the engine simply finishes
      // its rounds and writes the transcript.
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
      ...desktopEnvironment({
        projectRoot: paths.projectRoot,
        userDataPath: paths.userDataPath,
        workspacePath: paths.workspacePath,
      }),
      OPENAI_API_KEY: 'shape-journey-key',
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
    await askArchitect(
      page,
      'I need a team that reads a contract and tells me what is risky.',
    )
    await expect(
      page.getByText('I have enough information to prepare a Team proposal.'),
    ).toBeVisible({ timeout: 60_000 })
    await askArchitect(page, 'build it')

    const shapeBlock = page.getByRole('region', { name: 'How they work together' })
    await expect(shapeBlock).toBeVisible({ timeout: 60_000 })
    await expect(shapeBlock).toContainText('They take turns discussing it')

    await page.getByRole('button', { name: /^Create$/ }).click()
    await expect(
      page.getByLabel('Team contract-risk-review').locator('[data-slot="card-action"]'),
    ).toContainText(/created|reused/i, { timeout: 120_000 })

    // A workflow run of the same Team, which is the only route to the
    // non-Team-Chat branch: a task started with a `teamId` always becomes a
    // chat.
    const apiBaseUrl = await desktopApiBaseUrl(page)
    const task = await page.evaluate(
      async ([base]) => {
        const session = await (
          await fetch(`${base}/sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Workflow transcript run' }),
          })
        ).json()
        const response = await fetch(`${base}/sessions/${session.id}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workflowId: 'contract-risk-workflow',
            // A workflow launch refuses a thin brief and asks for topic,
            // audience, outcome and constraints before it will start.
            brief:
              'Review the attached supplier contract for legal risk. Audience: ' +
              'the finance director. Outcome: name the single clause that ' +
              'exposes us most, and why. Constraint: answer in two sentences.',
          }),
        })
        const raw = await response.text()
        if (!response.ok) throw new Error(`task start ${response.status}: ${raw}`)
        const started = JSON.parse(raw)
        return started as {
          id: string
          sessionId: string
          runId: string
          workflowId?: string
          targetKind?: string
        }
      },
      [apiBaseUrl],
    )

    // Proven to be the mode under test before its artifact is read as evidence.
    expect(task.workflowId).toBe('contract-risk-workflow')
    expect(task.targetKind).not.toBe('team-chat')

    await expect
      .poll(
        async () => {
          const response = await fetch(
            `${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`,
          )
          if (!response.ok) return 'unreadable'
          return ((await response.json()) as { status?: string }).status ?? 'unknown'
        },
        { timeout: 180_000 },
      )
      .toBe('done')

    const artifact = await findRunArtifact(paths.workspacePath, task.runId)
    expect(artifact, 'the workflow run wrote no final-result.md').not.toBeNull()
    // The transcript, written by `engines/discussion.ts:440-460`: the
    // discussion itself under its own title, carrying what the specialist
    // actually said.
    expect(artifact ?? '').toContain('# Discussion Outcome')
    // Every round the engine ran is in the record, which is what makes this a
    // transcript rather than a summary of one.
    for (const round of WORKFLOW_ROUNDS) {
      expect(artifact ?? '').toContain(round)
    }
    // And the lead's synthesis, which Team Chat would have saved, is not what
    // this mode writes.
    expect(artifact ?? '').not.toContain(FINAL_RESPONSE)
  } finally {
    await app.close()
    await provider.close()
  }
})

test('an uploaded file reaches a selected Team and its grounded answer is displayed', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const roster = ['board-lead', 'spec-alpha', 'spec-beta', 'spec-gamma', 'spec-delta', 'spec-epsilon', 'spec-zeta', 'spec-eta']
  const paths = await seedProject((name) => testInfo.outputPath(name), roster)
  const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'team-chat-e2e')
  await fs.mkdir(path.join(paths.projectRoot, 'teams', 'board-team'), { recursive: true })
  await fs.writeFile(path.join(paths.projectRoot, 'teams', 'board-team', 'team.yaml'),
    await fs.readFile(path.join(fixtureRoot, 'teams', 'board-team', 'team.yaml'), 'utf8'))
  await fs.writeFile(path.join(paths.projectRoot, 'teams.yaml'),
    (await fs.readFile(path.join(fixtureRoot, 'teams.yaml'), 'utf8')).split('\nline-team:')[0] ?? '')
  const reference = 'Use one term for each concept.'
  const groundedAnswer = 'The attached methodology supports a consistent terminology skill.'
  const received = new Set<string>()
  // Replace the paid, nondeterministic model at its HTTP boundary. Every
  // discussion response depends on the actual uploaded reference reaching it.
  const hasReference = (request: { body: Record<string, unknown> }, speaker: string): boolean => {
    if (!JSON.stringify(request.body).includes(reference)) return false
    received.add(speaker)
    return true
  }
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (request) => (request.systemPrompt ?? '').includes('Select the participants before any specialist runs.') && hasReference(request, 'selection'),
      content: JSON.stringify({ agents: ['spec-beta', 'spec-zeta'], rosterRationale: { 'spec-beta': 'Review terminology.', 'spec-zeta': 'Evaluate reuse.' } }) },
    { match: (request) => (request.systemPrompt ?? '').includes('You are spec-beta') && hasReference(request, 'spec-beta'),
      content: 'The reference recommends consistent terminology.' },
    { match: (request) => (request.systemPrompt ?? '').includes('You are spec-zeta') && hasReference(request, 'spec-zeta'),
      content: 'A terminology skill can apply the reference across documents.' },
    { match: (request) => lastUserMessage(request).includes('Completed specialist passes: 1') && hasReference(request, 'synthesis'),
      content: JSON.stringify({ decision: 'complete', reason: 'Both specialists reviewed the reference.', finalResponse: groundedAnswer }) },
  ] })
  await seedProviderSettings({ userDataPath: paths.userDataPath, baseUrl: provider.url, defaultModel: APP_DEFAULT_MODEL, kind: 'lm-studio' })
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: desktopEnvironment(paths) })
  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: 'Board Team' }).click()
    const chat = page.getByRole('region', { name: 'Run chat' })
    await chat.getByLabel('Upload files').setInputFiles({
      name: 'methodology.txt', mimeType: 'text/plain', buffer: Buffer.from(reference),
    })
    await expect(chat.getByTestId('file-message-card')).toContainText('parsed')
    const composer = chat.getByRole('textbox').first()
    await composer.fill('Propose skills based on the attached methodology.')
    await composer.press('Enter')
    await expect(chat.getByText(groundedAnswer, { exact: false })).toBeVisible({ timeout: 45_000 })
    expect([...received].sort()).toEqual(['selection', 'spec-beta', 'spec-zeta', 'synthesis'])
    await expect(chat.getByTestId('file-message-card')).toContainText('used in chat')
    await expect(composer).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('team-upload-grounded-answer.png') })
  } finally {
    await app.close()
    await provider.close()
  }
})

test('a saved Team shows and saves a partial answer when a selected specialist fails', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const roster = ['board-lead', 'spec-alpha', 'spec-beta', 'spec-gamma', 'spec-delta', 'spec-epsilon', 'spec-zeta', 'spec-eta']
  const paths = await seedProject((name) => testInfo.outputPath(name), roster)
  const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'team-chat-e2e')
  await fs.mkdir(path.join(paths.projectRoot, 'teams', 'board-team'), { recursive: true })
  await fs.writeFile(path.join(paths.projectRoot, 'teams', 'board-team', 'team.yaml'),
    (await fs.readFile(path.join(fixtureRoot, 'teams', 'board-team', 'team.yaml'), 'utf8')).replaceAll('board-result.md', 'final-result.md'))
  await fs.writeFile(path.join(paths.projectRoot, 'teams.yaml'),
    (await fs.readFile(path.join(fixtureRoot, 'teams.yaml'), 'utf8')).split('\nline-team:')[0]?.replaceAll('board-result.md', 'final-result.md') ?? '')

  // Replace the paid, nondeterministic provider only at its HTTP boundary.
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (request) => (request.systemPrompt ?? '').includes('Select the participants before any specialist runs.'),
      content: JSON.stringify({ agents: ['spec-beta', 'spec-zeta'], rosterRationale: { 'spec-beta': 'Provide evidence.', 'spec-zeta': 'Challenge it.' } }) },
    { match: (request) => (request.systemPrompt ?? '').includes('You are spec-beta'), content: SPOTTER_ANSWER },
    { match: (request) => (request.systemPrompt ?? '').includes('You are spec-zeta'), failStatus: 400 },
    { match: (request) => lastUserMessage(request).includes('Completed specialist passes: 1'),
      content: JSON.stringify({ decision: 'complete', reason: 'Use available evidence.', finalResponse: FINAL_RESPONSE }) },
  ] })
  await seedProviderSettings({ userDataPath: paths.userDataPath, baseUrl: provider.url, defaultModel: APP_DEFAULT_MODEL, kind: 'lm-studio' })
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: {
    ...desktopEnvironment(paths), OPENAI_API_KEY: 'partial-journey-key', OPENAI_BASE_URL: provider.url,
  } })
  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: 'Board Team' }).click()
    const composer = page.getByRole('textbox').first()
    await composer.fill('Which clause exposes me?')
    const dispatched = page.waitForResponse((response) => response.request().method() === 'POST' && /\/sessions\/[^/]+\/messages$/u.test(new URL(response.url()).pathname))
    await composer.press('Enter')
    const dispatch = (await (await dispatched).json()) as { task: { id: string; sessionId: string; runId: string } }
    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(chat.getByText(SPOTTER_ANSWER, { exact: false })).toBeVisible({ timeout: 60_000 })
    await expect(chat.getByText('Partial Team answer: spec-zeta did not complete its contribution.', { exact: false })).toBeVisible({ timeout: 60_000 })
    await expect(chat.getByText(FINAL_RESPONSE, { exact: false })).toBeVisible()
    const apiBaseUrl = await desktopApiBaseUrl(page)
    await expect.poll(async () => {
      const response = await fetch(`${apiBaseUrl}/sessions/${dispatch.task.sessionId}/tasks/${dispatch.task.id}`)
      const task = (await response.json()) as { status?: string }
      return task.status
    }, { timeout: 30_000 }).toBe('done')
    await expect(composer).toBeEnabled()
    const artifact = await findRunArtifact(paths.workspacePath, dispatch.task.runId)
    expect(artifact).toContain('Partial Team answer: spec-zeta did not complete its contribution.')
    expect(artifact).toContain(FINAL_RESPONSE)
    await page.screenshot({ path: testInfo.outputPath('partial-team-answer.png') })
  } finally {
    await app.close()
    await provider.close()
  }
})


test('a Team reads both nested codebases from a folder attached in the chat header', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const roster = ['board-lead', 'spec-alpha', 'spec-beta', 'spec-gamma', 'spec-delta', 'spec-epsilon', 'spec-zeta', 'spec-eta']
  const paths = await seedProject((name) => testInfo.outputPath(name), roster)
  const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'team-chat-e2e')
  await fs.mkdir(path.join(paths.projectRoot, 'teams', 'board-team'), { recursive: true })
  await fs.copyFile(path.join(fixtureRoot, 'teams', 'board-team', 'team.yaml'), path.join(paths.projectRoot, 'teams', 'board-team', 'team.yaml'))
  await fs.writeFile(path.join(paths.projectRoot, 'teams.yaml'),
    (await fs.readFile(path.join(fixtureRoot, 'teams.yaml'), 'utf8')).split('\nline-team:')[0] ?? '')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-nested-codebases-'))
  await fs.mkdir(path.join(root, 'gateway', 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'engine', 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'gateway', 'src', 'main.ts'), 'export const gateway = "CITRUS-731";')
  await fs.writeFile(path.join(root, 'engine', 'src', 'main.ts'), 'export const engine = "CEDAR-952";')
  const firstRead: Record<string, unknown> = { path: 'gateway/src/main.ts' }
  const secondRead: Record<string, unknown> = { path: 'engine/src/main.ts' }
  const hasMap = (request: { body: Record<string, unknown> }): boolean =>
    lastUserMessage(request).includes('<attached_folders') && lastUserMessage(request).includes('gateway') && lastUserMessage(request).includes('engine')
  const hasRead = (request: { body: Record<string, unknown> }, marker: string): boolean => {
    const messages = Array.isArray(request.body.messages) ? request.body.messages : []
    return messages.some((message: unknown) => typeof message === 'object' && message !== null &&
      'role' in message && message.role === 'tool' && 'content' in message &&
      typeof message.content === 'string' && message.content.includes(marker))
  }
  const answer = 'Both codebases were read: gateway CITRUS-731 and engine CEDAR-952.'
  // Replace only the paid, nondeterministic model and the native directory dialog.
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (request) => (request.systemPrompt ?? '').includes('Select the participants before any specialist runs.') && hasMap(request),
      content: JSON.stringify({ agents: ['spec-beta', 'spec-zeta'], rosterRationale: { 'spec-beta': 'Read gateway.', 'spec-zeta': 'Read engine.' } }) },
    { match: (request) => (request.systemPrompt ?? '').includes('You are spec-beta') && hasMap(request) && !hasRead(request, 'CITRUS-731'),
      toolCalls: [{ id: 'gateway-read', name: 'folder_read', arguments: firstRead }] },
    { match: (request) => (request.systemPrompt ?? '').includes('You are spec-beta') && hasRead(request, 'CITRUS-731'),
      content: 'Gateway identifies itself as CITRUS-731 at gateway/src/main.ts.' },
    { match: (request) => (request.systemPrompt ?? '').includes('You are spec-zeta') && hasMap(request) && !hasRead(request, 'CEDAR-952'),
      toolCalls: [{ id: 'engine-read', name: 'folder_read', arguments: secondRead }] },
    { match: (request) => (request.systemPrompt ?? '').includes('You are spec-zeta') && hasRead(request, 'CEDAR-952'),
      content: 'Engine identifies itself as CEDAR-952 at engine/src/main.ts.' },
    { match: (request) => lastUserMessage(request).includes('Completed specialist passes: 1') && hasMap(request) &&
        lastUserMessage(request).includes('CITRUS-731') && lastUserMessage(request).includes('CEDAR-952'),
      content: JSON.stringify({ decision: 'complete', reason: 'Both codebases were read.', finalResponse: answer }) },
  ] })
  await seedProviderSettings({ userDataPath: paths.userDataPath, baseUrl: provider.url, defaultModel: APP_DEFAULT_MODEL, kind: 'lm-studio' })
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: desktopEnvironment(paths) })
  try {
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, root)
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: 'Board Team' }).click()
    const chat = page.getByRole('region', { name: 'Run chat' })
    await chat.getByRole('button', { name: 'Add folder', exact: true }).click()
    await expect(chat.getByRole('button', { name: 'Attached folders (1)', exact: true })).toBeVisible()
    await chat.getByRole('button', { name: 'Attached folders (1)', exact: true }).click()
    const hash = await page.evaluate(() => window.location.hash.slice(1))
    const apiUrl = new URLSearchParams(hash).get('pipeline-api-base-url')
    expect(apiUrl).toBeTruthy()
    const sessions = await new FileSystemSessionStore(paths.workspacePath).listSessions()
    expect(sessions).toHaveLength(1)
    const response = await fetch(`${apiUrl}/sessions/${sessions[0]?.id}/folders`, { signal: AbortSignal.timeout(5_000) })
    expect(response.ok).toBe(true)
    const { folders } = z.object({ folders: z.array(sharedFolderViewSchema) }).parse(await response.json())
    expect(folders).toHaveLength(1)
    const id = folders[0]?.id
    firstRead.folder = id
    secondRead.folder = id
    await page.keyboard.press('Escape')
    const composer = chat.getByRole('textbox').first()
    await composer.fill('Inspect both codebases in the attached folder and report their identifiers.')
    await composer.press('Enter')
    await expect(chat.getByText(answer, { exact: false })).toBeVisible({ timeout: 35_000 })
    const gatewayRequest = provider.requests.find((request) => hasRead(request, 'CITRUS-731'))
    const engineRequest = provider.requests.find((request) => hasRead(request, 'CEDAR-952'))
    expect(gatewayRequest, 'gateway source reached its specialist through folder_read').toBeDefined()
    expect(engineRequest, 'engine source reached its specialist through folder_read').toBeDefined()
    expect(provider.requests.filter((request) => (request.systemPrompt ?? '').includes('Select the participants before any specialist runs.')).some(hasMap)).toBe(true)
    await expect(composer).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('team-nested-folder-answer.png') })
  } finally {
    await app.close()
    await provider.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
