/**
 * What the user is told about the roster, and when.
 *
 * A Team chat run picks a subset of the bench on the user's behalf. The choice
 * and the reason for each name have to reach the transcript before the chosen
 * specialists start answering, otherwise the sidebar fills with members whose
 * selection the user never saw explained.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { createDiscussionTool } from '../../engines/discussion.js'
import { createBriefTool, createSetRosterTool } from '../../engines/discussion-tools.js'
import { readTeamChatMessages } from '../../domains/runtime/team-chat-messages.js'
import { STAGE_TYPE, STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import type { DiscussionStageConfig, RuntimeState } from '../../core/types.js'

const noopSignal = undefined as never
const noopUpdate = undefined as never
const noopExt = undefined as never

function makeState(): RuntimeState {
  return {
    sessionId: 'chat-session-001',
    currentLevelIndex: 0,
    levelStates: new Map(),
    totalCost: 0,
    startTime: Date.now(),
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }
}

function makeConfig(participants: string[]): DiscussionStageConfig {
  return {
    type: STAGE_TYPE.DISCUSSION,
    coordinator: 'problem-decomposer',
    participants,
    config: {
      mode: 'deliberate' as never,
      min_rounds: 1,
      max_rounds: 1,
      constraints: { max_budget_usd: 10, max_time_minutes: 30 },
      output: { format: 'report.md', user_review: false, path: '' },
    },
  }
}

function makeChatCtx(
  state: RuntimeState,
  outputPath: string,
  participants: string[] = ['agent-a', 'agent-b', 'agent-c'],
): never {
  state.levelStates.set('l1', {
    status: 'active' as never,
    stageStatus: STAGE_LIFECYCLE_STATUS.READY,
    engineState: null,
    loopbackCount: 0,
  })
  return {
    config: makeConfig(participants),
    teamName: 'Test Team',
    levelId: 'l1',
    chatMode: true,
    agents: new Map(),
    rosterEntries: new Map(),
    state,
    workspacePath: outputPath,
    outputPath,
    inputFilesContent: '',
    agentMetrics: new Map(),
    getCurrentCoordinatorRunId: () => 1,
    onDashboardUpdate: undefined,
  } as never
}

const RATIONALE_BY_AGENT: Record<string, string> = {
  'agent-a': 'Owns the capital model.',
  'agent-b': 'Knows the retooling risk.',
}

function makeBriefParams(roster: readonly string[] = ['agent-a', 'agent-b']) {
  return {
    title: 'Manufacturing investment',
    inquiry: 'What should we invest in?',
    objectives: ['Rank the options'],
    scope: 'Capital allocation for one plant',
    roster_rationale: Object.fromEntries(
      roster.map((name) => [name, RATIONALE_BY_AGENT[name] ?? `${name} was asked.`]),
    ),
    deliverables: ['A recommendation'],
  }
}

test('a Team chat coordinator announces the chosen roster with a rationale for each name', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-announce-'))
  try {
    const state = makeState()
    const ctx = makeChatCtx(state, tmpDir)

    // The coordinator's own order, deliberately the reverse of the rationale
    // map, so the announcement cannot be passing by object key order.
    await createSetRosterTool(ctx).execute(
      'roster-call',
      { agents: ['agent-b', 'agent-a'] },
      noopSignal,
      noopUpdate,
      noopExt,
    )
    await createBriefTool(ctx).execute(
      'brief-call',
      makeBriefParams(),
      noopSignal,
      noopUpdate,
      noopExt,
    )

    const messages = readTeamChatMessages(tmpDir)
    assert.equal(messages.length, 1)
    const announcement = messages[0]
    assert.equal(announcement?.agent_name, 'problem-decomposer')
    assert.equal(announcement?.message_type, 'framing')
    const text = announcement?.text ?? ''
    assert.ok(text.includes('agent-b'), 'the announcement must name every selected agent')
    assert.ok(text.includes('agent-a'), 'the announcement must name every selected agent')
    assert.ok(
      text.includes('Knows the retooling risk.') &&
        text.includes('Owns the capital model.'),
      'the announcement must carry each selected agent\'s rationale',
    )
    assert.ok(
      text.indexOf('agent-b') < text.indexOf('agent-a'),
      'the announcement must follow the locked roster order',
    )
    assert.ok(
      !text.includes('agent-c'),
      'an unselected member must not appear in the announcement',
    )
    assert.ok(
      !fs.existsSync(path.join(tmpDir, 'brief.md')),
      'Team chat prepares context in memory rather than publishing a brief file',
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('a Team chat discussion refuses to dispatch participants before the roster is announced', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-announce-gate-'))
  try {
    const state = makeState()
    const ctx = makeChatCtx(state, tmpDir)

    await createSetRosterTool(ctx).execute(
      'roster-call',
      { agents: ['agent-a'] },
      noopSignal,
      noopUpdate,
      noopExt,
    )

    await assert.rejects(
      () =>
        createDiscussionTool(ctx).execute(
          'converse-call',
          { to: 'all', message: 'Which option is strongest?' },
          noopSignal,
          noopUpdate,
          noopExt,
        ),
      /create_brief/,
    )

    await createBriefTool(ctx).execute(
      'brief-call',
      makeBriefParams(['agent-a']),
      noopSignal,
      noopUpdate,
      noopExt,
    )
    await createDiscussionTool(ctx).execute(
      'converse-call',
      { to: 'all', message: 'Which option is strongest?' },
      noopSignal,
      noopUpdate,
      noopExt,
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('a brief must give every locked agent a reason and name no one else', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-rationale-'))
  try {
    const state = makeState()
    const ctx = makeChatCtx(state, tmpDir)
    await createSetRosterTool(ctx).execute(
      'roster-call',
      { agents: ['agent-a', 'agent-b'] },
      noopSignal,
      noopUpdate,
      noopExt,
    )
    const brief = createBriefTool(ctx)

    await assert.rejects(
      () =>
        brief.execute(
          'missing-call',
          { ...makeBriefParams(), roster_rationale: { 'agent-a': 'Owns the capital model.' } },
          noopSignal,
          noopUpdate,
          noopExt,
        ),
      /agent-b/,
      'a selected agent with no reason must be refused',
    )
    await assert.rejects(
      () =>
        brief.execute(
          'blank-call',
          {
            ...makeBriefParams(),
            roster_rationale: { 'agent-a': 'Owns the capital model.', 'agent-b': '   ' },
          },
          noopSignal,
          noopUpdate,
          noopExt,
        ),
      /agent-b/,
      'a blank reason is not a reason',
    )
    await assert.rejects(
      () =>
        brief.execute(
          'extra-call',
          {
            ...makeBriefParams(),
            roster_rationale: {
              'agent-a': 'Owns the capital model.',
              'agent-b': 'Knows the retooling risk.',
              'agent-c': 'Was never selected.',
            },
          },
          noopSignal,
          noopUpdate,
          noopExt,
        ),
      /agent-c/,
      'a reason for an unselected agent must be refused',
    )

    assert.deepEqual(
      readTeamChatMessages(tmpDir),
      [],
      'a refused brief announces nothing',
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
