import assert from 'node:assert/strict'
import * as path from 'node:path'
import test, { beforeEach } from 'node:test'

import { getRuntimeDefaultModelState, setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { loadAgent } from '../../parsers/load-agent.js'

beforeEach((context) => {
  assert.ok('after' in context, 'The default must be restored after each test')
  const previousDefault = getRuntimeDefaultModelState()
  context.after(() => { setRuntimeDefaultModelState(previousDefault) })
})

function loadShippedGeneralAgent() {
  const agent = loadAgent({
    name: 'general-agent', type: 'agent', role: 'worker',
    agent_file: path.resolve('agents/general-agent/general-agent.md'),
  }, {
    team: { name: 'general-agent-defaults', description: '', version: '1' },
    workspace: { path: process.cwd(), watch: false },
    levels: [], gates: [], agents: [],
  }, 0)
  assert.ok(agent, 'The shipped General Agent must load')
  return agent
}

test('the shipped General Agent follows the app default when its provider and model change', () => {
  setRuntimeDefaultModelState({ status: 'available', provider: 'codex', model: 'gpt-6-astra' })
  const first = loadShippedGeneralAgent()
  assert.deepEqual(first.selection, {
    provider: 'codex', model: 'gpt-6-astra', source: 'app-default', reason: 'agent-default',
  })

  setRuntimeDefaultModelState({ status: 'available', provider: 'claude', model: 'haiku' })
  const next = loadShippedGeneralAgent()
  assert.deepEqual(next.selection, {
    provider: 'claude', model: 'haiku', source: 'app-default', reason: 'agent-default',
  })
})

test('the shipped General Agent reports a missing app default instead of choosing another model', () => {
  setRuntimeDefaultModelState({ status: 'unset' })
  const agent = loadShippedGeneralAgent()
  assert.equal(agent.selection, null)
  assert.equal(agent.selectionError?.code, 'app-default-unset')
})

test('the shipped General Agent reports an unavailable app default instead of switching providers', () => {
  setRuntimeDefaultModelState({ status: 'unavailable', provider: 'codex', model: 'gpt-6-astra' })
  const agent = loadShippedGeneralAgent()
  assert.equal(agent.selection, null)
  assert.equal(agent.selectionError?.code, 'app-default-unavailable')
})

test('the General Agent is instructed to research current information and ask for a missing location without denying access', () => {
  const agent = loadShippedGeneralAgent()
  assert.ok(agent.tools?.includes('research_web'))
  assert.match(agent.systemPrompt, /Use the available research_web tool to look up current information/)
  assert.match(agent.systemPrompt, /ask for the\s+city or location/)
  assert.match(agent.systemPrompt, /Do not claim that internet access is unavailable/)
  assert.doesNotMatch(agent.systemPrompt, /cannot do is fetch anything nobody put in front of/)
})
