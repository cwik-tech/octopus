/**
 * A review team, built from a proposal and then actually run.
 *
 * A review is the shape with a decision in it: one agent drafts, another either
 * approves the draft or sends it back, and the loop ends either with an
 * approved result or with nothing published at all. Both endings are user-
 * visible outcomes, and neither is proven by emitting YAML.
 *
 * Nothing here seeds a team.yaml or drives the engine directly. The proposal
 * arrives over the provider boundary, the build writes the team, the user runs
 * it from the Run tab, and the reviewer's verdict comes back the same way a
 * model's would. What the run leaves on disk is read at the end.
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { parseMarkdownArtifact } from '../../domains/runtime/artifacts.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  APP_DEFAULT_MODEL,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
  writeAgentPersona,
} from './support/model-selection-fixture.js'

const ARCHITECT_MARKER = 'You are the Agent Architect'

const WRITER = 'clause-writer'
const CHECKER = 'clause-checker'

const DRAFT = 'Clause 7 caps liability at twelve months of fees.'
const APPROVAL = 'This states the cap accurately.'
const REJECTION = 'The cap is stated without its carve-outs.'

/** The proposal, exactly as a provider would return it. */
function reviewProposalJson(depth: 'quick' | 'standard'): string {
  return JSON.stringify({
    message: 'Here is a team for that.',
    warnings: [],
    outcome: {
      id: 'proposal',
      kind: 'team',
      team: {
        teamId: 'clause-review',
        description: 'Drafts a clause summary and has it checked.',
        tags: [],
        existingAgents: [
          { name: WRITER, role: 'Writer', rationale: 'Already available.' },
          { name: CHECKER, role: 'Checker', rationale: 'Already available.' },
        ],
        newAgents: [],
        documentDomains: null,
        questionsResolved: [],
        shape: {
          kind: 'review',
          rationale: 'One writes the summary and the other checks it before it counts.',
          depth,
          producer: WRITER,
          reviewer: CHECKER,
        },
      },
    },
  })
}

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
 * `FakeChatCompletionsRequest.userMessage` is the *first* user message, so a
 * second turn can never be told apart by it.
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

async function seedProject(outputPath: (name: string) => string): Promise<{
  projectRoot: string
  userDataPath: string
  workspacePath: string
}> {
  const projectRoot = outputPath('review-journey-project')
  const userDataPath = outputPath('review-journey-user-data')
  const workspacePath = outputPath('review-journey-workspace')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(projectRoot, { recursive: true }),
  ])
  await fs.writeFile(path.join(projectRoot, 'teams.yaml'), '', 'utf8')
  for (const [name, marker] of [
    [WRITER, `You are ${WRITER}`],
    [CHECKER, `You are ${CHECKER}`],
  ] as const) {
    await writeAgentPersona(projectRoot, {
      name,
      description: `${name} persona.`,
      marker,
    })
  }
  return { projectRoot, userDataPath, workspacePath }
}

async function builtTeamYaml(projectRoot: string, teamId: string): Promise<string> {
  return fs.readFile(path.join(projectRoot, 'teams', teamId, 'team.yaml'), 'utf8')
}

/** The declared artifact this run wrote, scoped to the run's own directory. */
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
 * The review log of the child that actually ran the review stage.
 *
 * Both the wrapper run and the child it spawned own a file of this name, and
 * the wrapper's is empty — it ran no review. So the log is identified by what
 * is in it, not by being the first match under the run directory.
 */
async function findRunReviewEvents(
  workspacePath: string,
  runId: string,
): Promise<string | null> {
  const entries = await fs.readdir(workspacePath, { withFileTypes: true, recursive: true })
  for (const entry of entries) {
    if (entry.isDirectory() || entry.name !== 'review-events.jsonl') continue
    const full = path.join(entry.parentPath, entry.name)
    if (!full.includes(runId)) continue
    const contents = await fs.readFile(full, 'utf8')
    if (contents.includes('loop.max-iterations-reached')) return contents
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

async function askArchitect(page: Page, brief: string): Promise<void> {
  const composer = page.getByPlaceholder('Describe the Agents or Team you need…')
  await expect(composer).toBeEnabled({ timeout: 60_000 })
  await composer.fill(brief)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
}

/** The Architect half of the script, identical for both endings. */
function architectScript(depth: 'quick' | 'standard') {
  return [
    {
      match: (request: { systemPrompt?: string | undefined; body: Record<string, unknown> }) =>
        isArchitectTurn(request) && lastUserMessage(request).includes('checked before'),
      content: 'I have enough information to prepare a Team proposal.',
    },
    {
      match: (request: { systemPrompt?: string | undefined; body: Record<string, unknown> }) =>
        isArchitectTurn(request) && lastUserMessage(request).includes('build it'),
      content: 'Understood — preparing the proposal for your review.\n[[proposal-requested]]',
    },
    {
      match: (request: { systemPrompt?: string | undefined }) =>
        (request.systemPrompt ?? '').includes('## RESOURCE_ARCHITECT_RESPONSE_SCHEMA'),
      content: reviewProposalJson(depth),
    },
  ]
}

/** Builds the proposed review team and returns the page it was built on. */
async function buildReviewTeam(page: Page): Promise<void> {
  await openCreate(page)
  await askArchitect(
    page,
    'I need a team that writes a clause summary and has it checked before it counts.',
  )
  await expect(
    page.getByText('I have enough information to prepare a Team proposal.'),
  ).toBeVisible({ timeout: 60_000 })
  await askArchitect(page, 'build it')

  const shapeBlock = page.getByRole('region', { name: 'How they work together' })
  await expect(shapeBlock).toBeVisible({ timeout: 60_000 })
  await expect(shapeBlock).toContainText('One drafts, another checks it before it counts')

  await page.getByRole('button', { name: /^Create$/ }).click()
  await expect(
    page.getByLabel('Team clause-review').locator('[data-slot="card-action"]'),
  ).toContainText(/created|reused/i, { timeout: 120_000 })
}

/** Runs the built team from the Run tab and returns the dispatched task. */
async function runTeam(page: Page): Promise<{
  id: string
  sessionId: string
  runId: string
}> {
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page.getByRole('tab', { name: 'Teams', exact: true }).click()
  await page.getByRole('radio', { name: 'Clause Review' }).click()

  const composer = page.getByRole('textbox').first()
  await composer.fill('Summarise the liability cap in clause 7.')
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
  return dispatch.task
}

async function taskStatus(page: Page, task: { id: string; sessionId: string }) {
  const apiBaseUrl = await desktopApiBaseUrl(page)
  const response = await fetch(
    `${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`,
  )
  if (!response.ok) return 'unreadable'
  const body = (await response.json()) as { status?: string }
  return body.status ?? 'unknown'
}

test('a review team publishes the draft its reviewer approved', async ({}, testInfo) => {
  test.setTimeout(240_000)
  const paths = await seedProject((name) => testInfo.outputPath(name))

  const provider = await startFakeChatCompletionsServer({
    script: [
      ...architectScript('standard'),
      {
        match: (request) =>
          !isArchitectTurn(request) &&
          (request.systemPrompt ?? '').includes(`You are ${WRITER}`),
        content: DRAFT,
      },
      {
        // The reviewer's verdict travels as a tag the engine parses
        // (`engines/review.ts:215-217`), not as free prose.
        match: (request) =>
          !isArchitectTurn(request) &&
          (request.systemPrompt ?? '').includes(`You are ${CHECKER}`),
        content: `${APPROVAL}\n<review_decision>APPROVE</review_decision>`,
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
      OPENAI_API_KEY: 'review-journey-key',
      OPENAI_BASE_URL: provider.url,
      // The Architect's own reviewer is not scripted here, and an unreviewed
      // answer never prepares a proposal, so review is off, as in
      // create-conversation-navigation.spec.ts.
      PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: 'false',
    },
  })

  try {
    const page = await app.firstWindow()
    await buildReviewTeam(page)

    const yaml = await builtTeamYaml(paths.projectRoot, 'clause-review')
    expect(yaml).toContain('type: review')
    expect(yaml).toContain(`producer: "${WRITER}"`)
    expect(yaml).toContain(`reviewer: "${CHECKER}"`)

    const task = await runTeam(page)
    await expect
      .poll(() => taskStatus(page, task), { timeout: 180_000 })
      .toBe('done')

    // Approval is what publishes. The artifact holds the draft, and its own
    // front matter records the verdict that let it through — so a file written
    // by some other route could not stand in for an approved review.
    const artifact = await findRunArtifact(paths.workspacePath, task.runId)
    expect(artifact, 'the approved run wrote no final-result.md').not.toBeNull()
    const parsed = parseMarkdownArtifact(artifact ?? '')
    expect(parsed.body).toContain(DRAFT)
    // Read through the artifact reader rather than matched as raw text: the
    // front matter is quoted, and the contract is the field, not its spelling.
    expect(parsed.metadata.stage_type).toBe('review')
    expect(parsed.metadata.status).toBe('approved')
    expect(parsed.metadata.verdict).toBe('APPROVE')
  } finally {
    await app.close()
    await provider.close()
  }
})

test('a review that is never approved ends the run, and publishes nothing', async ({}, testInfo) => {
  test.setTimeout(240_000)
  const paths = await seedProject((name) => testInfo.outputPath(name))

  const provider = await startFakeChatCompletionsServer({
    script: [
      // One iteration, so exhaustion is reached without a long loop.
      ...architectScript('quick'),
      {
        match: (request) =>
          !isArchitectTurn(request) &&
          (request.systemPrompt ?? '').includes(`You are ${WRITER}`),
        content: DRAFT,
      },
      {
        match: (request) =>
          !isArchitectTurn(request) &&
          (request.systemPrompt ?? '').includes(`You are ${CHECKER}`),
        content:
          `## Blocking Issues\n1. [Section: Clause 7] — ${REJECTION} — state the carve-outs.\n\n` +
          `<review_decision>REVISE</review_decision>`,
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
      OPENAI_API_KEY: 'review-journey-key',
      OPENAI_BASE_URL: provider.url,
      // The Architect's own reviewer is not scripted here, and an unreviewed
      // answer never prepares a proposal, so review is off, as in
      // create-conversation-navigation.spec.ts.
      PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: 'false',
    },
  })

  try {
    const page = await app.firstWindow()
    await buildReviewTeam(page)
    const task = await runTeam(page)

    // The run reaches its terminal blocked state first. Text can appear before
    // publication settles, so checking for a missing artifact at that instant
    // would prove nothing.
    await expect
      .poll(() => taskStatus(page, task), { timeout: 180_000 })
      .toBe('blocked')

    // What the user is told is what happened and what moves it on — not that
    // there is a blocked run for them to go and resolve.
    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(
      chat.getByText('The reviewer did not approve this within the rounds', {
        exact: false,
      }),
    ).toBeVisible({ timeout: 60_000 })
    await expect(
      chat.getByText('start a new run to try again', { exact: false }),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      chat.getByText('Resolve the blocked run', { exact: false }),
    ).toHaveCount(0)

    // The run's own evidence: one round at quick depth, ended on REVISE.
    const events = await findRunReviewEvents(paths.workspacePath, task.runId)
    expect(events, 'the run recorded no review events').not.toBeNull()
    expect(events ?? '').toContain('loop.max-iterations-reached')
    expect(events ?? '').toContain('"max_iterations":1')
    expect(events ?? '').toContain('"last_verdict":"revise"')

    // And nothing was published: an unapproved draft is not a result.
    const artifact = await findRunArtifact(paths.workspacePath, task.runId)
    expect(artifact, 'an unapproved review published a final-result.md').toBeNull()
  } finally {
    await app.close()
    await provider.close()
  }
})
