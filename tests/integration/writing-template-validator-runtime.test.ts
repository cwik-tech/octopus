import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initProviders } from '../../providers/index.js'
import { createChainTool } from '../../engines/chain.js'
import { createReviewTool } from '../../engines/review.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'

initProviders()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'writing-template-validator-e2e')
const writingTeamRoot = path.join(fixtureRoot, 'teams', 'writing-team')

function withFakePi<T>(
  handlerSource: string,
  fn: (binDir: string, logPath: string) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pi-bin-'))
  const scriptPath = path.join(dir, 'pi')
  const logPath = path.join(dir, 'invocations.log')
  fs.writeFileSync(
    scriptPath,
    // A real Pi run ends on `agent_settled`: `message_end` says what a message
    // held, `agent_settled` says Pi will not auto-retry or run a follow-up.
    `#!/usr/bin/env node\n${handlerSource.replace(
      "process.env.FAKE_PI_LOG || ''",
      JSON.stringify(logPath),
    )}\nprocess.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')\n`,
    { mode: 0o755 },
  )

  return fn(dir, logPath).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

function makeLoadedAgents(agentRoot: string) {
  return new Map([
    ['brief-builder', {
      name: 'brief-builder',
      model: 'gpt-5.4-mini',
      thinking: 'low',
      tools: [],
      systemPrompt: 'AGENT:brief-builder\n{{TASK_CONTENT}}',
      experienceContent: '',
      experienceEnabled: false,
      skillsContent: '',
      knowledgeContent: '',
      agentDir: path.join(agentRoot, 'agents', 'brief-builder'),
      color: 1,
      provider: 'pi',
    }],
    ['writer', {
      name: 'writer',
      model: 'gpt-5.4-mini',
      thinking: 'low',
      tools: [],
      systemPrompt: 'AGENT:writer\n{{TASK_CONTENT}}',
      experienceContent: '',
      experienceEnabled: false,
      skillsContent: '',
      knowledgeContent: '',
      agentDir: path.join(agentRoot, 'agents', 'writer'),
      color: 2,
      provider: 'pi',
    }],
    ['editor', {
      name: 'editor',
      model: 'gpt-5.4-mini',
      thinking: 'low',
      tools: [],
      systemPrompt: 'AGENT:editor\n{{TASK_CONTENT}}',
      experienceContent: '',
      experienceEnabled: false,
      skillsContent: '',
      knowledgeContent: '',
      agentDir: path.join(agentRoot, 'agents', 'editor'),
      color: 3,
      provider: 'pi',
    }],
  ])
}

function makeRosterEntries() {
  return new Map([
    ['brief-builder', { name: 'brief-builder', type: 'agent', provider: 'pi', model: 'gpt-5.4-mini', thinking: 'low' }],
    ['writer', { name: 'writer', type: 'agent', provider: 'pi', model: 'gpt-5.4-mini', thinking: 'low', produces: [{ path: 'draft-package.md' }] }],
    ['editor', { name: 'editor', type: 'agent', provider: 'pi', model: 'gpt-5.4-mini', thinking: 'low' }],
  ])
}

function readTextResult(result: any): string {
  return (result.content?.[0] as { text?: string } | undefined)?.text ?? ''
}

function makeRuntimeState() {
  return {
    sessionId: 'template-validator-session',
    currentLevelIndex: 0,
    levelStates: new Map([
      ['brief-and-draft', {
        status: 'active',
        stageStatus: STAGE_LIFECYCLE_STATUS.READY,
        loopbackCount: 0,
        engineState: null,
      }],
      ['editorial-review', {
        status: 'pending',
        stageStatus: STAGE_LIFECYCLE_STATUS.NOT_STARTED,
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
  levelId: string
  stage: any
  assignmentDir: string
  workspaceDir: string
  state: any
}) {
  return {
    teamName: 'writing-team',
    teamConfig: params.teamConfig,
    teamRootPath: writingTeamRoot,
    levelId: params.levelId,
    config: params.stage,
    agents: makeLoadedAgents(fixtureRoot),
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
    coordinatorName: 'editor',
  } as any
}

async function runScenario(
  mode: 'BAD-STRUCTURE' | 'GOOD-STRUCTURE' | 'BAD-TONE' | 'GOOD-TONE',
  logPath: string,
) {
  const parsed = parseTeamConfig(path.join(writingTeamRoot, 'team.yaml'))
  assert.equal(parsed.errors.length, 0)
  assert.ok(parsed.config)

  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-validator-workspace-'))
  const assignmentDir = path.join(workspaceDir, 'assignments', `case-${mode.toLowerCase()}`)
  fs.mkdirSync(assignmentDir, { recursive: true })
  fs.writeFileSync(path.join(assignmentDir, 'incoming-brief.md'), `Create ${mode} executive summary.`)

  const teamConfig = parsed.config!
  teamConfig.workspace.path = workspaceDir
  const state = makeRuntimeState()

  const chainCtx = buildBaseContext({
    teamConfig,
    levelId: 'brief-and-draft',
    stage: teamConfig.levels[0]!.stage,
    assignmentDir,
    workspaceDir,
    state,
  })

  const chainTool = createChainTool(chainCtx)
  const chainResult = await chainTool.execute('chain-call', {}, undefined as any, undefined as any, undefined as any)
  const chainText = readTextResult(chainResult)
  assert.match(chainText, /Chain Complete/)
  assert.equal(fs.existsSync(path.join(assignmentDir, 'chain-step-1-brief-builder.md')), true)
  assert.equal(fs.existsSync(path.join(assignmentDir, 'draft-package.md')), true)

  state.currentLevelIndex = 1
  ;(state.levelStates.get('brief-and-draft') as any).status = 'completed'
  ;(state.levelStates.get('brief-and-draft') as any).stageStatus = STAGE_LIFECYCLE_STATUS.COMPLETED
  ;(state.levelStates.get('editorial-review') as any).status = 'active'
  ;(state.levelStates.get('editorial-review') as any).stageStatus = STAGE_LIFECYCLE_STATUS.READY

  const reviewCtx = buildBaseContext({
    teamConfig,
    levelId: 'editorial-review',
    stage: teamConfig.levels[1]!.stage,
    assignmentDir,
    workspaceDir,
    state,
  })
  const reviewTool = createReviewTool(reviewCtx)
  const reviewResult = await reviewTool.execute('review-call', {}, undefined as any, undefined as any, undefined as any)
  const reviewText = readTextResult(reviewResult)
  const invocationLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''

  return { assignmentDir, reviewText, invocationLog, state }
}

test('deterministic runtime integration blocks bad template structure before reviewer approval', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const promptIdx = args.indexOf('--append-system-prompt')
const promptPath = promptIdx >= 0 ? args[promptIdx + 1] : ''
const messageArg = args.find((arg) => arg.startsWith('@')) || ''
const prompt = promptPath && fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : ''
const message = messageArg ? fs.readFileSync(messageArg.slice(1), 'utf8') : ''
const logPath = process.env.FAKE_PI_LOG || ''
function appendLog(line) {
  if (!logPath) return
  fs.appendFileSync(logPath, line + '\\n')
}
let text = 'NOOP'
if (prompt.includes('AGENT:brief-builder')) {
  appendLog('brief-builder')
  let mode = 'GOOD-STRUCTURE'
  if (message.includes('BAD-STRUCTURE')) mode = 'BAD-STRUCTURE'
  else if (message.includes('BAD-TONE')) mode = 'BAD-TONE'
  else if (message.includes('GOOD-TONE')) mode = 'GOOD-TONE'
  text = [
    '# Structured Brief',
    '',
    'Mode: ' + mode,
    'Document Goal: Deterministic template validation',
    '',
    '## Document Configuration',
    '',
    '- **Template:** Executive Summary — selected for deterministic executive-summary validation',
    '- **Template confidence:** **High**',
    '- **Style profile:** **strategic-consulting** — selected for deterministic style-profile validation',
  ].join('\\n')
} else if (prompt.includes('AGENT:writer')) {
  let mode = 'GOOD-STRUCTURE'
  if (message.includes('BAD-STRUCTURE')) mode = 'BAD-STRUCTURE'
  else if (message.includes('BAD-TONE')) mode = 'BAD-TONE'
  else if (message.includes('GOOD-TONE')) mode = 'GOOD-TONE'
  if (message.includes('# Chain Step')) {
    appendLog('writer-chain-' + mode)
    text = [
      '# Draft Package',
      '',
      'Mode: ' + mode,
      'Topic: Template validator executive summary',
      'Draft Marker: WRITER-CHAIN-DRAFT',
    ].join('\\n')
  } else {
    appendLog('writer-review-' + mode)
    if (mode === 'BAD-STRUCTURE') {
      text = [
        '# Bad Executive Summary Example',
        '',
        'Mode: BAD-STRUCTURE',
        '',
        'This intentionally wrong draft contains enough body text to clear the near-empty guard while still violating the selected executive-summary template headings.',
        '',
        '## Context',
        '',
        'Wrong heading one with enough prose to make the document look superficially complete during the review loop.',
        '',
        '## Key Findings',
        '',
        'Wrong heading two adds more text so the runtime reaches the deterministic template validator instead of failing on length.',
        '',
        '## Recommended Actions',
        '',
        'Wrong heading three keeps the structure invalid because the required template headings are still missing entirely.',
      ].join('\\n')
    } else if (mode === 'BAD-TONE') {
      text = [
        '# Bad Tone Example',
        '',
        'Mode: BAD-TONE',
        '',
        '## Context',
        '',
        'Summarize the source artifact for an internal QA reader.',
        '',
        '## Executive Summary',
        '',
        'The board\\'s conclusion is straightforward: this is a story of selective growth.',
        '',
        '## Main Findings',
        '',
        '- First finding.',
        '',
        '## Recommended Next Steps',
        '',
        '- First next step.',
        '',
        '## Open Questions And Assumptions',
        '',
        '- First open question.',
      ].join('\\n')
    } else {
      text = [
        '# Good Executive Summary Example',
        '',
        'Mode: ' + mode,
        '',
        '## Context',
        '',
        'Summarize the source artifact for an internal QA reader.',
        '',
        '## Executive Summary',
        '',
        'This draft follows the exact template structure and should pass deterministic validation.',
        '',
        '## Main Findings',
        '',
        '- First finding.',
        '',
        '## Recommended Next Steps',
        '',
        '- First next step.',
        '',
        '## Open Questions And Assumptions',
        '',
        '- First open question.',
      ].join('\\n')
    }
  }
} else if (prompt.includes('AGENT:editor')) {
  appendLog('editor-reviewer')
  if (message.includes('Mode: GOOD-STRUCTURE')) {
    text = '<review_decision>APPROVE</review_decision>\\nDeterministic template-validation draft approved.'
  } else {
    text = '<review_decision>REVISE</review_decision>\\nDeterministic reviewer rejects invalid structure.'
  }
}
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    model: 'fake-pi-model',
    usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
    content: [{ type: 'text', text }]
  }
}) + '\\n')
`, async (binDir, logPath) => {
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      const { assignmentDir, reviewText, invocationLog, state } = await runScenario('BAD-STRUCTURE', logPath)

      assert.match(reviewText, /Review Blocked 2\/2/)
      assert.equal(fs.existsSync(path.join(assignmentDir, 'final-draft.md')), false)
      assert.match(fs.readFileSync(path.join(assignmentDir, 'review-feedback-v1.md'), 'utf8'), /Required template heading is missing/)
      assert.match(fs.readFileSync(path.join(assignmentDir, 'review-feedback-v2.md'), 'utf8'), /Required template heading is missing/)
      assert.match(fs.readFileSync(path.join(assignmentDir, 'logs', 'review-events.jsonl'), 'utf8'), /validator\.template-structure\.failed/)
      assert.doesNotMatch(invocationLog, /editor-reviewer/)
      assert.equal(state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
    } finally {
      process.env.PATH = originalPath
    }
  })
})

test('deterministic runtime integration approves a draft that matches the selected template headings', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const promptIdx = args.indexOf('--append-system-prompt')
const promptPath = promptIdx >= 0 ? args[promptIdx + 1] : ''
const messageArg = args.find((arg) => arg.startsWith('@')) || ''
const prompt = promptPath && fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : ''
const message = messageArg ? fs.readFileSync(messageArg.slice(1), 'utf8') : ''
const logPath = process.env.FAKE_PI_LOG || ''
function appendLog(line) {
  if (!logPath) return
  fs.appendFileSync(logPath, line + '\\n')
}
let text = 'NOOP'
if (prompt.includes('AGENT:brief-builder')) {
  appendLog('brief-builder')
  text = [
    '# Structured Brief',
    '',
    'Mode: GOOD-STRUCTURE',
    '',
    '## Document Configuration',
    '',
    '- **Template:** Executive Summary — selected for deterministic executive-summary validation',
    '- **Template confidence:** **High**',
    '- **Style profile:** **strategic-consulting** — selected for deterministic style-profile validation',
  ].join('\\n')
} else if (prompt.includes('AGENT:writer')) {
  if (message.includes('# Chain Step')) {
    appendLog('writer-chain-good')
    text = [
      '# Draft Package',
      '',
      'Mode: GOOD-STRUCTURE',
      'Draft Marker: WRITER-CHAIN-DRAFT',
    ].join('\\n')
  } else {
    appendLog('writer-review-good')
    text = [
      '# Good Executive Summary Example',
      '',
      'Mode: GOOD-STRUCTURE',
      '',
      '## Context',
      '',
      'Summarize the source artifact for an internal QA reader.',
      '',
      '## Executive Summary',
      '',
      'This draft follows the exact template structure and should pass deterministic validation.',
      '',
      '## Main Findings',
      '',
      '- First finding.',
      '',
      '## Recommended Next Steps',
      '',
      '- First next step.',
      '',
      '## Open Questions And Assumptions',
      '',
      '- First open question.',
    ].join('\\n')
  }
} else if (prompt.includes('AGENT:editor')) {
  appendLog('editor-reviewer')
  text = '<review_decision>APPROVE</review_decision>\\nDeterministic template-validation draft approved.'
}
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    model: 'fake-pi-model',
    usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
    content: [{ type: 'text', text }]
  }
}) + '\\n')
`, async (binDir, logPath) => {
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      const { assignmentDir, reviewText, invocationLog, state } = await runScenario('GOOD-STRUCTURE', logPath)

      assert.match(reviewText, /Review Complete 1\/2/)
      assert.equal(fs.existsSync(path.join(assignmentDir, 'final-draft.md')), true)
      const finalDraft = fs.readFileSync(path.join(assignmentDir, 'final-draft.md'), 'utf8')
      assert.match(finalDraft, /## Context/)
      assert.match(finalDraft, /## Executive Summary/)
      assert.match(finalDraft, /## Main Findings/)
      assert.match(finalDraft, /## Recommended Next Steps/)
      assert.match(finalDraft, /## Open Questions And Assumptions/)
      assert.match(fs.readFileSync(path.join(assignmentDir, 'review-feedback-v1.md'), 'utf8'), /<review_decision>APPROVE<\/review_decision>/)
      assert.match(invocationLog, /editor-reviewer/)
      assert.equal(state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    } finally {
      process.env.PATH = originalPath
    }
  })
})

test('deterministic runtime integration blocks banned consultant-tone phrases before reviewer approval', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const promptIdx = args.indexOf('--append-system-prompt')
const promptPath = promptIdx >= 0 ? args[promptIdx + 1] : ''
const messageArg = args.find((arg) => arg.startsWith('@')) || ''
const prompt = promptPath && fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : ''
const message = messageArg ? fs.readFileSync(messageArg.slice(1), 'utf8') : ''
const logPath = process.env.FAKE_PI_LOG || ''
function appendLog(line) {
  if (!logPath) return
  fs.appendFileSync(logPath, line + '\\n')
}
let text = 'NOOP'
if (prompt.includes('AGENT:brief-builder')) {
  appendLog('brief-builder')
  text = [
    '# Structured Brief',
    '',
    'Mode: BAD-TONE',
    '',
    '## Document Configuration',
    '',
    '- **Template:** Executive Summary — selected for deterministic executive-summary validation',
    '- **Template confidence:** **High**',
    '- **Style profile:** **strategic-consulting** — selected for deterministic style-profile validation',
  ].join('\\n')
} else if (prompt.includes('AGENT:writer')) {
  if (message.includes('# Chain Step')) {
    appendLog('writer-chain-bad-tone')
    text = [
      '# Draft Package',
      '',
      'Mode: BAD-TONE',
      'Draft Marker: WRITER-CHAIN-DRAFT',
    ].join('\\n')
  } else {
    appendLog('writer-review-bad-tone')
    text = [
      '# Bad Tone Example',
      '',
      'Mode: BAD-TONE',
      '',
      '## Context',
      '',
      'Summarize the source artifact for an internal QA reader.',
      '',
      '## Executive Summary',
      '',
      'The board\\'s conclusion is straightforward: this is a story of selective growth.',
      '',
      '## Main Findings',
      '',
      '- First finding.',
      '',
      '## Recommended Next Steps',
      '',
      '- First next step.',
      '',
      '## Open Questions And Assumptions',
      '',
      '- First open question.',
    ].join('\\n')
  }
} else if (prompt.includes('AGENT:editor')) {
  appendLog('editor-reviewer')
  text = '<review_decision>APPROVE</review_decision>\\nThis should not be reached.'
}
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    model: 'fake-pi-model',
    usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
    content: [{ type: 'text', text }]
  }
}) + '\\n')
`, async (binDir, logPath) => {
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      const { assignmentDir, reviewText, invocationLog, state } = await runScenario('BAD-TONE', logPath)

      assert.match(reviewText, /Review Blocked 2\/2/)
      assert.equal(fs.existsSync(path.join(assignmentDir, 'final-draft.md')), false)
      assert.match(fs.readFileSync(path.join(assignmentDir, 'review-feedback-v1.md'), 'utf8'), /Draft uses banned phrase/)
      assert.match(fs.readFileSync(path.join(assignmentDir, 'logs', 'review-events.jsonl'), 'utf8'), /validator\.style-profile\.failed/)
      assert.doesNotMatch(invocationLog, /editor-reviewer/)
      assert.equal(state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
    } finally {
      process.env.PATH = originalPath
    }
  })
})
