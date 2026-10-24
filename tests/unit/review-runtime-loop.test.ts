import test, { mock } from 'node:test'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'
import { parseResearchPublicationAudit } from '../../domains/deep-research/deep-research-publication-audit.js'

type MockDispatchResult =
  | { text: string; skipped?: boolean; interruption?: { kind: 'awaiting_input'; interactionId: string } }
  | Error

let queuedResults: MockDispatchResult[] = []
let dispatchCalls: Array<{ finalPrompt?: string; userMessage?: string; agentName?: string }> = []
const UNUSED_EXTENSION_CONTEXT: ExtensionToolContext = Object.create(null)

mock.module('../../domains/agent-execution/failure-policy.js', {
  namedExports: {
    HaltError: class HaltError extends Error {
      agentName: string
      originalError: string

      constructor(agentName: string, originalError: string) {
        super(originalError)
        this.name = 'HaltError'
        this.agentName = agentName
        this.originalError = originalError
      }
    },
    // `isLevelReadyForGate` reaches deep-research observers, which import this
    // from the same module. A module mock replaces the whole module, so it has
    // to be present or the import graph fails to link.
    DispatchResultValidationError: class DispatchResultValidationError extends Error {},
    resolveFailurePolicy: () => ({ policy: 'retry', maxRetries: 2 }),
    dispatchWithFailurePolicy: mock.fn(async (options: any) => {
      dispatchCalls.push({
        finalPrompt: options?.finalPrompt,
        userMessage: options?.userMessage,
        agentName: options?.agent?.name,
      })
      const next = queuedResults.shift()
      if (!next) throw new Error('No mocked review dispatch result queued.')
      if (next instanceof Error) throw next
      return {
        text: next.text,
        skipped: next.skipped ?? false,
        ...(next.interruption ? { interruption: next.interruption } : {}),
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
const { isLevelReadyForGate } = await import('../../team-runtime/level-lifecycle.js')

function makeLevels(maxIterations = 3) {
  return [
    {
      id: 'brief-and-draft',
      name: 'Brief And Draft',
      order: 0,
      stage: {
        type: 'chain',
        sequence: ['writer'],
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
          max_iterations: maxIterations,
          output: {
            format: 'final-draft.md',
            user_review: false,
          },
        },
      },
    },
  ] as any
}

function makeContext(dir: string, maxIterations = 3) {
  const levels = makeLevels(maxIterations)
  return {
    teamName: 'writing-team',
    teamConfig: {
      team: { name: 'writing-team', description: 'test', version: '0.1.0' },
      workspace: { path: dir, watch: false },
      models: {},
      agents: [],
      levels,
      gates: [],
    } as any,
    teamRootPath: dir,
    levelId: 'editorial-review',
    config: levels[1]!.stage,
    agents: new Map([
      ['writer', { name: 'writer', systemPrompt: 'Writer task:\n{{TASK_CONTENT}}', agentDir: dir, experienceEnabled: false }],
      ['editor', { name: 'editor', systemPrompt: 'Reviewer task:\n{{TASK_CONTENT}}', agentDir: dir, experienceEnabled: false }],
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

function readTextResult(result: any): string {
  return (result.content?.[0] as { text?: string } | undefined)?.text ?? ''
}

/** Returns everything after the first line equal to `heading`, failing when no such line exists. */
function textAfterHeading(message: string, heading: string): string {
  const lines = message.split('\n')
  const index = lines.indexOf(heading)
  assert.notEqual(index, -1, `Expected a "${heading}" line in:\n${message}`)
  return lines.slice(index + 1).join('\n')
}

/** Returns the bullet lines of the "Rules:" list in a reviewer request. */
function reviewRules(message: string): string[] {
  const rules: string[] = []
  for (const line of textAfterHeading(message, 'Rules:').split('\n')) {
    if (!line.startsWith('- ')) break
    rules.push(line)
  }
  return rules
}

function makeValidDraft(label: string): string {
  return (
    `# ${label}\n\n` +
    `This draft contains enough concrete body text to satisfy the runtime draft validation guard. ` +
    `It covers the assignment clearly, preserves meaningful prose, and gives the reviewer real content to evaluate.`
  )
}

function writeExecutiveSummaryTemplateFixture(dir: string) {
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'templates', 'executive-summary.md'),
    `---
template_name: executive-summary
document_type: one-pager
sections_required:
  - Context
  - Executive Summary
  - Main Findings
  - Recommended Next Steps
  - Open Questions And Assumptions
---

# Executive Summary
`,
  )
}

function writeBriefBuilderTemplateSelectionFixture(dir: string) {
  fs.writeFileSync(
    path.join(dir, 'chain-step-1-brief-builder.md'),
    `# Writing Brief

## Document Configuration

- **Template:** Executive Summary - selected for a concise one-page synthesis.
- **Template confidence:** **High**
- **Style profile:** **strategic-consulting** - selected for consultant-style synthesis.
`,
  )
}

function writeStrategicConsultingProfileFixture(dir: string) {
  fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'profiles', 'strategic-consulting.yaml'),
    `name: strategic-consulting
forbidden_hedges:
  - "straightforward"
  - "the story is"
  - "boring"
banned_additional:
  - "the board's conclusion is straightforward"
  - "looks much more attractive"
`,
  )
}

function makeExecutiveSummaryDraftWithRequiredSections(): string {
  return (
    '# Executive Summary Example\n\n' +
    'A short top matter paragraph keeps the document readable while preserving the template structure.\n\n' +
    '## Context\n\n' +
    'Summarize the source discussion into a one-page decision-ready brief for a general business reader.\n\n' +
    '## Executive Summary\n\n' +
    'The source material points to a narrow set of practical conclusions, and the summary turns them into a clear answer with direct implications for the reader.\n\n' +
    '## Main Findings\n\n' +
    '- Finding one explains the durable pattern in the source material.\n' +
    '- Finding two explains the main trade-off and why it matters.\n' +
    '- Finding three clarifies the conclusion without drifting into transcript recap.\n\n' +
    '## Recommended Next Steps\n\n' +
    '- Validate the key assumption against the operating context.\n' +
    '- Decide which action should be taken first and by whom.\n' +
    '- Capture unresolved dependency risks before execution.\n\n' +
    '## Open Questions And Assumptions\n\n' +
    '- One uncertainty still affects confidence and should be monitored.\n' +
    '- One assumption underpins the recommendation and should be made explicit.\n'
  )
}

test('submit_for_review completes on first-pass approval in a single call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      { text: 'APPROVE\nLooks good.' },
    ]

    const ctx = makeContext(dir, 3)
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Review Complete 1\/3/)
    assert.match(text, /APPROVE/)
    assert.equal(fs.existsSync(path.join(dir, 'draft-v1.md')), true)
    assert.equal(fs.existsSync(path.join(dir, 'review-feedback-v1.md')), true)
    assert.equal(
      fs.readFileSync(path.join(dir, 'final-draft.md'), 'utf8').includes('This draft contains enough concrete body text'),
      true,
    )
    const finalDraft = fs.readFileSync(path.join(dir, 'final-draft.md'), 'utf8')
    assert.match(finalDraft, /agent: "runtime"/)
    assert.match(finalDraft, /from: "writer"/)
    assert.match(finalDraft, /to: "editor"/)
    assert.match(finalDraft, /supersedes: "draft-v1.md"/)
    const reviewFeedback = fs.readFileSync(path.join(dir, 'review-feedback-v1.md'), 'utf8')
    assert.match(reviewFeedback, /APPROVE/)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.engineState?.iteration, 1)
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review audits a canonical copy while preserving the editorial draft', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  const validatedUrl = 'https://validated.example/report'
  const unvalidatedUrl = 'https://unvalidated.example/mention'
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial publication draft input')
    fs.mkdirSync(path.join(dir, 'research', 'evidence-graph'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'research-package.md'),
      `# Research package\n\nThe source supports the bounded decision ([source](${validatedUrl})).\n`,
    )
    fs.writeFileSync(
      path.join(dir, 'research', 'evidence-graph', 'current.json'),
      JSON.stringify({
        schemaVersion: 1,
        planId: 'plan-one',
        approvedPlanHash: 'a'.repeat(64),
        correctionWave: 0,
        generatedAt: '2026-08-28T12:00:00.000Z',
        requirements: [],
        claims: [],
        sources: [{
          id: 'source-one',
          canonicalUrl: validatedUrl,
          title: 'Validated report',
          publisher: 'Validated publisher',
          independenceKey: 'validated.example',
          sourceType: 'primary',
          status: 'usable',
          observedAt: '2026-08-28T12:00:00.000Z',
          freshness: 'current',
        }],
        edges: [],
        contradictions: [],
        unresolvedQuestions: [],
        gaps: [],
        coverage: {
          requiredRequirements: 0,
          satisfiedRequirements: 0,
          supportedClaims: 0,
          totalClaims: 0,
          crossVerifiedConsequentialClaims: 0,
          consequentialClaims: 0,
        },
      }),
    )
    queuedResults = [
      {
        text:
          '# Editorial draft\n\n' +
          `The validated source supports the bounded decision ([source](${validatedUrl})).\n\n` +
          `A secondary mention appears at ${unvalidatedUrl}.\n\n` +
          'The report contains enough concrete body text for the reviewer to assess its evidence fidelity and publication readiness.',
      },
      { text: '<review_decision>APPROVE</review_decision>' },
    ]

    const ctx = makeContext(dir, 1)
    ctx.config.config.research_publication_validation = {
      source_artifact: 'research-package.md',
      evidence_graph_artifact: 'research/evidence-graph/current.json',
      audit_artifact: 'publication-audit.json',
    }
    const tool = createReviewTool(ctx)

    const result = await tool.execute(
      'call-1',
      {},
      undefined,
      undefined,
      UNUSED_EXTENSION_CONTEXT,
    )

    assert.match(readTextResult(result), /Review Complete 1\/1/)
    const finalDraft = fs.readFileSync(path.join(dir, 'final-draft.md'), 'utf8')
    assert.match(finalDraft, new RegExp(unvalidatedUrl.replaceAll('.', '\\.')))
    const audit = parseResearchPublicationAudit(
      JSON.parse(fs.readFileSync(path.join(dir, 'publication-audit.json'), 'utf8')),
    )
    assert.equal(audit.decision, 'APPROVE')
    assert.deepEqual(audit.violations, [])
    assert.deepEqual(audit.sourceSummary.publicationUrls, [validatedUrl])
    assert.equal(audit.canonicalization?.removedUnknownUrls.length, 1)
    assert.equal(audit.canonicalization?.removedUnknownUrls[0]?.url, unvalidatedUrl)
    assert.equal(audit.canonicalization?.removedUnknownUrls[0]?.kind, 'bare_url')
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review blocks by default when the reviewer dispatch is skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      { text: 'Reviewer unavailable', skipped: true },
    ]

    const ctx = makeContext(dir, 1)
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)

    assert.match(readTextResult(result), /Review Blocked 1\/1/)
    assert.equal(fs.existsSync(path.join(dir, 'final-draft.md')), false)
    assert.match(fs.readFileSync(path.join(dir, 'review-feedback-v1.md'), 'utf8'), /approval is required/i)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review only auto-approves a skipped reviewer when explicitly configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      { text: 'Reviewer unavailable', skipped: true },
    ]

    const ctx = makeContext(dir, 1)
    ctx.config.config.on_reviewer_skip = 'approve_latest'
    ctx.teamConfig.levels[1].stage.config.on_reviewer_skip = 'approve_latest'
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)

    assert.match(readTextResult(result), /Review Complete 1\/1/)
    assert.equal(fs.existsSync(path.join(dir, 'final-draft.md')), true)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review handles revise-then-approve without a second coordinator call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  const draftV1 = makeValidDraft('Produced draft v1')
  const draftV2 = makeValidDraft('Produced draft v2')
  const firstFeedback = 'REVISE\nTighten the argument.'
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    dispatchCalls = []
    queuedResults = [
      { text: draftV1 },
      { text: firstFeedback },
      { text: draftV2 },
      { text: 'APPROVE\nNow approved.' },
    ]

    const ctx = makeContext(dir, 3)
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Iteration 1: REVISE/)
    assert.match(text, /Iteration 2: APPROVE/)
    assert.equal(fs.existsSync(path.join(dir, 'draft-v1.md')), true)
    assert.equal(fs.existsSync(path.join(dir, 'draft-v2.md')), true)
    assert.equal(fs.existsSync(path.join(dir, 'review-feedback-v1.md')), true)
    assert.equal(fs.existsSync(path.join(dir, 'review-feedback-v2.md')), true)
    assert.equal(fs.existsSync(path.join(dir, 'review-draft-v1.md')), false)
    assert.equal(fs.existsSync(path.join(dir, 'review-draft-v2.md')), false)
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => /draft-v\d+\.md$/.test(name)).sort(),
      ['draft-v1.md', 'draft-v2.md'],
      'Iteration drafts are named draft-vN.md and nothing else',
    )
    assert.equal(
      fs.readFileSync(path.join(dir, 'final-draft.md'), 'utf8').includes('Produced draft v2'),
      true,
    )
    const secondWriterDispatch = dispatchCalls.find((call, index) =>
      call.agentName === 'writer' && index >= 2,
    )
    assert.ok(secondWriterDispatch)
    assert.match(secondWriterDispatch.userMessage ?? '', /# Revision Request \(Iteration 2\)/)
    assert.match(secondWriterDispatch.userMessage ?? '', /Previous feedback from reviewer:/)
    assert.match(secondWriterDispatch.userMessage ?? '', /Tighten the argument\./)
    assert.match(secondWriterDispatch.finalPrompt ?? '', /# Revision Request \(Iteration 2\)/)
    assert.match(secondWriterDispatch.finalPrompt ?? '', /Current Draft/)
    assert.match(secondWriterDispatch.finalPrompt ?? '', /Tighten the argument\./)

    // The writer's revision request carries the draft under revision and the reviewer's feedback.
    const writerRequests = dispatchCalls.filter((call) => call.agentName === 'writer')
    assert.equal(writerRequests.length, 2)
    for (const revisionRequest of [writerRequests[1]?.userMessage ?? '', writerRequests[1]?.finalPrompt ?? '']) {
      assert.ok(textAfterHeading(revisionRequest, '## Current Draft').includes(draftV1))
      assert.ok(revisionRequest.includes(firstFeedback))
    }
    // The max-iterations fallback refuses to promote a draft that still has this section, so the writer is told about it by name.
    assert.match(writerRequests[1]?.userMessage ?? '', /## Placeholders/)

    // The second review carries the first review's feedback as blocking guidance, with the same rules and verdict format.
    const reviewerRequests = dispatchCalls
      .filter((call) => call.agentName === 'editor')
      .map((call) => call.userMessage ?? '')
    assert.equal(reviewerRequests.length, 2)
    const [firstReviewerRequest = '', secondReviewerRequest = ''] = reviewerRequests
    assert.doesNotMatch(firstReviewerRequest, /^## Previous Blocking Guidance$/m)
    assert.match(secondReviewerRequest, /^# Review Request \(Iteration 2\)$/m)
    assert.ok(textAfterHeading(secondReviewerRequest, '## Previous Blocking Guidance').includes(firstFeedback))
    assert.ok(secondReviewerRequest.includes(draftV2))
    for (const heading of ['## Instructions', '## Blocking Issues', '## Warnings']) {
      assert.match(secondReviewerRequest, new RegExp(`^${heading}$`, 'm'))
    }
    assert.ok(secondReviewerRequest.includes('<review_decision>APPROVE</review_decision>'))
    assert.ok(secondReviewerRequest.includes('<review_decision>REVISE</review_decision>'))
    const firstRoundRules = reviewRules(firstReviewerRequest)
    assert.notEqual(firstRoundRules.length, 0, 'The reviewer request lists review rules')
    const secondRoundRules = reviewRules(secondReviewerRequest)
    assert.deepEqual(
      firstRoundRules.filter((rule) => !secondRoundRules.includes(rule)),
      [],
      'Every first-round review rule is repeated in the second review',
    )
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.engineState?.iteration, 2)
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review accepts a tagged approval even when reviewer chatter appears first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      { text: 'Checking files first.\n<review_decision>APPROVE</review_decision>\nLooks good.' },
    ]

    const ctx = makeContext(dir, 3)
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Review Complete 1\/3/)
    assert.equal(fs.existsSync(path.join(dir, 'final-draft.md')), true)
    const feedback = fs.readFileSync(path.join(dir, 'review-feedback-v1.md'), 'utf8')
    assert.match(feedback, /<review_decision>APPROVE<\/review_decision>/)
    assert.doesNotMatch(feedback, /Checking files first\./)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review treats multiple tagged reviewer decisions as an invalid verdict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      {
        text:
          '<review_decision>REVISE</review_decision>\nNeed changes.\n' +
          '<review_decision>APPROVE</review_decision>\nActually approved.',
      },
    ]

    const ctx = makeContext(dir, 1)
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Review Blocked 1\/1/)
    const feedback = fs.readFileSync(path.join(dir, 'review-feedback-v1.md'), 'utf8')
    assert.match(feedback, /Invalid review verdict/)
    assert.equal(fs.existsSync(path.join(dir, 'final-draft.md')), false)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review blocks the stage after max iterations without approval', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      { text: 'REVISE\nNeeds a rewrite.' },
      { text: makeValidDraft('Produced draft v2') },
      { text: 'REVISE\nStill not there.' },
    ]

    const ctx = makeContext(dir, 2)
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Review Blocked 2\/2/)
    assert.equal(fs.existsSync(path.join(dir, 'final-draft.md')), false)
    assert.equal(fs.existsSync(path.join(dir, 'draft-v1.md')), true)
    assert.equal(fs.existsSync(path.join(dir, 'draft-v2.md')), true)
    assert.equal(fs.existsSync(path.join(dir, 'review-feedback-v1.md')), true)
    assert.equal(fs.existsSync(path.join(dir, 'review-feedback-v2.md')), true)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.engineState?.lastVerdict, 'revise')
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review can promote the latest draft with warnings after max iterations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      { text: 'REVISE\nNeeds a stronger example.' },
      { text: makeValidDraft('Produced draft v2') },
      { text: 'REVISE\nStill a bit generic.' },
    ]

    const ctx = makeContext(dir, 2)
    ctx.config.config.on_max_iterations = 'approve_latest_with_warnings'
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Review Complete 2\/2/)
    assert.match(text, /promoted the latest draft with warnings/i)
    assert.equal(fs.existsSync(path.join(dir, 'final-draft.md')), true)
    const finalDraft = fs.readFileSync(path.join(dir, 'final-draft.md'), 'utf8')
    assert.match(finalDraft, /status: "approved_with_warnings"/)
    assert.match(finalDraft, /verdict: "MAX_ITERATIONS_APPROVE_WITH_WARNINGS"/)
    assert.match(finalDraft, /Produced draft v2/)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.engineState?.lastVerdict, 'approve')
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review treats invalid reviewer verdicts as revision cycles until the limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      { text: 'This verdict is malformed.' },
    ]

    const ctx = makeContext(dir, 1)
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Review Blocked 1\/1/)
    assert.equal(fs.existsSync(path.join(dir, 'final-draft.md')), false)
    assert.equal(fs.existsSync(path.join(dir, 'draft-v1.md')), true)
    assert.equal(fs.existsSync(path.join(dir, 'review-feedback-v1.md')), true)
    assert.match(ctx.state.levelStates.get('editorial-review')?.engineState?.lastFeedback ?? '', /Invalid review verdict/)
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review prefers the producer artifact written to OUTPUT_PATH over raw producer narration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    fs.writeFileSync(
      path.join(dir, 'draft-v1.md'),
      '# Canonical review draft\n\n' +
      'Actual producer artifact body with enough concrete prose to satisfy the runtime validation guard. ' +
      'This ensures the review loop uses the persisted artifact body rather than the raw producer narration.',
    )
    queuedResults = [
      { text: makeValidDraft('Producer progress report instead of the draft') },
      { text: 'APPROVE\nLooks good.' },
    ]

    const ctx = makeContext(dir, 3)
    const tool = createReviewTool(ctx)
    await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)

    const finalBody = fs.readFileSync(path.join(dir, 'final-draft.md'), 'utf8')
    assert.match(finalBody, /Actual producer artifact body/)
    assert.doesNotMatch(finalBody, /Producer progress report instead of the draft/)
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review fails fast when a later revision draft is empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      { text: 'REVISE\nTighten the argument.' },
      { text: '' },
    ]

    const ctx = makeContext(dir, 3)
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)
    const reviewEvents = fs.readFileSync(getAssignmentLogPath(dir, 'review-events.jsonl'), 'utf8')

    assert.match(text, /Producer returned an empty draft on review iteration 2\./)
    assert.match(reviewEvents, /"step":"producer\.output\.invalid"/)
    assert.doesNotMatch(reviewEvents, /"step":"reviewer\.dispatch\.start".*"iteration":2/)
    assert.equal(fs.existsSync(path.join(dir, 'review-feedback-v2.md')), false)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.FAILED)
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review fails fast when a revision draft is near-empty after normalization', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: makeValidDraft('Produced draft v1') },
      { text: 'REVISE\nTighten the argument.' },
      { text: '# Title\n\nShort fragment only.' },
    ]

    const ctx = makeContext(dir, 3)
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Producer returned a near-empty draft on review iteration 2/)
    assert.equal(fs.existsSync(path.join(dir, 'review-feedback-v2.md')), false)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.FAILED)
  } finally {
    queuedResults = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review blocks approval when the draft violates the selected template headings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    writeExecutiveSummaryTemplateFixture(dir)
    writeBriefBuilderTemplateSelectionFixture(dir)
    writeStrategicConsultingProfileFixture(dir)
    dispatchCalls = []
    queuedResults = [
      {
        text:
          '# Wrong Structure\n\n' +
          'This draft contains enough concrete body text to satisfy the runtime draft validation guard while still missing the required template headings.\n\n' +
          '## Context\n\n' +
          'This section should have been named Task according to the selected template.\n\n' +
          '## Key Findings\n\n' +
          '- A misplaced heading still contains substantive content.\n\n' +
          '## Recommended Actions\n\n' +
          '- Another renamed heading keeps the prose readable but breaks the template contract.\n',
      },
    ]

    const ctx = makeContext(dir, 1)
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)
    const feedback = fs.readFileSync(path.join(dir, 'review-feedback-v1.md'), 'utf8')

    assert.match(text, /Review Blocked 1\/1/)
    assert.match(feedback, /<review_decision>REVISE<\/review_decision>/)
    assert.match(feedback, /Required template heading is missing/)
    assert.doesNotMatch(feedback, /## Context/)
    assert.match(feedback, /## Executive Summary/)
    assert.equal(fs.existsSync(path.join(dir, 'final-draft.md')), false)
    assert.equal(dispatchCalls.filter((call) => call.agentName === 'editor').length, 0)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review keeps normal approval flow when the draft matches the selected template headings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    writeExecutiveSummaryTemplateFixture(dir)
    writeBriefBuilderTemplateSelectionFixture(dir)
    writeStrategicConsultingProfileFixture(dir)
    dispatchCalls = []
    queuedResults = [
      { text: makeExecutiveSummaryDraftWithRequiredSections() },
      { text: 'APPROVE\nTemplate structure and content are acceptable.' },
    ]

    const ctx = makeContext(dir, 2)
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)

    assert.match(text, /Review Complete 1\/2/)
    assert.equal(fs.existsSync(path.join(dir, 'final-draft.md')), true)
    assert.equal(dispatchCalls.filter((call) => call.agentName === 'editor').length, 1)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit_for_review blocks approval when the draft uses banned style-profile phrases', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    writeExecutiveSummaryTemplateFixture(dir)
    writeBriefBuilderTemplateSelectionFixture(dir)
    writeStrategicConsultingProfileFixture(dir)
    dispatchCalls = []
    queuedResults = [
      {
        text:
          '# Executive Summary Example\n\n' +
          '## Context\n\n' +
          'Summarize the board discussion for an executive reader.\n\n' +
          '## Executive Summary\n\n' +
          'The board\'s conclusion is straightforward: the answer is more selective than the market narrative suggests.\n\n' +
          '## Main Findings\n\n' +
          '- One finding keeps the draft structurally valid.\n\n' +
          '## Recommended Next Steps\n\n' +
          '- One action keeps the draft decision-oriented.\n\n' +
          '## Open Questions And Assumptions\n\n' +
          '- One question remains unresolved.\n',
      },
    ]

    const ctx = makeContext(dir, 1)
    const tool = createReviewTool(ctx)
    const result = await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)
    const text = readTextResult(result)
    const feedback = fs.readFileSync(path.join(dir, 'review-feedback-v1.md'), 'utf8')

    assert.match(text, /Review Blocked 1\/1/)
    assert.match(feedback, /Draft uses banned phrase/)
    assert.match(feedback, /the board's conclusion is straightforward/i)
    assert.match(fs.readFileSync(path.join(dir, 'logs', 'review-events.jsonl'), 'utf8'), /validator\.style-profile\.failed/)
    assert.equal(fs.existsSync(path.join(dir, 'final-draft.md')), false)
    assert.equal(dispatchCalls.filter((call) => call.agentName === 'editor').length, 0)
    assert.equal(ctx.state.levelStates.get('editorial-review')?.stageStatus, STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The engine leaves an unfinished phase behind at three independent ordinary
 * exits. Each gets its own case so removing the cleanup from any one of them
 * fails here.
 */
const ORDINARY_REVIEW_FAILURES = [
  { name: 'the producer dispatch fails', queued: () => [new Error('Producer provider exploded.')] },
  {
    name: 'the producer returns a near-empty draft',
    queued: () => [{ text: '# Draft\n\nToo short.' }],
  },
  {
    name: 'the reviewer dispatch fails',
    queued: () => [{ text: makeValidDraft('Produced draft v1') }, new Error('Reviewer provider exploded.')],
  },
] as const

for (const scenario of ORDINARY_REVIEW_FAILURES) {
  test(`a review is not offered to the gate as a finished stage when ${scenario.name} on its last iteration`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
    try {
      fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
      queuedResults = [...scenario.queued()]
      const ctx = makeContext(dir, 1)
      const phases: Array<string | undefined> = []
      ctx.onStateCheckpoint = () => {
        phases.push(ctx.state.levelStates.get('editorial-review')?.engineState?.pendingPhase)
      }
      const tool = createReviewTool(ctx)

      await tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any)

      const engineState = ctx.state.levelStates.get('editorial-review')?.engineState
      assert.equal(engineState?.pendingPhase, undefined, 'A failed review must not hold an unfinished phase')
      assert.equal(phases.at(-1), undefined, 'Clearing the unfinished phase must be checkpointed')
      assert.equal(
        isLevelReadyForGate(ctx.teamConfig.levels[1], dir, ctx),
        false,
        'A failed review must not be offered to the gate as a finished stage',
      )
    } finally {
      queuedResults = []
      dispatchCalls = []
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('a review paused by a human question keeps the phase it must resume', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-loop-'))
  try {
    fs.writeFileSync(path.join(dir, 'draft-package.md'), 'Initial draft input')
    queuedResults = [
      { text: '', interruption: { kind: 'awaiting_input' as const, interactionId: 'question-one' } },
    ]
    const ctx = makeContext(dir, 1)
    const tool = createReviewTool(ctx)

    await assert.rejects(
      tool.execute('call-1', {}, undefined as any, undefined as any, undefined as any),
      (error: unknown) => (error as Error).name === 'AgentQuestionInterruptionError',
    )

    const engineState = ctx.state.levelStates.get('editorial-review')?.engineState
    assert.equal(engineState?.pendingPhase, 'producer', 'A paused review must resume the phase it stopped in')
  } finally {
    queuedResults = []
    dispatchCalls = []
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
