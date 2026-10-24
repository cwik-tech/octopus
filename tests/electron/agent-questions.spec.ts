import { _electron as electron, expect, type TestInfo } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentQuestionViewsSchema } from '../../contracts/agent-questions.js'
import { observeQuestionTaskOutcome, readQuestionProviderEvidence } from './support/agent-question-evidence.js'

import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'

import { agentQuestionDesktopTest } from './support/agent-question-desktop.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const completedWriterResponse = 'For Marta, a flower opens in the morning light.'
const completedEditorResponse = 'Edited dedication: For Marta, a flower opens in the morning light.'

async function prepareChainDesktop(testInfo: TestInfo) {
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
        return { text: completedEditorResponse }
      }
      if (body.includes('You are line-one')) {
        writerRequests.push(body)
        if (body.includes('Marta')) return { text: completedWriterResponse }
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
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment({ ...process.env, PATH: '/usr/bin:/bin' }),
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'agent-questions-test-key',
      OPENAI_BASE_URL: provider.baseUrl,
      PI_CODING_AGENT_DIR: piStatePath,
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })

  return { workspacePath, app, provider, writerRequests, editorRequests }
}

agentQuestionDesktopTest(prepareChainDesktop)('a chain agent asks inline and finishes its response before the next agent runs', async ({ desktop }) => {
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
  await expect(chat.getByRole('status', { name: 'Line One is thinking', exact: true })).toHaveCount(0)
  const savedQuestion = agentQuestionViewsSchema.parse(await (await page.request.get((await questionsRequest).url())).json())[0]
  if (!savedQuestion) throw new Error('The visible card has no saved question.')
  const completion = observeQuestionTaskOutcome(workspacePath, savedQuestion, 15_000)
  await question.getByRole('textbox', { name: 'Who is the dedication for?', exact: true }).fill('Marta')
  await question.getByRole('button', { name: 'Submit and continue', exact: true }).click()

  await expect(chat.getByText(completedWriterResponse, { exact: true })).toBeVisible()
  await expect(chat.getByText(completedEditorResponse, { exact: true })).toBeVisible()
  await expect(question.getByText('Marta', { exact: true })).toBeVisible()
  await expect(question.getByRole('textbox')).toHaveCount(0)
  expect(writerRequests.filter((body) => body.includes('Marta'))).toHaveLength(1)
  expect(editorRequests).toHaveLength(1)
  expect(editorRequests[0]).toContain(completedWriterResponse)
  await expect(chat.getByRole('button', { name: 'Submit and continue', exact: true })).toHaveCount(0)
  const terminalTask = await completion
  expect(terminalTask.status, terminalTask.error).toBe('done')
  const evidence = await readQuestionProviderEvidence(workspacePath, { ...savedQuestion, runId: terminalTask.runId })
  const starts = evidence.agents.filter((event) => event.event === 'start' && event.agent_name === savedQuestion.agentId)
  const ends = evidence.agents.filter((event) => event.event === 'end' && event.agent_name === savedQuestion.agentId)
  expect(starts).toHaveLength(2)
  expect(starts[0]?.logical_invocation_id).toBeTruthy()
  expect(starts[1]?.logical_invocation_id).toBe(starts[0]?.logical_invocation_id)
  expect(ends.map((event) => event.status)).toEqual(['awaiting_input', 'completed'])
  expect(ends[0]?.dispatch_id).toBe(savedQuestion.dispatchId)
  expect(ends[1]?.dispatch_id).not.toBe(savedQuestion.dispatchId)
})

async function prepareDiscussionParticipantDesktop(testInfo: TestInfo) {
  const workspacePath = testInfo.outputPath('workspace')
  const projectRootPath = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  const piStatePath = testInfo.outputPath('pi-state')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }), fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests/fixtures/team-chat-e2e'), projectRootPath, { recursive: true }),
  ])
  await Promise.all(['board-lead', 'spec-alpha', 'spec-beta', 'spec-gamma', 'spec-delta', 'spec-epsilon', 'spec-zeta', 'spec-eta'].map(async (name) => {
    await fs.writeFile(path.join(projectRootPath, 'agents', name, `${name}.md`),
      `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\nYou are ${name} in a dedication-writing team. Use the question mechanism for required missing information.\n`)
  }))
  const predecessorRequests: string[] = []
  const interviewerRequests: string[] = []
  const poetRequests: string[] = []
  // Paid model responses alone are replaced. The complete desktop stack runs.
  const provider = await startDeterministicOpenAiServer({ resolveTurn: (body) => {
    if (body.includes('Select the participants before any specialist runs.')) return { text: JSON.stringify({
      agents: ['spec-gamma', 'spec-alpha', 'spec-beta'], rosterRationale: { 'spec-gamma': 'Set the form.', 'spec-alpha': 'Obtain the brief.', 'spec-beta': 'Write the poem.' },
    }) }
    if (body.includes('Review the work already produced by the roster locked at startup.')) return { text: JSON.stringify({
      decision: 'complete', reason: 'The named dedication is ready.', finalResponse: 'Final dedication for Marta: a flower opens in the morning light.',
    }) }
    if (body.includes('You are spec-alpha')) {
      interviewerRequests.push(body)
      return body.includes('Marta') ? { text: 'The completed brief requires a dedication for Marta.' } : {
        toolName: 'request_human_input', arguments: {
          progress: 'I need the recipient before I can prepare the brief.',
          questions: [{ question: 'Who is the dedication for?', reason: 'The request requires the recipient name.' }],
        },
      }
    }
    if (body.includes('You are spec-gamma')) {
      predecessorRequests.push(body)
      return { text: 'Use a four-line dedication.' }
    }
    if (body.includes('You are spec-beta')) {
      poetRequests.push(body)
      return { text: 'For Marta, a flower opens in the morning light.' }
    }
    return undefined
  } })
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: {
    ...fixtureDesktopEnvironment({ ...process.env, PATH: '/usr/bin:/bin' }), NODE_ENV: 'test', OPENAI_API_KEY: 'agent-questions-test-key', OPENAI_BASE_URL: provider.baseUrl,
    PI_CODING_AGENT_DIR: piStatePath,
    PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath, PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
    PIPELINE_DESKTOP_USER_DATA: userDataPath, PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
  } })
  return { workspacePath, app, provider, predecessorRequests, interviewerRequests, poetRequests }
}

agentQuestionDesktopTest(prepareDiscussionParticipantDesktop)('a discussion participant resumes before the pass continues', async ({ desktop }) => {
  const { workspacePath, app, predecessorRequests, interviewerRequests, poetRequests } = desktop
  const page = await app.firstWindow()
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page.getByRole('tab', { name: 'Teams', exact: true }).click()
  await page.getByRole('radio', { name: /^Board Team\b/ }).click()
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const savedQuestionRequest = page.waitForRequest((request) => request.url().endsWith('/agent-questions'))
  // The visible-card assertion owns a missing-question failure; closing the
  // app must not replace it with an unobserved response-wait rejection.
  void savedQuestionRequest.catch(() => undefined)
  await chat.getByRole('textbox').first().fill('Write a dedication. The interviewer must ask me for the required recipient name before the poet writes.')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  const card = chat.getByRole('region', { name: 'Spec Alpha needs your input', exact: true })
  await expect(card).toBeVisible({ timeout: 15_000 })
  expect(poetRequests, 'The poet must wait for the interviewer to finish.').toEqual([])
  const question = agentQuestionViewsSchema.parse(await (await page.request.get((await savedQuestionRequest).url())).json())[0]
  if (!question) throw new Error('The visible question was not persisted.')
  const completion = observeQuestionTaskOutcome(workspacePath, question, 15_000)
  await card.getByRole('textbox').fill('Marta')
  await card.getByRole('button', { name: 'Submit and continue', exact: true }).click()
  await expect(chat.getByText('The completed brief requires a dedication for Marta.', { exact: true })).toBeVisible()
  await expect(chat.getByText('For Marta, a flower opens in the morning light.', { exact: true })).toBeVisible()
  await expect(chat.getByText('Final dedication for Marta: a flower opens in the morning light.', { exact: true })).toBeVisible()
  await expect(card.getByRole('textbox')).toHaveCount(0)
  expect(interviewerRequests.filter((body) => body.includes('Marta'))).toHaveLength(1)
  expect(predecessorRequests).toHaveLength(1)
  expect(poetRequests).toHaveLength(1)
  expect(poetRequests[0]).toContain('The completed brief requires a dedication for Marta.')
  const task = await completion
  expect(task.status, task.error).toBe('done')
})

async function prepareDiscussionSelectionDesktop(testInfo: TestInfo) {
  const workspacePath = testInfo.outputPath('workspace')
  const projectRootPath = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  const piStatePath = testInfo.outputPath('pi-state')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }), fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests/fixtures/team-chat-e2e'), projectRootPath, { recursive: true }),
  ])
  await Promise.all(['board-lead', 'spec-alpha', 'spec-beta', 'spec-gamma', 'spec-delta', 'spec-epsilon', 'spec-zeta', 'spec-eta'].map(async (name) => {
    await fs.writeFile(path.join(projectRootPath, 'agents', name, `${name}.md`),
      `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\nYou are ${name} in a dedication-writing team. Obtain the required name before assigning the work.\n`)
  }))
  const selections: string[] = []
  const specialistRequests: string[] = []
  // Replace only the paid provider boundary, including its structured response.
  const provider = await startDeterministicOpenAiServer({ resolveTurn: (body) => {
    if (body.includes('Select the participants before any specialist runs.')) {
      selections.push(body)
      return { text: JSON.stringify(body.includes('Marta') ? {
        decision: 'select', agents: ['spec-alpha'], rosterRationale: { 'spec-alpha': 'Write the dedication for Marta.' }, progress: null, questions: null,
      } : {
        decision: 'needs_input', agents: null, rosterRationale: null,
        progress: 'I need the recipient before selecting the specialist.',
        questions: [{ question: 'Who is the dedication for?', reason: 'The recipient determines the brief.' }],
      }) }
    }
    if (body.includes('Review the work already produced by the roster locked at startup.')) return { text: JSON.stringify({
      decision: 'complete', reason: 'The dedication is ready.', finalResponse: 'The lead presents a finished dedication for Marta.',
    }) }
    if (body.includes('You are spec-alpha')) {
      specialistRequests.push(body)
      return { text: 'A completed dedication for Marta.' }
    }
    return undefined
  } })
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: {
    ...fixtureDesktopEnvironment({ ...process.env, PATH: '/usr/bin:/bin' }), NODE_ENV: 'test', OPENAI_API_KEY: 'agent-questions-test-key', OPENAI_BASE_URL: provider.baseUrl,
    PI_CODING_AGENT_DIR: piStatePath,
    PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath, PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
    PIPELINE_DESKTOP_USER_DATA: userDataPath, PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
  } })
  return { workspacePath, app, provider, selections, specialistRequests }
}

agentQuestionDesktopTest(prepareDiscussionSelectionDesktop)('the discussion lead asks before selecting specialists and resumes its selection', async ({ desktop }) => {
  const { workspacePath, app, selections, specialistRequests } = desktop
  const page = await app.firstWindow()
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page.getByRole('tab', { name: 'Teams', exact: true }).click()
  await page.getByRole('radio', { name: /^Board Team\b/ }).click()
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const savedQuestionRequest = page.waitForRequest((request) => request.url().endsWith('/agent-questions'))
  // Preserve the visible assertion failure if app cleanup rejects this wait.
  void savedQuestionRequest.catch(() => undefined)
  await chat.getByRole('textbox').first().fill('Lead: ask me for the required recipient before you select a specialist to write a dedication.')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  const card = chat.getByRole('region', { name: 'Board Lead needs your input', exact: true })
  await expect(card).toBeVisible({ timeout: 15_000 })
  expect(specialistRequests, 'No specialist may run before the lead finishes its selection.').toEqual([])
  expect(selections).toHaveLength(1)
  const question = agentQuestionViewsSchema.parse(await (await page.request.get((await savedQuestionRequest).url())).json())[0]
  if (!question) throw new Error('The lead question was not persisted.')
  const completion = observeQuestionTaskOutcome(workspacePath, question, 15_000)
  await card.getByRole('textbox').fill('Marta')
  await card.getByRole('button', { name: 'Submit and continue', exact: true }).click()
  await expect(chat.getByText('A completed dedication for Marta.', { exact: true })).toBeVisible()
  await expect(chat.getByText('The lead presents a finished dedication for Marta.', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(card.getByRole('textbox')).toHaveCount(0)
  expect(selections).toHaveLength(2)
  expect(selections[1]).toContain('Marta')
  expect(specialistRequests).toHaveLength(1)
  expect(specialistRequests[0]).toContain('Marta')
  const task = await completion
  expect(task.status, task.error).toBe('done')
})

async function prepareDiscussionFinalPassDesktop(testInfo: TestInfo) {
  const workspacePath = testInfo.outputPath('workspace')
  const projectRootPath = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  const piStatePath = testInfo.outputPath('pi-state')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }), fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests/fixtures/team-chat-e2e'), projectRootPath, { recursive: true }),
  ])
  await Promise.all(['board-lead', 'spec-alpha', 'spec-beta', 'spec-gamma', 'spec-delta', 'spec-epsilon', 'spec-zeta', 'spec-eta'].map(async (name) => {
    await fs.writeFile(path.join(projectRootPath, 'agents', name, `${name}.md`),
      `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\nYou are ${name} in a dedication-writing team. Obtain the required name before assigning the work.\n`)
  }))
  const selections: string[] = []
  const specialistRequests: string[] = []
  // Replace only the paid provider boundary, including its structured response.
  const provider = await startDeterministicOpenAiServer({ resolveTurn: (body) => {
    if (body.includes('Select the participants before any specialist runs.')) return { text: JSON.stringify({
      decision: 'select', agents: ['spec-alpha'], rosterRationale: { 'spec-alpha': 'Prepare a draft.' }, progress: null, questions: null,
    }) }
    if (body.includes('Review the work already produced by the roster locked at startup.')) {
      selections.push(body)
      return { text: JSON.stringify(body.includes('Marta') ? {
        decision: 'complete', reason: 'The required recipient is known.', finalResponse: 'The lead presents a finished dedication for Marta.',
        message: null, progress: null, questions: null,
      } : {
        decision: 'needs_input', reason: null, finalResponse: null, message: null,
        progress: 'The draft is ready; I need the recipient to finish it.',
        questions: [{ question: 'Who is the dedication for?', reason: 'The recipient is required for the final dedication.' }],
      }) }
    }
    if (body.includes('You are spec-alpha')) {
      specialistRequests.push(body)
      return { text: 'A four-line draft awaits its recipient.' }
    }
    return undefined
  } })
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: {
    ...fixtureDesktopEnvironment({ ...process.env, PATH: '/usr/bin:/bin' }), NODE_ENV: 'test', OPENAI_API_KEY: 'agent-questions-test-key', OPENAI_BASE_URL: provider.baseUrl,
    PI_CODING_AGENT_DIR: piStatePath,
    PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath, PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
    PIPELINE_DESKTOP_USER_DATA: userDataPath, PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
  } })
  return { workspacePath, app, provider, selections, specialistRequests }
}

agentQuestionDesktopTest(prepareDiscussionFinalPassDesktop)('the lead asks at the final allowed pass without repeating completed specialists', async ({ desktop }) => {
  const { workspacePath, app, selections, specialistRequests } = desktop
  const page = await app.firstWindow()
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page.getByRole('tab', { name: 'Teams', exact: true }).click()
  await page.getByRole('radio', { name: /^Board Team\b/ }).click()
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const savedQuestionRequest = page.waitForRequest((request) => request.url().endsWith('/agent-questions'))
  // Preserve the visible assertion failure if app cleanup rejects this wait.
  void savedQuestionRequest.catch(() => undefined)
  await chat.getByRole('textbox').first().fill('Prepare a draft, then ask me for the required recipient before the lead finishes the dedication.')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  const card = chat.getByRole('region', { name: 'Board Lead needs your input', exact: true })
  await expect(card).toBeVisible({ timeout: 15_000 })
  expect(specialistRequests, 'The specialist has finished before the lead asks.').toHaveLength(1)
  expect(selections).toHaveLength(1)
  const question = agentQuestionViewsSchema.parse(await (await page.request.get((await savedQuestionRequest).url())).json())[0]
  if (!question) throw new Error('The lead question was not persisted.')
  const completion = observeQuestionTaskOutcome(workspacePath, question, 15_000)
  await card.getByRole('textbox').fill('Marta')
  await card.getByRole('button', { name: 'Submit and continue', exact: true }).click()
  await expect(chat.getByText('A four-line draft awaits its recipient.', { exact: true })).toBeVisible()
  await expect(chat.getByText('The lead presents a finished dedication for Marta.', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(card.getByRole('textbox')).toHaveCount(0)
  expect(selections).toHaveLength(2)
  expect(selections[1]).toContain('Marta')
  expect(specialistRequests).toHaveLength(1)
  const task = await completion
  expect(task.status, task.error).toBe('done')
})
