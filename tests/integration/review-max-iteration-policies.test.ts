import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'

type MockDispatchResult =
  | { text: string; skipped?: boolean }
  | Error

let queuedResults: MockDispatchResult[] = []

mock.module('../../domains/agent-execution/failure-policy.js', {
  namedExports: {
    HaltError: class HaltError extends Error {},
    resolveFailurePolicy: () => ({ policy: 'retry', maxRetries: 2 }),
    dispatchWithFailurePolicy: mock.fn(async () => {
      const next = queuedResults.shift()
      if (!next) throw new Error('No mocked review dispatch result queued.')
      if (next instanceof Error) throw next
      return {
        text: next.text,
        skipped: next.skipped ?? false,
        cost: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        contextTokens: 0,
        model: 'mock-model',
      }
    }),
  },
})

const { createReviewTool } = await import('../../engines/review.js')

function makeContext(dir: string, onMaxIterations: 'block' | 'approve_latest' | 'approve_latest_with_warnings' | 'escalate_to_user') {
  return {
    teamName: 'writing-team',
    teamConfig: {
      team: { name: 'writing-team', description: 'test', version: '0.1.0' },
      workspace: { path: dir, watch: false },
      models: {},
      agents: [],
      levels: [
        {
          id: 'brief-and-draft',
          name: 'Brief And Draft',
          order: 0,
          stage: {
            type: 'chain',
            sequence: ['writer'],
            config: {
              output: { format: 'draft-package.md', user_review: false },
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
              max_iterations: 2,
              on_max_iterations: onMaxIterations,
              output: { format: 'final-draft.md', user_review: false },
            },
          },
        },
      ],
      gates: [],
    } as any,
    teamRootPath: dir,
    levelId: 'editorial-review',
    config: {
      type: 'review',
      producer: 'writer',
      reviewer: 'editor',
      config: {
        max_iterations: 2,
        on_max_iterations: onMaxIterations,
        output: { format: 'final-draft.md', user_review: false },
      },
    } as any,
    agents: new Map([
      ['writer', { name: 'writer', systemPrompt: 'Write.', agentDir: dir, experienceEnabled: false }],
      ['editor', { name: 'editor', systemPrompt: 'Review.', agentDir: dir, experienceEnabled: false }],
    ]),
    rosterEntries: new Map([
      ['writer', { name: 'writer', type: 'agent' }],
      ['editor', { name: 'editor', type: 'agent' }],
    ]),
    state: {
      sessionId: 'review-session',
      currentLevelIndex: 1,
      levelStates: new Map([
        ['editorial-review', {
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
  } as any
}

function makeValidDraft(label: string): string {
  return (
    `# ${label}\n\n` +
    `This draft contains enough concrete body text to satisfy the runtime draft validation guard. ` +
    `It covers the assignment clearly, preserves meaningful prose, and gives the reviewer real content to evaluate.`
  )
}

test('review policy block leaves the stage blocked and does not write final output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-policy-int-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      { text: 'REVISE\nNeeds a rewrite.' },
      { text: makeValidDraft('Produced draft v2') },
      { text: 'REVISE\nStill not there.' },
    ]

    const tool = createReviewTool(makeContext(dir, 'block'))
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = (result.content?.[0] as any)?.text ?? ''

    assert.match(text, /Review Blocked 2\/2/)
    assert.equal(fs.existsSync(path.join(dir, 'final-draft.md')), false)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('review policy approve_latest writes final output after hitting the limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-policy-int-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      { text: 'REVISE\nNeeds a rewrite.' },
      { text: makeValidDraft('Produced draft v2') },
      { text: 'REVISE\nStill not there.' },
    ]

    const tool = createReviewTool(makeContext(dir, 'approve_latest'))
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = (result.content?.[0] as any)?.text ?? ''

    assert.match(text, /promoted the latest draft after max iterations/i)
    assert.match(fs.readFileSync(path.join(dir, 'final-draft.md'), 'utf8'), /Produced draft v2/)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('review policy approve_latest_with_warnings writes final output after hitting the limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-policy-int-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      { text: 'REVISE\nNeeds a rewrite.' },
      { text: makeValidDraft('Produced draft v2') },
      { text: 'REVISE\nStill not there.' },
    ]

    const tool = createReviewTool(makeContext(dir, 'approve_latest_with_warnings'))
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = (result.content?.[0] as any)?.text ?? ''

    assert.match(text, /promoted the latest draft with warnings after max iterations/i)
    assert.match(fs.readFileSync(path.join(dir, 'final-draft.md'), 'utf8'), /Produced draft v2/)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('review policy approve_latest_with_warnings blocks instead of promoting TODO placeholders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-policy-int-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      {
        text:
          '# Draft\n\n' +
          'This draft has enough body text to clear the near-empty guard while still remaining invalid for approval because it leaves a required section unresolved for the reviewer. ' +
          '[TODO: Insert actual summary here]\n',
      },
      { text: 'REVISE\nStill incomplete.' },
      {
        text:
          '# Draft\n\n' +
          'This draft still carries unresolved placeholders even after revision and remains incomplete despite having enough prose to pass the near-empty validation threshold used by the runtime.\n\n' +
          '## Placeholders\n\n' +
          '- [TODO: Insert actual summary here]\n',
      },
      { text: 'REVISE\nStill incomplete.' },
    ]

    const tool = createReviewTool(makeContext(dir, 'approve_latest_with_warnings'))
    const result = await tool.execute('call-placeholders', {}, undefined as any, undefined as any, undefined as any)
    const text = (result.content?.[0] as any)?.text ?? ''

    assert.match(text, /Review Blocked 2\/2/)
    assert.match(text, /latest draft is still incomplete/i)
    assert.equal(fs.existsSync(path.join(dir, 'final-draft.md')), false)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// The stage ends here. Nothing is waiting for a reply, so the message must not
// promise that the user can direct it onward: it says the run is over and that
// a new run is how to try again.
test('review policy escalate_to_user ends the run blocked and offers a new run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-policy-int-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      { text: 'REVISE\nNeeds a rewrite.' },
      { text: makeValidDraft('Produced draft v2') },
      { text: 'REVISE\nStill not there.' },
    ]

    const tool = createReviewTool(makeContext(dir, 'escalate_to_user'))
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = (result.content?.[0] as any)?.text ?? ''

    assert.match(text, /Review Blocked 2\/2/)
    assert.match(text, /start a new run/iu)
    assert.doesNotMatch(text, /requires user direction|awaiting|resume/iu)
    assert.equal(fs.existsSync(path.join(dir, 'final-draft.md')), false)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
