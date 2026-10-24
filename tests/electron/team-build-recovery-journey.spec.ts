/**
 * What happens to a team build that stops before it finishes.
 *
 * A Team shell exists from the first moment of a build. If the build stops, the
 * shell is on disk: no roster, hidden from every catalog, and unable to satisfy
 * its own completion gate. The user has exactly two things they can do with it:
 * retry it or throw it away. A build that failed offers both on the screen where
 * it failed; a build the application stopped mid-work is interrupted, and it
 * offers both again after the application is reopened over the same files.
 *
 * The plans are fixture input; nothing a build produces is. Every stopped build
 * these journeys act on is one the product made, stopping for a reason the
 * product actually has: the agent it was told to reuse is not there, or the
 * process ended while the build was still working. Where the shape the user
 * chose is part of what a retry must publish, the build is made through the
 * interface and the proposal arrives over the provider boundary. Where it is
 * not, the same build is made through the real API before the application
 * starts, which is a launch this file no longer has to pay for.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as path from 'node:path'

import type {
  ResourceBuildJobSnapshot,
  ResourceTeamCreationPlan,
} from '../../contracts/resource-architect.js'
import { seedDesktopProjectRoot } from '../../electron/project-root.js'
import { CreateJobRegistry } from '../../server/create-job-registry.js'
import { ResourceArchitectStore } from '../../server/resource-architect-store.js'
import { handleResourceArchitectRoutes } from '../../server/routes/resource-architect.js'
import {
  ServiceError,
  statusCodeForServiceError,
} from '../../services/service-errors.js'
import {
  isProviderHealthProbe,
  startFakeChatCompletionsServer,
  type FakeChatCompletionsRequest,
  type FakeChatCompletionsTurn,
} from '../support/fake-chat-completions-server.js'
import {
  APP_DEFAULT_MODEL,
  FIXTURE_PROVIDER,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
  writeAgentPersona,
} from './support/model-selection-fixture.js'

const ARCHITECT_MARKER = 'You are the Agent Architect'
/** Only the proposal policy carries this heading. */
const PROPOSAL_POLICY_HEADING = '## RESOURCE_ARCHITECT_RESPONSE_SCHEMA'
const LEAD = 'intake-lead'
/** Deliberately absent when the first build runs. */
const LATE_ARRIVAL = 'late-reviewer'
const TEAM_ID = 'intake-review'
/** A second, older build that is left alone, so a newer discard's barrier can be seen. */
const OTHER_TEAM_ID = 'expense-review'

/**
 * The team a build is asked to make, in the form the product stores.
 *
 * One definition serves both ways a build starts here: the Architect proposes
 * it over the provider boundary in the retry journey, and the discard journey
 * saves it straight to the store before building it. Both then build the same
 * team, so what one journey proves about the record the other reads back.
 */
function teamPlan(teamId: string): ResourceTeamCreationPlan {
  return {
    id: `proposal-${teamId}`,
    kind: 'team',
    team: {
      teamId,
      description: 'Takes an intake note and has it checked.',
      tags: [],
      existingAgents: [
        { name: LEAD, role: 'Lead', rationale: 'Already available.' },
        { name: LATE_ARRIVAL, role: 'Reviewer', rationale: 'Already available.' },
      ],
      newAgents: [],
      questionsResolved: [],
      // A chain is proposed. The user changes it to a discussion before
      // building, so the shape the retry must publish is the amended one.
      shape: {
        kind: 'chain',
        rationale: 'One after another seemed simplest.',
        depth: 'quick',
        order: [LEAD, LATE_ARRIVAL],
      },
    },
  }
}

function proposalJson(teamId: string): string {
  const plan = teamPlan(teamId)
  return JSON.stringify({
    message: 'Here is a team for that.',
    warnings: [],
    // Null rather than absent, which is what a model actually sends.
    outcome: { ...plan, team: { ...plan.team, documentDomains: null } },
  })
}

/**
 * Whether this request is asking for a structured proposal.
 *
 * The Architect's own persona names the schema, so a prompt merely containing
 * that name is any of its turns. The proposal policy adds the heading, and only
 * the proposal policy does — so that is what tells the two operations apart. A
 * conversation entry that matched on the name alone was consumed by a proposal
 * request, and the proposal JSON came back as chat text.
 */
function isProposalTurn(request: { systemPrompt?: string | undefined }): boolean {
  return (request.systemPrompt ?? '').includes(PROPOSAL_POLICY_HEADING)
}

/** An Architect turn that is a conversation rather than a proposal. */
function isConversationTurn(request: { systemPrompt?: string | undefined }): boolean {
  return (
    (request.systemPrompt ?? '').includes(ARCHITECT_MARKER) &&
    !isProposalTurn(request)
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

/** What the Architect says back once it has heard the brief. */
const BRIEF_CONFIRMED = 'I have enough information to prepare the intake team.'

/** Only the Architect's independent reviewer carries this persona heading. */
const REVIEWER_MARKER = '# Reviewer of Agent Architect'
/** How the Architect's final request opens, after its draft was reviewed. */
const FINAL_INSTRUCTION = 'Return your final answer to the original request.'
/**
 * A review that passes the draft.
 *
 * `contracts/schemas/resource-architect-review.ts` accepts `pass` only with no
 * findings. Anything the reviewer returns that fails that schema leaves the
 * turn unreviewed, and an unreviewed turn never asks for a proposal.
 */
const PASSING_REVIEW = JSON.stringify({ verdict: 'pass', findings: [] })

/** A request from the reviewer, which is never an Architect turn itself. */
function isReviewRequest(request: FakeChatCompletionsRequest): boolean {
  const system = request.systemPrompt ?? ''
  return system.includes(REVIEWER_MARKER) && !system.includes(ARCHITECT_MARKER)
}

/** The Architect's final request, which carries its reviewed draft. */
function isFinalRequest(request: FakeChatCompletionsRequest): boolean {
  return isConversationTurn(request) && lastUserMessage(request).startsWith(FINAL_INSTRUCTION)
}

/** The draft a review or final request carries, read from its JSON packet. */
function candidateOf(request: FakeChatCompletionsRequest): string | undefined {
  const packet = lastUserMessage(request).split('\n\n').at(-1) ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(packet)
  } catch {
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null && 'candidate' in parsed &&
    typeof parsed.candidate === 'string'
    ? parsed.candidate
    : undefined
}

/** One scripted answer, named so a journey can say which one went unused. */
interface NamedTurn {
  readonly name: string
  readonly turn: FakeChatCompletionsTurn
}

/**
 * One Architect conversation turn as the app sends it with independent review
 * on: the draft, the review of that draft, and the final answer.
 *
 * Each answer claims the request by who is asking and what it carries, not by
 * arrival order: the review and the final request name the draft they are
 * about. The passing review means the final answer repeats the draft.
 */
function reviewedTurn(label: string, userText: string, answer: string): NamedTurn[] {
  return [
    {
      name: `${label} draft`,
      turn: {
        match: (request) =>
          isConversationTurn(request) && !isFinalRequest(request) &&
          lastUserMessage(request).includes(userText),
        content: answer,
      },
    },
    {
      name: `${label} review`,
      turn: {
        match: (request) => isReviewRequest(request) && candidateOf(request) === answer,
        content: PASSING_REVIEW,
      },
    },
    {
      name: `${label} final`,
      turn: {
        match: (request) => isFinalRequest(request) && candidateOf(request) === answer,
        content: answer,
      },
    },
  ]
}

function describeRequest(request: FakeChatCompletionsRequest): string {
  return `${request.model ?? 'no model'}: ${(request.systemPrompt ?? '').slice(0, 80)} | ${lastUserMessage(request).slice(0, 80)}`
}

/**
 * A journey's script that records which request each answer claimed.
 *
 * Each answer claims at most one request, and the fake server answers a
 * request that no answer claims with an empty reply, which is easy to miss. The
 * record lets a journey list every request that no answer claimed, apart from
 * the app's exact health probes, and every answer that no request used, so an
 * extra, repeated or wrongly shaped request fails the journey, and so does a
 * missing one.
 */
function claimedScript(turns: readonly NamedTurn[]) {
  const claimedRequests = new Set<FakeChatCompletionsRequest>()
  const usedTurns = new Set<string>()
  const script: FakeChatCompletionsTurn[] = turns.map(({ name, turn }) => ({
    ...turn,
    match: (request: FakeChatCompletionsRequest) => {
      if (!turn.match?.(request)) return false
      claimedRequests.add(request)
      usedTurns.add(name)
      return true
    },
  }))
  return {
    script,
    unanswered: (requests: readonly FakeChatCompletionsRequest[]): string[] =>
      requests
        .filter((request) => !claimedRequests.has(request) && !isProviderHealthProbe(request))
        .map(describeRequest),
    unused: (): string[] => turns.map(({ name }) => name).filter((name) => !usedTurns.has(name)),
  }
}

/** Every user message in the turn, so a proposal knows which brief it answers. */
function allUserText(request: { body: Record<string, unknown> }): string {
  const messages = Array.isArray(request.body.messages) ? request.body.messages : []
  return messages
    .filter(
      (message): message is { role: string; content?: unknown } =>
        typeof message === 'object' && message !== null &&
        (message as { role?: unknown }).role === 'user',
    )
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n')
}

/** The Architect's reply that asks the app for a proposal. */
const PROPOSAL_REQUESTED = 'Understood — preparing the proposal for your review.\n[[proposal-requested]]'

/**
 * The Architect's half of the one conversation held over the fake provider.
 *
 * A scripted turn is consumed once, and this journey holds a single
 * conversation: the reviewed reply that ends the brief, the reviewed reply
 * that asks for a proposal, and the proposal itself, which is not reviewed.
 */
function architectTurns(proposal: string): NamedTurn[] {
  return [
    ...reviewedTurn('brief', 'intake note', BRIEF_CONFIRMED),
    ...reviewedTurn('build it', 'build it', PROPOSAL_REQUESTED),
    { name: 'proposal', turn: { match: (request) => isProposalTurn(request), content: proposal } },
  ]
}

interface Paths {
  projectRoot: string
  userDataPath: string
  workspacePath: string
}

async function seedProject(outputPath: (name: string) => string): Promise<Paths> {
  const projectRoot = outputPath('recovery-journey-project')
  const userDataPath = outputPath('recovery-journey-user-data')
  const workspacePath = outputPath('recovery-journey-workspace')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(projectRoot, { recursive: true }),
  ])
  await fs.writeFile(path.join(projectRoot, 'teams.yaml'), '', 'utf8')
  // Only the lead exists. The build therefore fails while assembling the
  // roster, after the shell has been created — the exact state this is about.
  await writeAgentPersona(projectRoot, {
    name: LEAD,
    description: `${LEAD} persona.`,
    marker: `You are ${LEAD}`,
  })
  return { projectRoot, userDataPath, workspacePath }
}

async function launch(paths: Paths, providerUrl: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...desktopEnvironment(paths),
      OPENAI_API_KEY: 'recovery-journey-key',
      OPENAI_BASE_URL: providerUrl,
    },
  })
}

/**
 * Waits for one event, giving up after `ms` with a reason worth reading.
 *
 * The timer is always cleared, so nothing outlives the wait.
 */
async function withDeadline(
  event: Promise<void>,
  ms: number,
  reason: () => Promise<string>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void reason().then(
        (message) => reject(new Error(message)),
        () => reject(new Error('the event never happened')),
      )
    }, ms)
  })
  try {
    await Promise.race([event, expired])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** What the app's own API says about its builds, read once. */
async function jobStatuses(apiBaseUrl: string): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/create/resource-architect/jobs`, {
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  if (!response?.ok) return 'unreadable'
  const body = (await response.json()) as {
    jobs: { status: string; error?: string }[]
  }
  return JSON.stringify(body.jobs.map((job) => [job.status, job.error]))
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

/**
 * Points the Architect at the fixture connection.
 *
 * The seeded application default decides the chat turn. Authoring a new Agent
 * is a separate dispatch that takes its provider and model from this control,
 * and without it the build reached a real provider instead of the fake server —
 * so the held reply never arrived and nothing was ever in flight to interrupt.
 */
async function useFixtureArchitectModel(page: Page): Promise<void> {
  await page.getByLabel('Agent Architect model').click()
  // The open list, not the closed control: the trigger shows the same name.
  await page
    .getByRole('option', { name: APP_DEFAULT_MODEL.name })
    .first()
    .click()
}

async function askArchitect(page: Page, brief: string): Promise<void> {
  const composer = page.getByPlaceholder('Describe the Agents or Team you need…')
  await expect(composer).toBeEnabled({ timeout: 60_000 })
  await composer.fill(brief)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
}

/**
 * Proposes the team through the Architect, amends its shape, and builds it
 * into a failure.
 *
 * The amendment is why this one goes through the interface: the retry has to
 * publish the shape the user chose rather than the one that was proposed. A
 * journey that needs only a stopped build makes it through the API instead,
 * in `buildBothUntilTheApiStops`.
 */
async function buildUntilItFails(page: Page): Promise<void> {
  await openCreate(page)
  await askArchitect(page, 'I need a team that takes an intake note and checks it.')
  await expect(page.getByText(BRIEF_CONFIRMED)).toBeVisible({ timeout: 60_000 })
  await askArchitect(page, 'build it')

  const card = page.getByLabel(`Team ${TEAM_ID}`)
  await expect(card).toBeVisible({ timeout: 60_000 })
  const shapeBlock = card.getByRole('region', { name: 'How they work together' })
  await expect(shapeBlock).toContainText('Each builds on the last')
  await shapeBlock.getByRole('tab', { name: 'Group discussion' }).click()
  await expect(shapeBlock).toContainText('They take turns discussing it')

  await page.getByRole('button', { name: /^Create$/ }).click()
  await expect(card.locator('[data-slot="card-action"]')).toContainText(
    /failed|cancelled/i,
    { timeout: 120_000 },
  )
}

/**
 * A store whose API stops at the moment a build would record how it ended.
 *
 * The route answers as soon as a build starts and the build then runs on its
 * own, so the write that ends it is what there is to wait for. Waiting on that
 * rather than on a length of time is what keeps this from passing because a
 * timer was generous. That ending is handed to the waiter and never reaches
 * disk: the job file still says `running` beside its Team shell, which is what
 * an API that stopped mid-build leaves behind. The next launch's restart
 * reconciliation, not this fixture, decides what that record becomes.
 */
class StoppingStore extends ResourceArchitectStore {
  private readonly settled = new Map<string, ResourceBuildJobSnapshot>()
  private readonly waiting = new Map<string, (job: ResourceBuildJobSnapshot) => void>()

  override async saveJob(job: ResourceBuildJobSnapshot): Promise<void> {
    if (job.status === 'running') {
      await super.saveJob(job)
      return
    }
    const record = structuredClone(job)
    this.settled.set(record.jobId, record)
    const waiting = this.waiting.get(record.jobId)
    if (waiting) {
      this.waiting.delete(record.jobId)
      waiting(record)
    }
  }

  /** Resolves with the ending this build tried to record. */
  settledJob(jobId: string): Promise<ResourceBuildJobSnapshot> {
    const already = this.settled.get(jobId)
    if (already) return Promise.resolve(already)
    return new Promise<ResourceBuildJobSnapshot>((resolve) => {
      this.waiting.set(jobId, resolve)
    })
  }
}

/**
 * The two stopped builds the discard journey starts from, left as an API that
 * stopped mid-build leaves them.
 *
 * They are its precondition, not its subject: that journey is about what a
 * reopened application does with builds that stopped. So they are made the way
 * the product makes them, over the very workspace and project root the
 * application is about to open: the real route, the real registry, the real
 * store and the real team writer. Driving the interface to make them instead
 * cost an entire extra desktop launch to stage. What is seeded is the input a
 * conversation would have produced: the two plans. Everything the next launch
 * recovers from — the admission, the job record, the Team shell on disk — is
 * written by the product, not here.
 *
 * The expense build goes first and is then left alone. It is still unfinished
 * when the newer build is discarded, so its absence afterwards shows that a
 * newer discard closes restoration rather than exposing an older build.
 */
async function buildBothUntilTheApiStops(paths: Paths): Promise<void> {
  // What desktop boot does the first time it opens a project root. A build
  // loads the Architect's own team config before it admits anything, so
  // without this the route would refuse before ever reaching the roster.
  await seedDesktopProjectRoot({
    appRootPath: repoRoot,
    projectRootPath: paths.projectRoot,
  })
  const store = new StoppingStore(paths.workspacePath)
  const registry = new CreateJobRegistry({ workspacePath: paths.workspacePath })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void handleResourceArchitectRoutes({
      req,
      res,
      url,
      options: {
        repoRootPath: paths.projectRoot,
        resourceArchitectStore: store,
        createJobRegistry: registry,
        isAbortLike: () => false,
      },
    }).then(
      (handled) => {
        if (!handled && !res.writableEnded) res.writeHead(404).end()
      },
      (error: unknown) => {
        if (res.writableEnded) return
        // Answered the way the real server answers, so a refusal the product
        // states as a conflict does not read here as a crash.
        const status = error instanceof ServiceError
          ? statusCodeForServiceError(error)
          : 500
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error) }))
      },
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('The fixture API server never took a port.')
  }
  const origin = `http://127.0.0.1:${address.port}`

  try {
    // In this order: the second build is the newer one, and the newer one is
    // what a reopened Create offers to finish or to throw away.
    for (const teamId of [OTHER_TEAM_ID, TEAM_ID]) {
      const plan = teamPlan(teamId)
      await store.savePlan(plan)
      // The revision this build must be admitted against, from the server that
      // computes it rather than from a digest written here.
      const shape = await fetch(
        `${origin}/create/resource-architect/plans/${plan.id}/shape`,
        { signal: AbortSignal.timeout(30_000) },
      )
      const shapeBody = await shape.text()
      expect(shape.status, `reading the ${teamId} plan: ${shapeBody}`).toBe(200)
      const { revision } = JSON.parse(shapeBody) as { revision: string }

      const jobId = `build-${teamId}`
      const settled = store.settledJob(jobId)
      const started = await fetch(`${origin}/create/resource-architect/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // This API-only setup has no desktop boot to hydrate its app default.
        // Both plans reuse Agents, so no provider call is needed to reach the
        // intended missing-member failure.
        body: JSON.stringify({
          planId: plan.id,
          jobId,
          expectedRevision: revision,
          provider: FIXTURE_PROVIDER,
          model: APP_DEFAULT_MODEL.id,
        }),
        signal: AbortSignal.timeout(30_000),
      })
      const startedBody = await started.text()
      expect(started.status, `starting the ${teamId} build: ${startedBody}`).toBe(202)
      await withDeadline(
        settled.then(() => undefined),
        120_000,
        async () => `the ${teamId} build never stopped`,
      )
      const job = await settled
      // It stopped where this journey needs it: a member the plan reuses is not
      // there, so the build gives up after its Team shell exists. The API stops
      // before that ending is written, so a reopened application finds the
      // shell and a job that still says it is running.
      expect(job.status, JSON.stringify(job)).toBe('failed')
      expect(job.error ?? '').toContain(LATE_ARRIVAL)
    }
  } finally {
    registry.close()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
  }
}

async function teamYaml(paths: Paths): Promise<string> {
  return fs.readFile(path.join(paths.projectRoot, 'teams', TEAM_ID, 'team.yaml'), 'utf8')
}

async function teamDirectoryExists(paths: Paths): Promise<boolean> {
  try {
    await fs.stat(path.join(paths.projectRoot, 'teams', TEAM_ID))
    return true
  } catch {
    return false
  }
}

/** The new Agent the interrupted build is authoring when it is killed. */
const AUTHORED = 'note-checker'

/** A persona in the shape the generator writes, reused from the creation journey. */
function persona(name: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${name} description.`,
    'tier: specialist',
    '---',
    '',
    `# ${name}`,
    '',
    `You are ${name}`,
    '',
  ].join('\n')
}

/**
 * The generator's reply for one planned Agent.
 *
 * A skill is required, not optional: an Agent authored without one and with
 * none chosen from the library is refused, and the build then spends its turn
 * on a repair request instead of finishing.
 */
function generatedAgentJson(name: string): string {
  return JSON.stringify({
    message: `Created ${name}.`,
    suggestedName: name,
    personaMarkdown: persona(name),
    generatedSkills: [{
      name: `${name}-review`,
      body: `---\nname: ${name}-review\ndescription: Review a draft against the method. Use when a draft needs a structured review pass.\n---\n\n# Review\n`,
    }],
  })
}

/** A proposal that has to author an Agent, so the build takes long enough to stop. */
function authoringProposalJson(): string {
  return JSON.stringify({
    message: 'Here is a team for that.',
    warnings: [],
    outcome: {
      id: 'proposal-authoring',
      kind: 'team',
      team: {
        teamId: TEAM_ID,
        description: 'Takes an intake note and has it checked.',
        tags: [],
        existingAgents: [{ name: LEAD, role: 'Lead', rationale: 'Already available.' }],
        newAgents: [{
          name: AUTHORED,
          role: 'Checker',
          summary: 'Checks an intake note before it moves on.',
          description: 'Checks an intake note.',
          rationale: 'Nothing available covers checking.',
          documentSpecialization: null,
        }],
        documentDomains: null,
        questionsResolved: [],
        shape: {
          kind: 'chain',
          rationale: 'One after another seemed simplest.',
          depth: 'quick',
          order: [LEAD, AUTHORED],
        },
      },
    },
  })
}

/** Whether this request is the generator authoring the planned Agent. */
function isAuthoringRequest(request: { body: Record<string, unknown> }): boolean {
  return new RegExp(`Planned Agent name:\\s*\`${AUTHORED}\``, 'iu').test(
    allUserText(request),
  ) ||
    new RegExp(`Create the missing agent\\s+\`${AUTHORED}\``, 'iu').test(
      allUserText(request),
    )
}

test('a build killed while it was still working is recovered and retried to publication', async ({}, testInfo) => {
  test.setTimeout(300_000)
  const paths = await seedProject((name) => testInfo.outputPath(name))

  // The first authoring reply is held. Nothing releases it before the process
  // is killed, so the build is genuinely still working when it dies.
  let releaseAuthoring = (): void => {}
  const authoringHeld = new Promise<void>((resolve) => {
    releaseAuthoring = resolve
  })
  // Resolved by the matcher itself, so the kill below happens while the build
  // is demonstrably inside the authoring call rather than merely past the shell.
  let noteAuthoringStarted = (): void => {}
  const authoringStarted = new Promise<void>((resolve) => {
    noteAuthoringStarted = resolve
  })
  const claims = claimedScript([
    ...architectTurns(authoringProposalJson()),
    // Held: this is the request in flight when the desktop process dies.
    {
      name: 'held authoring',
      turn: {
        match: (request) => {
          if (!isAuthoringRequest(request)) return false
          noteAuthoringStarted()
          return true
        },
        gate: authoringHeld,
        content: generatedAgentJson(AUTHORED),
      },
    },
    // The retry's own authoring request, answered at once.
    {
      name: 'retry authoring',
      turn: {
        match: (request) => isAuthoringRequest(request),
        content: generatedAgentJson(AUTHORED),
      },
    },
  ])
  const provider = await startFakeChatCompletionsServer({ script: claims.script })
  await seedProviderSettings({
    userDataPath: paths.userDataPath,
    baseUrl: provider.url,
    defaultModel: APP_DEFAULT_MODEL,
  })

  let first: ElectronApplication | undefined
  try {
    first = await launch(paths, provider.url)
    const page = await first.firstWindow()
    await openCreate(page)
    await useFixtureArchitectModel(page)
    await askArchitect(page, 'I need a team that takes an intake note and checks it.')
    await expect(page.getByText(BRIEF_CONFIRMED)).toBeVisible({
      timeout: 60_000,
    })
    await askArchitect(page, 'build it')

    const card = page.getByLabel(`Team ${TEAM_ID}`)
    await expect(card).toBeVisible({ timeout: 60_000 })
    const shapeBlock = card.getByRole('region', { name: 'How they work together' })
    await expect(shapeBlock).toContainText('Each builds on the last')
    await shapeBlock.getByRole('tab', { name: 'Group discussion' }).click()
    await expect(shapeBlock).toContainText('They take turns discussing it')

    await page.getByRole('button', { name: /^Create$/ }).click()
    // The shell is on disk and the build is inside the authoring call, whose
    // answer is still held. Both are waited for, because either alone would let
    // the kill land somewhere other than the middle of the work.
    await expect
      .poll(() => teamDirectoryExists(paths), { timeout: 120_000 })
      .toBe(true)
    const apiBaseUrl = await desktopApiBaseUrl(page)
    // Bounded, so a build that ends instead of reaching the provider reports
    // why rather than holding this test until its whole timeout runs out. The
    // jobs are read once, for that report, and nothing keeps polling the app
    // after the wait is over.
    await withDeadline(
      authoringStarted,
      120_000,
      async () => `the build never reached the provider; jobs: ${await jobStatuses(apiBaseUrl)}`,
    )

    // And the receipt says the build is running, which is the state recovery
    // has to deal with. Read from the app's own API, not inferred.
    await expect
      .poll(async () => {
        const response = await fetch(
          `${apiBaseUrl}/create/resource-architect/jobs`,
          { signal: AbortSignal.timeout(15_000) },
        )
        if (!response.ok) return 'unreadable'
        const body = (await response.json()) as { jobs: { status: string }[] }
        return body.jobs.at(-1)?.status ?? 'none'
      }, { timeout: 60_000 })
      .toBe('running')

    // Killed, not stopped. Nothing rewrites the job: it is left saying running.
    const desktopProcess = first.process()
    const desktopExit = once(desktopProcess, 'exit')
    desktopProcess.kill('SIGKILL')
    await desktopExit
    first = undefined
    releaseAuthoring()

    const second = await launch(paths, provider.url)
    try {
      const reopened = await second.firstWindow()
      await openCreate(reopened)
      // The retry authors the same Agent, so it needs the same routing.
      await useFixtureArchitectModel(reopened)
      const restored = reopened.getByLabel(`Team ${TEAM_ID}`)
      await expect(restored).toBeVisible({ timeout: 120_000 })
      // Reconciled from running to interrupted, which the user can retry.
      await expect(restored.locator('[data-slot="card-action"]')).toContainText(
        /interrupted/i,
        { timeout: 60_000 },
      )
      await restored.getByRole('button', { name: 'Retry' }).click()
      await expect(restored.locator('[data-slot="card-action"]')).toContainText(
        /created|reused/i,
        { timeout: 180_000 },
      )
    } finally {
      await second.close()
    }

    const published = await teamYaml(paths)
    expect(published).not.toContain('building: true')
    expect(published).toContain('published_by:')
    expect(published).toContain('type: discussion')
    expect(published).toContain(`- name: "${AUTHORED}"`)
    // Both instances together sent exactly the scripted requests, once each,
    // besides the app's own health probes, and both conversation turns went
    // through independent review on the way.
    expect(claims.unanswered(provider.requests)).toEqual([])
    expect(claims.unused()).toEqual([])
    expect(provider.requests.filter(isReviewRequest)).toHaveLength(2)
  } finally {
    releaseAuthoring()
    // The kill is what normally ends the first instance. If an assertion got
    // there first, this test still owns that process and must not leave it.
    if (first) await first.close().catch(() => undefined)
    await provider.close()
  }
})

test('a build that failed is retried from its card, before leaving Create, through to a usable team', async ({}, testInfo) => {
  test.setTimeout(300_000)
  const paths = await seedProject((name) => testInfo.outputPath(name))
  const claims = claimedScript(architectTurns(proposalJson(TEAM_ID)))
  const provider = await startFakeChatCompletionsServer({ script: claims.script })
  await seedProviderSettings({
    userDataPath: paths.userDataPath,
    baseUrl: provider.url,
    defaultModel: APP_DEFAULT_MODEL,
  })

  try {
    const app = await launch(paths, provider.url)
    try {
      const page = await app.firstWindow()
      await buildUntilItFails(page)

      // The shell survives, unpublished, exactly as a failed build leaves it.
      expect(await teamDirectoryExists(paths)).toBe(true)
      expect(await teamYaml(paths)).toContain('building: true')

      // The reason it failed, removed while the failed card is still on the
      // screen where it failed. A failure is not carried to the next Create,
      // so this is where it is retried.
      await writeAgentPersona(paths.projectRoot, {
        name: LATE_ARRIVAL,
        description: `${LATE_ARRIVAL} persona.`,
        marker: `You are ${LATE_ARRIVAL}`,
      })

      const card = page.getByLabel(`Team ${TEAM_ID}`)
      // Its shape is settled: this plan has been built from already.
      await expect(card).toContainText(/that build did not finish/i)
      await expect(card.getByRole('tablist', { name: 'How they work together' })).toHaveCount(0)
      // And an unfinished shell is not something to open.
      await expect(card.getByRole('button', { name: /^Open / })).toHaveCount(0)

      await card.getByRole('button', { name: 'Retry' }).click()
      await expect(card.locator('[data-slot="card-action"]')).toContainText(
        /created|reused/i,
        { timeout: 180_000 },
      )
    } finally {
      await app.close()
    }

    // Published, and as the amended shape rather than the proposed chain.
    const published = await teamYaml(paths)
    expect(published).not.toContain('building: true')
    expect(published).toContain('published_by:')
    expect(published).toContain('type: discussion')
    expect(published).toContain(`- name: "${LATE_ARRIVAL}"`)
    // The build and its retry sent exactly the scripted requests, once each,
    // besides the app's own health probes, and both conversation turns went
    // through independent review on the way.
    expect(claims.unanswered(provider.requests)).toEqual([])
    expect(claims.unused()).toEqual([])
    expect(provider.requests.filter(isReviewRequest)).toHaveLength(2)
  } finally {
    await provider.close()
  }
})

test('a build that stopped can be thrown away instead, and its team is gone', async ({}, testInfo) => {
  test.setTimeout(300_000)
  const paths = await seedProject((name) => testInfo.outputPath(name))
  // No conversation is held here: both builds are made through the API before
  // the application starts. The server exists so the running application has a
  // provider that is not a real one.
  const provider = await startFakeChatCompletionsServer({ script: [] })
  await seedProviderSettings({
    userDataPath: paths.userDataPath,
    baseUrl: provider.url,
    defaultModel: APP_DEFAULT_MODEL,
  })

  try {
    // Two builds the API stopped mid-work, one of them left alone. This is
    // where the journey begins, and the application has not run yet.
    await buildBothUntilTheApiStops(paths)
    expect(await teamDirectoryExists(paths)).toBe(true)

    const discarding = await launch(paths, provider.url)
    try {
      const page = await discarding.firstWindow()
      await openCreate(page)
      const card = page.getByLabel(`Team ${TEAM_ID}`)
      await expect(card).toBeVisible({ timeout: 120_000 })
      // Reopening reconciled the newer build as interrupted: unfinished work.
      await expect(card.locator('[data-slot="card-action"]')).toContainText(/interrupted/i)

      await card.getByRole('button', { name: 'Discard' }).click()
      // Both controls go: there is nothing left to throw away, and nothing
      // left to finish. The server refuses either, so offering one would be a
      // button that does nothing.
      await expect(card.getByRole('button', { name: 'Discard' })).toHaveCount(0, {
        timeout: 60_000,
      })
      await expect(card.getByRole('button', { name: 'Retry' })).toHaveCount(0)
    } finally {
      await discarding.close()
    }

    // The directory and the registry entry both go.
    expect(await teamDirectoryExists(paths)).toBe(false)
    const registry = await fs.readFile(path.join(paths.projectRoot, 'teams.yaml'), 'utf8')
    expect(registry).not.toContain(TEAM_ID)
    // The Agent the plan reused is not the build's to remove.
    await expect(
      fs.stat(path.join(paths.projectRoot, 'agents', LEAD)),
    ).resolves.toBeTruthy()

    // Opening Create again brings back neither build. The discarded one is the
    // newest, so it closes restoration for the older interrupted one behind it
    // too. The composer accepts input only once restoration has run, which is
    // what makes both absences an answer rather than a race.
    const reopened = await launch(paths, provider.url)
    try {
      const page = await reopened.firstWindow()
      await openCreate(page)
      await expect(page.getByPlaceholder('Describe the Agents or Team you need…')).toBeEnabled({
        timeout: 120_000,
      })
      await expect(page.getByLabel(`Team ${TEAM_ID}`)).toHaveCount(0)
      await expect(page.getByLabel(`Team ${OTHER_TEAM_ID}`)).toHaveCount(0)
    } finally {
      await reopened.close()
    }
    expect(await teamDirectoryExists(paths)).toBe(false)
  } finally {
    await provider.close()
  }
})
