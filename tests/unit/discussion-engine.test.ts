/**
 * Unit tests for createBriefTool, createSetRosterTool (message updates),
 * and removal of old brief.md from converse.
 *
 * Sprint S1: Assignment Brief Feature
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createDiscussionTool } from '../../engines/discussion.js'
import { createBriefTool, createSetRosterTool } from '../../engines/discussion-tools.js'
import { STAGE_TYPE, STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import type { RuntimeState, DiscussionState, DiscussionStageConfig } from '../../core/types.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeState(): RuntimeState {
  return {
    sessionId: 'test-session-001',
    currentLevelIndex: 0,
    levelStates: new Map(),
    totalCost: 0,
    startTime: Date.now(),
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }
}

function makeConfig(participants: string[] = ['agent-a', 'agent-b']): DiscussionStageConfig {
  return {
    type: STAGE_TYPE.DISCUSSION,
    coordinator: 'problem-decomposer',
    participants,
    config: {
      mode: 'brainstorm' as any,
      min_rounds: 1,
      max_rounds: 3,
      constraints: { max_budget_usd: 10, max_time_minutes: 30 },
      output: { format: 'report.md', user_review: false, path: '' },
    },
  }
}

function makeCtx(
  state: RuntimeState,
  outputPath: string,
  participants: string[] = ['agent-a', 'agent-b'],
): any {
  // Register a levelState
  state.levelStates.set('l1', {
    status: 'active' as any,
    stageStatus: STAGE_LIFECYCLE_STATUS.READY,
    engineState: null,
    loopbackCount: 0,
  })

  return {
    config: makeConfig(participants),
    teamName: 'Test Team',
    levelId: 'l1',
    agents: new Map(),
    rosterEntries: new Map(),
    state,
    workspacePath: outputPath,
    outputPath,
    inputFilesContent: '',
    agentMetrics: new Map(),
    getCurrentCoordinatorRunId: () => 1,
    onDashboardUpdate: undefined,
  }
}

function lockRoster(state: RuntimeState, levelId: string, agents: string[], outputPath: string) {
  const levelState = state.levelStates.get(levelId)!
  const discussion: DiscussionState = {
    type: STAGE_TYPE.DISCUSSION,
    round: 0,
    messages: [],
    outputPath,
    approvedRoster: agents,
  }
  levelState.engineState = discussion
}

function makeBriefParams() {
  return {
    title: 'AgTech Go-To-Market Strategy',
    inquiry: 'How do we enter the European agtech market in 12 months?',
    objectives: ['Identify top 3 market segments', 'Define pricing model', 'Plan launch events'],
    scope: 'European market entry strategy for 2025',
    out_of_scope: 'North America and Asia operations',
    roster_rationale: {
      'agent-a': 'Deep domain expertise in agtech',
      'agent-b': 'Specialist in GTM strategy',
    },
    constraints: 'Budget: €50k. Timeline: 12 months.',
    deliverables: ['Market analysis report', 'GTM playbook', 'Risk assessment'],
  }
}

const noopSignal = undefined as any
const noopUpdate = undefined as any
const noopExt = undefined as any

// ─── createBriefTool — roster gate ──────────────────────────────────────────

test('createBriefTool throws when roster is not locked', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)
    const tool = createBriefTool(ctx)

    await assert.rejects(
      () => tool.execute('tc1', makeBriefParams(), noopSignal, noopUpdate, noopExt),
      /Roster must be locked via set_roster before creating the assignment brief/,
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('set_roster preserves delegated discussion state when startup cleared level states', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)
    state.levelStates.clear()

    await createSetRosterTool(ctx).execute(
      'set-roster',
      { agents: ['agent-a', 'agent-b'] },
      noopSignal,
      noopUpdate,
      noopExt,
    )

    await createBriefTool(ctx).execute(
      'create-brief',
      makeBriefParams(),
      noopSignal,
      noopUpdate,
      noopExt,
    )

    assert.ok(fs.existsSync(path.join(tmpDir, 'brief.md')))
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ─── createBriefTool — successful execution ──────────────────────────────────

test('createBriefTool writes brief.md with correct content when roster is locked', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)
    lockRoster(state, 'l1', ['agent-a', 'agent-b'], tmpDir)

    const tool = createBriefTool(ctx)
    const result = await tool.execute('tc1', makeBriefParams(), noopSignal, noopUpdate, noopExt)

    // Brief file should exist
    const briefPath = path.join(tmpDir, 'brief.md')
    assert.ok(fs.existsSync(briefPath), 'brief.md should be written')

    const content = fs.readFileSync(briefPath, 'utf-8')

    assert.ok(content.startsWith('---\n'), 'should include YAML frontmatter')
    assert.ok(content.includes('artifact_type: "brief"'), 'should record artifact type')
    assert.ok(content.includes('filename: "brief.md"'), 'should record filename')
    assert.ok(content.includes('path: "brief.md"'), 'should record relative path')

    // Check all sections present
    assert.ok(content.includes('# Assignment Brief'), 'should have H1 title')
    assert.ok(content.includes('## Client Inquiry'), 'should have Client Inquiry section')
    assert.ok(content.includes('## Objectives'), 'should have Objectives section')
    assert.ok(content.includes('## Scope'), 'should have Scope section')
    assert.ok(content.includes('## Out of Scope'), 'should have Out of Scope section')
    assert.ok(content.includes('## Team Roster'), 'should have Team Roster section')
    assert.ok(content.includes('## Constraints'), 'should have Constraints section')
    assert.ok(content.includes('## Expected Deliverables'), 'should have Deliverables section')

    // Check data
    assert.ok(content.includes('How do we enter the European agtech market'), 'should include inquiry')
    assert.ok(content.includes('Identify top 3 market segments'), 'should include objectives')
    assert.ok(content.includes('European market entry strategy'), 'should include scope')
    assert.ok(content.includes('North America and Asia operations'), 'should include out_of_scope')
    assert.ok(content.includes('agent-a'), 'should include agent-a in roster')
    assert.ok(content.includes('agent-b'), 'should include agent-b in roster')
    assert.ok(content.includes('Deep domain expertise in agtech'), 'should include rationale')
    assert.ok(content.includes('Budget:'), 'should include constraints')
    assert.ok(content.includes('Market analysis report'), 'should include deliverables')
    assert.ok(content.includes('test-session-001'), 'should include session id')
    assert.ok(content.includes('Test Team'), 'should include team name')

    // Check return value
    assert.ok(Array.isArray(result.content))
    const text = (result.content[0] as any).text as string
    assert.ok(text.includes('✅'), 'should have success indicator')
    assert.ok(text.includes('AgTech Go-To-Market Strategy'), 'should include title in result')
    assert.ok(text.includes('converse'), 'should prompt to call converse next')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('Team chat keeps its assignment brief in the conversation instead of creating a file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)
    ctx.chatMode = true
    lockRoster(state, 'l1', ['agent-a', 'agent-b'], tmpDir)

    const result = await createBriefTool(ctx).execute(
      'tc1',
      makeBriefParams(),
      noopSignal,
      noopUpdate,
      noopExt,
    )
    const text = (result.content[0] as { text: string }).text

    assert.equal(fs.existsSync(path.join(tmpDir, 'brief.md')), false)
    assert.doesNotMatch(text, /Saved to:/)
    assert.match(text, /Chat context prepared/)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('createBriefTool is idempotent — second call overwrites brief.md', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)
    lockRoster(state, 'l1', ['agent-a', 'agent-b'], tmpDir)
    const tool = createBriefTool(ctx)

    const params1 = { ...makeBriefParams(), title: 'First Brief', inquiry: 'First inquiry' }
    const params2 = { ...makeBriefParams(), title: 'Second Brief', inquiry: 'Second inquiry' }

    await tool.execute('tc1', params1, noopSignal, noopUpdate, noopExt)
    await tool.execute('tc2', params2, noopSignal, noopUpdate, noopExt)

    const content = fs.readFileSync(path.join(tmpDir, 'brief.md'), 'utf-8')
    assert.ok(content.includes('Second inquiry'), 'should have second inquiry')
    assert.ok(!content.includes('First inquiry'), 'should not have first inquiry')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('createBriefTool uses "Not specified." when out_of_scope omitted', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)
    lockRoster(state, 'l1', ['agent-a', 'agent-b'], tmpDir)
    const tool = createBriefTool(ctx)

    const params = { ...makeBriefParams() }
    delete (params as any).out_of_scope

    await tool.execute('tc1', params, noopSignal, noopUpdate, noopExt)

    const content = fs.readFileSync(path.join(tmpDir, 'brief.md'), 'utf-8')
    assert.ok(content.includes('Not specified.'), 'should use "Not specified." for missing out_of_scope')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('createBriefTool uses "None specified." when constraints omitted', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)
    lockRoster(state, 'l1', ['agent-a', 'agent-b'], tmpDir)
    const tool = createBriefTool(ctx)

    const params = { ...makeBriefParams() }
    delete (params as any).constraints

    await tool.execute('tc1', params, noopSignal, noopUpdate, noopExt)

    const content = fs.readFileSync(path.join(tmpDir, 'brief.md'), 'utf-8')
    assert.ok(content.includes('None specified.'), 'should use "None specified." for missing constraints')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('createBriefTool creates output directory if it does not exist', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'))
  const nestedPath = path.join(tmpDir, 'deep', 'nested', 'dir')
  try {
    const state = makeState()
    const ctx = makeCtx(state, nestedPath)
    // Set the nested discussion state manually
    state.levelStates.set('l1', {
      status: 'active' as any,
      stageStatus: STAGE_LIFECYCLE_STATUS.READY,
      engineState: {
        type: STAGE_TYPE.DISCUSSION,
        round: 0,
        messages: [],
        outputPath: nestedPath,
        approvedRoster: ['agent-a', 'agent-b'],
      } as DiscussionState,
      loopbackCount: 0,
    })

    const tool = createBriefTool(ctx)
    await tool.execute('tc1', makeBriefParams(), noopSignal, noopUpdate, noopExt)

    assert.ok(fs.existsSync(path.join(nestedPath, 'brief.md')), 'brief.md should be in nested dir')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ─── set_roster messages include create_brief ────────────────────────────────

test('set_roster lock success message mentions create_brief', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)

    const tool = createSetRosterTool(ctx)
    const result = await tool.execute('tc1', { agents: ['agent-a', 'agent-b'] }, noopSignal, noopUpdate, noopExt)

    const text = (result.content[0] as any).text as string
    assert.ok(text.includes('create_brief'), `Lock message should mention create_brief, got: ${text}`)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('set_roster first approved call locks roster immediately', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)

    const tool = createSetRosterTool(ctx)
    await tool.execute('tc1', { agents: ['agent-a', 'agent-b'] }, noopSignal, noopUpdate, noopExt)

    const discussion = state.levelStates.get('l1')?.engineState as DiscussionState
    assert.deepEqual(discussion.approvedRoster, ['agent-a', 'agent-b'])
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('set_roster publishes the complete orchestrator-selected roster', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)
    const selectedRosters: string[][] = []
    ctx.onRosterSelected = (agents: readonly string[]) => {
      selectedRosters.push([...agents])
    }

    await createSetRosterTool(ctx).execute(
      'tc1',
      { agents: ['agent-b'] },
      noopSignal,
      noopUpdate,
      noopExt,
    )

    assert.deepEqual(selectedRosters, [['agent-b']])
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('set_roster already-locked message mentions create_brief', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)
    lockRoster(state, 'l1', ['agent-a', 'agent-b'], tmpDir)

    const tool = createSetRosterTool(ctx)
    // Call with same roster — should return "already locked" message
    const result = await tool.execute('tc1', { agents: ['agent-a', 'agent-b'] }, noopSignal, noopUpdate, noopExt)

    const text = (result.content[0] as any).text as string
    assert.ok(text.includes('create_brief'), `Already-locked message should mention create_brief, got: ${text}`)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ─── converse does NOT write brief.md ────────────────────────────────────────

test('converse does not write brief.md (old inline creation removed)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'converse-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir, ['agent-a'])
    lockRoster(state, 'l1', ['agent-a'], tmpDir)

    const tool = createDiscussionTool(ctx)
    // converse will complete (agent-a not in agents map → "[Agent not found]")
    await tool.execute('tc1', { to: 'agent-a', message: 'Hello' }, noopSignal, noopUpdate, noopExt)

    assert.ok(!fs.existsSync(path.join(tmpDir, 'brief.md')), 'converse should NOT write brief.md')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ─── createBriefTool — objectives numbered, deliverables bulleted ─────────────

test('createBriefTool formats objectives as numbered list', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)
    lockRoster(state, 'l1', ['agent-a', 'agent-b'], tmpDir)
    const tool = createBriefTool(ctx)

    await tool.execute('tc1', makeBriefParams(), noopSignal, noopUpdate, noopExt)

    const content = fs.readFileSync(path.join(tmpDir, 'brief.md'), 'utf-8')
    assert.ok(content.includes('1. Identify top 3 market segments'), 'first objective should be numbered 1.')
    assert.ok(content.includes('2. Define pricing model'), 'second objective should be numbered 2.')
    assert.ok(content.includes('3. Plan launch events'), 'third objective should be numbered 3.')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('createBriefTool formats deliverables as bullet list', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)
    lockRoster(state, 'l1', ['agent-a', 'agent-b'], tmpDir)
    const tool = createBriefTool(ctx)

    await tool.execute('tc1', makeBriefParams(), noopSignal, noopUpdate, noopExt)

    const content = fs.readFileSync(path.join(tmpDir, 'brief.md'), 'utf-8')
    assert.ok(content.includes('- Market analysis report'), 'deliverables should use bullet format')
    assert.ok(content.includes('- GTM playbook'), 'all deliverables should be bullets')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('createBriefTool roster table includes pipe-separated rows', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, tmpDir)
    lockRoster(state, 'l1', ['agent-a', 'agent-b'], tmpDir)
    const tool = createBriefTool(ctx)

    await tool.execute('tc1', makeBriefParams(), noopSignal, noopUpdate, noopExt)

    const content = fs.readFileSync(path.join(tmpDir, 'brief.md'), 'utf-8')
    assert.ok(content.includes('| Agent | Rationale |'), 'should have table header')
    assert.ok(content.includes('| agent-a | Deep domain expertise in agtech |'), 'should have agent-a row')
    assert.ok(content.includes('| agent-b | Specialist in GTM strategy |'), 'should have agent-b row')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ─── Interactive vs delegated roster guidance ───────────────────────────────

const APPROVAL_MARKER = 'ask the user if they are okay with this selection'
const SELF_SELECT_MARKER = 'select the roster yourself'

test('a managed discussion permits blocking questions without asking for roster approval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-questions-'))
  try {
    const ctx = { ...makeCtx(makeState(), dir), delegatedAutostart: true, humanQuestions: true }
    const guidelines = (createDiscussionTool(ctx).promptGuidelines ?? []).join('\n')
    assert.match(guidelines, /blocking question/i)
    assert.doesNotMatch(guidelines, /no user to consult|Do not pause for user confirmation at any point/)
    assert.doesNotMatch(guidelines, new RegExp(APPROVAL_MARKER, 'i'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an interactive discussion asks the user to approve the roster', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-interactive-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, dir)
    ctx.delegatedAutostart = false

    const promptGuidelines = createDiscussionTool(ctx).promptGuidelines ?? []
    const guidelines = promptGuidelines.join('\n')
    const postRoundGuideline = promptGuidelines.find((guideline) =>
      guideline.startsWith('AFTER each converse round:'),
    )
    assert.ok(postRoundGuideline, 'interactive discussion must define post-round guidance')
    assert.match(guidelines, new RegExp(APPROVAL_MARKER, 'i'))
    assert.doesNotMatch(guidelines, new RegExp(SELF_SELECT_MARKER, 'i'))
    assert.match(postRoundGuideline, /wait for their response before calling converse again/i)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a delegated discussion self-selects without post-round user-wait language', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-delegated-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, dir)
    // A delegated child runs headless (-p --no-session): there is no user turn
    // to wait for, so telling it to wait would strand the stage.
    ctx.delegatedAutostart = true

    const promptGuidelines = createDiscussionTool(ctx).promptGuidelines ?? []
    const guidelines = promptGuidelines.join('\n')
    const postRoundGuideline = promptGuidelines.find((guideline) =>
      guideline.startsWith('AFTER each converse round:'),
    )
    assert.ok(postRoundGuideline, 'delegated discussion must define post-round guidance')
    assert.doesNotMatch(guidelines, new RegExp(APPROVAL_MARKER, 'i'))
    assert.doesNotMatch(
      postRoundGuideline,
      /\b(?:approval|ask|await|confirmation|consult|feedback|input|pause|prompt|question|reply|respond|response|user|wait|waiting)\b/i,
    )
    assert.match(guidelines, new RegExp(SELF_SELECT_MARKER, 'i'))
    assert.doesNotMatch(guidelines, /default to exactly 3 participants/i)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a delegated Team chat defaults to three responders but honors an explicit count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-team-chat-roster-'))
  try {
    const state = makeState()
    const ctx = makeCtx(state, dir)
    ctx.delegatedAutostart = true
    ctx.chatMode = true

    const guidelines = (createDiscussionTool(ctx).promptGuidelines ?? []).join('\n')

    assert.match(guidelines, /default to exactly 3 participants/i)
    assert.match(guidelines, /expand to a maximum of 5/i)
    assert.match(guidelines, /explicitly requests a participant count.*honor that count.*greater than 5/i)
    assert.match(guidelines, /fewer than 3.*select all/i)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
