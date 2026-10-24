import { requiredValue } from '../../core/required-value.js'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { mock } from 'node:test'

import { STAGE_TYPE } from '../../core/constants.js'
import type { RuntimeContext } from '../../domains/runtime/runtime-context.js'
import type {
  DiscussionState,
  LevelConfig,
  LoadedAgent,
} from '../../core/types.js'

const runAgentMock = mock.fn(async (_options: {
  systemPrompt: string
  userMessage: string
}) => ({
  text: 'reflected',
  cost: 0,
  durationMs: 1,
  inputTokens: 1,
  outputTokens: 1,
  contextTokens: 2,
  model: 'test-model',
}))

mock.module('../../domains/agent-execution/agent-runner.js', {
  namedExports: {
    runAgent: runAgentMock,
    dispatchToAgentOrTeam: mock.fn(),
  },
})

const { runExperienceReflections } = await import(
  '../../team-runtime/experience-reflections.js'
)

test('experience reflections keep read and append instructions on the seed pad', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-reflection-'))
  const agentDir = path.join(fixtureRoot, 'repo', 'agents', 'alpha')
  const seedExperienceDir = path.join(agentDir, 'experience')
  const seedPadPath = path.join(seedExperienceDir, 'scratch-pad.md')
  const workspacePath = path.join(fixtureRoot, 'workspace')
  fs.mkdirSync(seedExperienceDir, { recursive: true })
  fs.writeFileSync(seedPadPath, 'seed entry\n')

  const agent: LoadedAgent = {
    name: 'alpha',
    model: 'test-model',
    thinking: 'low',
    systemPrompt: 'Experience directory: {{EXPERIENCE_PATH}}',
    experienceContent: 'seed entry\n',
    experienceEnabled: true,
    skillsContent: '',
    knowledgeContent: '',
    // The pair this Agent resolved, matching the `provider`/`model` above. The
    // loader sets them together — `selection: null` means no pair could be
    // chosen and then both are empty — so a fixture naming a concrete pair with
    // a null selection described an Agent that cannot exist.
    selection: {
      provider: 'test-provider',
      model: 'test-model',
      source: 'agent',
      reason: 'explicit-agent-choice',
    },
    agentDir,
    color: 0,
    provider: 'test-provider',
  }
  const level = {
    id: 'discussion-level',
    name: 'Discussion',
    order: 1,
    stage: {
      type: STAGE_TYPE.DISCUSSION,
      coordinator: 'alpha',
      participants: [],
      config: {
        mode: 'deliberate',
        min_rounds: 1,
        max_rounds: 1,
        constraints: { max_time_minutes: 5, max_budget_usd: 1 },
        output: { format: 'discussion.md', user_review: false },
      },
    },
  } as LevelConfig
  const discussionState: DiscussionState = {
    type: STAGE_TYPE.DISCUSSION,
    round: 1,
    messages: [{
      from: 'alpha',
      to: 'all',
      round: 1,
      timestamp: new Date().toISOString(),
      type: 'position',
      message: 'A result worth reflecting on.',
    }],
    outputPath: '',
  }
  const context = {
    agents: new Map([['alpha', agent]]),
    teamConfig: {
      team: { name: 'test-team', description: '', version: '0.1.0' },
      workspace: { path: workspacePath, watch: false },
      models: {},
      gates: [],
      agents: [],
      levels: [level],
    },
    state: {
      sessionId: 'session-1',
      totalCost: 0,
      levelStates: new Map([[level.id, { engineState: discussionState }]]),
    },
    shutdownController: new AbortController(),
  } as unknown as RuntimeContext

  runAgentMock.mock.resetCalls()
  try {
    await runExperienceReflections(level, context, path.join(fixtureRoot, 'assignment'))

    assert.equal(runAgentMock.mock.calls.length, 1)
    const options = requiredValue(runAgentMock.mock.calls[0], 'tests/unit/experience-reflections.test.ts:114').arguments[0] as {
      systemPrompt: string
      userMessage: string
    }
    assert.match(options.systemPrompt, new RegExp(escapeRegExp(seedExperienceDir)))
    assert.ok(options.userMessage.includes(`at \`${seedPadPath}\``))
    assert.equal(fs.readFileSync(seedPadPath, 'utf8'), 'seed entry\n')
    assert.equal(fs.existsSync(path.join(workspacePath, 'agents')), false)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
