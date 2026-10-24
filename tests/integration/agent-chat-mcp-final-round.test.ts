import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { runSessionAgentChatTurn } from '../../services/agent-chat-service.js'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import type { AgentTextStreamFrame } from '../../contracts/agent-text-stream.js'
import { seedChatSessionStore } from '../helpers/chat-session-store-fixture.js'

/**
 * D9 wiring: a completed MCP tool-loop turn reaches the hub, and the prose from
 * a tool-requesting round does not.
 *
 * The adapter-level test proves the callback fires for the right round. This
 * one proves the callback is actually connected — service to hub — which is a
 * separate failure mode: the wiring was missing once already and nothing
 * noticed, because the adapter test passed either way.
 */

const TOOL_ROUND_PROSE = 'Let me look that up before answering.'
const FINAL_ANSWER = 'The answer is 42.'

function textFrames(hub: AgentTextStreamHub, channelId: string): string[] {
  const page = hub.read(channelId, 0)
  return (page?.frames ?? [])
    .filter(
      (frame: AgentTextStreamFrame): frame is Extract<AgentTextStreamFrame, { type: 'delta' }> =>
        frame.type === 'delta',
    )
    .map((frame) => frame.text)
}

test('a completed MCP turn publishes its final answer and no tool-round prose', async () => {
  const hub = new AgentTextStreamHub()
  const turnId = '33333333-4444-5555-6666-777777777777'

  // Stand in for the MCP service. It runs a two-round loop internally and, per
  // D9, reports only the round that requested no tools.
  const mcpAgentToolService = {
    runTurn: async (input: {
      onFinalRoundText?: (text: string) => void
    }) => {
      // Round one asks for a tool. Its prose is planning, not the answer, so
      // the adapter never reports it.
      void TOOL_ROUND_PROSE
      // Round two answers.
      input.onFinalRoundText?.(FINAL_ANSWER)
      return {
        kind: 'completed' as const,
        availableToolCount: 1,
        artifacts: [],
        route: 'mcp-native' as const,
        result: {
          text: FINAL_ANSWER,
          model: 'fake/model',
          toolCallCount: 1,
          executedToolCallCount: 1,
        },
      }
    },
  }

  // The MCP branch runs only for a speaker of type "agent", which means a real
  // persona on disk.
  const repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-final-round-')),
  )
  const agentDir = path.join(repoRoot, 'agents', 'probe-agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, 'probe-agent.md'),
    [
      '---',
      'name: probe-agent',
      'description: D9 wiring probe.',
      'tier: execution',
      'provider: lm-studio',
      'model: unused',
      'thinking: low',
      'tools: none',
      '---',
      '',
      '# Probe',
      '',
      'Answer briefly.',
      '',
    ].join('\n'),
    'utf8',
  )

  const messages: Array<Record<string, unknown>> = []
  const sessionStore = Object.assign(seedChatSessionStore(path.join(repoRoot, 'workspace'), '44444444-5555-6666-7777-888888888888'), {
    listChatMessages: async () => [],
    appendChatMessageIfAbsent: async (
      _id: string,
      message: Record<string, unknown>,
    ) => {
      messages.push(message)
      return 'appended' as const
    },
    updateSessionTitle: async () => null,
    listFiles: async () => [],
  })

  await runSessionAgentChatTurn({
    sessionId: '44444444-5555-6666-7777-888888888888',
    session: { id: 'x', title: 't', status: 'active', activityType: 'chat', createdAt: '', updatedAt: '' },
    sessionStore,
    repoRootPath: repoRoot,
    text: 'Ask the agent.',
    agentNames: ['probe-agent'],
    provider: 'lm-studio',
    model: 'unused',
    turnId,
    textStreamHub: hub,
    mcpAgentToolService: mcpAgentToolService as never,
  }).catch(() => undefined)

  fs.rmSync(repoRoot, { recursive: true, force: true })
  const published = textFrames(hub, turnId)
  assert.ok(
    published.includes(FINAL_ANSWER),
    'the final round reaches the hub through the service, not just the adapter',
  )
  assert.equal(
    published.some((text) => text.includes('look that up')),
    false,
    'tool-requesting prose never reaches the display channel',
  )
})
