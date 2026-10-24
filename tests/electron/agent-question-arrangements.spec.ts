import { _electron as electron, expect as baseExpect, type TestInfo } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentQuestionDesktopTest } from './support/agent-question-desktop.js'
import { agentQuestionViewsSchema } from '../../contracts/agent-questions.js'
import { observeQuestionTaskOutcome } from './support/agent-question-evidence.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'

const expect = baseExpect.configure({ timeout: 15_000 })

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function launchArrangementApp(testInfo: TestInfo, providerBaseUrl: string) {
  return electron.launch({ args: ['.'], cwd: repoRoot, env: {
    ...fixtureDesktopEnvironment({ ...process.env, PATH: '/usr/bin:/bin' }), NODE_ENV: 'test', OPENAI_API_KEY: 'agent-question-fixture', OPENAI_BASE_URL: providerBaseUrl,
    PI_CODING_AGENT_DIR: testInfo.outputPath('pi-state'),
    PIPELINE_DESKTOP_PROJECT_ROOT: testInfo.outputPath('project'), PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
    PIPELINE_DESKTOP_USER_DATA: testInfo.outputPath('user-data'), PIPELINE_DESKTOP_WORKSPACE_PATH: testInfo.outputPath('workspace'),
  } })
}

async function prepareBroadcast(testInfo: TestInfo) {
  const workspace = testInfo.outputPath('workspace')
  const project = testInfo.outputPath('project')
  const profile = testInfo.outputPath('user-data')
  await Promise.all([
    fs.mkdir(workspace, { recursive: true }), fs.mkdir(profile, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests/fixtures/team-chat-e2e'), project, { recursive: true }),
  ])
  const teamPath = path.join(project, 'teams/line-team/team.yaml')
  const team = await fs.readFile(teamPath, 'utf8')
  await fs.writeFile(teamPath, team.replace('type: chain\n      sequence:', 'type: broadcast\n      fan_out:').replace('handoff_format: markdown', 'aggregation: merge'))
  await Promise.all(['line-one', 'line-two'].map((id) => fs.writeFile(path.join(project, 'agents', id, `${id}.md`),
    `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\nYou are ${id}. Ask for required missing information using the question tool.\n`)))
  const writerRequests: string[] = []
  const seasonRequests: string[] = []
  // Replace only the paid provider boundary. Both requests run concurrently.
  const provider = await startDeterministicOpenAiServer({ resolveTurn: (body) => {
    if (body.includes('You are line-one')) {
      writerRequests.push(body)
      return body.includes('Marta') ? { text: 'The recipient is Marta.' } : {
        toolName: 'request_human_input', arguments: { progress: 'I need the recipient.', questions: [{ question: 'Who is the recipient?', reason: 'The name is required.' }] },
      }
    }
    if (body.includes('You are line-two')) {
      seasonRequests.push(body)
      return body.includes('Autumn') ? { text: 'The requested season is Autumn.' } : {
        toolName: 'request_human_input', arguments: { progress: 'I need the season.', questions: [{ question: 'Which season?', reason: 'The season is required.' }] },
      }
    }
    return undefined
  } })
  const app = await launchArrangementApp(testInfo, provider.baseUrl)
  return { workspace, app, provider, writerRequests, seasonRequests }
}

agentQuestionDesktopTest(prepareBroadcast)('two broadcast agents ask and answering one resumes only that unfinished agent', async ({ desktop }) => {
  const { workspace, app, writerRequests, seasonRequests } = desktop
  const page = await app.firstWindow()
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page.getByRole('tab', { name: 'Teams', exact: true }).click()
  await page.getByRole('radio', { name: /^Line Team\b/ }).click()
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const savedRequest = page.waitForRequest((request) => request.url().endsWith('/agent-questions'))
  // App teardown must not replace a failed visible-card assertion.
  void savedRequest.catch(() => undefined)
  await chat.getByRole('textbox').first().fill('Determine the required recipient and season. Each specialist must ask for its own missing fact.')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  const writerCard = chat.getByRole('region', { name: 'Line One needs your input', exact: true })
  const seasonCard = chat.getByRole('region', { name: 'Line Two needs your input', exact: true })
  await expect(writerCard).toBeVisible({ timeout: 15_000 })
  await expect(seasonCard).toBeVisible({ timeout: 15_000 })
  expect(writerRequests).toHaveLength(1)
  expect(seasonRequests).toHaveLength(1)
  const questions = agentQuestionViewsSchema.parse(await (await page.request.get((await savedRequest).url())).json())
  const writer = questions.find((question) => question.agentId === 'line-one')
  if (!writer) throw new Error('The writer question is missing.')
  await writerCard.getByRole('textbox').fill('Marta')
  await writerCard.getByRole('button', { name: 'Submit and continue', exact: true }).click()
  await expect(chat.getByText('The recipient is Marta.', { exact: true })).toBeVisible()
  expect(writerRequests).toHaveLength(2)
  expect(seasonRequests, 'Answering the writer must not resume the unanswered season agent.').toHaveLength(1)
  await expect(seasonCard.getByRole('textbox')).toBeVisible()
  const completion = observeQuestionTaskOutcome(workspace, writer, 15_000)
  await seasonCard.getByRole('textbox').fill('Autumn')
  await expect(seasonCard.getByRole('button', { name: 'Submit and continue', exact: true })).toBeEnabled()
  await seasonCard.getByRole('button', { name: 'Submit and continue', exact: true }).click()
  await expect(chat.getByText('The requested season is Autumn.', { exact: true })).toBeVisible()
  const outcome = await completion
  expect(outcome.status, outcome.error).toBe('done')
  expect(writerRequests, 'The completed writer must survive the second continuation.').toHaveLength(2)
  expect(seasonRequests).toHaveLength(2)
  expect(seasonRequests[1]).toContain('Marta')
  await expect(writerCard.getByRole('textbox')).toHaveCount(0)
  await expect(seasonCard.getByRole('textbox')).toHaveCount(0)
})

async function prepareRouting(testInfo: TestInfo) {
  const workspacePath = testInfo.outputPath('workspace')
  const projectRootPath = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  const piStatePath = testInfo.outputPath('pi-state')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests/fixtures/team-chat-e2e'), projectRootPath, { recursive: true }),
  ])

  const routingTeamPath = path.join(projectRootPath, 'teams/line-team/team.yaml')
  const routingTeam = await fs.readFile(routingTeamPath, 'utf8')
  await fs.writeFile(routingTeamPath, routingTeam.replace('type: chain\n      sequence:\n        - line-one\n        - line-two', 'type: routing\n      coordinator: line-one').replace('        handoff_format: markdown\n', ''))

  // Agent selection is explicit; legacy Team tier defaults no longer select a model.
  await Promise.all(['line-one', 'line-two'].map(async (name) => {
    const file = path.join(projectRootPath, 'agents', name, `${name}.md`)
    await fs.writeFile(file, `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\nYou are ${name} in a dedication-writing team. Follow the user request and use the available question tool for required missing information.\n`)
  }))

  const writerRequests: string[] = []
  const editorRequests: string[] = []
  // Real providers are paid and nondeterministic. Only their HTTP boundary is
  // replaced; Electron, API, dispatch, queue, engines, and stores are real.
  const provider = await startDeterministicOpenAiServer({
    resolveTurn: (body) => {
      if (body.includes('You are line-two')) {
        editorRequests.push(body)
        return { text: 'Unexpected editor response.' }
      }
      if (body.includes('You are line-one')) {
        writerRequests.push(body)
        if (body.includes('Marta')) return { text: 'The decision routes a dedication for Marta to the writing team.' }
        return {
          toolName: 'request_human_input',
          arguments: {
            progress: 'I can write the dedication once I know the recipient.',
            questions: [{ question: 'Who is the dedication for?', reason: 'The requested dedication needs a recipient.' }],
          },
        }
      }
      return undefined
    },
  })
  const app = await launchArrangementApp(testInfo, provider.baseUrl)

  return { workspacePath, app, provider, writerRequests, editorRequests }
}

agentQuestionDesktopTest(prepareRouting)('a routing coordinator finishes the same decision after its human answer', async ({ desktop }) => {
  const { workspacePath, app, writerRequests, editorRequests } = desktop
  const page = await app.firstWindow()
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page.getByRole('tab', { name: 'Teams', exact: true }).click()
  await page.getByRole('radio', { name: /^Line Team\b/ }).click()
  const composer = page.getByRole('textbox').first()
  const questionsRequest = page.waitForRequest((request) => request.url().endsWith('/agent-questions'))
  // A failed visible assertion closes the app before this read is awaited.
  // Keep that cleanup rejection from replacing the original assertion failure.
  void questionsRequest.catch(() => undefined)
  await composer.fill('Write a dedication. Ask me for the required recipient name before writing it.')
  await composer.press('Enter')

  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const question = chat.getByRole('region', { name: 'Line One needs your input', exact: true })
  await expect(question).toBeVisible({ timeout: 15_000 })
  await expect(chat.getByText('I can write the dedication once I know the recipient.', { exact: true })).toBeVisible()
  expect(editorRequests, 'The editor must not run while the writer is waiting.').toEqual([])
  await chat.getByRole('button', { name: 'Go to pending question', exact: true }).click()
  await expect(question.getByRole('textbox')).toBeFocused()
  await expect(page.getByRole('complementary', { name: 'Team participants' })).toContainText('Waiting for your answer')
  const savedQuestion = agentQuestionViewsSchema.parse(await (await page.request.get((await questionsRequest).url())).json())[0]
  if (!savedQuestion) throw new Error('The visible card has no saved question.')
  const completion = observeQuestionTaskOutcome(workspacePath, savedQuestion, 15_000)
  await question.getByRole('textbox', { name: 'Who is the dedication for?', exact: true }).fill('Marta')
  await question.getByRole('button', { name: 'Submit and continue', exact: true }).click()

  await expect(chat.getByText('The decision routes a dedication for Marta to the writing team.', { exact: true })).toBeVisible()
  await expect(question.getByText('Marta', { exact: true })).toBeVisible()
  await expect(question.getByRole('textbox')).toHaveCount(0)
  expect(writerRequests.filter((body) => body.includes('Marta'))).toHaveLength(1)
  expect(editorRequests).toHaveLength(0)
  await expect(chat.getByRole('button', { name: 'Submit and continue', exact: true })).toHaveCount(0)
  const terminalTask = await completion
  expect(terminalTask.status, terminalTask.error).toBe('done')
})

async function prepareParallelPipeline(testInfo: TestInfo) {
  const workspace = testInfo.outputPath('workspace')
  const project = testInfo.outputPath('project')
  const profile = testInfo.outputPath('user-data')
  await Promise.all([
    fs.mkdir(workspace, { recursive: true }), fs.mkdir(profile, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests/fixtures/team-chat-e2e'), project, { recursive: true }),
  ])
  const teamPath = path.join(project, 'teams/line-team/team.yaml')
  const team = await fs.readFile(teamPath, 'utf8')
  const planPath = testInfo.outputPath('plan.md')
  await fs.writeFile(planPath, `# Plan: Required details

**Status:** draft

### S1: Details

#### T1: Recipient
- **Agent:** line-one
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** recipient.md

#### T2: Season
- **Agent:** line-two
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** line-result.md
`)
  await fs.writeFile(teamPath, team.replace('type: chain\n      sequence:\n        - line-one\n        - line-two', 'type: pipeline').replace('handoff_format: markdown', `plan_file: ${planPath}\n        execution_mode: bounded_parallel\n        max_concurrency: 2\n        persist_result: true`))
  await Promise.all(['line-one', 'line-two'].map((id) => fs.writeFile(path.join(project, 'agents', id, `${id}.md`),
    `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\nYou are ${id}. Ask for required missing information using the question tool.\n`)))
  const writerRequests: string[] = []
  const seasonRequests: string[] = []
  // Replace only the paid provider boundary. Both requests run concurrently.
  const provider = await startDeterministicOpenAiServer({ resolveTurn: (body) => {
    if (body.includes('You are line-one')) {
      writerRequests.push(body)
      return body.includes('Marta') ? { text: 'The recipient is Marta.' } : {
        toolName: 'request_human_input', arguments: { progress: 'I need the recipient.', questions: [{ question: 'Who is the recipient?', reason: 'The name is required.' }] },
      }
    }
    if (body.includes('You are line-two')) {
      seasonRequests.push(body)
      return body.includes('Autumn') ? { text: 'The requested season is Autumn.' } : {
        toolName: 'request_human_input', arguments: { progress: 'I need the season.', questions: [{ question: 'Which season?', reason: 'The season is required.' }] },
      }
    }
    return undefined
  } })
  const app = await launchArrangementApp(testInfo, provider.baseUrl)
  return { workspace, app, provider, writerRequests, seasonRequests }
}

agentQuestionDesktopTest(prepareParallelPipeline)('two bounded pipeline agents ask and answering one preserves completed tasks', async ({ desktop }) => {
  const { workspace, app, writerRequests, seasonRequests } = desktop
  const page = await app.firstWindow()
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page.getByRole('tab', { name: 'Teams', exact: true }).click()
  await page.getByRole('radio', { name: /^Line Team\b/ }).click()
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const savedRequest = page.waitForRequest((request) => request.url().endsWith('/agent-questions'))
  // App teardown must not replace a failed visible-card assertion.
  void savedRequest.catch(() => undefined)
  await chat.getByRole('textbox').first().fill('Determine the required recipient and season. Each specialist must ask for its own missing fact.')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  const writerCard = chat.getByRole('region', { name: 'Line One needs your input', exact: true })
  const seasonCard = chat.getByRole('region', { name: 'Line Two needs your input', exact: true })
  await expect(writerCard).toBeVisible({ timeout: 15_000 })
  await expect(seasonCard).toBeVisible({ timeout: 15_000 })
  expect(writerRequests).toHaveLength(1)
  expect(seasonRequests).toHaveLength(1)
  const questions = agentQuestionViewsSchema.parse(await (await page.request.get((await savedRequest).url())).json())
  const writer = questions.find((question) => question.agentId === 'line-one')
  if (!writer) throw new Error('The writer question is missing.')
  await writerCard.getByRole('textbox').fill('Marta')
  await writerCard.getByRole('button', { name: 'Submit and continue', exact: true }).click()
  await expect(chat.getByText('The recipient is Marta.', { exact: true })).toBeVisible()
  expect(writerRequests).toHaveLength(2)
  expect(seasonRequests, 'Answering the writer must not resume the unanswered season agent.').toHaveLength(1)
  await expect(seasonCard.getByRole('textbox')).toBeVisible()
  const completion = observeQuestionTaskOutcome(workspace, writer, 15_000)
  await seasonCard.getByRole('textbox').fill('Autumn')
  await expect(seasonCard.getByRole('button', { name: 'Submit and continue', exact: true })).toBeEnabled()
  await seasonCard.getByRole('button', { name: 'Submit and continue', exact: true }).click()
  await expect(chat.getByText('The requested season is Autumn.', { exact: true })).toBeVisible()
  const outcome = await completion
  expect(outcome.status, outcome.error).toBe('done')
  expect(writerRequests, 'The completed writer must survive the second continuation.').toHaveLength(2)
  expect(seasonRequests).toHaveLength(2)
  expect(seasonRequests[1]).toContain('Marta')
  await expect(writerCard.getByRole('textbox')).toHaveCount(0)
  await expect(seasonCard.getByRole('textbox')).toHaveCount(0)
})

async function prepareEarlyAnswer(testInfo: TestInfo) {
  const workspace = testInfo.outputPath('workspace')
  const project = testInfo.outputPath('project')
  const profile = testInfo.outputPath('user-data')
  await Promise.all([
    fs.mkdir(workspace, { recursive: true }), fs.mkdir(profile, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests/fixtures/team-chat-e2e'), project, { recursive: true }),
  ])
  const teamPath = path.join(project, 'teams/line-team/team.yaml')
  const team = await fs.readFile(teamPath, 'utf8')
  await fs.writeFile(teamPath, team.replace('type: chain\n      sequence:', 'type: broadcast\n      fan_out:').replace('handoff_format: markdown', 'aggregation: merge'))
  await Promise.all(['line-one', 'line-two'].map((id) => fs.writeFile(path.join(project, 'agents', id, `${id}.md`),
    `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\nYou are ${id}. Ask for required missing information using the question tool.\n`)))
  const writerRequests: string[] = []
  const seasonRequests: string[] = []
  // Replace only the paid provider boundary. Both requests run concurrently.
  const provider = await startDeterministicOpenAiServer({ blockRequestsMatching: ['You are line-two'], resolveTurn: (body) => {
    if (body.includes('You are line-one')) {
      writerRequests.push(body)
      return body.includes('Marta') ? { text: 'The recipient is Marta.' } : {
        toolName: 'request_human_input', arguments: { progress: 'I need the recipient.', questions: [{ question: 'Who is the recipient?', reason: 'The name is required.' }] },
      }
    }
    if (body.includes('You are line-two')) {
      seasonRequests.push(body)
      return { text: 'The independent specialist has finished.' }
    }
    return undefined
  } })
  const app = await launchArrangementApp(testInfo, provider.baseUrl)
  return { workspace, app, provider, writerRequests, seasonRequests }
}

agentQuestionDesktopTest(prepareEarlyAnswer)('an answer received while another broadcast agent is working resumes after the active attempt drains', async ({ desktop }) => {
  const { workspace, app, provider, writerRequests, seasonRequests } = desktop
  const page = await app.firstWindow()
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page.getByRole('tab', { name: 'Teams', exact: true }).click()
  await page.getByRole('radio', { name: /^Line Team\b/ }).click()
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const savedRequest = page.waitForRequest((request) => request.url().endsWith('/agent-questions'))
  // App teardown must not replace a failed visible-card assertion.
  void savedRequest.catch(() => undefined)
  await chat.getByRole('textbox').first().fill('Determine the required recipient and season. Each specialist must ask for its own missing fact.')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  const writerCard = chat.getByRole('region', { name: 'Line One needs your input', exact: true })
  await expect(writerCard).toBeVisible({ timeout: 15_000 })
  expect(writerRequests).toHaveLength(1)
  const questions = agentQuestionViewsSchema.parse(await (await page.request.get((await savedRequest).url())).json())
  const writer = questions.find((question) => question.agentId === 'line-one')
  if (!writer) throw new Error('The writer question is missing.')
  const completion = observeQuestionTaskOutcome(workspace, writer, 15_000)
  void completion.catch(() => undefined)
  await writerCard.getByRole('textbox').fill('Marta')
  await writerCard.getByRole('button', { name: 'Submit and continue', exact: true }).click()
  await expect(writerCard.getByRole('status')).toHaveText('Answer received; waiting to continue')
  expect(writerRequests, 'Saving the answer cannot start a concurrent root attempt.').toHaveLength(1)
  provider.releaseBlockedResponses()
  await expect(chat.getByText('The recipient is Marta.', { exact: true })).toBeVisible({ timeout: 15_000 })
  const outcome = await completion
  expect(outcome.status, outcome.error).toBe('done')
  expect(writerRequests).toHaveLength(2)
  expect(seasonRequests, 'The completed independent specialist must not rerun.').toHaveLength(1)

})

async function prepareSerialPipeline(testInfo: TestInfo) {
  const workspacePath = testInfo.outputPath('workspace')
  const projectRootPath = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  const piStatePath = testInfo.outputPath('pi-state')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests/fixtures/team-chat-e2e'), projectRootPath, { recursive: true }),
  ])

  const teamPath = path.join(projectRootPath, 'teams/line-team/team.yaml')
  const team = await fs.readFile(teamPath, 'utf8')
  const planPath = testInfo.outputPath('plan.md')
  await fs.writeFile(planPath, `# Plan: Dedication

**Status:** draft

### S1: Writing

#### T1: Write the dedication
- **Agent:** line-one
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** draft.md

#### T2: Edit the dedication
- **Agent:** line-two
- **Status:** pending
- **Validate:** false
- **Depends on:** T1
- **Gate:** false
- **Result file:** line-result.md
`)
  await fs.writeFile(teamPath, team.replace('type: chain\n      sequence:\n        - line-one\n        - line-two', 'type: pipeline').replace('handoff_format: markdown', `plan_file: ${planPath}\n        execution_mode: serial\n        persist_result: true`))

  // Agent selection is explicit; legacy Team tier defaults no longer select a model.
  await Promise.all(['line-one', 'line-two'].map(async (name) => {
    const file = path.join(projectRootPath, 'agents', name, `${name}.md`)
    await fs.writeFile(file, `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\nYou are ${name} in a dedication-writing team. Follow the user request and use the available question tool for required missing information.\n`)
  }))

  const writerRequests: string[] = []
  const editorRequests: string[] = []
  // Real providers are paid and nondeterministic. Only their HTTP boundary is
  // replaced; Electron, API, dispatch, queue, engines, and stores are real.
  const provider = await startDeterministicOpenAiServer({
    resolveTurn: (body) => {
      if (body.includes('You are line-two')) {
        editorRequests.push(body)
        return { text: 'Final dedication for Marta.' }
      }
      if (body.includes('You are line-one')) {
        writerRequests.push(body)
        if (body.includes('Marta')) return { text: 'A complete dedication for Marta.' }
        return {
          toolName: 'request_human_input',
          arguments: {
            progress: 'I can write the dedication once I know the recipient.',
            questions: [{ question: 'Who is the dedication for?', reason: 'The requested dedication needs a recipient.' }],
          },
        }
      }
      return undefined
    },
  })
  const app = await launchArrangementApp(testInfo, provider.baseUrl)

  return { workspacePath, app, provider, writerRequests, editorRequests }
}

agentQuestionDesktopTest(prepareSerialPipeline)('a serial pipeline task resumes before its dependent task runs', async ({ desktop }) => {
  const { workspacePath, app, writerRequests, editorRequests } = desktop
  const page = await app.firstWindow()
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page.getByRole('tab', { name: 'Teams', exact: true }).click()
  await page.getByRole('radio', { name: /^Line Team\b/ }).click()
  const composer = page.getByRole('textbox').first()
  const questionsRequest = page.waitForRequest((request) => request.url().endsWith('/agent-questions'))
  // A failed visible assertion closes the app before this read is awaited.
  // Keep that cleanup rejection from replacing the original assertion failure.
  void questionsRequest.catch(() => undefined)
  await composer.fill('Write a dedication. Ask me for the required recipient name before writing it.')
  await composer.press('Enter')

  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const question = chat.getByRole('region', { name: 'Line One needs your input', exact: true })
  await expect(question).toBeVisible({ timeout: 15_000 })
  await expect(chat.getByText('I can write the dedication once I know the recipient.', { exact: true })).toBeVisible()
  expect(editorRequests, 'The editor must not run while the writer is waiting.').toEqual([])
  await chat.getByRole('button', { name: 'Go to pending question', exact: true }).click()
  await expect(question.getByRole('textbox')).toBeFocused()
  await expect(page.getByRole('complementary', { name: 'Team participants' })).toContainText('Waiting for your answer')
  const savedQuestion = agentQuestionViewsSchema.parse(await (await page.request.get((await questionsRequest).url())).json())[0]
  if (!savedQuestion) throw new Error('The visible card has no saved question.')
  const completion = observeQuestionTaskOutcome(workspacePath, savedQuestion, 15_000)
  await question.getByRole('textbox', { name: 'Who is the dedication for?', exact: true }).fill('Marta')
  await question.getByRole('button', { name: 'Submit and continue', exact: true }).click()

  await expect(chat.getByText('A complete dedication for Marta.', { exact: true })).toBeVisible()
  await expect(question.getByText('Marta', { exact: true })).toBeVisible()
  await expect(question.getByRole('textbox')).toHaveCount(0)
  expect(writerRequests.filter((body) => body.includes('Marta'))).toHaveLength(1)
  await expect(chat.getByText('Final dedication for Marta.', { exact: true })).toBeVisible()
  expect(editorRequests).toHaveLength(1)
  expect(editorRequests[0]).toContain('Marta')
  await expect(chat.getByRole('button', { name: 'Submit and continue', exact: true })).toHaveCount(0)
  const terminalTask = await completion
  expect(terminalTask.status, terminalTask.error).toBe('done')
})
