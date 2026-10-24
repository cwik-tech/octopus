import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Value } from 'typebox/value'

import { createReviewTool, resolveInitialReviewContent } from '../../engines/review.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'
import type { LevelConfig, TeamConfig } from '../../core/types.js'

function makeLevels(): LevelConfig[] {
  return [
    {
      id: 'brief-and-draft',
      name: 'Brief And Draft',
      order: 0,
      stage: {
        type: 'chain',
        sequence: ['brief-builder', 'writer'],
        config: {
          output: {
            format: 'draft-package.md',
            user_review: false,
          },
        },
      },
    },
    {
      id: 'editorial-review',
      name: 'Editorial Review',
      order: 1,
      stage: {
        type: 'review',
        producer: 'writer',
        reviewer: 'editor',
        config: {
          max_iterations: 3,
          output: {
            format: 'final-draft.md',
            user_review: false,
          },
        },
      },
    },
  ] as LevelConfig[]
}

function makeTeamConfig(dir: string): TeamConfig {
  return {
    team: { name: 'writing-team', description: 'test', version: '0.1.0' },
    workspace: { path: dir, watch: false },
    models: {},
    agents: [],
    levels: makeLevels(),
    gates: [],
  } as any
}

test('resolveInitialReviewContent prefers explicit content when provided', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-content-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'assignment draft')
    const result = resolveInitialReviewContent(makeTeamConfig(dir), 'editorial-review', dir, 'explicit content')
    assert.equal(result, 'explicit content')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveInitialReviewContent falls back to the previous level output artifact in the assignment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-content-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'assignment draft')
    const result = resolveInitialReviewContent(makeTeamConfig(dir), 'editorial-review', dir)
    assert.equal(result, 'assignment draft')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review defaults to produce and returns a clear bootstrap error when no draft is available', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-tool-'))
  try {
    const tool = createReviewTool({
      teamName: 'writing-team',
      teamConfig: makeTeamConfig(dir),
      teamRootPath: dir,
      levelId: 'editorial-review',
      config: makeLevels()[1]!.stage as any,
      agents: new Map(),
      rosterEntries: new Map(),
      state: {
        sessionId: 'review-session',
        currentLevelIndex: 1,
        levelStates: new Map([
          ['editorial-review', { status: 'active', loopbackCount: 0, engineState: null }],
        ]),
        totalCost: 0,
        startTime: 0,
        timerStarted: false,
        endTime: null,
        spawnDepth: 0,
        rootSessionId: 'root-session',
        parentSessionId: undefined,
      },
      workspacePath: dir,
      outputPath: dir,
      inputFilesContent: '',
      agentMetrics: new Map(),
      stageFailureOverride: undefined,
      shutdownSignal: undefined,
      budgetLedger: undefined,
      onDashboardUpdate: undefined,
      getCurrentCoordinatorRunId: () => 1,
      coordinatorName: 'editor',
    } as any)

    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? ''
    assert.match(text, /Review bootstrap failed:/)
    assert.match(text, /draft-package\.md/)
    const reviewEventsPath = getAssignmentLogPath(dir, 'review-events.jsonl')
    assert.ok(fs.existsSync(reviewEventsPath))
    const reviewEvents = fs.readFileSync(reviewEventsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    assert.ok(reviewEvents.some((event) => event.step === 'tool.enter'))
    assert.ok(reviewEvents.some((event) => event.step === 'bootstrap.empty'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review tolerates undefined params and still returns a bootstrap error instead of throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-tool-'))
  try {
    const tool = createReviewTool({
      teamName: 'writing-team',
      teamConfig: {
        team: { name: 'writing-team', description: 'test', version: '0.1.0' },
        workspace: { path: dir, watch: false },
        models: {},
        agents: [],
        levels: makeLevels(),
        gates: [],
      } as any,
      teamRootPath: dir,
      levelId: 'editorial-review',
      config: makeLevels()[1]!.stage as any,
      agents: new Map(),
      rosterEntries: new Map(),
      state: {
        sessionId: 'review-session',
        currentLevelIndex: 1,
        levelStates: new Map([
          ['editorial-review', { status: 'active', loopbackCount: 0, engineState: null }],
        ]),
        totalCost: 0,
        startTime: 0,
        timerStarted: false,
        endTime: null,
        spawnDepth: 0,
        rootSessionId: 'root-session',
        parentSessionId: undefined,
      },
      workspacePath: dir,
      outputPath: dir,
      inputFilesContent: '',
      agentMetrics: new Map(),
      stageFailureOverride: undefined,
      shutdownSignal: undefined,
      budgetLedger: undefined,
      onDashboardUpdate: undefined,
      getCurrentCoordinatorRunId: () => 1,
      coordinatorName: 'editor',
    } as any)

    const result = await tool.execute('call-1', undefined as any, undefined as any, undefined as any, undefined as any)
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? ''
    assert.match(text, /Review bootstrap failed:/)
    const reviewEvents = fs.readFileSync(getAssignmentLogPath(dir, 'review-events.jsonl'), 'utf8')
    assert.match(reviewEvents, /"step":"tool.enter"/)
    assert.match(reviewEvents, /"step":"bootstrap.empty"/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review tolerates string params by treating them as content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-tool-'))
  try {
    const tool = createReviewTool({
      teamName: 'writing-team',
      teamConfig: {
        team: { name: 'writing-team', description: 'test', version: '0.1.0' },
        workspace: { path: dir, watch: false },
        models: {},
        agents: [],
        levels: makeLevels(),
        gates: [],
      } as any,
      teamRootPath: dir,
      levelId: 'editorial-review',
      config: makeLevels()[1]!.stage as any,
      agents: new Map(),
      rosterEntries: new Map(),
      state: {
        sessionId: 'review-session',
        currentLevelIndex: 1,
        levelStates: new Map([
          ['editorial-review', { status: 'active', loopbackCount: 0, engineState: null }],
        ]),
        totalCost: 0,
        startTime: 0,
        timerStarted: false,
        endTime: null,
        spawnDepth: 0,
        rootSessionId: 'root-session',
        parentSessionId: undefined,
      },
      workspacePath: dir,
      outputPath: dir,
      inputFilesContent: '',
      agentMetrics: new Map(),
      stageFailureOverride: undefined,
      shutdownSignal: undefined,
      budgetLedger: undefined,
      onDashboardUpdate: undefined,
      getCurrentCoordinatorRunId: () => 1,
      coordinatorName: 'editor',
    } as any)

    const result = await tool.execute('call-1', 'string content' as any, undefined as any, undefined as any, undefined as any)
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? ''
    assert.ok(text.length > 0)
    const reviewEvents = fs.readFileSync(getAssignmentLogPath(dir, 'review-events.jsonl'), 'utf8')
    assert.match(reviewEvents, /"provided_content_length":14/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review schema is an object with optional fields and passthrough extras', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-tool-'))
  try {
    const tool = createReviewTool({
      teamName: 'writing-team',
      teamConfig: {
        team: { name: 'writing-team', description: 'test', version: '0.1.0' },
        workspace: { path: dir, watch: false },
        models: {},
        agents: [],
        levels: makeLevels(),
        gates: [],
      } as any,
      teamRootPath: dir,
      levelId: 'editorial-review',
      config: makeLevels()[1]!.stage as any,
      agents: new Map(),
      rosterEntries: new Map(),
      state: {
        sessionId: 'review-session',
        currentLevelIndex: 1,
        levelStates: new Map([
          ['editorial-review', { status: 'active', loopbackCount: 0, engineState: null }],
        ]),
        totalCost: 0,
        startTime: 0,
        timerStarted: false,
        endTime: null,
        spawnDepth: 0,
        rootSessionId: 'root-session',
        parentSessionId: undefined,
      },
      workspacePath: dir,
      outputPath: dir,
      inputFilesContent: '',
      agentMetrics: new Map(),
      stageFailureOverride: undefined,
      shutdownSignal: undefined,
      budgetLedger: undefined,
      onDashboardUpdate: undefined,
      getCurrentCoordinatorRunId: () => 1,
      coordinatorName: 'editor',
    } as any)

    assert.equal(Value.Check(tool.parameters, {}), true)
    assert.equal(Value.Check(tool.parameters, null), false)
    assert.equal(Value.Check(tool.parameters, undefined), false)
    assert.equal(Value.Check(tool.parameters, { action: 'status' }), true)
    assert.equal(Value.Check(tool.parameters, { content: 'draft content' }), true)
    assert.equal(Value.Check(tool.parameters, { message: 'review this' }), true)
    assert.equal(Value.Check(tool.parameters, { action: 'produce', arbitrary: true }), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
