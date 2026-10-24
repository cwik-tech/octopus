import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

type PiSession = Awaited<ReturnType<typeof createAgentSession>>['session']
type PiSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>
type PiModel = NonNullable<PiSessionOptions['model']>
type PiAssistantMessageEventStream = Awaited<
  ReturnType<PiSession['agent']['streamFunction']>
>

test('Pi passes post-validation tool_call mutations to execute without revalidation', async (context) => {
  const piAi = await loadInstalledPiAi()
  const cwd = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'pi-tool-mutation-compatibility-')),
  )
  context.after(() => fs.rm(cwd, { recursive: true, force: true }))
  const agentDir = path.join(cwd, 'agent')
  await fs.mkdir(agentDir, { recursive: true })
  await fs.writeFile(
    path.join(agentDir, 'auth.json'),
    JSON.stringify({ openai: { type: 'api_key', key: 'local-test-key' } }),
    { mode: 0o600 },
  )

  let executedValue: unknown
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on('tool_call', (event) => {
          if (event.toolName === 'compatibility_probe') {
            event.input.value = 42
          }
        })
      },
    ],
  })
  await loader.reload()

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    model: localModel(),
    tools: ['compatibility_probe'],
    customTools: [defineTool({
      name: 'compatibility_probe',
      label: 'Compatibility Probe',
      description: 'Observe Pi tool-call mutation ordering.',
      parameters: Type.Object({ value: Type.String() }),
      execute: async (_toolCallId, params) => {
        executedValue = params.value
        return {
          content: [{ type: 'text', text: String(params.value) }],
          details: {},
        }
      },
    })],
  })
  context.after(() => session.dispose())

  let providerTurns = 0
  session.agent.streamFunction = async () => {
    providerTurns += 1
    const stream = piAi.createAssistantMessageEventStream()
    const message = providerTurns === 1
      ? assistantMessage(
          [{
            type: 'toolCall',
            id: 'compatibility-call',
            name: 'compatibility_probe',
            arguments: { value: 'schema-valid-before-hook' },
          }],
          'toolUse',
        )
      : assistantMessage([{ type: 'text', text: 'done' }], 'stop')
    stream.push({ type: 'start', partial: message })
    stream.push({ type: 'done', reason: message.stopReason, message })
    return stream
  }

  await session.prompt('Run the compatibility probe.')

  assert.equal(executedValue, 42)
  assert.equal(providerTurns, 2)
})

interface InstalledPiAi {
  createAssistantMessageEventStream(): PiAssistantMessageEventStream
}

async function loadInstalledPiAi(): Promise<InstalledPiAi> {
  const moduleValue: unknown = await import('@earendil-works/pi-ai')
  if (!isInstalledPiAi(moduleValue)) {
    throw new Error('Installed Pi AI does not expose its event-stream factory.')
  }
  return moduleValue
}

function isInstalledPiAi(value: unknown): value is InstalledPiAi {
  return value !== null &&
    typeof value === 'object' &&
    'createAssistantMessageEventStream' in value &&
    typeof value.createAssistantMessageEventStream === 'function'
}

function localModel(): PiModel {
  return {
    id: 'pi-compatibility-model',
    name: 'Pi compatibility model',
    api: 'openai-completions' as const,
    provider: 'openai',
    baseUrl: 'http://127.0.0.1',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1_000,
    maxTokens: 1_000,
  }
}

function assistantMessage(
  content: Extract<PiSession['agent']['state']['messages'][number], { role: 'assistant' }>['content'],
  stopReason: 'toolUse' | 'stop',
) {
  return {
    role: 'assistant' as const,
    content,
    api: 'openai-completions' as const,
    provider: 'openai',
    model: 'pi-compatibility-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: Date.now(),
  }
}
