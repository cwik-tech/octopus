import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { createChainTool } from '../../engines/chain.js'
import { createPipelineTool } from '../../engines/pipeline.js'
import { tryAdvanceLevel } from '../../team-runtime/level-lifecycle.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import { approveResearchPlan } from '../../domains/deep-research/deep-research-approval.js'
import { parseMarkdownArtifact } from '../../domains/runtime/artifacts.js'
import type {
  EvidencePacket,
  QualityVerdict,
  ResearchAdaptiveDecision,
  ResearchEvidenceGraph,
  ResearchPlan,
  ResearchPlanAmendment,
  ResearchQualityPacket,
  ResearchSynthesisPacket,
  ResearchWorkerSpec,
  SourceRecord,
} from '../../contracts/deep-research.js'
import { parseEvidencePacket } from '../../domains/deep-research/deep-research-validation.js'
import { hashResearchValue } from '../../domains/deep-research/deep-research-worker-policy.js'
import {
  LEVEL_STATUS,
  STAGE_LIFECYCLE_STATUS,
  STAGE_TYPE,
} from '../../core/constants.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { createRuntimeContext } from '../../domains/runtime/runtime-context.js'
import { registerProvider } from '../../providers/index.js'
import type {
  ProviderExecuteOptions,
  ProviderResult,
} from '../../providers/types.js'
import { parseWorkflowTemplate } from '../../workflows/loader.js'
import { runWorkflow } from '../../workflows/runner.js'

const REPO_ROOT = process.cwd()
const RESEARCH_TEAM_ROOT = path.join(REPO_ROOT, 'teams', 'research-team')
const RESEARCH_TEAM_CONFIG_PATH = path.join(RESEARCH_TEAM_ROOT, 'team.yaml')
const DEEP_RESEARCH_WORKFLOW_PATH = path.join(
  REPO_ROOT,
  'workflows',
  'templates',
  'deep-research-to-document.yaml',
)
const FIXTURE_PROVIDER = 'deep-research-correction-fixture'
const OBSERVED_AT = '2026-07-17T12:00:00.000Z'

test('negative evidence review drives a targeted replacement through approved Markdown and DOCX publication', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      path.join(os.tmpdir(), 'deep-research-correction-publication-'),
    ),
  )
  const assignmentPath = path.join(
    root,
    'workspace',
    'sessions',
    'session-one',
    'runs',
    'run-one',
    'assignments',
    'assignment-one',
  )
  fs.mkdirSync(assignmentPath, { recursive: true })

  try {
    assertProductionDeepResearchWiring()
    const workers = [
      makeWorkerSpec({
        id: 'worker-one',
        laneId: 'lane-one',
        displayRole: 'Adoption Evidence Analyst',
        question: 'What level of adoption is supported by observed evidence?',
        requiredMetric: 'adoption',
      }),
      makeWorkerSpec({
        id: 'worker-two',
        laneId: 'lane-two',
        displayRole: 'Retention Evidence Analyst',
        question: 'What level of retention is supported by observed evidence?',
        requiredMetric: 'retention',
      }),
    ]
    const approvedPlan = approveResearchPlan(
      makePlan(workers, { adaptive: true }),
      OBSERVED_AT,
    )
    materializeApprovedPlan(assignmentPath, approvedPlan)

    const t1WaveZeroPacket = makeEvidencePacket({
      assignmentPath,
      worker: workers[0]!,
      taskId: 'T1',
      claimId: 'claim-adoption',
      statement: 'Observed adoption reached 42% in 2026.',
      wave: 0,
      sourceFixtures: [
        {
          suffix: 'a',
          url: 'https://official.example/evidence',
          title: 'Official adoption evidence',
          publisher: 'Official Example',
          sourceType: 'primary',
          excerpt: 'Observed adoption reached 42% in 2026.',
        },
      ],
    })
    const t1WaveOnePacket = makeEvidencePacket({
      assignmentPath,
      worker: workers[0]!,
      taskId: 'T1',
      claimId: 'claim-adoption',
      statement: 'Observed adoption reached 42% in 2026.',
      wave: 1,
      sourceFixtures: [
        {
          suffix: 'a',
          url: 'https://official.example/evidence',
          title: 'Official adoption evidence',
          publisher: 'Official Example',
          sourceType: 'primary',
          excerpt: 'Observed adoption reached 42% in 2026.',
        },
        {
          suffix: 'b',
          url: 'https://independent.example/verification',
          title: 'Independent adoption verification',
          publisher: 'Independent Example',
          sourceType: 'industry',
          excerpt: 'Independent verification measured adoption at 42% in 2026.',
        },
      ],
    })
    const t2WaveZeroPacket = makeEvidencePacket({
      assignmentPath,
      worker: workers[1]!,
      taskId: 'T2',
      claimId: 'claim-retention',
      statement: 'Observed retention reached 88% in 2026.',
      wave: 0,
      sourceFixtures: [
        {
          suffix: 'a',
          url: 'https://metrics.example/retention',
          title: 'Official retention evidence',
          publisher: 'Metrics Example',
          sourceType: 'primary',
          excerpt: 'Observed retention reached 88% in 2026.',
        },
        {
          suffix: 'b',
          url: 'https://benchmark.example/retention',
          title: 'Independent retention verification',
          publisher: 'Benchmark Example',
          sourceType: 'industry',
          excerpt:
            'Independent verification measured retention at 88% in 2026.',
        },
      ],
    })
    const evidenceByTaskAndWave = new Map<string, EvidencePacket>([
      ['T1:0', t1WaveZeroPacket],
      ['T1:1', t1WaveOnePacket],
      ['T2:0', t2WaveZeroPacket],
    ])

    const providerCalls: string[] = []
    registerProvider({
      name: FIXTURE_PROVIDER,
      execute: async (options) => {
        const role = fixtureRole(options)
        if (role === 'web-researcher') {
          const response = researchResponseFromPrompt(
            options,
            evidenceByTaskAndWave,
          )
          providerCalls.push(
            `web-researcher:${response.taskId}:wave-${response.wave}`,
          )
          return fixtureResult(JSON.stringify(response.packet))
        }
        if (role === 'research-synthesizer') {
          providerCalls.push(role)
          return fixtureResult(renderResearchPackageFromPrompt(options))
        }
        if (role === 'evidence-critic') {
          providerCalls.push(role)
          return fixtureResult(JSON.stringify(qualityReviewFromPrompt(options)))
        }
        if (role === 'research-handoff') {
          providerCalls.push(role)
          return fixtureResult(extractResearchPackage(options.userMessage))
        }
        if (role === 'writer') {
          providerCalls.push(role)
          return fixtureResult(
            finalReportFromPrompt(
              'Evidence-backed writing draft',
              options.userMessage,
            ),
          )
        }
        if (role === 'editor') {
          providerCalls.push(role)
          assert.match(options.userMessage, /Evidence-backed writing draft/)
          return fixtureResult(
            finalReportFromPrompt(
              'Editorially reviewed report',
              options.userMessage,
            ),
          )
        }
        throw new Error(`Unexpected deterministic provider role: ${role}`)
      },
    }, {
      source: 'tests/integration/deep-research-correction-publication.test.ts#full-flow',
      trustClass: 'test',
    })

    const initialPipeline = await createPipelineTool(
      makePipelineContext(assignmentPath),
    ).execute(
      'collect-initial-evidence',
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    )
    assert.match(readToolText(initialPipeline), /Pipeline complete/)
    const initialDeterministicVerdict = readJson<QualityVerdict>(
      path.join(
        assignmentPath,
        'research',
        'quality',
        'deterministic-verdict.json',
      ),
    )
    assert.equal(initialDeterministicVerdict.decision, 'REVISE')
    assert.ok(
      initialDeterministicVerdict.findings.some((finding) =>
        finding.taskIds.includes('T1'),
      ),
    )
    assert.equal(
      initialDeterministicVerdict.findings.some((finding) =>
        finding.taskIds.includes('T2'),
      ),
      false,
    )
    const initialGraph = readJson<ResearchEvidenceGraph>(
      path.join(
        assignmentPath,
        'research',
        'evidence-graph',
        'current.json',
      ),
    )
    assert.equal(initialGraph.correctionWave, 0)
    assert.ok(
      initialGraph.gaps.some(
        (gap) =>
          gap.type === 'cross_verification_missing' &&
          gap.taskIds.includes('T1'),
      ),
    )
    assert.equal(
      fs.existsSync(
        path.join(
          assignmentPath,
          'research',
          'sections',
          'section-one',
          'dossier-current.json',
        ),
      ),
      true,
    )
    assert.equal(
      fs.existsSync(path.join(assignmentPath, 'research', 'section-plan.md')),
      false,
    )

    await runSynthesis(assignmentPath, 'synthesize-wave-zero')
    const initialReview = await runQualityReview(
      assignmentPath,
      'review-wave-zero',
    )
    assert.match(readToolText(initialReview), /Chain Complete/)
    const reviseVerdict = readJson<{
      correctionWave: number
      decision: string
      correctionRequests: Array<{ taskIds: string[] }>
    }>(path.join(assignmentPath, 'research', 'quality', 'current-verdict.json'))
    assert.equal(reviseVerdict.correctionWave, 0)
    assert.equal(reviseVerdict.decision, 'REVISE')
    assert.ok(
      reviseVerdict.correctionRequests.some((request) =>
        request.taskIds.includes('T1'),
      ),
    )
    assert.equal(
      reviseVerdict.correctionRequests.some((request) =>
        request.taskIds.includes('T2'),
      ),
      false,
    )
    const adaptiveDecision = readJson<ResearchAdaptiveDecision>(
      path.join(
        assignmentPath,
        'research',
        'adaptive',
        'current-decision.json',
      ),
    )
    assert.equal(adaptiveDecision.decision, 'continue')
    assert.equal(adaptiveDecision.route, 'research')
    assert.equal(adaptiveDecision.aggregateExpectedInformationGain, 85)
    const amendment = readJson<ResearchPlanAmendment>(
      path.join(
        assignmentPath,
        'research',
        'amendments',
        'current.json',
      ),
    )
    assert.equal(amendment.approvedPlanHash, approvedPlan.approvalHash)
    assert.equal(amendment.fromWave, 0)
    assert.equal(amendment.toWave, 1)
    assert.deepEqual(amendment.targetTaskIds, ['T1'])
    assert.equal(amendment.scopeChange, 'none')

    const t1WaveZeroEvidencePath = path.join(
      assignmentPath,
      'research',
      'evidence',
      'wave-0',
      'T1.json',
    )
    const t2WaveZeroEvidencePath = path.join(
      assignmentPath,
      'research',
      'evidence',
      'wave-0',
      'T2.json',
    )
    const t1WaveZeroHash = sha256(fs.readFileSync(t1WaveZeroEvidencePath))
    const t2WaveZeroHash = sha256(fs.readFileSync(t2WaveZeroEvidencePath))
    const runtimePlanPath = path.join(
      assignmentPath,
      '.runtime',
      'pipeline',
      'collect-evidence',
      'plan.md',
    )
    assert.equal(fs.existsSync(runtimePlanPath), true)
    const correctionRoute = await routeQualityDecision(
      assignmentPath,
      path.join(root, 'workspace'),
    )
    assert.equal(fs.existsSync(runtimePlanPath), false)
    assert.equal(correctionRoute.currentLevelId, 'collect-evidence')
    assert.equal(correctionRoute.collectStatus, LEVEL_STATUS.ACTIVE)
    assert.equal(
      correctionRoute.collectStageStatus,
      STAGE_LIFECYCLE_STATUS.READY,
    )
    assert.equal(correctionRoute.collectLoopbackCount, 1)
    assert.equal(correctionRoute.collectEngineState, null)
    assert.equal(correctionRoute.synthesisStatus, LEVEL_STATUS.PENDING)
    assert.equal(
      correctionRoute.synthesisStageStatus,
      STAGE_LIFECYCLE_STATUS.NOT_STARTED,
    )
    assert.equal(correctionRoute.synthesisEngineState, null)
    assert.equal(correctionRoute.qualityStatus, LEVEL_STATUS.PENDING)
    assert.equal(
      correctionRoute.qualityStageStatus,
      STAGE_LIFECYCLE_STATUS.NOT_STARTED,
    )
    assert.equal(correctionRoute.qualityEngineState, null)
    assert.equal(correctionRoute.persistCount, 1)
    assert.equal(correctionRoute.registerCount, 1)
    assert.equal(correctionRoute.startCount, 1)
    assert.ok(
      correctionRoute.notifications.some((message) =>
        message.includes('Gate transform complete'),
      ),
    )
    assert.ok(
      correctionRoute.notifications.some((message) =>
        message.includes('(loopback)'),
      ),
    )
    assert.match(
      fs.readFileSync(
        findGateReport(
          assignmentPath,
          'quality-audit-to-collect-evidence',
        ),
        'utf8',
      ),
      /research\/quality\/current-verdict\.json[\s\S]*research\/corrections\/current\.json/u,
    )
    const correctionPlan = fs.readFileSync(
      path.join(assignmentPath, 'research', 'plan.md'),
      'utf8',
    )
    assert.match(correctionPlan, /Deep Research Correction Wave 1/)
    assert.match(correctionPlan, /#### T1:/)
    assert.doesNotMatch(correctionPlan, /#### T2:/)
    const correctionContext = readJson<{
      wave: number
      amendmentPath: string
      amendmentHash: string
      taskRequests: Record<string, unknown[]>
    }>(path.join(assignmentPath, 'research', 'corrections', 'current.json'))
    assert.equal(correctionContext.wave, 1)
    assert.equal(
      correctionContext.amendmentPath,
      'research/amendments/amendment-wave-1.json',
    )
    assert.equal(correctionContext.amendmentHash, hashResearchValue(amendment))
    assert.deepEqual(Object.keys(correctionContext.taskRequests), ['T1'])

    const correctionPipeline = await createPipelineTool(
      makePipelineContext(assignmentPath),
    ).execute(
      'collect-corrected-evidence',
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    )
    assert.match(readToolText(correctionPipeline), /Pipeline complete/)
    assert.equal(
      sha256(fs.readFileSync(t1WaveZeroEvidencePath)),
      t1WaveZeroHash,
    )
    assert.equal(
      sha256(fs.readFileSync(t2WaveZeroEvidencePath)),
      t2WaveZeroHash,
    )
    assert.equal(
      fs.existsSync(
        path.join(assignmentPath, 'research', 'evidence', 'wave-1', 'T2.json'),
      ),
      false,
    )
    const manifest = readJson<{
      correctionWave: number
      latestByTask: Record<string, string>
    }>(
      path.join(
        assignmentPath,
        'research',
        'evidence',
        'current-manifest.json',
      ),
    )
    assert.equal(manifest.correctionWave, 1)
    assert.equal(manifest.latestByTask.T1, 'research/evidence/wave-1/T1.json')
    assert.equal(manifest.latestByTask.T2, 'research/evidence/wave-0/T2.json')
    assert.equal(
      parseEvidencePacket(
        readJson(
          path.join(
            assignmentPath,
            'research',
            'evidence',
            'wave-1',
            'T1.json',
          ),
        ),
      ).sources.length,
      2,
    )
    const correctedGraph = readJson<ResearchEvidenceGraph>(
      path.join(
        assignmentPath,
        'research',
        'evidence-graph',
        'current.json',
      ),
    )
    assert.equal(correctedGraph.correctionWave, 1)
    assert.equal(
      correctedGraph.gaps.some(
        (gap) => gap.type === 'cross_verification_missing',
      ),
      false,
    )

    await runSynthesis(assignmentPath, 'synthesize-wave-one')
    const approvedReview = await runQualityReview(
      assignmentPath,
      'review-wave-one',
    )
    assert.match(readToolText(approvedReview), /Chain Complete/)
    const approvedVerdict = readJson<{
      correctionWave: number
      decision: string
      correctionRequests: unknown[]
    }>(path.join(assignmentPath, 'research', 'quality', 'current-verdict.json'))
    assert.equal(approvedVerdict.correctionWave, 1)
    assert.equal(approvedVerdict.decision, 'APPROVE')
    assert.deepEqual(approvedVerdict.correctionRequests, [])
    assert.equal(
      readJson<ResearchAdaptiveDecision>(
        path.join(
          assignmentPath,
          'research',
          'adaptive',
          'current-decision.json',
        ),
      ).decision,
      'not_applicable',
    )

    const publication = await publishApprovedResearch(assignmentPath, root)
    assert.equal(publication.status, 'completed')
    assert.deepEqual(
      publication.steps.map((step) => step.stepId),
      ['research', 'writer', 'editorial', 'publish'],
    )
    const markdownPath = publication.artifacts?.find(
      (artifact) => artifact.relativePath === 'final-report.md',
    )?.artifactPath
    const docxPath = publication.artifacts?.find(
      (artifact) => artifact.relativePath === 'final-report.docx',
    )?.artifactPath
    assert.ok(markdownPath)
    assert.ok(docxPath)
    assert.match(
      fs.readFileSync(markdownPath, 'utf8'),
      /Editorially reviewed report/,
    )
    assert.equal(
      fs.readFileSync(docxPath).subarray(0, 2).toString('ascii'),
      'PK',
    )
    assert.match(parseDocx(docxPath, root), /Editorially reviewed report/)
    assert.deepEqual(providerCalls.slice(0, 2).sort(), [
      'web-researcher:T1:wave-0',
      'web-researcher:T2:wave-0',
    ])
    assert.deepEqual(providerCalls.slice(2), [
      'research-synthesizer',
      'evidence-critic',
      'web-researcher:T1:wave-1',
      'research-synthesizer',
      'evidence-critic',
      'research-handoff',
      'writer',
      'editor',
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unaffordable research correction preserves the verdict and routes to escalation', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-budget-escalation-')),
  )
  const assignmentPath = path.join(
    root,
    'workspace',
    'sessions',
    'session-one',
    'runs',
    'run-one',
    'assignments',
    'assignment-one',
  )
  fs.mkdirSync(assignmentPath, { recursive: true })

  try {
    const worker = makeWorkerSpec({
      id: 'worker-one',
      laneId: 'lane-one',
      displayRole: 'Adoption Evidence Analyst',
      question: 'What level of adoption is supported by observed evidence?',
      requiredMetric: 'adoption',
    })
    const approvedPlan = approveResearchPlan(makePlan([worker]), OBSERVED_AT)
    materializeApprovedPlan(assignmentPath, approvedPlan)
    fs.writeFileSync(
      path.join(assignmentPath, 'research-package.md'),
      '# Research package\n\nThe completed review requires more evidence.\n',
    )
    writeJson(
      path.join(
        assignmentPath,
        'research',
        'evidence',
        'current-manifest.json',
      ),
      {
        schemaVersion: 1,
        correctionWave: 0,
        latestByTask: {
          T1: 'research/evidence/wave-0/T1.json',
        },
      },
    )
    const verdict = {
      schemaVersion: 1,
      verdictId: 'critic-budget-limited-revision',
      correctionWave: 0,
      decision: 'REVISE',
      findings: [
        {
          code: 'required_authority_missing',
          severity: 'blocking',
          message: 'The adoption claim needs another authoritative source.',
          taskIds: ['T1'],
          sectionIds: [approvedPlan.tasks[0]!.sectionId],
          claimIds: [],
          sourceIds: [],
        },
      ],
      correctionRequests: [
        {
          schemaVersion: 1,
          id: 'research-authoritative-source',
          type: 'new_research',
          claimIds: [],
          taskIds: ['T1'],
          sectionIds: [approvedPlan.tasks[0]!.sectionId],
          acceptanceCriteria: ['Add another authoritative source.'],
          impactScope: 'local',
        },
      ],
      correctionRoute: 'research',
      reviewedAt: OBSERVED_AT,
    } satisfies QualityVerdict
    const verdictPath = path.join(
      assignmentPath,
      'research',
      'quality',
      'current-verdict.json',
    )
    writeJson(verdictPath, verdict)

    const limitsPath = path.join(
      assignmentPath,
      'research',
      'runtime-limits.json',
    )
    const limits = readJson<Record<string, unknown>>(limitsPath)
    limits.deadlineAt = new Date(Date.now() + 600_000).toISOString()
    writeJson(limitsPath, limits)

    const executablePlanPath = path.join(
      assignmentPath,
      'research',
      'plan.md',
    )
    const planBeforeRouting = fs.readFileSync(executablePlanPath, 'utf8')
    const route = await routeQualityDecision(
      assignmentPath,
      path.join(root, 'workspace'),
    )

    assert.equal(route.currentLevelId, 'research-escalation')
    assert.equal(route.qualityStatus, LEVEL_STATUS.COMPLETED)
    assert.equal(route.escalationStatus, LEVEL_STATUS.ACTIVE)
    assert.deepEqual(readJson<QualityVerdict>(verdictPath), verdict)
    assert.equal(fs.readFileSync(executablePlanPath, 'utf8'), planBeforeRouting)
    assert.equal(
      fs.existsSync(
        path.join(assignmentPath, 'research', 'corrections', 'current.json'),
      ),
      false,
    )
    assert.ok(
      route.notifications.some((message) =>
        message.includes('write-free preflight'),
      ),
    )
    assert.ok(
      route.notifications.some((message) =>
        message.includes('Research Quality Audit → Research Escalation'),
      ),
    )
    assert.match(
      fs.readFileSync(
        findGateReport(
          assignmentPath,
          'quality-audit-to-collect-evidence',
        ),
        'utf8',
      ),
      /Insufficient remaining execution budget[\s\S]*latest quality verdict remains authoritative/u,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('quality review retries a malformed correction scope and persists only the repaired verdict', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-quality-repair-')))
  const assignmentPath = path.join(root, 'assignment')
  fs.mkdirSync(assignmentPath, { recursive: true })
  try {
    const worker = makeWorkerSpec({
      id: 'worker-one',
      laneId: 'lane-one',
      displayRole: 'Evidence Analyst',
      question: 'What does the observed evidence establish?',
      requiredMetric: 'adoption',
    })
    const approvedPlan = approveResearchPlan(makePlan([worker]), OBSERVED_AT)
    materializeApprovedPlan(assignmentPath, approvedPlan)
    fs.writeFileSync(
      path.join(assignmentPath, 'research-package.md'),
      '# Research package\n\nA section conclusion needs bounded resynthesis.\n',
    )
    writeJson(path.join(assignmentPath, 'research', 'quality', 'current-packet.json'), {
      schemaVersion: 1,
      planId: approvedPlan.planId,
      requiredTaskIds: ['T1'],
      synthesis: {
        schemaVersion: 1,
        planId: approvedPlan.planId,
        coverage: [],
        claims: [],
        sources: [],
        contradictions: [],
        unresolvedQuestions: [],
      },
      claimSourceMatrix: [],
    })
    writeJson(path.join(assignmentPath, 'research', 'quality', 'deterministic-verdict.json'), {
      schemaVersion: 1,
      verdictId: 'deterministic-review-ready',
      correctionWave: 0,
      decision: 'APPROVE',
      findings: [],
      correctionRequests: [],
      reviewedAt: OBSERVED_AT,
    } satisfies QualityVerdict)
    const sectionId = approvedPlan.tasks[0]!.sectionId
    const verdict = {
      schemaVersion: 1,
      verdictId: 'critic-section-revision',
      correctionWave: 0,
      decision: 'REVISE',
      findings: [{
        code: 'decision_not_supported',
        severity: 'blocking',
        message: 'The section conclusion is not supported by the packet.',
        taskIds: ['T1'],
        sectionIds: [sectionId],
        claimIds: [],
        sourceIds: [],
      }],
      correctionRequests: [{
        schemaVersion: 1,
        id: 'resynthesize-section',
        type: 'resynthesize',
        claimIds: [],
        taskIds: ['T1'],
        sectionIds: [sectionId],
        acceptanceCriteria: ['Remove the unsupported conclusion.'],
        impactScope: 'section',
      }],
      correctionRoute: 'synthesis',
      reviewedAt: OBSERVED_AT,
    }
    let attempts = 0
    registerProvider({
      name: FIXTURE_PROVIDER,
      execute: async (options) => {
        assert.equal(fixtureRole(options), 'evidence-critic')
        attempts += 1
        if (attempts === 1) return fixtureResult(JSON.stringify(verdict))
        assert.match(options.userMessage, /# Runtime Validation Feedback/u)
        assert.match(options.userMessage, /impactScope must be exactly local or global/u)
        return fixtureResult(JSON.stringify({
          ...verdict,
          correctionRequests: verdict.correctionRequests.map((request) => ({
            ...request,
            impactScope: 'local',
          })),
        }))
      },
    }, {
      source: 'tests/integration/deep-research-correction-publication.test.ts#repair-scope',
      trustClass: 'test',
    }, { replaceExisting: true })

    const review = await runQualityReview(assignmentPath, 'review-repaired-verdict')
    const persisted = readJson<QualityVerdict>(path.join(
      assignmentPath,
      'research',
      'quality',
      'current-verdict.json',
    ))

    assert.match(readToolText(review), /Chain Complete/u)
    assert.equal(attempts, 2)
    assert.equal(
      persisted.decision,
      'REVISE',
      `${readToolText(review)}\n${JSON.stringify(persisted, null, 2)}`,
    )
    assert.equal(persisted.correctionRequests[0]?.impactScope, 'local')
    assert.equal(fs.existsSync(path.join(assignmentPath, 'research', 'quality', 'escalation.md')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('quality review receives only the current assignment artifacts when the shared workspace has a conflicting report', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-quality-isolation-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const assignmentPath = path.join(
    workspacePath,
    'sessions',
    'session-one',
    'runs',
    'run-one',
    'assignments',
    'assignment-one',
  )
  fs.mkdirSync(assignmentPath, { recursive: true })

  try {
    const worker = makeWorkerSpec({
      id: 'worker-one',
      laneId: 'lane-one',
      displayRole: 'Evidence Analyst',
      question: 'What does the current assignment establish?',
      requiredMetric: 'adoption',
    })
    const approvedPlan = approveResearchPlan(makePlan([worker]), OBSERVED_AT)
    materializeApprovedPlan(assignmentPath, approvedPlan)
    const currentReport = '# Research package\n\nCURRENT_ASSIGNMENT_REPORT\n'
    const staleReport = '# Research package\n\nSTALE_SHARED_WORKSPACE_REPORT\n'
    fs.writeFileSync(path.join(assignmentPath, 'research-package.md'), currentReport)
    fs.writeFileSync(path.join(workspacePath, 'research-package.md'), staleReport)
    writeJson(path.join(assignmentPath, 'research', 'quality', 'current-packet.json'), {
      schemaVersion: 1,
      planId: approvedPlan.planId,
      requiredTaskIds: ['T1'],
      reviewScope: {
        stage: 'research',
        criterion: 'safe_to_write',
        downstreamPublicationPending: true,
        excludedArtifacts: ['final-report.md', 'final-report.docx'],
      },
      synthesis: {
        schemaVersion: 1,
        planId: approvedPlan.planId,
        coverage: [],
        claims: [],
        sources: [],
        contradictions: [],
        unresolvedQuestions: [],
      },
      claimSourceMatrix: [],
    })
    const deterministicVerdict = {
      schemaVersion: 1,
      verdictId: 'deterministic-current-assignment',
      correctionWave: 0,
      decision: 'APPROVE',
      findings: [],
      correctionRequests: [],
      reviewedAt: OBSERVED_AT,
    } satisfies QualityVerdict
    writeJson(
      path.join(
        assignmentPath,
        'research',
        'quality',
        'deterministic-verdict.json',
      ),
      deterministicVerdict,
    )

    let receivedMessage = ''
    registerProvider({
      name: FIXTURE_PROVIDER,
      execute: async (options) => {
        assert.equal(fixtureRole(options), 'evidence-critic')
        assert.equal(options.cwd, assignmentPath)
        receivedMessage = options.userMessage
        return fixtureResult(JSON.stringify({
          ...deterministicVerdict,
          verdictId: 'critic-current-assignment',
        }))
      },
    }, {
      source: 'tests/integration/deep-research-correction-publication.test.ts#quality-isolation',
      trustClass: 'test',
    }, { replaceExisting: true })

    const review = await createChainTool(
      makeChainContext({
        assignmentPath,
        workspacePath,
        levelId: 'quality-audit',
        agentName: 'evidence-critic',
        roleMarker: 'FIXTURE_ROLE:evidence-critic',
      }),
    ).execute(
      'review-current-assignment',
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    )

    assert.match(readToolText(review), /Chain Complete/u)
    assert.match(receivedMessage, /CURRENT_ASSIGNMENT_REPORT/u)
    assert.doesNotMatch(receivedMessage, /STALE_SHARED_WORKSPACE_REPORT/u)
    assert.match(receivedMessage, /What does the current assignment establish\?/u)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('quality review refuses an over-budget complete request before provider dispatch', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-quality-budget-')),
  )
  const assignmentPath = path.join(
    root,
    'workspace',
    'sessions',
    'session-one',
    'runs',
    'run-one',
    'assignments',
    'assignment-one',
  )
  fs.mkdirSync(assignmentPath, { recursive: true })

  try {
    const worker = makeWorkerSpec({
      id: 'worker-one',
      laneId: 'lane-one',
      displayRole: 'Evidence Analyst',
      question: 'What does the current assignment establish?',
      requiredMetric: 'adoption',
    })
    const approvedPlan = approveResearchPlan(makePlan([worker]), OBSERVED_AT)
    materializeApprovedPlan(assignmentPath, approvedPlan)
    fs.writeFileSync(
      path.join(assignmentPath, 'research-package.md'),
      `# Research package\n\n${'evidence '.repeat(100_000)}\n`,
    )
    writeJson(path.join(assignmentPath, 'research', 'quality', 'current-packet.json'), {
      schemaVersion: 1,
      planId: approvedPlan.planId,
      requiredTaskIds: ['T1'],
      reviewScope: {
        stage: 'research',
        criterion: 'safe_to_write',
        downstreamPublicationPending: true,
        excludedArtifacts: ['final-report.md', 'final-report.docx'],
      },
      synthesis: {
        schemaVersion: 1,
        planId: approvedPlan.planId,
        coverage: [],
        claims: [],
        sources: [],
        contradictions: [],
        unresolvedQuestions: [],
      },
      claimSourceMatrix: [],
    })
    writeJson(
      path.join(
        assignmentPath,
        'research',
        'quality',
        'deterministic-verdict.json',
      ),
      {
        schemaVersion: 1,
        verdictId: 'deterministic-current-assignment',
        correctionWave: 0,
        decision: 'APPROVE',
        findings: [],
        correctionRequests: [],
        reviewedAt: OBSERVED_AT,
      } satisfies QualityVerdict,
    )

    let providerCalls = 0
    registerProvider({
      name: FIXTURE_PROVIDER,
      execute: async () => {
        providerCalls += 1
        return fixtureResult('{}')
      },
    }, {
      source: 'tests/integration/deep-research-correction-publication.test.ts#quality-budget',
      trustClass: 'test',
    }, { replaceExisting: true })

    const review = await runQualityReview(assignmentPath, 'review-over-budget')

    assert.equal(providerCalls, 0)
    assert.match(
      readToolText(review),
      /Deep Research quality review request was refused before launch/u,
    )
    assert.match(readToolText(review), /reserving 32000 tokens for the answer/u)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('invalid quality reviewer output routes deterministic escalation to Attention Required', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      path.join(os.tmpdir(), 'deep-research-quality-escalation-'),
    ),
  )
  const assignmentPath = path.join(
    root,
    'workspace',
    'sessions',
    'session-one',
    'runs',
    'run-one',
    'assignments',
    'assignment-one',
  )
  fs.mkdirSync(assignmentPath, { recursive: true })

  try {
    const workers = [
      makeWorkerSpec({
        id: 'worker-one',
        laneId: 'lane-one',
        displayRole: 'Adoption Evidence Analyst',
        question: 'What level of adoption is supported by observed evidence?',
        requiredMetric: 'adoption',
      }),
      makeWorkerSpec({
        id: 'worker-two',
        laneId: 'lane-two',
        displayRole: 'Retention Evidence Analyst',
        question: 'What level of retention is supported by observed evidence?',
        requiredMetric: 'retention',
      }),
    ]
    const approvedPlan = approveResearchPlan(makePlan(workers), OBSERVED_AT)
    materializeApprovedPlan(assignmentPath, approvedPlan)
    fs.writeFileSync(
      path.join(assignmentPath, 'research-package.md'),
      '# Research package\n\nValidated evidence awaits adversarial review.\n',
    )
    writeJson(
      path.join(assignmentPath, 'research', 'quality', 'current-packet.json'),
      {
        schemaVersion: 1,
        planId: approvedPlan.planId,
        requiredTaskIds: approvedPlan.tasks.map((task) => task.id),
        synthesis: {
          schemaVersion: 1,
          planId: approvedPlan.planId,
          coverage: [],
          claims: [],
          sources: [],
          contradictions: [],
          unresolvedQuestions: [],
        },
        claimSourceMatrix: [],
      },
    )
    writeJson(
      path.join(
        assignmentPath,
        'research',
        'quality',
        'deterministic-verdict.json',
      ),
      {
        schemaVersion: 1,
        verdictId: 'deterministic-review-ready',
        correctionWave: 0,
        decision: 'APPROVE',
        findings: [],
        correctionRequests: [],
        reviewedAt: OBSERVED_AT,
      } satisfies QualityVerdict,
    )

    let reviewAttempts = 0
    registerProvider({
      name: FIXTURE_PROVIDER,
      execute: async (options) => {
        assert.equal(fixtureRole(options), 'evidence-critic')
        reviewAttempts += 1
        if (reviewAttempts > 1) {
          assert.match(options.userMessage, /# Runtime Validation Feedback/u)
        }
        return fixtureResult('```json\n{"decision":"APPROVE"}\n```')
      },
    }, {
      source: 'tests/integration/deep-research-correction-publication.test.ts#invalid-review',
      trustClass: 'test',
    }, { replaceExisting: true })

    const review = await runQualityReview(
      assignmentPath,
      'review-invalid-verdict',
    )
    assert.match(
      readToolText(review),
      /Quality reviewer unavailable after bounded recovery/,
    )
    assert.equal(reviewAttempts, 2)
    const fallback = readJson<QualityVerdict>(
      path.join(
        assignmentPath,
        'research',
        'quality',
        'current-verdict.json',
      ),
    )
    assert.equal(fallback.decision, 'ESCALATE')
    assert.equal(fallback.correctionWave, 0)
    assert.deepEqual(fallback.correctionRequests, [])
    assert.ok(
      fallback.findings.some(
        (finding) =>
          finding.severity === 'blocking' &&
          finding.message.includes('Runtime validation detail'),
      ),
    )
    assert.deepEqual(
      readJson<QualityVerdict>(
        path.join(
          assignmentPath,
          'research',
          'quality',
          'verdict-wave-0.json',
        ),
      ),
      fallback,
    )
    const escalation = parseMarkdownArtifact(fs.readFileSync(
      path.join(assignmentPath, 'research', 'quality', 'escalation.md'),
      'utf8',
    ))
    const blockedReport = parseMarkdownArtifact(fs.readFileSync(
      path.join(assignmentPath, 'research-package.md'),
      'utf8',
    ))
    assert.equal(escalation.metadata.status, 'blocked')
    assert.match(escalation.body, /Deep Research Requires Attention/)
    assert.equal(blockedReport.metadata.status, 'blocked')
    assert.match(blockedReport.body, /Deep Research Requires Attention/)
    assert.match(
      fs.readFileSync(
        path.join(assignmentPath, 'research', 'reports', 'report-wave-0.md'),
        'utf8',
      ),
      /Validated evidence awaits adversarial review/,
    )

    const route = await routeQualityDecision(
      assignmentPath,
      path.join(root, 'workspace'),
    )
    assert.equal(route.currentLevelId, 'research-escalation')
    assert.equal(route.qualityStatus, LEVEL_STATUS.COMPLETED)
    assert.equal(
      route.qualityStageStatus,
      STAGE_LIFECYCLE_STATUS.COMPLETED,
    )
    assert.equal(route.escalationStatus, LEVEL_STATUS.ACTIVE)
    assert.equal(
      route.escalationStageStatus,
      STAGE_LIFECYCLE_STATUS.READY,
    )
    assert.ok(
      route.notifications.some((message) =>
        message.includes('Research Quality Audit → Research Escalation'),
      ),
    )
    assert.equal(
      fs.existsSync(
        path.join(assignmentPath, 'research', 'corrections', 'current.json'),
      ),
      false,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('terminal correction review preserves its source verdict and completes adaptive escalation', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      path.join(os.tmpdir(), 'deep-research-terminal-review-'),
    ),
  )
  const assignmentPath = path.join(
    root,
    'workspace',
    'sessions',
    'session-one',
    'runs',
    'run-one',
    'assignments',
    'assignment-one',
  )
  fs.mkdirSync(assignmentPath, { recursive: true })

  try {
    const worker = makeWorkerSpec({
      id: 'worker-one',
      laneId: 'lane-one',
      displayRole: 'Adoption Evidence Analyst',
      question: 'What level of adoption is supported by observed evidence?',
      requiredMetric: 'adoption',
    })
    const adaptivePlan = makePlan([worker], { adaptive: true })
    assert.ok(adaptivePlan.executionPolicy)
    const approvedPlan = approveResearchPlan({
      ...adaptivePlan,
      executionPolicy: {
        ...adaptivePlan.executionPolicy,
        stopping: {
          ...adaptivePlan.executionPolicy.stopping,
          maximumCorrectionWaves: 1,
        },
      },
    }, OBSERVED_AT)
    materializeApprovedPlan(assignmentPath, approvedPlan)
    fs.writeFileSync(
      path.join(assignmentPath, 'research-package.md'),
      '# Research package\n\nOne blocking evidence gap remains.\n',
    )
    writeJson(
      path.join(assignmentPath, 'research', 'quality', 'current-packet.json'),
      {
        schemaVersion: 1,
        planId: approvedPlan.planId,
        requiredTaskIds: ['T1'],
        synthesis: {
          schemaVersion: 1,
          planId: approvedPlan.planId,
          coverage: [],
          claims: [],
          sources: [],
          contradictions: [],
          unresolvedQuestions: [],
        },
        claimSourceMatrix: [],
      },
    )
    const finding = {
      code: 'source_not_independent' as const,
      severity: 'blocking' as const,
      message: 'The remaining claim lacks independent corroboration.',
      taskIds: ['T1'],
      sectionIds: ['section-one'],
      claimIds: [],
      sourceIds: [],
    }
    const correctionRequest = {
      schemaVersion: 1 as const,
      id: 'cross-verify-adoption',
      type: 'cross_verify' as const,
      claimIds: [],
      taskIds: ['T1'],
      sectionIds: ['section-one'],
      question: 'Can an independent source corroborate the adoption figure?',
      acceptanceCriteria: ['Provide independent corroboration or remove the claim.'],
      impactScope: 'local' as const,
    }
    writeJson(
      path.join(
        assignmentPath,
        'research',
        'quality',
        'deterministic-verdict.json',
      ),
      {
        schemaVersion: 1,
        verdictId: 'deterministic-terminal-wave',
        correctionWave: 1,
        decision: 'REVISE',
        findings: [finding],
        correctionRequests: [correctionRequest],
        correctionRoute: 'research',
        reviewedAt: OBSERVED_AT,
      } satisfies QualityVerdict,
    )
    writeJson(
      path.join(
        assignmentPath,
        'research',
        'corrections',
        'current.json',
      ),
      {
        schemaVersion: 1,
        wave: 1,
      },
    )

    registerProvider({
      name: FIXTURE_PROVIDER,
      execute: async (options) => {
        assert.equal(fixtureRole(options), 'evidence-critic')
        return fixtureResult(JSON.stringify({
          schemaVersion: 1,
          verdictId: 'critic-terminal-wave',
          correctionWave: 1,
          decision: 'REVISE',
          findings: [finding],
          correctionRequests: [correctionRequest],
          correctionRoute: 'research',
          reviewedAt: OBSERVED_AT,
        } satisfies QualityVerdict))
      },
    }, {
      source: 'tests/integration/deep-research-correction-publication.test.ts#terminal-wave',
      trustClass: 'test',
    }, { replaceExisting: true })

    const review = await runQualityReview(
      assignmentPath,
      'review-terminal-wave',
    )
    assert.match(readToolText(review), /Chain Complete/u)
    assert.doesNotMatch(
      readToolText(review),
      /invalid verdict|Immutable Deep Research artifact changed/u,
    )

    const sourceVerdict = readJson<QualityVerdict>(
      path.join(
        assignmentPath,
        'research',
        'adaptive',
        'source-verdict-wave-1.json',
      ),
    )
    const finalVerdict = readJson<QualityVerdict>(
      path.join(
        assignmentPath,
        'research',
        'quality',
        'current-verdict.json',
      ),
    )
    const decision = readJson<ResearchAdaptiveDecision>(
      path.join(
        assignmentPath,
        'research',
        'adaptive',
        'decision-wave-1.json',
      ),
    )

    assert.equal(sourceVerdict.decision, 'REVISE')
    assert.equal(decision.decision, 'stop')
    assert.equal(decision.sourceVerdictHash, hashResearchValue(sourceVerdict))
    assert.equal(finalVerdict.decision, 'ESCALATE')
    assert.match(finalVerdict.verdictId, /^adaptive-stop-1-/u)
    assert.equal(
      finalVerdict.findings.some((candidate) =>
        candidate.message.includes('Immutable Deep Research artifact changed'),
      ),
      false,
    )
    assert.deepEqual(
      readJson<QualityVerdict>(
        path.join(
          assignmentPath,
          'research',
          'quality',
          'verdict-wave-1.json',
        ),
      ),
      finalVerdict,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function assertProductionDeepResearchWiring(): void {
  const teamConfig = productionResearchTeamConfig()
  const collect = teamConfig.levels.find(
    (level) => level.id === 'collect-evidence',
  )
  assert.ok(collect)
  assert.equal(collect.stage.type, 'pipeline')
  if (collect.stage.type === 'pipeline') {
    assert.equal(collect.stage.config.plan_file, 'research/plan.md')
    assert.equal(
      collect.stage.config.plan_artifact,
      'research/approved-plan.json',
    )
    assert.equal(
      collect.stage.config.deadline_artifact,
      'research/runtime-limits.json',
    )
    assert.equal(collect.stage.config.execution_mode, 'bounded_parallel')
    assert.equal(collect.stage.config.assignment_scope, 'task')
  }
  const correction = teamConfig.gates.find(
    (gate) =>
      gate.from === 'quality-audit' &&
      gate.to === 'collect-evidence' &&
      gate.condition.type === 'artifact_json' &&
      gate.condition.pointer === '/correctionRoute' &&
      gate.condition.value === 'research' &&
      gate.transform?.type === 'script',
  )
  assert.ok(correction)
  assert.equal(correction.reset_scope, 'target_through_source')
  assert.equal(correction.max_loopbacks, 2)
  assert.equal(
    correction.transform?.script,
    path.join(RESEARCH_TEAM_ROOT, 'scripts', 'prepare-correction-wave.mjs'),
  )
  assert.equal(
    correction.transform?.output,
    'research/corrections/current.json',
  )
  const resynthesis = teamConfig.gates.find(
    (gate) =>
      gate.from === 'quality-audit' &&
      gate.to === 'synthesize-evidence' &&
      gate.condition.type === 'artifact_json' &&
      gate.condition.pointer === '/correctionRoute' &&
      gate.condition.value === 'synthesis' &&
      gate.transform?.type === 'script',
  )
  assert.ok(resynthesis)
  assert.equal(resynthesis.reset_scope, 'target_through_source')
  assert.equal(resynthesis.max_loopbacks, 2)
  assert.equal(
    resynthesis.transform?.script,
    path.join(RESEARCH_TEAM_ROOT, 'scripts', 'prepare-resynthesis-wave.mjs'),
  )
  const approval = teamConfig.gates.find(
    (gate) =>
      gate.from === 'quality-audit' &&
      gate.to === 'done' &&
      gate.condition.type === 'artifact_json' &&
      gate.condition.pointer === '/decision' &&
      gate.condition.value === 'APPROVE',
  )
  assert.ok(approval)

  const parsedWorkflow = parseWorkflowTemplate(DEEP_RESEARCH_WORKFLOW_PATH)
  assert.deepEqual(parsedWorkflow.errors, [])
  assert.ok(parsedWorkflow.template)
  const [research, editorial, publish] = parsedWorkflow.template.steps
  assert.equal(research?.team, 'research-team')
  assert.equal(research?.result_artifact, 'research-package.md')
  assert.deepEqual(research?.result_artifacts, [
    'research/evidence-graph/current.json',
  ])
  assert.deepEqual(editorial?.handoff, {
    from_step: 'research',
    from_artifact: 'research-package.md',
    to_artifact: 'research-package.md',
  })
  assert.deepEqual(editorial?.context_handoffs, [
    {
      from_step: 'research',
      from_artifact: 'research/evidence-graph/current.json',
      to_artifact: 'research/evidence-graph/current.json',
    },
  ])
  assert.equal(editorial?.team, 'deep-research-publication-team')
  assert.deepEqual(editorial?.result_artifacts, [
    'publication-audit.json',
  ])
  assert.equal(publish?.transform, 'markdown_to_docx')
  assert.deepEqual(publish?.provenance_handoff, {
    from_step: 'research',
    from_artifact: 'research-package.md',
    evidence_graph_artifact: 'research/evidence-graph/current.json',
    audit_artifact: 'publication-audit.json',
  })
  assert.deepEqual(publish?.result_artifacts, [
    'final-report.docx',
    'publication-audit.json',
  ])
}

function findGateReport(
  assignmentPath: string,
  routeSuffix: string,
): string {
  const directory = path.join(assignmentPath, 'gate-checks')
  const filename = fs.readdirSync(directory).find((entry) =>
    entry.startsWith('gate-') &&
    entry.endsWith(`${routeSuffix}.md`),
  )
  assert.ok(filename, `Missing gate report for ${routeSuffix}.`)
  return path.join(directory, filename)
}

function productionResearchTeamConfig() {
  const parsed = parseTeamConfig(RESEARCH_TEAM_CONFIG_PATH)
  assert.deepEqual(parsed.errors, [])
  assert.ok(parsed.config)
  return parsed.config
}

function makePlan(
  workers: readonly ResearchWorkerSpec[],
  options: { adaptive?: boolean } = {},
): ResearchPlan {
  return {
    schemaVersion: 1,
    planId: 'plan-one',
    requestId: 'request-one',
    request: {
      schemaVersion: 1,
      requestId: 'request-one',
      question: 'What level of adoption is supported by observed evidence?',
      objective: 'Establish an evidence-backed adoption figure.',
      audience: 'Decision makers',
      includedScope: ['Observed adoption evidence'],
      excludedScope: [],
      desiredSections: ['Adoption evidence'],
      jurisdictions: [],
      freshnessAsOf: OBSERVED_AT,
      authenticatedDomains: [],
      sourceRequirements: ['Require independent corroboration.'],
      maxDurationMinutes: 20,
      maxResearcherAgents: Math.max(1, workers.length),
      outputFormats: ['markdown', 'docx'],
    },
    sections: [
      {
        schemaVersion: 1,
        id: 'section-one',
        title: 'Adoption evidence',
        objective: 'Establish the observed adoption figure.',
        taskIds: workers.map((_, index) => `T${index + 1}`),
      },
    ],
    tasks: workers.map((worker, index) => ({
      schemaVersion: 1 as const,
      id: `T${index + 1}`,
      sectionId: 'section-one',
      title:
        index === 0 ? 'Verify adoption evidence' : 'Verify retention evidence',
      question: worker.question,
      purpose: 'evidence_verification' as const,
      workerSpecId: worker.id,
      dependsOn: [],
      correctionWave: 0 as const,
    })),
    workerSpecs: workers,
    maxDurationMinutes: 20,
    maxResearcherAgents: Math.max(1, workers.length),
    expectedPeakWorkers: Math.max(1, workers.length),
    authenticatedDomains: [],
    ...(options.adaptive
      ? {
          executionPolicy: {
            schemaVersion: 1,
            complexity: 'standard',
            complexityRationale:
              'Two quantitative claims require independent corroboration.',
            searchBreadth: 'balanced',
            maxCostUsd: 20,
            evidenceTargets: {
              minimumSupportedClaims: 2,
              minimumIndependentSourcesPerConsequentialClaim: 2,
              crossVerifyConsequentialClaims: true,
            },
            stopping: {
              minimumExpectedInformationGain: 80,
              maximumCorrectionWaves: 2,
            },
            synthesis: {
              mode: 'single_pass',
              maximumParallelSections: 1,
            },
          },
        }
      : {}),
  }
}

function makeWorkerSpec(input: {
  id: string
  laneId: string
  displayRole: string
  question: string
  requiredMetric: string
}): ResearchWorkerSpec {
  return {
    schemaVersion: 1,
    id: input.id,
    laneId: input.laneId,
    sectionId: 'section-one',
    baseAgent: 'web-researcher',
    displayRole: input.displayRole,
    domain: 'technology adoption',
    lens: 'source_verification',
    methodCardIds: ['source-verification-v1'],
    specialistStance:
      'Approach this assignment as a technology-adoption verification analyst. Separate reported interest from observed organizational use.',
    question: input.question,
    decisionUse: 'Establish an evidence-backed adoption figure.',
    workingDefinitions: [
      'Count adoption only when a source establishes actual organizational use.',
    ],
    dependencyClaimIds: [],
    sourceRequirements: {
      preferredTypes: ['primary', 'industry'],
      requiredAuthorityTypes: ['primary'],
      queryHints: ['official adoption evidence'],
    },
    requiredMetrics: [input.requiredMetric],
    prohibitedAssumptions: ['A single publisher is independent corroboration.'],
    stopRule: {
      minimumPrimarySources: 1,
      minimumIndependentSources: 2,
      maximumSources: 4,
    },
    limits: { deadlineMs: 60_000 },
  }
}

function materializeApprovedPlan(
  assignmentPath: string,
  plan: ResearchPlan,
): void {
  const inputPath = path.join(assignmentPath, 'research', 'plan-ready.md')
  const outputPath = path.join(assignmentPath, 'research', 'approved-plan.json')
  fs.mkdirSync(path.dirname(inputPath), { recursive: true })
  fs.writeFileSync(inputPath, '# Approved plan is ready.\n')
  fs.writeFileSync(
    path.join(assignmentPath, 'incoming-brief.md'),
    [
      '# Approved Deep Research brief',
      '',
      '<!-- pipeline-runtime:approved-deep-research-plan:v1 -->',
      JSON.stringify(plan, null, 2),
      '',
    ].join('\n'),
  )
  const materializeGate = productionResearchTeamConfig().gates.find(
    (gate) =>
      gate.from === 'prepare-approved-plan' &&
      gate.to === 'collect-evidence' &&
      gate.transform?.type === 'script',
  )
  assert.ok(materializeGate?.transform?.script)
  runScript(
    path.resolve(RESEARCH_TEAM_ROOT, materializeGate.transform.script),
    assignmentPath,
    inputPath,
    outputPath,
  )
}

async function routeQualityDecision(
  assignmentPath: string,
  workspacePath: string,
) {
  const assignmentLocation = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-one',
    runId: 'run-one',
    assignmentId: 'assignment-one',
  })
  assert.ok(assignmentLocation)
  assert.equal(assignmentLocation.assignmentPath, assignmentPath)

  const teamConfig = productionResearchTeamConfig()
  const qualityIndex = teamConfig.levels.findIndex(
    (level) => level.id === 'quality-audit',
  )
  assert.notEqual(qualityIndex, -1)
  const runtimePlanPath = path.join(
    assignmentPath,
    '.runtime',
    'pipeline',
    'collect-evidence',
    'plan.md',
  )
  const levelStates = new Map(
    teamConfig.levels.map((level, index) => {
      let engineState = null
      if (level.id === 'collect-evidence') {
        engineState = {
          type: STAGE_TYPE.PIPELINE,
          planPath: runtimePlanPath,
          completedSprintIds: ['S1'],
          activeTaskIds: [],
        }
      } else if (level.id === 'synthesize-evidence') {
        engineState = {
          type: STAGE_TYPE.CHAIN,
          currentStep: 1,
          totalSteps: 1,
          outputs: [
            {
              agent: 'research-synthesizer',
              text: fs.readFileSync(
                path.join(assignmentPath, 'research-package.md'),
                'utf8',
              ),
            },
          ],
        }
      } else if (level.id === 'quality-audit') {
        engineState = {
          type: STAGE_TYPE.CHAIN,
          currentStep: 1,
          totalSteps: 1,
          outputs: [
            {
              agent: 'evidence-critic',
              text: fs.readFileSync(
                path.join(
                  assignmentPath,
                  'research',
                  'quality',
                  'current-verdict.json',
                ),
                'utf8',
              ),
            },
          ],
        }
      }
      return [
        level.id,
        {
          status:
            index === qualityIndex
              ? LEVEL_STATUS.ACTIVE
              : index < qualityIndex
                ? LEVEL_STATUS.COMPLETED
                : LEVEL_STATUS.PENDING,
          stageStatus:
            index === qualityIndex
              ? STAGE_LIFECYCLE_STATUS.RUNNING
              : index < qualityIndex
                ? STAGE_LIFECYCLE_STATUS.COMPLETED
                : STAGE_LIFECYCLE_STATUS.NOT_STARTED,
          loopbackCount: 0,
          engineState,
        },
      ]
    }),
  )

  const ctx = createRuntimeContext({ sendUserMessage: () => {} } as never)
  ctx.teamConfig = teamConfig
  ctx.teamRoot = RESEARCH_TEAM_ROOT
  ctx.assignmentLocation = assignmentLocation
  ctx.state.sessionId = assignmentLocation.assignmentId
  ctx.state.rootSessionId = assignmentLocation.runId
  ctx.state.parentSessionId = assignmentLocation.sessionId
  ctx.state.currentLevelIndex = qualityIndex
  ctx.state.levelStates = levelStates as never
  ctx.state.startTime = Date.now()
  ctx.state.timerStarted = true

  let persistCount = 0
  let registerCount = 0
  let startCount = 0
  const notifications: string[] = []
  await tryAdvanceLevel(
    {
      ui: {
        notify: (message: string) => {
          notifications.push(message)
        },
      },
    } as never,
    ctx,
    {
      persistState: () => {
        persistCount += 1
      },
      registerLevelTools: () => {
        registerCount += 1
      },
      runtimeOwnsLevel: () => true,
      // No turn owns the loop in this fixture, so the destination is
      // prepared by the transition itself.
      prepareHostForActiveLevel: async () => true,
      startActiveLevel: async () => {
        startCount += 1
        return false
      },
      updateDashboard: () => {},
    },
  )

  const collect = ctx.state.levelStates.get('collect-evidence')
  const synthesis = ctx.state.levelStates.get('synthesize-evidence')
  const quality = ctx.state.levelStates.get('quality-audit')
  const escalation = ctx.state.levelStates.get('research-escalation')
  assert.ok(collect)
  assert.ok(synthesis)
  assert.ok(quality)
  assert.ok(escalation)
  return {
    currentLevelId: teamConfig.levels[ctx.state.currentLevelIndex]?.id,
    collectStatus: collect.status,
    collectStageStatus: collect.stageStatus,
    collectLoopbackCount: collect.loopbackCount,
    collectEngineState: collect.engineState,
    synthesisStatus: synthesis.status,
    synthesisStageStatus: synthesis.stageStatus,
    synthesisEngineState: synthesis.engineState,
    qualityStatus: quality.status,
    qualityStageStatus: quality.stageStatus,
    qualityEngineState: quality.engineState,
    escalationStatus: escalation.status,
    escalationStageStatus: escalation.stageStatus,
    escalationEngineState: escalation.engineState,
    persistCount,
    registerCount,
    startCount,
    notifications,
  }
}

function runScript(
  scriptPath: string,
  assignmentPath: string,
  inputPath: string,
  outputPath: string,
): void {
  const result = spawnSync(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      WORKSPACE_PATH: assignmentPath,
      TRANSFORM_INPUT: inputPath,
      TRANSFORM_OUTPUT: outputPath,
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

interface SourceFixture {
  suffix: string
  url: string
  title: string
  publisher: string
  sourceType: SourceRecord['sourceType']
  excerpt: string
}

function makeEvidencePacket(input: {
  assignmentPath: string
  worker: ResearchWorkerSpec
  taskId: string
  claimId: string
  statement: string
  wave: 0 | 1
  sourceFixtures: SourceFixture[]
}): EvidencePacket {
  const sources = input.sourceFixtures.map((fixture) => {
    const receiptId = `receipt-${input.taskId.toLowerCase()}-wave-${input.wave}-${fixture.suffix}`
    const contentRelativePath =
      `research/acquisitions/${input.worker.laneId}/${receiptId}/content.md`
    const content = [fixture.title, fixture.excerpt].join('\n')
    const contentBuffer = Buffer.from(content)
    const contentSha256 = sha256(contentBuffer)
    const contentPath = path.join(input.assignmentPath, contentRelativePath)
    fs.mkdirSync(path.dirname(contentPath), { recursive: true })
    fs.writeFileSync(contentPath, contentBuffer)

    const receiptPath = path.join(
      input.assignmentPath,
      'research',
      'observations',
      input.worker.laneId,
      `${receiptId}.json`,
    )
    writeJson(receiptPath, {
      schemaVersion: 1,
      receiptId,
      sessionId: 'session-one',
      runId: 'run-one',
      assignmentId: 'assignment-one',
      activityScopeId: input.worker.laneId,
      activityId: receiptId,
      agentPath: 'agents/web-researcher',
      method: 'managed-browser',
      requestedUrl: fixture.url,
      finalUrl: fixture.url,
      canonicalUrl: fixture.url,
      title: fixture.title,
      mediaType: 'text/html',
      observedAt: OBSERVED_AT,
      contentRelativePath,
      contentSha256,
      contentBytes: contentBuffer.byteLength,
      quality: 'usable',
      attempts: [{
        method: 'managed-browser',
        outcome: 'usable',
        startedAt: OBSERVED_AT,
        durationMs: 1,
        contentBytes: contentBuffer.byteLength,
      }],
    })
    return {
      schemaVersion: 1 as const,
      sourceId: `source-${input.taskId.toLowerCase()}-wave-${input.wave}-${fixture.suffix}`,
      assignmentId: input.worker.laneId,
      canonicalUrl: fixture.url,
      title: fixture.title,
      publisher: fixture.publisher,
      independenceKey: new URL(fixture.url).hostname,
      sourceType: fixture.sourceType,
      accessMethod: 'managed-browser' as const,
      observationReceiptId: receiptId,
      observedAt: OBSERVED_AT,
      publishedAt: OBSERVED_AT,
      contentSha256,
      status: 'usable' as const,
      excerpt: fixture.excerpt,
    }
  })
  return {
    schemaVersion: 1,
    assignmentId: input.worker.laneId,
    taskId: input.taskId,
    workerSpecHash: hashResearchValue(input.worker),
    question: input.worker.question,
    shortAnswer: input.statement,
    findings: [
      {
        schemaVersion: 1,
        claimId: input.claimId,
        taskId: input.taskId,
        sectionId: 'section-one',
        statement: input.statement,
        kind: 'fact',
        evidenceStandard: 'independent_corroboration',
        sourceIds: sources.map((source) => source.sourceId),
        evidenceLinks: sources.map((source) => ({
          sourceId: source.sourceId,
          observationReceiptId: source.observationReceiptId,
          observedExcerpt: source.excerpt,
          locator: source.title,
          relationship: 'supports' as const,
        })),
        confidence: sources.length > 1 ? 'high' : 'low',
        status: 'supported',
        applicableScope: input.worker.requiredMetrics ?? [],
      },
    ],
    sources: sources.map(({ excerpt: _excerpt, ...source }) => source),
    contradictions: [],
    unresolvedQuestions: [],
    stopReason: 'decision_useful',
  }
}

function makePipelineContext(assignmentPath: string) {
  const levelId = 'collect-evidence'
  const teamConfig = productionResearchTeamConfig()
  const level = teamConfig.levels.find((candidate) => candidate.id === levelId)
  assert.ok(level)
  assert.equal(level.stage.type, 'pipeline')
  const stage = level.stage
  return {
    teamName: 'research-team',
    teamConfig,
    teamRootPath: RESEARCH_TEAM_ROOT,
    levelId,
    config: stage,
    agents: new Map([
      [
        'web-researcher',
        fixtureAgent(
          'web-researcher',
          'FIXTURE_ROLE:web-researcher',
          assignmentPath,
        ),
      ],
    ]),
    rosterEntries: new Map([
      [
        'web-researcher',
        {
          name: 'web-researcher',
          type: 'agent',
          on_failure: { policy: 'retry', max_retries: 0 },
        },
      ],
    ]),
    state: runtimeState(levelId),
    workspacePath: assignmentPath,
    outputPath: assignmentPath,
    inputFilesContent: '',
    agentMetrics: new Map(),
    stageFailureOverride: 'halt',
  } as never
}

async function runSynthesis(
  assignmentPath: string,
  callId: string,
): Promise<void> {
  const synthesisPacket = fs.readFileSync(
    path.join(assignmentPath, 'research', 'synthesis', 'current.json'),
    'utf8',
  )
  const result = await createChainTool(
    makeChainContext({
      assignmentPath,
      levelId: 'synthesize-evidence',
      agentName: 'research-synthesizer',
      roleMarker: 'FIXTURE_ROLE:research-synthesizer',
    }),
  ).execute(
    callId,
    {
      message: fixtureEnvelope('synthesis-packet', synthesisPacket),
    } as never,
    undefined as never,
    undefined as never,
    undefined as never,
  )
  assert.match(readToolText(result), /Chain Complete/)
}

async function runQualityReview(assignmentPath: string, callId: string) {
  return createChainTool(
    makeChainContext({
      assignmentPath,
      levelId: 'quality-audit',
      agentName: 'evidence-critic',
      roleMarker: 'FIXTURE_ROLE:evidence-critic',
    }),
  ).execute(
    callId,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  )
}

function makeChainContext(input: {
  assignmentPath: string
  workspacePath?: string
  levelId: string
  agentName: string
  roleMarker: string
}) {
  const teamConfig = productionResearchTeamConfig()
  const level = teamConfig.levels.find(
    (candidate) => candidate.id === input.levelId,
  )
  assert.ok(level)
  assert.equal(level.stage.type, 'chain')
  const stage = level.stage
  const rosterEntry = teamConfig.agents.find(
    (candidate) => candidate.name === input.agentName,
  )
  assert.ok(rosterEntry)
  return {
    teamName: 'research-team',
    teamConfig,
    teamRootPath: RESEARCH_TEAM_ROOT,
    levelId: input.levelId,
    config: stage,
    agents: new Map([
      [
        input.agentName,
        fixtureAgent(input.agentName, input.roleMarker, input.assignmentPath),
      ],
    ]),
    rosterEntries: new Map([
      [input.agentName, rosterEntry],
    ]),
    state: runtimeState(input.levelId),
    workspacePath: input.workspacePath ?? input.assignmentPath,
    outputPath: input.assignmentPath,
    inputFilesContent: '',
    agentMetrics: new Map(),
    getCurrentCoordinatorRunId: () => 1,
    coordinatorName: input.agentName,
  } as never
}

function fixtureAgent(name: string, systemPrompt: string, agentDir: string) {
  return {
    name,
    systemPrompt,
    agentDir,
    experienceEnabled: false,
    model: 'fixture-model',
    thinking: 'low',
    tools: [],
    provider: FIXTURE_PROVIDER,
  }
}

function runtimeState(levelId: string) {
  return {
    sessionId: 'assignment-one',
    currentLevelIndex: 0,
    levelStates: new Map([
      [
        levelId,
        {
          status: 'active',
          stageStatus: STAGE_LIFECYCLE_STATUS.READY,
          loopbackCount: 0,
          engineState: null,
        },
      ],
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
  const match = /FIXTURE_ROLE:([a-z-]+)/u.exec(options.systemPrompt)
  if (!match)
    throw new Error('Deterministic provider received no fixture role.')
  return match[1]!
}

function fixtureResult(text: string): ProviderResult {
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

function researchResponseFromPrompt(
  options: ProviderExecuteOptions,
  evidenceByTaskAndWave: ReadonlyMap<string, EvidencePacket>,
): {
  taskId: string
  wave: 0 | 1
  packet: EvidencePacket
} {
  const taskId = requiredPromptCapture(
    options.userMessage,
    /Set taskId exactly to "([^"]+)"\./u,
    'taskId',
  )
  const assignmentId = requiredPromptCapture(
    options.userMessage,
    /Set assignmentId exactly to "([^"]+)"\./u,
    'assignmentId',
  )
  const workerSpecHash = requiredPromptCapture(
    options.userMessage,
    /Set workerSpecHash exactly to "([a-f0-9]{64})"\./u,
    'workerSpecHash',
  )
  const waveCapture = /This is correction wave ([12])\./u.exec(
    options.userMessage,
  )?.[1]
  const wave = waveCapture === undefined ? 0 : (Number(waveCapture) as 1)
  const packet = evidenceByTaskAndWave.get(`${taskId}:${wave}`)
  assert.ok(
    packet,
    `No evidence fixture for ${taskId} correction wave ${wave}.`,
  )
  assert.equal(packet.assignmentId, assignmentId)
  assert.equal(packet.workerSpecHash, workerSpecHash)
  assert.match(
    options.userMessage,
    new RegExp(escapeRegExp(packet.question), 'u'),
  )
  if (wave === 1) {
    assert.match(options.userMessage, /# Targeted Correction Wave/u)
    assert.match(options.userMessage, /independent-source requirement/u)
    assert.match(options.userMessage, /complete replacement EvidencePacket/u)
  } else {
    assert.doesNotMatch(options.userMessage, /# Targeted Correction Wave/u)
  }
  return {
    taskId,
    wave,
    packet: {
      ...packet,
      taskId,
      assignmentId,
      workerSpecHash,
    },
  }
}

function renderResearchPackageFromPrompt(
  options: ProviderExecuteOptions,
): string {
  const synthesis = JSON.parse(
    extractFixtureEnvelope(options.userMessage, 'synthesis-packet'),
  ) as ResearchSynthesisPacket
  assert.equal(synthesis.planId, 'plan-one')
  assert.deepEqual(synthesis.coverage.map((entry) => entry.taskId).sort(), [
    'T1',
    'T2',
  ])
  assert.equal(
    synthesis.coverage.every((entry) => entry.isCovered),
    true,
  )
  const statements = synthesis.claims.map((claim) => claim.statement)
  assert.ok(statements.includes('Observed adoption reached 42% in 2026.'))
  assert.ok(statements.includes('Observed retention reached 88% in 2026.'))
  return [
    '# Research package',
    '',
    ...statements.flatMap((statement) => [statement, '']),
    '## Limitations and contradictions',
    '',
    'A limitation remains: the bounded observation is uncertain outside the approved scope.',
    '',
    '## Sources',
    '',
    ...synthesis.sources.map((source) => `- ${source.canonicalUrl}`),
    '',
  ].join('\n')
}

function qualityReviewFromPrompt(
  options: ProviderExecuteOptions,
): QualityVerdict {
  const quality = JSON.parse(
    extractRuntimeEnvelope(options.userMessage, 'quality-packet'),
  ) as ResearchQualityPacket
  const deterministic = JSON.parse(
    extractRuntimeEnvelope(options.userMessage, 'deterministic-verdict'),
  ) as QualityVerdict
  const researchPackage = extractRuntimeEnvelope(
    options.userMessage,
    'research-package',
  )
  assert.equal(quality.planId, 'plan-one')
  assert.deepEqual(quality.requiredTaskIds, ['T1', 'T2'])
  for (const source of quality.synthesis.sources) {
    assert.match(
      researchPackage,
      new RegExp(escapeRegExp(source.canonicalUrl), 'u'),
    )
  }
  if (deterministic.correctionWave === 0) {
    assert.equal(deterministic.decision, 'REVISE')
    assert.ok(deterministic.correctionRequests.length > 0)
    assert.equal(
      deterministic.correctionRequests.every(
        (request) =>
          request.taskIds.includes('T1') && !request.taskIds.includes('T2'),
      ),
      true,
    )
  } else {
    assert.equal(deterministic.correctionWave, 1)
    assert.equal(deterministic.decision, 'APPROVE')
    assert.deepEqual(deterministic.correctionRequests, [])
    assert.equal(quality.synthesis.sources.length, 4)
  }
  return {
    ...deterministic,
    verdictId: `fixture-critic-wave-${deterministic.correctionWave}`,
    reviewedAt: OBSERVED_AT,
  }
}

function extractResearchPackage(prompt: string): string {
  const packageStart = prompt.lastIndexOf('# Research package')
  assert.notEqual(
    packageStart,
    -1,
    'Research package was not handed to writing.',
  )
  return prompt.slice(packageStart).trimEnd() + '\n'
}

function finalReportFromPrompt(title: string, prompt: string): string {
  const claims = [
    'Observed adoption reached 42% in 2026.',
    'Observed retention reached 88% in 2026.',
  ].filter((claim) => prompt.includes(claim))
  assert.equal(claims.length, 2)
  const urls = Array.from(
    new Set(prompt.match(/https?:\/\/[^\s<>'"`]+/gu) ?? []),
  ).map((url) => url.replace(/[.,;:!?}\]]+$/u, ''))
  assert.deepEqual(urls.sort(), [
    'https://benchmark.example/retention',
    'https://independent.example/verification',
    'https://metrics.example/retention',
    'https://official.example/evidence',
  ])
  assert.match(prompt, /limitation/u)
  assert.match(prompt, /uncertain/u)
  return [
    `# ${title}`,
    '',
    ...claims.flatMap((claim) => [claim, '']),
    '## Limitations and contradictions',
    '',
    'A limitation remains: the bounded observation is uncertain outside the approved scope.',
    '',
    '## Sources',
    '',
    ...urls.map((url) => `- ${url}`),
    '',
  ].join('\n')
}

function fixtureEnvelope(name: string, value: string): string {
  return `<fixture-${name}>\n${value.trim()}\n</fixture-${name}>`
}

function extractFixtureEnvelope(prompt: string, name: string): string {
  const startMarker = `<fixture-${name}>`
  const endMarker = `</fixture-${name}>`
  const start = prompt.indexOf(startMarker)
  const end = prompt.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(start, -1, `Missing ${name} handoff start marker.`)
  assert.notEqual(end, -1, `Missing ${name} handoff end marker.`)
  return prompt.slice(start + startMarker.length, end).trim()
}

function extractRuntimeEnvelope(prompt: string, name: string): string {
  const startMarker = `<runtime-${name}>`
  const endMarker = `</runtime-${name}>`
  const start = prompt.indexOf(startMarker)
  const end = prompt.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(start, -1, `Missing ${name} runtime start marker.`)
  assert.notEqual(end, -1, `Missing ${name} runtime end marker.`)
  return prompt.slice(start + startMarker.length, end).trim()
}

function requiredPromptCapture(
  prompt: string,
  pattern: RegExp,
  label: string,
): string {
  const value = pattern.exec(prompt)?.[1]
  assert.ok(value, `Provider prompt is missing ${label}.`)
  return value
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

async function publishApprovedResearch(assignmentPath: string, root: string) {
  const teamPath = createFixtureWritingTeam(root)
  const templatePath = path.join(root, 'correction-publication.yaml')
  fs.writeFileSync(
    templatePath,
    `
workflow:
  id: correction-publication
  steps:
    - id: research
      type: agent
      team: fixture-writing-team
      agent: research-handoff
      stage_type: chain
      input_artifact: incoming-brief.md
      result_artifact: research-package.md
      recovery_policy: manual
    - id: writer
      type: agent
      team: fixture-writing-team
      agent: writer
      stage_type: chain
      input_artifact: incoming-brief.md
      result_artifact: writer-draft.md
      recovery_policy: manual
      handoff:
        from_step: research
        from_artifact: research-package.md
        to_artifact: incoming-brief.md
    - id: editorial
      type: agent
      team: fixture-writing-team
      agent: editor
      stage_type: chain
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
      recovery_policy: manual
      handoff:
        from_step: writer
        from_artifact: writer-draft.md
        to_artifact: incoming-brief.md
    - id: publish
      type: transform
      transform: markdown_to_docx
      input_artifact: final-draft.md
      result_artifact: final-report.md
      result_artifacts:
        - final-report.docx
      recovery_policy: idempotent
      handoff:
        from_step: editorial
        from_artifact: final-draft.md
        to_artifact: final-draft.md
      provenance_handoff:
        from_step: research
        from_artifact: research-package.md
  output:
    from_step: publish
    artifact: final-report.md
    secondary_artifacts:
      - artifact: final-report.docx
        media_type: application/vnd.openxmlformats-officedocument.wordprocessingml.document
        label: Word document
`,
  )
  return runWorkflow({
    workflowEntry: {
      name: 'correction-publication',
      template_path: templatePath,
    },
    teamRegistry: new Map([
      [
        'fixture-writing-team',
        {
          name: 'fixture-writing-team',
          type: 'team' as const,
          team_path: teamPath,
          input_artifact: 'incoming-brief.md',
          output_artifact: 'final-draft.md',
        },
      ],
    ]),
    brief: fs.readFileSync(
      path.join(assignmentPath, 'research-package.md'),
      'utf8',
    ),
    workspacePath: path.join(root, 'publication-workspace'),
    spawnDepth: 0,
    persistenceMode: 'required',
    taskId: 'correction-publication-task',
    productSessionId: 'correction-publication-session',
    rootSessionId: 'correction-publication-root',
    executionAttemptId: 'correction-publication-attempt',
  })
}

function createFixtureWritingTeam(root: string): string {
  const teamPath = path.join(root, 'fixture-writing-team')
  const agentNames = ['research-handoff', 'writer', 'editor']
  for (const agentName of agentNames) {
    const agentPath = path.join(
      teamPath,
      'agents',
      agentName,
      `${agentName}.md`,
    )
    fs.mkdirSync(path.dirname(agentPath), { recursive: true })
    // Each fixture agent names the pair it runs with; the team names none.
    fs.writeFileSync(
      agentPath,
      `---\nprovider: ${FIXTURE_PROVIDER}\nmodel: fixture-model\nthinking: low\n---\n\nFIXTURE_ROLE:${agentName}\n`,
    )
  }
  fs.writeFileSync(
    path.join(teamPath, 'team.yaml'),
    `
team:
  name: fixture-writing-team
  description: Deterministic integration fixture for writing handoffs.
  version: "1.0.0"
workspace:
  path: workspace
  watch: false
workflow:
  entry_level: writing-chain
  input_contract:
    artifacts:
      - path: incoming-brief.md
        required: true
  output_contract:
    artifacts:
      - path: final-draft.md
        required: true
    completion_artifact: final-draft.md
agents:
  - name: research-handoff
    type: agent
    role: Carries the approved research package into writing.
    tier: strategic
    tools: []
    agent_file: agents/research-handoff/research-handoff.md
    experience_enabled: false
  - name: writer
    type: agent
    role: Writes the evidence-sealed draft.
    tier: execution
    tools: []
    agent_file: agents/writer/writer.md
    experience_enabled: false
  - name: editor
    type: agent
    role: Reviews the evidence-sealed draft.
    tier: strategic
    tools: []
    agent_file: agents/editor/editor.md
    produces:
      - path: final-draft.md
    experience_enabled: false
levels:
  - id: writing-chain
    name: Writing Chain
    order: 0
    stage:
      type: chain
      sequence:
        - research-handoff
        - writer
        - editor
      config:
        output:
          format: final-draft.md
          user_review: false
gates:
  - from: writing-chain
    to: done
    condition:
      type: artifact_exists
      artifact: final-draft.md
`,
  )
  return teamPath
}

function parseDocx(docxPath: string, root: string): string {
  const outputPath = path.join(root, 'parsed-docx')
  fs.mkdirSync(outputPath, { recursive: true })
  const parseScript = [
    "import { parseDocx } from './parsers/docx.ts'",
    'const result = await parseDocx(process.argv[1], process.argv[2])',
    'console.log(JSON.stringify(result))',
  ].join(';')
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      parseScript,
      docxPath,
      outputPath,
    ],
    {
      cwd: path.join(REPO_ROOT, 'file-parser'),
      encoding: 'utf8',
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout.trim()) as {
    status: string
    outputs: { text?: string }
  }
  assert.equal(parsed.status, 'success')
  assert.ok(parsed.outputs.text)
  return fs.readFileSync(path.join(outputPath, parsed.outputs.text), 'utf8')
}

function readToolText(result: unknown): string {
  const toolResult = result as { content?: Array<{ text?: string }> }
  return toolResult.content?.[0]?.text ?? ''
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson<T = unknown>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
