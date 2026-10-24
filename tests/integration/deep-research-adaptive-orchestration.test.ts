import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type {
  ResearchEvidenceGraph,
  ResearchExecutionPolicy,
  ResearchPublicationAudit,
} from '../../contracts/deep-research.js'
import { finalizeDeepResearchEvidenceWave } from '../../domains/deep-research/deep-research-pipeline-adapter.js'
import { approveResearchPlan } from '../../domains/deep-research/deep-research-approval.js'
import { createPipelineTool } from '../../engines/pipeline.js'
import { createReviewTool } from '../../engines/review.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import type {
  ProviderExecuteOptions,
  ProviderResult,
} from '../../providers/types.js'
import { registerProvider } from '../../providers/index.js'
import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import {
  makeEvidencePacket,
  makePlan,
  TEST_TIME,
} from '../unit/deep-research-fixtures.js'

const REPO_ROOT = process.cwd()
const RESEARCH_TEAM_ROOT = path.join(REPO_ROOT, 'teams', 'research-team')
const PUBLICATION_TEAM_ROOT = path.join(
  REPO_ROOT,
  'teams',
  'deep-research-publication-team',
)
const SECTION_PROVIDER = 'deep-research-section-draft-fixture'
const PUBLICATION_PROVIDER = 'deep-research-publication-repair-fixture'
const PUBLICATION_BLOCK_PROVIDER =
  'deep-research-publication-block-fixture'

const SECTION_POLICY: ResearchExecutionPolicy = {
  schemaVersion: 1,
  complexity: 'complex',
  complexityRationale:
    'The report needs evidence-bound section drafting before one synthesis pass.',
  searchBreadth: 'broad',
  maxCostUsd: 20,
  evidenceTargets: {
    minimumSupportedClaims: 1,
    minimumIndependentSourcesPerConsequentialClaim: 2,
    crossVerifyConsequentialClaims: true,
  },
  stopping: {
    minimumExpectedInformationGain: 50,
    maximumCorrectionWaves: 2,
  },
  synthesis: {
    mode: 'section_dossiers',
    maximumParallelSections: 2,
  },
}

test('section dossier finalization drives the run-owned draft pipeline and persists its result', async () => {
  const assignmentPath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-sections-')),
  )
  try {
    const plan = approveResearchPlan(
      makePlan({ executionPolicy: SECTION_POLICY }),
      TEST_TIME,
    )
    const evidencePath = 'research/evidence/wave-0/task-one.json'
    writeJson(
      path.join(assignmentPath, 'research', 'approved-plan.json'),
      plan,
    )
    writeJson(
      path.join(assignmentPath, evidencePath),
      makeEvidencePacket(),
    )

    finalizeDeepResearchEvidenceWave({
      assignmentPath,
      planArtifact: 'research/approved-plan.json',
      executablePlan: {
        title: 'Approved research',
        status: 'executing',
        sprints: [{
          id: 'S1',
          name: 'Evidence',
          taskIds: ['task-one'],
          gateTaskId: null,
        }],
        tasks: new Map([
          ['task-one', {
            id: 'task-one',
            title: 'Channel economics',
            agent: 'web-researcher',
            status: 'completed',
            validate: false,
            dependsOn: [],
            gate: false,
            resultFile: evidencePath,
            sprintId: 'S1',
          }],
        ]),
      },
    })

    const startedAt = new Date()
    writeJson(
      path.join(assignmentPath, 'research', 'runtime-limits.json'),
      {
        schemaVersion: 1,
        planId: plan.planId,
        maxDurationMinutes: plan.maxDurationMinutes,
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(
          startedAt.getTime() + plan.maxDurationMinutes * 60_000,
        ).toISOString(),
      },
    )

    const summaryIndexPath = path.join(
      assignmentPath,
      'research',
      'evidence',
      'current-summary.md',
    )
    const summaryIndex = fs.readFileSync(summaryIndexPath, 'utf8')
    assert.match(
      summaryIndex,
      /\[task-one — [^\]]+\]\(wave-0\/task-one--[^\)]+\.md\)/u,
    )
    assert.match(summaryIndex, /artifact_type: "result"/u)

    // The section plan addresses each task by its declared result file, which
    // is the identity the runtime matches against the dossier index. It does
    // not name a dossier path: a writer has no filesystem, so a path in its
    // task section is an instruction it cannot follow, sitting next to one
    // telling it not to try.
    const sectionPlanPath = path.join(
      assignmentPath,
      'research',
      'section-plan.md',
    )
    const sectionPlan = fs.readFileSync(sectionPlanPath, 'utf8')
    assert.match(
      sectionPlan,
      /Result file:\*\* research\/sections\/section-one\/draft-wave-0\.md/u,
    )
    assert.doesNotMatch(sectionPlan, /Dossier:/u)
    const graph = readJson<ResearchEvidenceGraph>(
      path.join(
        assignmentPath,
        'research',
        'evidence-graph',
        'current.json',
      ),
    )
    assert.equal(graph.correctionWave, 0)
    assert.equal(graph.gaps.length, 0)

    const prompts: string[] = []
    registerProvider({
      name: SECTION_PROVIDER,
      execute: async (options) => {
        prompts.push(options.userMessage)
        // The writer answers from the evidence the runtime materialized into
        // the request. It deliberately does not know the dossier any other
        // way: an earlier version of this fixture returned a plausible section
        // without reading its assigned input, which let a run pass while every
        // live writer was refusing for want of a Read tool.
        const dossier = readMaterializedDossier(options.userMessage)
        assert.ok(dossier, 'the section writer request carried no materialized dossier')
        return providerResult(JSON.stringify({
          schemaVersion: 1,
          status: 'section_complete',
          sectionId: dossier.sectionId,
          claimIds: dossier.claims.map((claim) => claim.claimId),
          sourceIds: dossier.sources.map((source) => source.sourceId),
          markdown: '# Acquisition\n\n' +
            'The validated evidence supports sustainable acquisition economics ' +
            `(${dossier.sources.map((source) => source.canonicalUrl).join('; ')}).\n` +
            'The conclusion remains limited to the approved B2B SaaS scope.\n',
        }))
      },
    })

    const teamConfig = parseRequiredTeamConfig(
      path.join(RESEARCH_TEAM_ROOT, 'team.yaml'),
    )
    const level = teamConfig.levels.find(
      (candidate) => candidate.id === 'draft-sections',
    )
    assert.ok(level)
    assert.equal(level.stage.type, 'pipeline')
    const rosterEntry = teamConfig.agents.find(
      (candidate) => candidate.name === 'research-section-writer',
    )
    assert.ok(rosterEntry)
    const result = await createPipelineTool({
      teamName: 'research-team',
      teamConfig,
      teamRootPath: RESEARCH_TEAM_ROOT,
      levelId: 'draft-sections',
      config: level.stage,
      agents: new Map([
        ['research-section-writer', {
          name: 'research-section-writer',
          systemPrompt: 'FIXTURE_ROLE:research-section-writer',
          agentDir: assignmentPath,
          experienceEnabled: false,
          model: 'fixture-model',
          thinking: 'low',
          tools: [],
          provider: SECTION_PROVIDER,
        }],
      ]),
      rosterEntries: new Map([
        ['research-section-writer', rosterEntry],
      ]),
      state: runtimeState('draft-sections'),
      workspacePath: assignmentPath,
      outputPath: assignmentPath,
      inputFilesContent: '',
      agentMetrics: new Map(),
      stageFailureOverride: 'halt',
    } as never).execute(
      'draft-section-dossiers',
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    )

    assert.match(toolText(result), /Pipeline complete/u)
    assert.equal(prompts.length, 1)
    assert.match(
      fs.readFileSync(
        path.join(
          assignmentPath,
          'research',
          'sections',
          'section-one',
          'draft-wave-0.md',
        ),
        'utf8',
      ),
      /validated evidence supports sustainable acquisition economics/u,
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('publication review canonicalizes graph sources before repairing an uncited numeric claim', async () => {
  const assignmentPath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-publication-')),
  )
  try {
    preparePublicationArtifacts(assignmentPath)

    const calls: string[] = []
    let producerIteration = 0
    registerProvider({
      name: PUBLICATION_PROVIDER,
      execute: async (options) => {
        const role = fixtureRole(options)
        calls.push(role)
        if (role === 'deep-research-writer') {
          producerIteration += 1
          if (producerIteration === 1) {
            return providerResult(`# Final report

The observed result reached 42% in 2026. The evidence remains limited to the
approved B2B SaaS scope. This draft contains enough explanatory prose to be a
complete editorial candidate, but it intentionally omits one validated source
and does not place a citation beside the numeric claim.

## References

- https://example.com/report
`)
          }
          assert.match(options.userMessage, /numeric claim paragraph/u)
          return providerResult(`# Final report

The observed result reached 42% in 2026
(https://example.com/report). The evidence remains limited to the approved
B2B SaaS scope. Independent corroboration is retained, and the report makes no
claim outside the validated evidence boundary.

## References

- https://example.com/report
- https://independent.example.org/benchmark
`)
        }
        assert.equal(role, 'deep-research-publication-editor')
        return providerResult(
          '<review_decision>APPROVE</review_decision>\n\nThe repaired draft preserves the evidence boundary.',
        )
      },
    })

    const { result } = await executePublicationReview(
      assignmentPath,
      PUBLICATION_PROVIDER,
    )

    assert.match(toolText(result), /Review Complete 2\/3/u)
    assert.deepEqual(calls, [
      'deep-research-writer',
      'deep-research-writer',
      'deep-research-publication-editor',
    ])
    const firstAudit = readJson<ResearchPublicationAudit>(
      path.join(assignmentPath, 'publication-audit-v1.json'),
    )
    assert.equal(firstAudit.decision, 'REVISE')
    assert.deepEqual(
      firstAudit.canonicalization?.publicationUrlInventory,
      [
        'https://example.com/report',
        'https://independent.example.org/benchmark',
      ],
    )
    assert.deepEqual(
      firstAudit.violations.map((violation) => violation.code),
      ['numeric_claim_uncited'],
    )
    assert.equal(
      readJson<ResearchPublicationAudit>(
        path.join(assignmentPath, 'publication-audit-v2.json'),
      ).decision,
      'APPROVE',
    )
    assert.equal(
      readJson<ResearchPublicationAudit>(
        path.join(assignmentPath, 'publication-audit.json'),
      ).decision,
      'APPROVE',
    )
    assert.match(
      fs.readFileSync(path.join(assignmentPath, 'final-draft.md'), 'utf8'),
      /independent\.example\.org\/benchmark/u,
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('publication review blocks after three deterministic failures without promoting a draft', async () => {
  const assignmentPath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-publication-block-')),
  )
  try {
    preparePublicationArtifacts(assignmentPath)
    const calls: string[] = []
    registerProvider({
      name: PUBLICATION_BLOCK_PROVIDER,
      execute: async (options) => {
        const role = fixtureRole(options)
        calls.push(role)
        assert.equal(role, 'deep-research-writer')
        return providerResult(`# Final report

The observed result reached 42% in 2026. This deliberately incomplete draft
keeps enough prose for review but omits the independent validated source and
does not place a citation beside the numeric claim.

## References

- https://example.com/report
`)
      },
    })

    const { result, state } = await executePublicationReview(
      assignmentPath,
      PUBLICATION_BLOCK_PROVIDER,
    )

    assert.match(toolText(result), /Review Blocked 3\/3/u)
    assert.deepEqual(calls, [
      'deep-research-writer',
      'deep-research-writer',
      'deep-research-writer',
    ])
    assert.equal(
      state.levelStates.get('publication-review')?.stageStatus,
      STAGE_LIFECYCLE_STATUS.BLOCKED,
    )
    for (let iteration = 1; iteration <= 3; iteration += 1) {
      assert.equal(
        readJson<ResearchPublicationAudit>(
          path.join(assignmentPath, `publication-audit-v${iteration}.json`),
        ).decision,
        'REVISE',
      )
      assert.equal(
        fs.existsSync(path.join(assignmentPath, `draft-v${iteration}.md`)),
        true,
      )
    }
    assert.equal(
      readJson<ResearchPublicationAudit>(
        path.join(assignmentPath, 'publication-audit.json'),
      ).decision,
      'REVISE',
    )
    assert.equal(
      fs.existsSync(path.join(assignmentPath, 'final-draft.md')),
      false,
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

function preparePublicationArtifacts(assignmentPath: string): void {
  const plan = approveResearchPlan(makePlan(), TEST_TIME)
  const evidencePacket = makeEvidencePacket()
  const graphAssignmentPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'deep-research-publication-graph-'),
  )
  try {
    writeJson(
      path.join(graphAssignmentPath, 'research', 'approved-plan.json'),
      plan,
    )
    const evidencePath = 'research/evidence/wave-0/task-one.json'
    writeJson(path.join(graphAssignmentPath, evidencePath), evidencePacket)
    finalizeDeepResearchEvidenceWave({
      assignmentPath: graphAssignmentPath,
      planArtifact: 'research/approved-plan.json',
      executablePlan: {
        title: 'Approved research',
        status: 'executing',
        sprints: [{
          id: 'S1',
          name: 'Evidence',
          taskIds: ['task-one'],
          gateTaskId: null,
        }],
        tasks: new Map([
          ['task-one', {
            id: 'task-one',
            title: 'Channel economics',
            agent: 'web-researcher',
            status: 'completed',
            validate: false,
            dependsOn: [],
            gate: false,
            resultFile: evidencePath,
            sprintId: 'S1',
          }],
        ]),
      },
    })
    const graph = readJson<ResearchEvidenceGraph>(
      path.join(
        graphAssignmentPath,
        'research',
        'evidence-graph',
        'current.json',
      ),
    )
    writeJson(
      path.join(
        assignmentPath,
        'research',
        'evidence-graph',
        'current.json',
      ),
      graph,
    )
  } finally {
    fs.rmSync(graphAssignmentPath, { recursive: true, force: true })
  }

  fs.writeFileSync(
    path.join(assignmentPath, 'research-package.md'),
    `# Research package

The observed result reached 42% in 2026. This conclusion is limited to the
approved B2B SaaS scope.

## Sources

- https://example.com/report
- https://independent.example.org/benchmark
`,
  )
}

async function executePublicationReview(
  assignmentPath: string,
  provider: string,
) {
  const teamConfig = parseRequiredTeamConfig(
    path.join(PUBLICATION_TEAM_ROOT, 'team.yaml'),
  )
  const level = teamConfig.levels.find(
    (candidate) => candidate.id === 'publication-review',
  )
  assert.ok(level)
  assert.equal(level.stage.type, 'review')
  const writerRoster = teamConfig.agents.find(
    (candidate) => candidate.name === 'deep-research-writer',
  )
  const editorRoster = teamConfig.agents.find(
    (candidate) => candidate.name === 'deep-research-publication-editor',
  )
  assert.ok(writerRoster)
  assert.ok(editorRoster)
  const state = runtimeState('publication-review')
  const result = await createReviewTool({
    teamName: 'deep-research-publication-team',
    teamConfig,
    teamRootPath: PUBLICATION_TEAM_ROOT,
    levelId: 'publication-review',
    config: level.stage,
    agents: new Map([
      ['deep-research-writer', {
        name: 'deep-research-writer',
        systemPrompt: 'FIXTURE_ROLE:deep-research-writer',
        agentDir: assignmentPath,
        experienceEnabled: false,
        model: 'fixture-model',
        thinking: 'low',
        tools: [],
        provider,
      }],
      ['deep-research-publication-editor', {
        name: 'deep-research-publication-editor',
        systemPrompt: 'FIXTURE_ROLE:deep-research-publication-editor',
        agentDir: assignmentPath,
        experienceEnabled: false,
        model: 'fixture-model',
        thinking: 'low',
        tools: [],
        provider,
      }],
    ]),
    rosterEntries: new Map([
      ['deep-research-writer', writerRoster],
      ['deep-research-publication-editor', editorRoster],
    ]),
    state,
    workspacePath: assignmentPath,
    outputPath: assignmentPath,
    inputFilesContent: '',
    agentMetrics: new Map(),
    getCurrentCoordinatorRunId: () => 1,
    coordinatorName: 'deep-research-publication-editor',
  } as never).execute(
    'repair-publication',
    {},
    undefined as never,
    undefined as never,
    undefined as never,
  )
  return { result, state }
}

/**
 * The dossier the runtime materialized into a section writer's request, or
 * null when the request carried only a path.
 */
function readMaterializedDossier(userMessage: string): {
  sectionId: string
  claims: Array<{ claimId: string }>
  sources: Array<{ sourceId: string; canonicalUrl: string }>
} | null {
  const fence = /```json\s*([\s\S]*?)```/u.exec(userMessage)
  const body = fence?.[1]
  if (!body) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record: Record<string, unknown> = { ...parsed }
  if (typeof record.sectionId !== 'string') return null
  if (!Array.isArray(record.claims) || !Array.isArray(record.sources)) return null
  const claims = record.claims.flatMap((claim) =>
    claim && typeof claim === 'object' && 'claimId' in claim &&
    typeof claim.claimId === 'string'
      ? [{ claimId: claim.claimId }]
      : [])
  const sources = record.sources.flatMap((source) =>
    source && typeof source === 'object' &&
    'sourceId' in source && typeof source.sourceId === 'string' &&
    'canonicalUrl' in source && typeof source.canonicalUrl === 'string'
      ? [{ sourceId: source.sourceId, canonicalUrl: source.canonicalUrl }]
      : [])
  return { sectionId: record.sectionId, claims, sources }
}

function parseRequiredTeamConfig(teamPath: string) {
  const parsed = parseTeamConfig(teamPath)
  assert.deepEqual(parsed.errors, [])
  assert.ok(parsed.config)
  return parsed.config
}

function runtimeState(levelId: string) {
  return {
    sessionId: 'assignment-one',
    currentLevelIndex: 0,
    levelStates: new Map([
      [levelId, {
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
    rootSessionId: 'run-one',
    parentSessionId: 'session-one',
  }
}

function fixtureRole(options: ProviderExecuteOptions): string {
  const role = /FIXTURE_ROLE:([a-z-]+)/u.exec(options.systemPrompt)?.[1]
  assert.ok(role)
  return role
}

function providerResult(text: string): ProviderResult {
  return {
    text,
    cost: 0,
    durationMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    contextTokens: 0,
    model: 'fixture-model',
    costTracked: true,
    costSource: 'zero_cost',
  }
}

function toolText(result: unknown): string {
  return (
    result as { content?: Array<{ text?: string }> }
  ).content?.[0]?.text ?? ''
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}
