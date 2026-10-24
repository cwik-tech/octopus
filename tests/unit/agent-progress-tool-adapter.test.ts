import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentProgressToolAdapter } from '../../domains/mcp/agent-progress-tool-adapter.js'
import type { BuiltinToolExecutionInput } from '../../domains/mcp/builtin-agent-tool-adapter.js'
import type { McpJsonObject } from '../../contracts/mcp.js'
import type { AgentProgressUpdate } from '../../contracts/agent-progress.js'
import { runProviderToolLoop, type ProviderToolAssistantTurn } from '../../domains/provider/provider-tool-loop.js'
import { whenDefined } from '../../core/optional-properties.js'

function input(value: McpJsonObject): BuiltinToolExecutionInput {
  return { toolCallId: 'report', input: value, context: { contractVersion: 1, requestId: 'request', leaseId: 'lease', sessionId: 'session', runId: 'turn', assignmentId: 'assignment', agentPath: 'agents/analyst' } }
}

test('the progress tool reports a validated milestone and only acknowledges the display update', async () => {
  const reports: AgentProgressUpdate[] = []
  const adapter = createAgentProgressToolAdapter(update => reports.push(update))
  const result = await adapter.execute(input({ summary: 'Updating calendar', tasks: [{ id: 'calendar', label: 'Calendar', status: 'active' }] }))
  assert.deepEqual(reports, [{ kind: 'reported', summary: 'Updating calendar', tasks: [{ id: 'calendar', label: 'Calendar', status: 'active' }] }])
  assert.deepEqual(result.output, { reported: true })
  assert.equal(result.isError, false)
})

test('invalid or cancelled reports cannot update the display', async () => {
  const reports: AgentProgressUpdate[] = []
  const adapter = createAgentProgressToolAdapter(update => reports.push(update))
  const rejected = await adapter.execute(input({ summary: '', raw: 'PRIVATE_PAYLOAD' }))
  assert.equal(rejected.isError, true)
  assert.equal(rejected.content.includes('PRIVATE_PAYLOAD'), false)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(adapter.execute({ ...input({ summary: 'Late report' }), signal: controller.signal }), { name: 'AbortError' })
  assert.deepEqual(reports, [])
})

test('an invalid progress report fails only its own call, not the native tool loop reply', async () => {
  const reports: AgentProgressUpdate[] = []
  const adapter = createAgentProgressToolAdapter(update => reports.push(update))
  // The provider is the replaced boundary; the loop's schema check and the real adapter run.
  const turns: ProviderToolAssistantTurn[] = [
    { content: null, toolCalls: [{ id: 'long', name: 'report_progress', arguments: { summary: 'x'.repeat(200) } }] },
    { content: null, toolCalls: [{ id: 'duplicate', name: 'report_progress', arguments: { summary: 'Checking', tasks: [
      { id: 'same', label: 'One', status: 'active' }, { id: 'same', label: 'Two', status: 'pending' },
    ] } }] },
    { content: 'Final answer.', toolCalls: [] },
  ]
  const result = await runProviderToolLoop({
    messages: [{ role: 'user', content: 'Work.' }],
    tools: [{ name: adapter.tool.namespacedName, ...whenDefined(adapter.tool.description, description => ({ description })), inputSchema: adapter.tool.inputSchema, effect: adapter.tool.effect }],
    adapter: { async complete() { const turn = turns.shift(); assert.ok(turn); return turn } },
    async executeTool(call) {
      const executed = await adapter.execute(input(call.arguments))
      return { content: executed.content, isError: executed.isError }
    },
  })
  assert.equal(result.text, 'Final answer.')
  assert.deepEqual(result.messages.flatMap(message => message.role === 'tool' ? [message.isError] : []), [true, true])
  assert.deepEqual(reports, [])
})
