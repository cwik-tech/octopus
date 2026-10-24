import { _electron as electron, expect, test, type Page, type TestInfo } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { z } from 'zod/v4'

import { isProviderHealthProbe, startFakeChatCompletionsServer, type FakeChatCompletionsRequest, type FakeChatCompletionsTurn, type FakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { ANALYST_MODEL, APP_DEFAULT_MODEL, EDITOR_MODEL, FIXTURE_PROVIDER, desktopEnvironment, repoRoot, seedProviderSettings } from './support/model-selection-fixture.js'
import { resourceArchitectFeedbackDiagnosticsSchema } from '../../contracts/schemas/resource-architect-review.js'

const REVIEWER_ID = 'reviewer-of-agent-architect'
const PRIVATE_DRAFT = 'PRIVATE CANDIDATE: contract-author and contract-checker.'
const PRIVATE_CRITIQUE = 'PRIVATE REVIEW: the Skills table is missing.'
const DRAFT = `${PRIVATE_DRAFT}\n[[proposal-requested]]`
const REVIEW = JSON.stringify({ verdict: 'revise', findings: [{
  severity: 'high', location: 'Missing Skills section', issue: PRIVATE_CRITIQUE,
  requestedChange: 'Include contract-analysis for both Agents, marked shared.',
}] })
const FINAL = [
  'Reviewed recommendation for the contract Team.',
  '',
  '| Agent | Purpose |',
  '| --- | --- |',
  '| contract-author | Draft contracts |',
  '| contract-checker | Check contracts |',
  '',
  '## Skills',
  '',
  '| Skill | Purpose | Agents | Sharing |',
  '| --- | --- | --- | --- |',
  '| contract-analysis | Planned creation: identify contract terms | contract-author, contract-checker | shared |',
].join('\n')
const TURN_PATH = '/create/resource-architect/turn'
const postedTurnSchema = z.object({
  jobId: z.string().min(1), operation: z.literal('conversation'),
  provider: z.literal(FIXTURE_PROVIDER), model: z.literal(APP_DEFAULT_MODEL.id),
  composerSelection: z.object({ provider: z.literal(FIXTURE_PROVIDER), model: z.literal(APP_DEFAULT_MODEL.id), origin: z.literal('default') }),
})
const completedTurnSchema = z.object({
  message: z.string(), warnings: z.array(z.string()), proposalRequested: z.boolean().optional(),
  meta: z.object({ review: resourceArchitectFeedbackDiagnosticsSchema }),
})

function deferred() {
  let complete: (() => void) | undefined
  const promise = new Promise<void>((resolve) => { complete = resolve })
  return { promise, resolve: () => { if (!complete) throw new Error('Gate is not initialized'); complete() } }
}

async function reached(event: Promise<void>, description: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([event, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} never reached the provider`)), 10_000)
    })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isArchitect(request: FakeChatCompletionsRequest): boolean {
  return request.systemPrompt?.includes('You are the Agent Architect') ?? false
}
/**
 * The requests the Architect's draft, review and final phases sent, in order.
 *
 * The app's own health probes are not feedback phases, so they are left out;
 * `isProviderHealthProbe` matches that exact shape and nothing else, so an
 * extra Architect or reviewer request still fails the counts below.
 */
function phaseRequests(provider: FakeChatCompletionsServer): FakeChatCompletionsRequest[] {
  return provider.requests.filter((request) => !isProviderHealthProbe(request))
}
function isReviewer(request: FakeChatCompletionsRequest): boolean {
  // An Architect request can quote the reviewer's persona too: when the
  // reviewer Agent is open in the inspector, its saved package rides along.
  return !isArchitect(request) && (request.systemPrompt?.includes('# Reviewer of Agent Architect') ?? false)
}

async function openCreate(page: Page): Promise<void> {
  await expect(page.getByRole('tab', { name: 'Run', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('tab', { name: 'Create', exact: true }).click()
  await page.getByLabel('Resource type').getByRole('tab', { name: 'Agents', exact: true }).click()
  await expect(page.getByLabel('Agent Architect model')).toContainText(APP_DEFAULT_MODEL.name)
}

async function submit(page: Page, text = 'Recommend a contract drafting and checking Team.'): Promise<void> {
  await page.getByPlaceholder('Describe the Agents or Team you need…').fill(text)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
}

function observeTurn(page: Page) {
  return {
    request: page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith(TURN_PATH)),
    response: page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(TURN_PATH)),
  }
}

test('Create recovers a saved reply after its response is lost without generating again', async ({}, testInfo) => {
  const provider = await startFakeChatCompletionsServer({ script: [
    { content: DRAFT, match: isArchitect }, { content: REVIEW, match: isReviewer },
    { content: FINAL, match: isArchitect }, { failStatus: 500 },
  ] })
  const fixture = await launchFixture(testInfo, provider)
  try {
    // Drop delivery at the HTTP boundary after the real API has persisted it.
    // Disable the optional preview so only durable recovery can show the reply.
    let submittedTurns = 0
    await fixture.page.route('**/create/resource-architect/turn?*', (route) => route.fulfill({ status: 404 }))
    await fixture.page.route('**/create/resource-architect/turn', async (route) => {
      submittedTurns += 1
      const response = await route.fetch({ timeout: 15_000, maxRetries: 0 })
      expect(response.ok()).toBe(true)
      await route.abort('failed')
    })
    await submit(fixture.page)
    const chat = fixture.page.getByRole('region', { name: 'Agent Architect chat' })
    await expect(chat.getByText('Reviewed recommendation for the contract Team.', { exact: true })).toHaveCount(1)
    await expect(chat).not.toContainText('Failed to fetch')
    await expect(chat.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled()
    expect(submittedTurns).toBe(1)
    await fixture.page.screenshot({ path: testInfo.outputPath('recovered-reply.png') })
  } finally {
    await fixture.app.close()
    await provider.close()
  }
})

test('Create checks again after recovery is unavailable without resubmitting the request', async ({}, testInfo) => {
  const provider = await startFakeChatCompletionsServer({ script: [
    { content: DRAFT, match: isArchitect }, { content: REVIEW, match: isReviewer },
    { content: FINAL, match: isArchitect }, { failStatus: 500 },
  ] })
  const fixture = await launchFixture(testInfo, provider)
  try {
    await expect(fixture.page.getByPlaceholder('Describe the Agents or Team you need…')).toBeEnabled()
    let submittedTurns = 0
    await fixture.page.route('**/create/resource-architect/turn?*', (route) => route.fulfill({ status: 404 }))
    await fixture.page.route('**/create/resource-architect/turn', async (route) => {
      submittedTurns += 1
      expect((await route.fetch({ timeout: 15_000, maxRetries: 0 })).ok()).toBe(true)
      await route.abort('failed')
    })
    const conversationRoute = '**/create/resource-architect/conversation'
    await fixture.page.route(conversationRoute, (route) => route.abort('failed'))
    await submit(fixture.page)
    await expect(fixture.page.getByText("We couldn't check your request. Your message is still here.", { exact: true })).toBeVisible()
    const check = fixture.page.getByRole('button', { name: 'Check again', exact: true })
    await expect(check).toBeEnabled()
    await fixture.page.screenshot({ path: testInfo.outputPath('connection-unavailable.png') })
    await expect(fixture.page.getByPlaceholder('Describe the Agents or Team you need…')).toBeInViewport({ ratio: 1 })
    await fixture.page.unroute(conversationRoute)
    await check.click()
    const chat = fixture.page.getByRole('region', { name: 'Agent Architect chat' })
    await expect(chat.getByText('Reviewed recommendation for the contract Team.', { exact: true })).toHaveCount(1)
    await expect(check).toHaveCount(0)
    expect(submittedTurns).toBe(1)
    await fixture.page.screenshot({ path: testInfo.outputPath('checked-again.png') })
  } finally {
    await fixture.app.close()
    await provider.close()
  }
})

test('Create reconnects to a running request after losing its response', async ({}, testInfo) => {
  const admitted = deferred()
  const release = deferred()
  const forwarded = deferred()
  const provider = await startFakeChatCompletionsServer({ script: [
    { content: DRAFT, gate: release.promise, deltaGates: [release.promise], match: (request) => {
      if (!isArchitect(request)) return false
      admitted.resolve()
      return true
    } },
    { content: REVIEW, match: isReviewer }, { content: FINAL, match: isArchitect }, { failStatus: 500 },
  ] })
  const fixture = await launchFixture(testInfo, provider)
  try {
    let dropped = false
    let submittedTurns = 0
    await fixture.page.route('**/create/resource-architect/turn?*', (route) => dropped ? route.continue() : route.fulfill({ status: 404 }))
    await fixture.page.route('**/create/resource-architect/turn', async (route) => {
      submittedTurns += 1
      const response = route.fetch({ timeout: 15_000, maxRetries: 0 })
      await admitted.promise
      dropped = true
      await route.abort('failed')
      expect((await response).ok()).toBe(true)
      forwarded.resolve()
    })
    await submit(fixture.page)
    await expect(fixture.page.getByRole('status', { name: 'Agent Architect connection' })).toContainText('Your request is still running.')
    await fixture.page.screenshot({ path: testInfo.outputPath('reconnecting-request.png') })
    await expect(fixture.page.getByRole('button', { name: 'Stop generation', exact: true })).toBeInViewport({ ratio: 1 })
    release.resolve()
    await reached(forwarded.promise, 'Forwarded authoring request')
    const chat = fixture.page.getByRole('region', { name: 'Agent Architect chat' })
    await expect(chat.getByText('Reviewed recommendation for the contract Team.', { exact: true })).toHaveCount(1)
    await expect(chat.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled()
    await expect(fixture.page.getByRole('status', { name: 'Agent Architect connection' })).toHaveCount(0)
    expect(submittedTurns).toBe(1)
    await fixture.page.screenshot({ path: testInfo.outputPath('reconnected-running-reply.png') })
  } finally {
    release.resolve()
    await fixture.app.close()
    await provider.close()
  }
})

async function launchFixture(testInfo: TestInfo, provider: FakeChatCompletionsServer, reviewEnabled = true) {
  const workspacePath = testInfo.outputPath('workspace')
  const userDataPath = testInfo.outputPath('user-data')
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
  const projectRoot = executablePath ? path.join(userDataPath, 'project') : testInfo.outputPath('project')
  await fs.mkdir(workspacePath, { recursive: true })
  await seedProviderSettings({ userDataPath, baseUrl: provider.url, defaultModel: APP_DEFAULT_MODEL })
  const environment = desktopEnvironment({ projectRoot, userDataPath, workspacePath })
  environment.PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED = String(reviewEnabled)
  // A packaged run must resolve and seed its own bundled assets and editable root.
  if (executablePath) {
    delete environment.PIPELINE_DESKTOP_REPO_ROOT
    delete environment.PIPELINE_DESKTOP_PROJECT_ROOT
  }
  const app = await electron.launch({
    args: executablePath ? [] : ['.'], cwd: repoRoot, env: environment,
    ...(executablePath ? { executablePath: path.resolve(repoRoot, executablePath) } : {}),
  }).catch(async (error: unknown) => { await provider.close(); throw error })
  try {
    const page = await app.firstWindow()
    await openCreate(page)
    expect(await app.evaluate(({ app: desktop }) => desktop.isPackaged)).toBe(Boolean(executablePath))
    const reviewerPath = path.join(projectRoot, 'agents', REVIEWER_ID, `${REVIEWER_ID}.md`)
    const shippedReviewer = await fs.readFile(reviewerPath, 'utf8')
    expect(shippedReviewer).toContain('# Reviewer of Agent Architect')
    // Deliberately different from both the visible composer and reviewer.
    const architectPath = path.join(projectRoot, 'agents/resource-architect/resource-architect.md')
    const architect = await fs.readFile(architectPath, 'utf8')
    await fs.writeFile(architectPath, `---\nprovider: ${FIXTURE_PROVIDER}\nmodel: ${EDITOR_MODEL.id}\nthinking: low\n---\n${architect}`)
    await fs.writeFile(reviewerPath, shippedReviewer.replace('system: true\n', `system: true\nprovider: ${FIXTURE_PROVIDER}\nmodel: ${ANALYST_MODEL.id}\n`))
    return { app, page, projectRoot, workspacePath, reviewerPath }
  } catch (error) {
    await app.close()
    await provider.close()
    throw error
  }
}

// Paid, nondeterministic models are replaced only at their HTTP endpoints.
// Electron, the loopback authoring API, editable files, and durable stores are real.
test('Create privately reviews a draft and shows one final Skills table using the visible prefill', async ({}, testInfo) => {
  const reviewing = deferred()
  const releaseReview = deferred()
  const provider = await startFakeChatCompletionsServer({ script: [
    { content: DRAFT, match: isArchitect },
    { content: REVIEW, gate: releaseReview.promise, deltaGates: [releaseReview.promise], match: (request) => {
      if (!isReviewer(request)) return false
      reviewing.resolve()
      return true
    } },
    { content: FINAL, match: isArchitect },
    { failStatus: 500 },
  ] })
  const fixture = await launchFixture(testInfo, provider)
  try {
    const turn = observeTurn(fixture.page)
    await submit(fixture.page)
    const request = await turn.request
    const requestBody: unknown = request.postDataJSON()
    const submitted = postedTurnSchema.parse(requestBody)
    await reached(reviewing.promise, 'Independent review')
    const chat = fixture.page.getByRole('region', { name: 'Agent Architect chat' })
    await expect(chat).not.toContainText(PRIVATE_DRAFT)
    await expect(chat).not.toContainText(PRIVATE_CRITIQUE)
    await expect(chat.getByRole('button', { name: 'Stop generation', exact: true })).toBeEnabled()
    releaseReview.resolve()

    const response = await turn.response
    expect(response.status()).toBe(200)
    const payload = completedTurnSchema.parse(await response.json())
    expect(payload.message).toBe(FINAL)
    expect(payload.proposalRequested).toBeUndefined()
    expect(payload.meta.review.reviewStatus).toBe('completed')
    expect(phaseRequests(provider).map((entry) => entry.model)).toEqual([APP_DEFAULT_MODEL.id, ANALYST_MODEL.id, APP_DEFAULT_MODEL.id])
    expect(JSON.stringify(phaseRequests(provider)[2]?.body)).toContain(PRIVATE_CRITIQUE)
    await expect(chat.getByText('Reviewed recommendation for the contract Team.', { exact: true })).toHaveCount(1)
    await expect(chat.getByRole('columnheader', { name: 'Sharing', exact: true })).toBeVisible()
    await expect(chat.getByRole('row', { name: 'contract-analysis Planned creation: identify contract terms contract-author, contract-checker shared' })).toBeVisible()
    await expect(chat.locator('.is-assistant')).toHaveCount(1)
    await expect(chat).not.toContainText(PRIVATE_DRAFT)
    await expect(chat).not.toContainText(PRIVATE_CRITIQUE)
    await expect(chat).not.toContainText('[[proposal-requested]]')
    const roster = await chat.getByRole('table').nth(0).boundingBox()
    const skills = await chat.getByRole('table').nth(1).boundingBox()
    expect(roster).not.toBeNull()
    expect(skills).not.toBeNull()
    expect(skills?.y).toBeGreaterThan(roster?.y ?? Number.POSITIVE_INFINITY)
    await fixture.page.screenshot({ path: testInfo.outputPath('reviewed-skills.png') })
    const metrics = await fs.readFile(path.join(fixture.workspacePath, 'resource-architect-telemetry/turns.json'), 'utf8')
    expect(metrics).toContain(submitted.jobId)
    expect(metrics).not.toContain(PRIVATE_DRAFT)
    expect(metrics).not.toContain(PRIVATE_CRITIQUE)
  } finally {
    releaseReview.resolve()
    await fixture.app.close()
    await provider.close()
  }
})

test('review failure discloses the draft, suppresses its proposal, and retains the notice after reload', async ({}, testInfo) => {
  const provider = await startFakeChatCompletionsServer({ script: [
    { content: DRAFT, match: isArchitect },
    { content: 'invalid reviewer result', match: isReviewer },
    { failStatus: 500 },
  ] })
  const fixture = await launchFixture(testInfo, provider)
  try {
    const turn = observeTurn(fixture.page)
    await submit(fixture.page)
    const payload = completedTurnSchema.parse(await (await turn.response).json())
    const requestBody: unknown = (await turn.request).postDataJSON()
    const submitted = postedTurnSchema.parse(requestBody)
    expect(payload.meta.review.reviewStatus).toBe('not_reviewed')
    expect(payload.proposalRequested).toBeUndefined()
    expect(phaseRequests(provider)).toHaveLength(2)
    const chat = fixture.page.getByRole('region', { name: 'Agent Architect chat' })
    await expect(chat).toContainText(PRIVATE_DRAFT)
    await expect(chat).toContainText('Not reviewed. Reviewer of Agent Architect could not complete review.')
    await expect(chat).not.toContainText('[[proposal-requested]]')
    await fixture.page.reload()
    await openCreate(fixture.page)
    const restored = fixture.page.getByRole('note', { name: 'Agent Architect review' })
    await expect(restored).toHaveAttribute('data-architect-job-id', submitted.jobId)
    await expect(restored).toContainText('Not reviewed. Reviewer of Agent Architect could not complete review.')
    await fixture.page.screenshot({ path: testInfo.outputPath('not-reviewed-restored.png') })
  } finally {
    await fixture.app.close()
    await provider.close()
  }
})

test('the startup switch disables review with a missing persona and restores its disclosure', async ({}, testInfo) => {
  const provider = await startFakeChatCompletionsServer({ script: [
    { content: FINAL, match: isArchitect }, { failStatus: 500 },
  ] })
  const fixture = await launchFixture(testInfo, provider, false)
  try {
    await fs.rm(fixture.reviewerPath)
    const turn = observeTurn(fixture.page)
    await submit(fixture.page)
    const payload = completedTurnSchema.parse(await (await turn.response).json())
    const requestBody: unknown = (await turn.request).postDataJSON()
    const submitted = postedTurnSchema.parse(requestBody)
    expect(phaseRequests(provider).map((entry) => entry.model)).toEqual([APP_DEFAULT_MODEL.id])
    expect(payload.meta.review.reviewStatus).toBe('disabled')
    await expect(fixture.page.getByRole('region', { name: 'Agent Architect chat' })).toContainText('Review disabled. Reviewer of Agent Architect was not used.')
    await fixture.page.reload()
    await openCreate(fixture.page)
    const restored = fixture.page.getByRole('note', { name: 'Agent Architect review' })
    await expect(restored).toHaveAttribute('data-architect-job-id', submitted.jobId)
    await expect(restored).toContainText('Review disabled. Reviewer of Agent Architect was not used.')
    await fixture.page.screenshot({ path: testInfo.outputPath('review-disabled-restored.png') })
  } finally {
    await fixture.app.close()
    await provider.close()
  }
})

for (const [phase, expectedCalls] of [['draft', 1], ['review', 2], ['final', 3]] as const) {
  test(`Stop during ${phase} prevents later feedback phases and final publication`, async ({}, testInfo) => {
    const held = deferred()
    const release = deferred()
    const gateFor = (name: string, match: (request: FakeChatCompletionsRequest) => boolean, content: string): FakeChatCompletionsTurn => ({
      content, ...(phase === name ? { gate: release.promise, deltaGates: [release.promise] } : {}),
      match: (request) => {
        if (!match(request)) return false
        if (phase === name) held.resolve()
        return true
      },
    })
    const provider = await startFakeChatCompletionsServer({ script: [
      gateFor('draft', isArchitect, DRAFT), gateFor('review', isReviewer, REVIEW), gateFor('final', isArchitect, FINAL), { failStatus: 500 },
    ] })
    const fixture = await launchFixture(testInfo, provider)
    try {
      const turn = observeTurn(fixture.page)
      await submit(fixture.page)
      await reached(held.promise, `Held ${phase}`)
      const cancelling = fixture.page.waitForResponse((response) => response.request().method() === 'POST' && /\/create\/jobs\/[^/]+\/cancel$/u.test(new URL(response.url()).pathname))
      await fixture.page.getByRole('button', { name: 'Stop generation', exact: true }).click()
      expect((await cancelling).ok()).toBe(true)
      const cancelled = z.object({ cancelled: z.literal(true) }).parse(await (await turn.response).json())
      expect(cancelled.cancelled).toBe(true)
      release.resolve()
      expect(phaseRequests(provider)).toHaveLength(expectedCalls)
      await expect(fixture.page.getByRole('region', { name: 'Agent Architect chat' })).not.toContainText('Reviewed recommendation for the contract Team.')
      await expect(fixture.page.getByRole('region', { name: 'Agent Architect chat' })).not.toContainText(PRIVATE_DRAFT)
      await expect(fixture.page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled()
    } finally {
      release.resolve()
      await fixture.app.close()
      await provider.close()
    }
  })
}

test('the reviewer remains editable and the next Create turn reads its saved persona', async ({}, testInfo) => {
  const provider = await startFakeChatCompletionsServer({ script: [
    { content: DRAFT, match: isArchitect }, { content: REVIEW, match: isReviewer }, { content: FINAL, match: isArchitect }, { failStatus: 500 },
  ] })
  const fixture = await launchFixture(testInfo, provider)
  try {
    await fixture.page.getByRole('button', { name: 'Search Agents', exact: true }).click()
    await fixture.page.getByRole('searchbox', { name: 'Search Agents', exact: true }).fill('Reviewer Of Agent Architect')
    await fixture.page.getByRole('button', { name: /^Reviewer Of Agent Architect(?: —|$)/u }).click()
    const editor = fixture.page.getByRole('textbox', { name: 'Persona markdown', exact: true })
    await expect(editor).toHaveValue(/# Reviewer of Agent Architect/u)
    const saved = fixture.page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/create/agents/save'))
    await editor.fill(`${await editor.inputValue()}\nSaved reviewer instruction: check every shared skill consumer.\n`)
    await editor.press('Tab')
    expect((await saved).ok()).toBe(true)
    await fixture.page.screenshot({ path: testInfo.outputPath('editable-reviewer.png') })
    await fixture.page.getByRole('button', { name: 'Hide details', exact: true }).click()
    const turn = observeTurn(fixture.page)
    await submit(fixture.page)
    const payload = completedTurnSchema.parse(await (await turn.response).json())
    expect(payload.meta.review.reviewStatus).toBe('completed')
    const reviewerRequests = provider.requests.filter(isReviewer)
    expect(reviewerRequests).toHaveLength(1)
    expect(reviewerRequests[0]?.systemPrompt).toContain('Saved reviewer instruction: check every shared skill consumer.')
    expect(await fs.readFile(fixture.reviewerPath, 'utf8')).toContain('Saved reviewer instruction: check every shared skill consumer.')
    await fixture.page.getByRole('tab', { name: 'Run', exact: true }).click()
    await fixture.page.getByLabel('Run target type').getByRole('tab', { name: 'Agents', exact: true }).click()
    await fixture.page.getByRole('button', { name: 'Search Agents', exact: true }).click()
    await fixture.page.getByRole('searchbox', { name: 'Search Agents', exact: true }).fill('Reviewer Of Agent Architect')
    await expect(fixture.page.getByRole('button', { name: /^Reviewer Of Agent Architect(?: —|$)/u })).toHaveCount(0)
  } finally {
    await fixture.app.close()
    await provider.close()
  }
})
