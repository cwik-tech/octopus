import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initProviders } from '../../providers/index.js'
import { createChainTool } from '../../engines/chain.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'

initProviders()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const vcTeamRoot = path.join(repoRoot, 'teams', 'venture-capital-team')

function withFakePi<T>(handlerSource: string, fn: (binDir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pi-bin-'))
  const scriptPath = path.join(dir, 'pi')
  fs.writeFileSync(
    scriptPath,
    // A real Pi run ends on `agent_settled`: `message_end` says what a message
    // held, `agent_settled` says Pi will not auto-retry or run a follow-up.
    `#!/usr/bin/env node\n${handlerSource}\nprocess.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')\n`,
    { mode: 0o755 },
  )

  return fn(dir).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

function readTextResult(result: any): string {
  return (result.content?.[0] as { text?: string } | undefined)?.text ?? ''
}

function makeLoadedAgents(teamRoot: string) {
  return new Map([
    ['vc-deal-evaluator', {
      name: 'vc-deal-evaluator',
      model: 'gpt-5.4-mini',
      thinking: 'low',
      tools: [],
      systemPrompt: 'AGENT:vc-deal-evaluator\n{{TASK_CONTENT}}',
      experienceContent: '',
      experienceEnabled: false,
      skillsContent: '',
      knowledgeContent: '',
      agentDir: path.join(teamRoot, 'agents', 'vc-deal-evaluator'),
      color: 1,
      provider: 'pi',
    }],
  ])
}

function makeRosterEntries() {
  return new Map([
    ['vc-deal-evaluator', {
      name: 'vc-deal-evaluator',
      type: 'agent',
      provider: 'pi',
      model: 'gpt-5.4-mini',
      thinking: 'low',
      produces: [
        { path: 'output/minutes.md' },
        { path: 'output/investment-memo.md' },
      ],
    }],
  ])
}

function makeRuntimeState() {
  return {
    sessionId: 'vc-handoff-session',
    currentLevelIndex: 1,
    levelStates: new Map([
      ['deliberation', {
        status: 'completed',
        stageStatus: STAGE_LIFECYCLE_STATUS.COMPLETED,
        loopbackCount: 0,
        engineState: null,
      }],
      ['memo-synthesis', {
        status: 'active',
        stageStatus: STAGE_LIFECYCLE_STATUS.READY,
        loopbackCount: 0,
        engineState: null,
      }],
    ]),
    totalCost: 0,
    startTime: Date.now(),
    timerStarted: true,
    endTime: null,
    spawnDepth: 0,
    rootSessionId: 'root-session',
    parentSessionId: undefined,
  }
}

function buildBaseContext(params: {
  teamConfig: any
  assignmentDir: string
  workspaceDir: string
  state: any
}) {
  return {
    teamName: 'venture-capital-team',
    teamConfig: params.teamConfig,
    teamRootPath: vcTeamRoot,
    levelId: 'memo-synthesis',
    config: params.teamConfig.levels[1]!.stage,
    agents: makeLoadedAgents(repoRoot),
    rosterEntries: makeRosterEntries(),
    state: params.state,
    workspacePath: params.workspaceDir,
    outputPath: params.assignmentDir,
    inputFilesContent: '',
    agentMetrics: new Map(),
    stageFailureOverride: undefined,
    shutdownSignal: undefined,
    budgetLedger: undefined,
    onDashboardUpdate: undefined,
    getCurrentCoordinatorRunId: () => 1,
    coordinatorName: undefined,
  } as any
}

test('venture-capital memo-synthesis stage consumes output/minutes.md and produces output/investment-memo.md', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const promptIdx = args.indexOf('--append-system-prompt')
const promptPath = promptIdx >= 0 ? args[promptIdx + 1] : ''
const messageArg = args.find((arg) => arg.startsWith('@')) || ''
const prompt = promptPath && fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : ''
const message = messageArg ? fs.readFileSync(messageArg.slice(1), 'utf8') : ''
const sawMinutes = message.includes('Critical finding: seasonal utilization breaks the payback case.')
const sawChainBootstrap = message.includes('# Chain Step 1/1')
let text = 'UNEXPECTED'
if (prompt.includes('AGENT:vc-deal-evaluator')) {
  text = [
    '# Agridynamics Robotics — Investment Memo',
    '',
    '## Executive Summary',
    '',
    (sawMinutes && sawChainBootstrap)
      ? 'Pass. The memo-synthesis stage received the seeded minutes artifact and converted it into the final memo.'
      : 'FAIL: minutes handoff missing.',
    '',
    '## Recommendation',
    '',
    '**Recommendation:** Pass',
  ].join('\\n')
}
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    model: 'fake-model-v1',
    usage: { input: 12, output: 24, totalTokens: 36, cost: { total: 0.02 } },
    content: [{ type: 'text', text }]
  }
}) + '\\n')
`, async (binDir) => {
    const parsed = parseTeamConfig(path.join(vcTeamRoot, 'team.yaml'))
    assert.equal(parsed.errors.length, 0)
    assert.ok(parsed.config)

    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-handoff-workspace-'))
    const assignmentDir = path.join(workspaceDir, 'assignments', 'case-vc-handoff')
    fs.mkdirSync(path.join(assignmentDir, 'output'), { recursive: true })

    try {
      const minutesBody = [
        '---',
        'artifact_type: "result"',
        '---',
        '# Meeting Minutes',
        '',
        '## Round 1',
        '',
        '**vc-financial-modeler:** Critical finding: seasonal utilization breaks the payback case.',
      ].join('\n')
      fs.writeFileSync(path.join(assignmentDir, 'output', 'minutes.md'), minutesBody)

      const teamConfig = parsed.config!
      teamConfig.workspace.path = workspaceDir
      const state = makeRuntimeState()
      const chainCtx = buildBaseContext({
        teamConfig,
        assignmentDir,
        workspaceDir,
        state,
      })

      const chainTool = createChainTool(chainCtx)
      const chainResult = await chainTool.execute('vc-memo-synthesis', {}, undefined as any, undefined as any, undefined as any)
      const chainText = readTextResult(chainResult)

      assert.match(chainText, /Chain Complete/)
      assert.equal(fs.existsSync(path.join(assignmentDir, 'output', 'investment-memo.md')), true)

      const memoArtifact = fs.readFileSync(path.join(assignmentDir, 'output', 'investment-memo.md'), 'utf8')
      assert.match(memoArtifact, /Pass\. The memo-synthesis stage received the seeded minutes artifact/)
      assert.match(memoArtifact, /artifact_type: "result"/)
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(workspaceDir, { recursive: true, force: true })
    }
  })
})
