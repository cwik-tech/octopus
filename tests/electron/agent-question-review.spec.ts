import { _electron as electron, expect, type TestInfo } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentQuestionViewsSchema } from '../../contracts/agent-questions.js'
import { observeQuestionTaskOutcome } from './support/agent-question-evidence.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'

import { agentQuestionDesktopTest } from './support/agent-question-desktop.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const draft = 'A flower opens in the morning light. Its petals hold the colors of a Michigan spring. The dedication celebrates a generous friend with warmth and gratitude. This complete draft preserves the requested four lines and contains enough detail for a meaningful review.'

async function setupReview(testInfo: TestInfo, requesterId: string) {
  const workspace = testInfo.outputPath('workspace')
  const project = testInfo.outputPath('project')
  const profile = testInfo.outputPath('user-data')
  await Promise.all([
    fs.mkdir(workspace, { recursive: true }), fs.mkdir(profile, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests/fixtures/team-chat-e2e'), project, { recursive: true }),
  ])
  const teamPath = path.join(project, 'teams/line-team/team.yaml')
  const team = await fs.readFile(teamPath, 'utf8')
  await fs.writeFile(teamPath, team.replace('type: chain\n      sequence:\n        - line-one\n        - line-two', 'type: review\n      producer: line-one\n      reviewer: line-two').replace('handoff_format: markdown', 'max_iterations: 1'))
  await Promise.all(['line-one', 'line-two'].map((id) => fs.writeFile(path.join(project, 'agents', id, `${id}.md`),
    `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\nYou are ${id}. Complete your role in the review; ask only for required missing information.\n`)))
  const producerRequests: string[] = []
  const reviewerRequests: string[] = []
  // Paid/nondeterministic model output is replaced at its HTTP boundary only.
  const provider = await startDeterministicOpenAiServer({ resolveTurn: (body) => {
    const isProducer = body.includes('You are line-one')
    const isReviewer = body.includes('You are line-two')
    if (!isProducer && !isReviewer) return undefined
    if (isProducer) producerRequests.push(body)
    if (isReviewer) reviewerRequests.push(body)
    if (body.includes(`You are ${requesterId}`) && !body.includes('Marta')) return {
      toolName: 'request_human_input', arguments: {
        progress: 'I need the required recipient before completing this review step.',
        questions: [{ question: 'Who is this for?', reason: 'The dedication requires a recipient.' }],
      },
    }
    return { text: isProducer ? draft : 'APPROVE\nThe dedication is suitable for Marta.' }
  } })
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: {
    ...fixtureDesktopEnvironment({ ...process.env, PATH: '/usr/bin:/bin' }), NODE_ENV: 'test', OPENAI_API_KEY: 'question-review-fixture', OPENAI_BASE_URL: provider.baseUrl,
    PI_CODING_AGENT_DIR: testInfo.outputPath('pi-state'),
    PIPELINE_DESKTOP_PROJECT_ROOT: project, PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
    PIPELINE_DESKTOP_USER_DATA: profile, PIPELINE_DESKTOP_WORKSPACE_PATH: workspace,
  } })
  return { workspace, app, provider, producerRequests, reviewerRequests }
}

for (const role of [
  { name: 'reviewer', id: 'line-two', label: 'Line Two', beforeProducer: 1, beforeReviewer: 1, afterProducer: 1, afterReviewer: 2 },
  { name: 'producer', id: 'line-one', label: 'Line One', beforeProducer: 1, beforeReviewer: 0, afterProducer: 2, afterReviewer: 1 },
] as const) {
agentQuestionDesktopTest((info) => setupReview(info, role.id))(`a review ${role.name} resumes the same final iteration after answering`, async ({ desktop }) => {
  const { workspace, app, producerRequests, reviewerRequests } = desktop
  const page = await app.firstWindow()
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page.getByRole('tab', { name: 'Teams', exact: true }).click()
  await page.getByRole('radio', { name: /^Line Team\b/ }).click()
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const questionRequest = page.waitForRequest((request) => request.url().endsWith('/agent-questions'))
  // Preserve a missing-card assertion when cleanup closes this request wait.
  void questionRequest.catch(() => undefined)
  await chat.getByRole('textbox').first().fill('Prepare and review a dedication. Ask for the required recipient before completing your assigned role.')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  const card = chat.getByRole('region', { name: `${role.label} needs your input`, exact: true })
  await expect(card).toBeVisible({ timeout: 15_000 })
  expect(producerRequests).toHaveLength(role.beforeProducer)
  expect(reviewerRequests).toHaveLength(role.beforeReviewer)
  const saved = agentQuestionViewsSchema.parse(await (await page.request.get((await questionRequest).url())).json())[0]
  if (!saved) throw new Error('The review question was not persisted.')
  const completion = observeQuestionTaskOutcome(workspace, saved, 15_000)
  await card.getByRole('textbox').fill('Marta')
  await card.getByRole('button', { name: 'Submit and continue', exact: true }).click()
  await expect(chat.getByText('The dedication is suitable for Marta.', { exact: false })).toBeVisible({ timeout: 15_000 })
  const outcome = await completion
  expect(outcome.status, outcome.error).toBe('done')
  expect(producerRequests).toHaveLength(role.afterProducer)
  expect(reviewerRequests).toHaveLength(role.afterReviewer)
  expect(reviewerRequests.at(-1)).toContain(draft)
  expect(reviewerRequests.at(-1)).toContain('Marta')
  expect(reviewerRequests.at(-1)).toContain('Iteration 1')
  await expect(card.getByRole('textbox')).toHaveCount(0)
})
}
