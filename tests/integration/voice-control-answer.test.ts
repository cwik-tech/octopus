import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { voiceControlDescriptorSchema } from '../../contracts/voice-control.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore, type RunStartRequest } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer } from '../../server/api-server.js'
import { FileSystemWorkflowStateStore } from '../../workflows/workflow-state-store.js'
import {
  createAgentQuestionWait,
  createHumanInputWait,
  createModelChoiceWait,
  MODEL_CHOICE_FIXTURE,
  type WaitingTask,
} from '../helpers/waiting-task-fixtures.js'

/** A worker that never starts, so a continued task stays visibly scheduled. */
class BlockingTaskLauncher implements RunLauncher {
  async startRun(_request: RunStartRequest): Promise<never> {
    return await new Promise<never>(() => undefined)
  }
}

async function withVoiceClient<T extends WaitingTask>(
  seed: (sessionStore: FileSystemSessionStore) => Promise<T>,
  run: (input: { client: Client; waiting: T; sessionStore: FileSystemSessionStore }) => Promise<void>,
): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-answer-')))
  const workspacePath = path.join(root, 'workspace')
  const discoveryDir = path.join(root, 'voice-control')
  fs.mkdirSync(workspacePath, { recursive: true })
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const waiting = await seed(sessionStore)
  const server = await startApiServer({
    apiToken: randomBytes(32).toString('base64url'),
    store: new FileSystemRunStore(workspacePath),
    launcher: new BlockingTaskLauncher(),
    taskLauncher: new BlockingTaskLauncher(),
    sessionStore,
    repoRootPath: process.cwd(),
    workspacePath,
    voiceControl: { mcpToken: randomBytes(32).toString('base64url'), discoveryDir },
  })
  let client: Client | undefined
  try {
    const descriptor = voiceControlDescriptorSchema.parse(
      JSON.parse(fs.readFileSync(path.join(discoveryDir, 'apps', 'octopus.json'), 'utf8')),
    )
    const transport = new StreamableHTTPClientTransport(new URL(descriptor.mcp.url), {
      requestInit: { headers: { ...descriptor.mcp.headers } },
    })
    client = new Client({ name: 'voice-layer-test', version: '1.0.0' })
    await client.connect(new ExactOptionalMcpTransport(transport))
    await run({ client, waiting, sessionStore })
  } finally {
    await client?.close()
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text?: string }[]
  assert.equal(content[0]?.type, 'text')
  return content[0]?.text ?? ''
}

function assertSucceeded(result: Awaited<ReturnType<Client['callTool']>>): void {
  assert.notEqual(result.isError, true, firstText(result))
}

test('a workflow waiting for feedback is read aloud, and continues after answer_question', async () => {
  await withVoiceClient(createHumanInputWait, async ({ client, waiting, sessionStore }) => {
    const question = await client.callTool({
      name: 'get_question',
      arguments: { sessionId: waiting.sessionId, taskId: waiting.taskId },
    })
    assertSucceeded(question)
    assert.match(firstText(question), /oat milk sales grew/)

    const answered = await client.callTool({
      name: 'answer_question',
      arguments: { sessionId: waiting.sessionId, taskId: waiting.taskId, answer: 'Keep it short.' },
    })
    assertSucceeded(answered)

    const snapshot = await new FileSystemWorkflowStateStore(waiting.assignmentPath).requireSnapshot()
    assert.deepEqual(
      snapshot.state.steps[0]?.humanInput?.submission?.messages.map((message) => message.text),
      ['Keep it short.'],
    )
    // Continuing is a continuation admission; the status changes when a worker takes it.
    const task = await sessionStore.getTaskRecord(waiting.sessionId, waiting.taskId)
    assert.equal(task?.admission?.source, 'human_input', 'the task is scheduled to continue')
  })
})

test("an agent's question is read aloud, and the task continues after answer_question", async () => {
  await withVoiceClient(createAgentQuestionWait, async ({ client, waiting, sessionStore }) => {
    const question = await client.callTool({
      name: 'get_question',
      arguments: { sessionId: waiting.sessionId, taskId: waiting.taskId },
    })
    assertSucceeded(question)
    assert.match(firstText(question), /Who is the dedication for\?/)

    const answered = await client.callTool({
      name: 'answer_question',
      arguments: { sessionId: waiting.sessionId, taskId: waiting.taskId, answer: 'Marta' },
    })
    assertSucceeded(answered)

    const snapshot = await new FileSystemWorkflowStateStore(waiting.assignmentPath).requireSnapshot()
    assert.notEqual(snapshot.state.agentQuestions?.interactions[0]?.status, 'pending')
    const task = await sessionStore.getTaskRecord(waiting.sessionId, waiting.taskId)
    assert.equal(task?.admission?.source, 'agent_question', 'the task is scheduled to continue')
  })
})

test('choose_model approves the offered retry, and the task is scheduled again', async () => {
  await withVoiceClient(createModelChoiceWait, async ({ client, waiting }) => {
    // Set after the server boots, which hydrates the default from settings.
    setRuntimeDefaultModelState({ status: 'available', ...MODEL_CHOICE_FIXTURE.proposedDefault })
    try {
      const question = await client.callTool({
        name: 'get_question',
        arguments: { sessionId: waiting.sessionId, taskId: waiting.taskId },
      })
      assertSucceeded(question)
      assert.match(firstText(question), /gpt-5\.4-mini/)

      const chosen = await client.callTool({
        name: 'choose_model',
        arguments: { sessionId: waiting.sessionId, taskId: waiting.taskId },
      })
      assertSucceeded(chosen)

      const snapshot = await new FileSystemWorkflowStateStore(waiting.assignmentPath).requireSnapshot()
      assert.equal(snapshot.state.steps[0]?.approvedModelChoice?.offerId, MODEL_CHOICE_FIXTURE.offerId)
      assert.equal(
        (chosen.structuredContent as { task?: { admission?: { source?: string } } } | undefined)
          ?.task?.admission?.source,
        'model_choice',
      )
    } finally {
      setRuntimeDefaultModelState(undefined)
    }
  })
})

test('answer_question says so when nothing is waiting', async () => {
  await withVoiceClient(createModelChoiceWait, async ({ client, waiting }) => {
    const answered = await client.callTool({
      name: 'answer_question',
      arguments: { sessionId: waiting.sessionId, taskId: waiting.taskId, answer: 'Yes.' },
    })
    assert.equal(answered.isError, true)
    assert.match(firstText(answered), /no question/i)
  })
})
