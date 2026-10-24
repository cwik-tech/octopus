import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type {
  ResearchEvaluationCase,
} from '../../contracts/deep-research.js'
import { approveResearchPlan } from '../../domains/deep-research/deep-research-approval.js'
import {
  buildResearchEvidenceGraph,
  buildResearchSectionDossiers,
} from '../../domains/deep-research/deep-research-evidence-graph.js'
import { buildResearchPublicationAudit } from '../../domains/deep-research/deep-research-publication-audit.js'
import { buildResearchSynthesisPacket } from '../../domains/deep-research/deep-research-quality.js'
import {
  buildArtifactMetadata,
  withArtifactFrontmatter,
} from '../../domains/runtime/artifacts.js'
import { generateWordBuffer } from '../../domains/word-generation/generate-word.js'
import {
  evaluateDeepResearchRunDirectory,
  loadDeepResearchEvaluationCorpus,
  loadDeepResearchEvaluationReport,
} from '../../services/deep-research-evaluation-service.js'
import {
  makeEvidencePacket,
  makePlan,
  TEST_TIME,
} from '../unit/deep-research-fixtures.js'

const CORPUS_PATH = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'deep-research',
  'evaluation-corpus.json',
)

test('frozen Deep Research corpus contains distinct simple and complex release cases', () => {
  const corpus = loadDeepResearchEvaluationCorpus(CORPUS_PATH)

  assert.equal(corpus.cases.length, 2)
  assert.deepEqual(
    corpus.cases.map((entry) => entry.scenarioClass).sort(),
    ['complex', 'simple'],
  )
  assert.ok(
    corpus.cases.find(
      (entry) => entry.scenarioClass === 'complex',
    )?.requiredArtifacts.includes('section_drafts'),
  )
})

test('real run artifacts produce a retained metric report, baseline comparison, and artifact-specific failure', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'deep-research-evaluation-'),
  )
  const retainedPath = `${root}-retained`
  try {
    const corpus = loadDeepResearchEvaluationCorpus(CORPUS_PATH)
    const complexCase = corpus.cases.find(
      (entry) => entry.scenarioClass === 'complex',
    )!
    const evaluationCase: ResearchEvaluationCase = {
      ...complexCase,
      id: 'adaptive-acquisition-economics',
      title: 'Adaptive acquisition economics',
      brief:
        'Evaluate acquisition economics with independent observed evidence.',
      expectedTerms: ['acquisition', 'economics'],
    }
    const policy = {
      schemaVersion: 1 as const,
      complexity: 'complex' as const,
      complexityRationale:
        'The report uses evidence-bound section drafting.',
      searchBreadth: 'broad' as const,
      maxCostUsd: 24,
      evidenceTargets: {
        minimumSupportedClaims: 1,
        minimumIndependentSourcesPerConsequentialClaim: 2,
        crossVerifyConsequentialClaims: true,
      },
      stopping: {
        minimumExpectedInformationGain: 30,
        maximumCorrectionWaves: 2 as const,
      },
      synthesis: {
        mode: 'section_dossiers' as const,
        maximumParallelSections: 2,
      },
    }
    const plan = approveResearchPlan(
      makePlan({ executionPolicy: policy }),
      TEST_TIME,
    )
    const evidencePacket = makeEvidencePacket()
    const synthesis = buildResearchSynthesisPacket({
      plan,
      evidencePackets: [evidencePacket],
    })
    const graph = buildResearchEvidenceGraph({
      plan,
      synthesis,
      correctionWave: 0,
    })
    const dossiers = buildResearchSectionDossiers({
      plan,
      synthesis,
      graph,
      evidencePackets: [evidencePacket],
    })
    const reportMarkdown = `# Acquisition economics

The acquisition channel has sustainable economics according to independently
observed evidence.

## Limitations

The evidence applies only to the stated B2B SaaS scope.

## Sources

- https://example.com/report
- https://independent.example.org/benchmark
`
    const audit = buildResearchPublicationAudit({
      sourceMarkdown: reportMarkdown,
      publicationMarkdown: reportMarkdown,
      evidenceGraph: graph,
      auditedAt: TEST_TIME,
    })
    assert.equal(audit.decision, 'APPROVE')

    const graphPath = path.join(
      root,
      'research',
      'evidence-graph',
      'current.json',
    )
    const dossierPath = path.join(
      root,
      'research',
      'sections',
      'section-one',
      'dossier-current.json',
    )
    const sectionDraftPath = path.join(
      root,
      'research',
      'sections',
      'section-one',
      'draft-wave-0.md',
    )
    const finalDraftPath = path.join(root, 'final-draft.md')
    const finalMarkdownPath = path.join(root, 'final-report.md')
    const finalDocxPath = path.join(root, 'final-report.docx')
    const evaluationPath = path.join(root, 'evaluation.json')
    const workflowStatePath = path.join(
      root,
      'assignments',
      'evaluation-task',
      '.runtime',
      'workflow-state.json',
    )
    for (const directory of [
      path.dirname(graphPath),
      path.dirname(dossierPath),
      path.dirname(workflowStatePath),
    ]) {
      fs.mkdirSync(directory, { recursive: true })
    }
    writeJson(graphPath, graph)
    writeJson(dossierPath, dossiers[0])
    fs.writeFileSync(sectionDraftPath, reportMarkdown, 'utf8')
    fs.writeFileSync(
      path.join(root, 'research-package.md'),
      reportMarkdown,
      'utf8',
    )
    fs.writeFileSync(
      finalDraftPath,
      withArtifactFrontmatter(
        buildArtifactMetadata({
          filePath: finalDraftPath,
          rootDir: root,
          artifactType: 'result',
          createdAt: TEST_TIME,
          status: 'approved',
          verdict: 'APPROVE',
          reviewed: 'deep-research-publication-editor',
        }),
        reportMarkdown,
      ),
      'utf8',
    )
    fs.writeFileSync(finalMarkdownPath, reportMarkdown, 'utf8')
    writeJson(path.join(root, 'publication-audit.json'), audit)
    const downstreamPackagePath = path.join(
      root,
      'assignments',
      'writing-handoff',
      'research-package.md',
    )
    fs.mkdirSync(path.dirname(downstreamPackagePath), {
      recursive: true,
    })
    fs.writeFileSync(
      downstreamPackagePath,
      '**Status:** BLOCKED\n\nThis newer handoff copy is not canonical.\n',
      'utf8',
    )
    const generatedWord = await generateWordBuffer(reportMarkdown, {
      profile: 'research-report',
      renderMermaid: false,
      sourceDirectory: root,
    })
    fs.writeFileSync(finalDocxPath, generatedWord.buffer)
    writeJson(workflowStatePath, {
      schemaVersion: 1,
      revision: 3,
      taskId: 'evaluation-task',
      sessionId: 'evaluation-session',
      rootRunId: 'evaluation-run',
      workflowId: 'deep-research-report',
      ownerExecutionAttemptId: 'evaluation-attempt',
      status: 'completed',
      totalCostUsd: 4.25,
      recoveryCount: 0,
      createdAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-16T12:01:00.000Z',
      steps: [],
    })

    const report = evaluateDeepResearchRunDirectory({
      runPath: root,
      evaluationCase,
      outputPath: evaluationPath,
      evaluatedAt: TEST_TIME,
    })

    assert.equal(report.decision, 'PASS')
    assert.ok(
      report.compositeScore >=
      evaluationCase.thresholds.minimumCompositeScore,
    )
    assert.equal(report.metrics.length, 11)
    assert.ok(report.metrics.every((metric) => metric.passed))
    assert.equal(
      report.metrics.find((metric) => metric.id === 'cost')?.value,
      4.25,
    )
    assert.equal(
      report.metrics.find(
        (metric) => metric.id === 'elapsed_time',
      )?.value,
      60_000,
    )
    assert.ok(
      report.retainedArtifacts.some((artifact) =>
        artifact.endsWith('draft-wave-0.md'),
      ),
    )
    assert.deepEqual(
      loadDeepResearchEvaluationReport(evaluationPath),
      report,
    )

    const compared = evaluateDeepResearchRunDirectory({
      runPath: root,
      evaluationCase,
      baseline: report,
      elapsedMs: 60_000,
      costUsd: 4.25,
      evaluatedAt: TEST_TIME,
    })
    assert.equal(compared.decision, 'PASS')
    assert.equal(compared.comparison?.compositeScoreDelta, 0)
    assert.equal(compared.comparison?.passed, true)

    const cliCorpusPath = path.join(root, 'cli-corpus.json')
    const cliEvaluationPath = path.join(root, 'cli-evaluation.json')
    writeJson(cliCorpusPath, {
      ...corpus,
      cases: [evaluationCase],
    })
    const cli = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/evaluate-deep-research-run.ts',
        '--run',
        root,
        '--case',
        evaluationCase.id,
        '--corpus',
        cliCorpusPath,
        '--baseline',
        evaluationPath,
        '--output',
        cliEvaluationPath,
        '--retain',
        retainedPath,
        '--elapsed-ms',
        '60000',
        '--cost-usd',
        '4.25',
        '--evaluated-at',
        TEST_TIME,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    assert.equal(cli.status, 0, cli.stderr)
    const cliSummary = JSON.parse(cli.stdout) as {
      evaluationId: string
      caseId: string
      decision: string
      compositeScore: number
      outputPath: string
      retainedPath: string | null
      blockingReasons: string[]
    }
    assert.match(cliSummary.evaluationId, /^deep-research-evaluation-/u)
    assert.equal(cliSummary.caseId, evaluationCase.id)
    assert.equal(cliSummary.decision, 'PASS')
    assert.equal(Number.isFinite(cliSummary.compositeScore), true)
    assert.equal(cliSummary.outputPath, cliEvaluationPath)
    assert.equal(cliSummary.retainedPath, retainedPath)
    assert.deepEqual(cliSummary.blockingReasons, [])
    assert.equal(
      loadDeepResearchEvaluationReport(cliEvaluationPath).comparison?.passed,
      true,
    )
    assert.equal(
      fs.existsSync(path.join(retainedPath, 'final-report.docx')),
      true,
    )

    const repeatedRetention = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/evaluate-deep-research-run.ts',
        '--run',
        root,
        '--case',
        evaluationCase.id,
        '--corpus',
        cliCorpusPath,
        '--retain',
        retainedPath,
        '--elapsed-ms',
        '60000',
        '--cost-usd',
        '4.25',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    assert.notEqual(repeatedRetention.status, 0)
    assert.match(
      repeatedRetention.stderr,
      /Retention target already exists and will not be overwritten/u,
    )

    fs.unlinkSync(sectionDraftPath)
    const missingDraft = evaluateDeepResearchRunDirectory({
      runPath: root,
      evaluationCase,
      elapsedMs: 60_000,
      costUsd: 4.25,
      evaluatedAt: TEST_TIME,
    })
    assert.equal(missingDraft.decision, 'FAIL')
    assert.match(
      missingDraft.blockingReasons.join(' '),
      /Required artifact validity/u,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(retainedPath, { recursive: true, force: true })
  }
})

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  )
}
