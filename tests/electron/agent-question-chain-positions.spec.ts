import { _electron as electron, expect, type TestInfo } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentQuestionViewsSchema } from '../../contracts/agent-questions.js'
import { agentQuestionDesktopTest } from './support/agent-question-desktop.js'
import { observeQuestionTaskOutcome } from './support/agent-question-evidence.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const writerAnswer = 'A complete dedication for Marta.'
const editorAnswer = 'An edited dedication for Marta.'

async function prepareChainPosition(info: TestInfo, sequence: readonly string[]) {
  const workspace = info.outputPath('workspace')
  const project = info.outputPath('project')
  const profile = info.outputPath('user-data')
  await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(profile, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests/fixtures/team-chat-e2e'), project, { recursive: true })])
  const agents = ['spec-alpha', 'line-one', 'line-two']
  for (const id of agents) {
    await fs.writeFile(path.join(project, 'agents', id, `${id}.md`),
      `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\nYou are ${id}. Complete your assigned step.\n`)
  }
  const teamFile = path.join(project, 'teams/line-team/team.yaml')
  const team = await fs.readFile(teamFile, 'utf8')
  const roster = agents.map((id) => `  - name: ${id}\n    type: agent\n    role: Complete this chain step\n    agent_file: ../../agents/${id}/${id}.md\n${id === sequence.at(-1) ? '    produces:\n      - path: line-result.md\n' : ''}`).join('')
  await fs.writeFile(teamFile, team.replace(/agents:\n[\s\S]*?\nlevels:/, `agents:\n${roster}\nlevels:`)
    .replace(/      sequence:\n[\s\S]*?      config:/, `      sequence:\n${sequence.map((id) => `        - ${id}\n`).join('')}      config:`))
  const calls: Array<{ agent: string; body: string }> = []
  // Only the paid provider boundary is replaced. Predecessor work is real.
  const provider = await startDeterministicOpenAiServer({ resolveTurn: (body) => {
    const agent = agents.find((id) => body.includes(`You are ${id}.`))
    if (!agent) return undefined
    calls.push({ agent, body })
    if (agent === 'spec-alpha') return { text: 'Use a four-line form.' }
    if (agent === 'line-two') return { text: editorAnswer }
    return body.includes('Marta') ? { text: writerAnswer } : {
      toolName: 'request_human_input', arguments: {
        progress: 'The form is ready; I need the recipient to finish.',
        questions: [{ question: 'Who is the recipient?', reason: 'A named dedication requires the name.' }],
      },
    }
  } })
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: {
    ...fixtureDesktopEnvironment({ ...process.env, PATH: '/usr/bin:/bin' }), NODE_ENV: 'test', OPENAI_API_KEY: 'question-position-fixture', OPENAI_BASE_URL: provider.baseUrl,
    PI_CODING_AGENT_DIR: info.outputPath('pi-state'),
    PIPELINE_DESKTOP_PROJECT_ROOT: project, PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
    PIPELINE_DESKTOP_USER_DATA: profile, PIPELINE_DESKTOP_WORKSPACE_PATH: workspace,
  } })
  return { app, provider, workspace, calls }
}

for (const position of [
  { name: 'middle', sequence: ['spec-alpha', 'line-one', 'line-two'], final: editorAnswer,
    completed: ['spec-alpha', 'line-one', 'line-one', 'line-two'], editorInputs: [true] },
  { name: 'final', sequence: ['spec-alpha', 'line-one'], final: writerAnswer,
    completed: ['spec-alpha', 'line-one', 'line-one'], editorInputs: [] },
]) {
  agentQuestionDesktopTest((info) => prepareChainPosition(info, position.sequence))(
    `a ${position.name} chain agent resumes without replaying its accepted predecessor`, async ({ desktop }) => {
      const page = await desktop.app.firstWindow()
      await page.getByRole('tab', { name: 'Run', exact: true }).click()
      await page.getByRole('tab', { name: 'Teams', exact: true }).click()
      await page.getByRole('radio', { name: /^Line Team\b/ }).click()
      const chat = page.getByRole('region', { name: 'Run chat', exact: true })
      const questionRequest = page.waitForRequest((request) => request.url().endsWith('/agent-questions'))
      void questionRequest.catch(() => undefined) // Preserve a failed visible assertion during teardown.
      await chat.getByRole('textbox').first().fill('Prepare the form, then ask for the required recipient and finish the dedication.')
      await chat.getByRole('button', { name: 'Send message', exact: true }).click()
      const card = chat.getByRole('region', { name: 'Line One needs your input', exact: true })
      await expect(card).toBeVisible({ timeout: 15_000 })
      expect(desktop.calls.map((call) => call.agent)).toEqual(['spec-alpha', 'line-one'])
      const saved = agentQuestionViewsSchema.parse(await (await page.request.get((await questionRequest).url())).json())[0]
      if (!saved) throw new Error('The visible question has no durable identity.')
      const completion = observeQuestionTaskOutcome(desktop.workspace, saved, 15_000)
      await card.getByRole('textbox').fill('Marta')
      await card.getByRole('button', { name: 'Submit and continue', exact: true }).click()
      await expect(chat.getByText(position.final, { exact: true })).toBeVisible({ timeout: 15_000 })
      const outcome = await completion
      expect(outcome.status, outcome.error).toBe('done')
      expect(desktop.calls.map((call) => call.agent)).toEqual(position.completed)
      expect(desktop.calls.filter((call) => call.agent === 'line-two').map((call) => call.body.includes(writerAnswer))).toEqual(position.editorInputs)
      await expect(card.getByRole('textbox')).toHaveCount(0)
    },
  )
}
