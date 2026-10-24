import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import type { AppDefaultModelState } from '../../contracts/agent-model-selection.js'
import { checkAgentProviderHealth } from '../../domains/agent-generator/provider-health.js'
import {
  getRuntimeDefaultModelState,
  setRuntimeDefaultModelState,
} from '../../domains/provider/default-model-selection.js'
import type { LocalCliAgentView } from '../../domains/provider/provider-settings.js'

const AVAILABLE_DEFAULT: AppDefaultModelState = {
  status: 'available', provider: 'claude', model: 'opus',
}

function makeFixture(t: TestContext, frontmatter: string, appDefault = AVAILABLE_DEFAULT) {
  const previousDefault = getRuntimeDefaultModelState()
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-health-default-'))
  t.after(() => {
    setRuntimeDefaultModelState(previousDefault)
    fs.rmSync(repoRoot, { recursive: true, force: true })
  })
  setRuntimeDefaultModelState(appDefault)
  const agentDir = path.join(repoRoot, 'agents', 'reviewer-of-agent-architect')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'reviewer-of-agent-architect.md'),
    `---\nname: reviewer-of-agent-architect\nsystem: true\n${frontmatter}\n---\nReview the architect response.\n`)
  return repoRoot
}

// Installed CLIs and their discovery are machine-dependent. These are the
// cached settings supplied at the health check's external settings boundary.
const cliSettingsReader = {
  async listCliAgents(): Promise<LocalCliAgentView[]> {
    return [{
      id: 'claude', name: 'Claude Code', command: 'claude',
      available: true, enabled: true, path: '/fixture/claude',
      models: [
        { id: 'opus', name: 'Claude Opus', enabled: true },
        { id: 'sonnet', name: 'Claude Sonnet', enabled: true },
      ],
      mcpBridge: { supported: true },
    }]
  },
}

for (const frontmatter of ['', 'model: default', 'provider: codex\nmodel: default']) {
  test(`an inheriting agent is healthy on the app default with ${frontmatter || 'no saved pair'}`, async (t) => {
    const repoRoot = makeFixture(t, frontmatter)

    const [health] = await checkAgentProviderHealth({
      repoRoot, agentNames: ['reviewer-of-agent-architect'], cliSettingsReader,
    })

    assert.equal(health?.status, 'ok')
    assert.equal(health.provider, 'claude')
    assert.equal(health.model, 'opus')
    assert.deepEqual(health.diagnostics, [])
  })
}

test('an explicit agent keeps its own model when the app default differs', async (t) => {
  const repoRoot = makeFixture(t, 'provider: claude\nmodel: sonnet')

  const [health] = await checkAgentProviderHealth({ repoRoot, cliSettingsReader })

  assert.equal(health?.status, 'ok')
  assert.equal(health.provider, 'claude')
  assert.equal(health.model, 'sonnet')
})

test('an agent name absent from the library is not made healthy by the app default', async (t) => {
  const repoRoot = makeFixture(t, '')

  const [health] = await checkAgentProviderHealth({
    repoRoot, agentNames: ['missing-agent'], cliSettingsReader,
  })

  assert.equal(health?.status, 'unknown')
})

test('an inheriting agent reports that no app default is selected', async (t) => {
  const repoRoot = makeFixture(t, '', { status: 'unset' })

  const [health] = await checkAgentProviderHealth({ repoRoot, cliSettingsReader })

  assert.equal(health?.status, 'unknown')
  assert.equal(health.message,
    "Agent 'reviewer-of-agent-architect': No application default model is selected. Choose one in Settings → AI Providers.")
})

test('an unavailable app default retains its identity and reason', async (t) => {
  const repoRoot = makeFixture(t, '', {
    status: 'unavailable', provider: 'claude', model: 'opus', detail: 'model disabled',
  })

  const [health] = await checkAgentProviderHealth({ repoRoot, cliSettingsReader })

  assert.ok(health)
  assert.notEqual(health.status, 'ok')
  assert.equal(health.provider, 'claude')
  assert.equal(health.model, 'opus')
  assert.equal(health.message,
    "Agent 'reviewer-of-agent-architect' (claude): The application default model is unavailable: model disabled.")
})

for (const scenario of [
  { frontmatter: 'provider: claude', reason: "Provider 'claude' names no model." },
  { frontmatter: 'model: sonnet', reason: "Model 'sonnet' names no provider." },
]) {
  test(`an incomplete explicit choice is not filled from the default: ${scenario.frontmatter}`, async (t) => {
    const repoRoot = makeFixture(t, scenario.frontmatter)

    const [health] = await checkAgentProviderHealth({ repoRoot, cliSettingsReader })

    assert.ok(health)
    assert.notEqual(health.status, 'ok')
    assert.ok(health.message?.includes(scenario.reason), health.message)
  })
}

test('an inherited model still reports a real provider configuration failure', async (t) => {
  const repoRoot = makeFixture(t, '', {
    status: 'available', provider: 'claude', model: 'disabled-model',
  })

  const [health] = await checkAgentProviderHealth({ repoRoot, cliSettingsReader })

  assert.equal(health?.status, 'error')
  assert.equal(health.message,
    "Agent 'reviewer-of-agent-architect' (claude): Enable model 'disabled-model' for Claude Code in AI Providers.")
})
