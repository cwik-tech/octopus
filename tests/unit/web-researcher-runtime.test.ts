import assert from 'node:assert/strict'
import * as path from 'node:path'
import test from 'node:test'

import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { loadAgent } from '../../parsers/load-agent.js'
import type { AgentRosterEntry, TeamConfig } from '../../core/types.js'

test('Web Researcher keeps its pinned runtime when the app default uses another provider', () => {
  const agentFile = path.join(
    process.cwd(),
    'agents',
    'web-researcher',
    'web-researcher.md',
  )
  const rosterEntry: AgentRosterEntry = {
    name: 'web-researcher',
    type: 'agent',
    role: 'External research',
    tier: 'strategic',
    agent_file: agentFile,
  }
  const teamConfig: TeamConfig = {
    team: {
      name: 'session-chat',
      description: 'Ad hoc session chat',
      version: '1.0.0',
    },
    workspace: { path: '/tmp/workspace', watch: false },
    levels: [],
    gates: [],
    agents: [],
  }

  setRuntimeDefaultModelState({ status: 'available', provider: 'claude', model: 'haiku' })
  try {
    const loaded = loadAgent(rosterEntry, teamConfig, 0)

    assert.ok(loaded)
    assert.equal(loaded.provider, 'codex')
    assert.equal(loaded.model, 'gpt-5.5')
  } finally {
    setRuntimeDefaultModelState({ status: 'unset' })
  }
})
