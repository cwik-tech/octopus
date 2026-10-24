import { whenDefined } from '../../core/optional-properties.js'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer } from '../../server/api-server.js'
import { approveResearchPlan } from '../../domains/deep-research/deep-research-approval.js'
import { hashResearchValue } from '../../domains/deep-research/deep-research-worker-policy.js'
import type {
  QualityVerdict,
  ResearchPlan,
} from '../../contracts/deep-research.js'
import type { DeepResearchJourneySnapshot } from '../../contracts/deep-research-journey.js'
import type { RunPlan } from '../../contracts/run-plan.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { buildDurableWorkflowTerminalOutcome } from '../../workflows/results.js'
import {
  createWorkflowArtifactReference,
  FileSystemWorkflowStateStore,
} from '../../workflows/workflow-state-store.js'
import { makePlan } from '../unit/deep-research-fixtures.js'

const HASH = 'a'.repeat(64)
const CREATED_AT = '2026-07-17T12:00:00.000Z'
const RESEARCH_CHILD_ID = '11111111-1111-4111-8111-111111111111'
const EDITORIAL_CHILD_ID = '22222222-2222-4222-8222-222222222222'
const PUBLISH_CHILD_ID = '33333333-3333-4333-8333-333333333333'

test('Deep Research journey route projects a terminal Research block over a stale REVISE verdict', async () => {
  const fixture = await createJourneyFixture()
  const persistedTask = await fixture.sessionStore.getTaskRecord(
    fixture.sessionId,
    fixture.taskId,
  )
  assert.ok(persistedTask?.runPath)
  const immutableRunPlan = JSON.parse(
    fs.readFileSync(path.join(persistedTask.runPath, 'run-plan.json'), 'utf8'),
  ) as RunPlan
  assert.equal(immutableRunPlan.id, persistedTask.runPlanId)
  const originalRunPlan = await fixture.sessionStore.getRunPlan(fixture.sessionId)
  assert.ok(originalRunPlan)
  assert.equal(await fixture.sessionStore.saveRunPlan(fixture.sessionId, {
    ...originalRunPlan,
    id: 'newer-run-plan',
    status: 'ready',
    
  }), true)
  const server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath),
    launcher: {
      async startRun(request) {
        return { launched: true, pid: 1, cwd: request.cwd }
      },
    },
    sessionStore: fixture.sessionStore,
    workspacePath: fixture.workspacePath,
    recoverInterruptedTasks: false,
  })
  try {
    writeJson(
      path.join(fixture.researchAssignmentPath, 'research/quality/current-verdict.json'),
      reviseVerdict(),
    )
    fs.writeFileSync(
      path.join(fixture.researchAssignmentPath, 'research/quality/escalation.md'),
      '# Attention required\n\nThe research lane failed before another quality audit.\n',
    )

    const revising = await fetchJourney(server.url, fixture.sessionId, fixture.taskId)
    assert.equal(revising.response.status, 200)
    assert.equal(revising.response.headers.get('cache-control'), 'no-store')
    assert.equal(revising.snapshot.version, 1)
    assert.equal(revising.snapshot.plan?.planId, 'plan-one')
    assert.equal(revising.snapshot.phase, 'research')
    assert.equal(revising.snapshot.research?.status, 'correcting')
    assert.equal(revising.snapshot.research?.correctionWave, 2)
    assert.equal(revising.snapshot.research?.block, null)
    assert.equal(revising.snapshot.quality?.decision, 'REVISE')
    assert.equal(revising.snapshot.escalation, null)
    assert.equal(
      revising.snapshot.artifacts.some(
        (artifact) => artifact.kind === 'escalation',
      ),
      false,
    )
    assert.deepEqual(revising.snapshot.research?.workers, [{
      taskId: 'T1',
      displayRole: 'B2B Marketing Analyst',
      status: 'pending',
      attempt: 3,
    }])
    assert.ok(
      revising.snapshot.artifacts.some(
        (artifact) => artifact.relativePath === 'research/approved-plan.json',
      ),
    )
    assert.equal(
      revising.snapshot.artifacts.some(
        (artifact) => artifact.relativePath.includes('.runtime'),
      ),
      false,
    )

    await blockResearchWorkflow(fixture)

    const escalated = await fetchJourney(server.url, fixture.sessionId, fixture.taskId)
    assert.equal(escalated.snapshot.phase, 'escalation')
    assert.equal(escalated.snapshot.workflow.status, 'blocked')
    assert.equal(escalated.snapshot.research?.status, 'blocked')
    assert.equal(escalated.snapshot.quality?.decision, 'REVISE')
    assert.deepEqual(escalated.snapshot.research?.block, {
      kind: 'execution',
      message: 'Research failed before a new quality audit.',
    })
    assert.deepEqual(escalated.snapshot.escalation, {
      runId: RESEARCH_CHILD_ID,
      relativePath: 'research/quality/escalation.md',
    })
    assert.ok(
      escalated.snapshot.artifacts.some(
        (artifact) => artifact.kind === 'escalation',
      ),
    )
  } finally {
    await server.close()
    fixture.cleanup()
  }
})

test('Deep Research journey API exposes every adaptive artifact kind and excludes neighboring files', async () => {
  const fixture = await createJourneyFixture()
  const runPath = path.dirname(path.dirname(fixture.researchAssignmentPath))
  const server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath),
    launcher: {
      async startRun(request) {
        return { launched: true, pid: process.pid, cwd: request.cwd }
      },
    },
    sessionStore: fixture.sessionStore,
    workspacePath: fixture.workspacePath,
    recoverInterruptedTasks: false,
  })
  try {
    for (const relativePath of [
      'research/evidence-graph/current.json',
      'research/evidence-graph/graph-wave-0.json',
      'research/sections/current-index.json',
      'research/sections/section-one/dossier-wave-0.json',
      'research/adaptive/current-decision.json',
      'research/adaptive/decision-wave-0.json',
      'research/amendments/current.json',
      'research/amendments/amendment-wave-1.json',
    ]) {
      writeJson(path.join(fixture.researchAssignmentPath, relativePath), {
        schemaVersion: 1,
      })
    }
    for (const relativePath of [
      'research/section-plan.md',
      'research/sections/section-one/draft-wave-0.md',
    ]) {
      const filePath = path.join(fixture.researchAssignmentPath, relativePath)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, '# Allowlisted adaptive artifact\n')
    }
    writeJson(
      path.join(fixture.researchAssignmentPath, 'research/private-neighbor.json'),
      { secret: true },
    )
    writeJson(
      path.join(fixture.researchAssignmentPath, '.runtime/private-state.json'),
      { secret: true },
    )

    const editorialPath = path.join(
      runPath,
      'assignments',
      EDITORIAL_CHILD_ID,
    )
    const publishPath = path.join(
      runPath,
      'assignments',
      PUBLISH_CHILD_ID,
    )
    writeJson(path.join(editorialPath, 'publication-audit.json'), {
      schemaVersion: 1,
    })
    writeJson(path.join(publishPath, 'publication-audit.json'), {
      schemaVersion: 1,
    })

    const { response, snapshot } = await fetchJourney(
      server.url,
      fixture.sessionId,
      fixture.taskId,
    )
    assert.equal(response.status, 200)
    const exposed = new Set(
      snapshot.artifacts.map(
        (artifact) => `${artifact.kind}:${artifact.relativePath}`,
      ),
    )
    for (const expected of [
      'evidence_graph:research/evidence-graph/current.json',
      'evidence_graph:research/evidence-graph/graph-wave-0.json',
      'section_dossier:research/sections/current-index.json',
      'section_dossier:research/section-plan.md',
      'section_dossier:research/sections/section-one/dossier-wave-0.json',
      'section_dossier:research/sections/section-one/draft-wave-0.md',
      'adaptive_decision:research/adaptive/current-decision.json',
      'adaptive_decision:research/adaptive/decision-wave-0.json',
      'amendment:research/amendments/current.json',
      'amendment:research/amendments/amendment-wave-1.json',
      'publication_audit:publication-audit.json',
    ]) {
      assert.equal(exposed.has(expected), true, `Missing ${expected}`)
    }
    assert.equal(
      snapshot.artifacts.some(
        (artifact) =>
          artifact.relativePath === 'research/private-neighbor.json' ||
          artifact.relativePath.includes('.runtime'),
      ),
      false,
    )
    assert.equal(
      snapshot.artifacts.filter(
        (artifact) => artifact.kind === 'publication_audit',
      ).length,
      2,
    )
  } finally {
    await server.close()
    fixture.cleanup()
  }
})

test('Deep Research journey keeps explicit critic escalation behavior', async () => {
  const fixture = await createJourneyFixture()
  try {
    writeJson(
      path.join(fixture.researchAssignmentPath, 'research/quality/current-verdict.json'),
      escalateVerdict(),
    )
    fs.writeFileSync(
      path.join(fixture.researchAssignmentPath, 'research/quality/escalation.md'),
      '# Attention required\n\nThe source authority cannot be established.\n',
    )

    const { buildDeepResearchJourneySnapshot } = await import(
      '../../services/deep-research-journey-service.js'
    )
    const task = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    const runPlan = await fixture.sessionStore.getRunPlan(fixture.sessionId)
    assert.ok(task)
    const snapshot = await buildDeepResearchJourneySnapshot({
      workspacePath: fixture.workspacePath,
      task,
      runPlan,
    })
    assert.equal(snapshot.phase, 'escalation')
    assert.equal(snapshot.quality?.decision, 'ESCALATE')
    assert.equal(snapshot.research?.block?.kind, 'quality')
  } finally {
    fixture.cleanup()
  }
})

test('a failed research plan is reported as blocked even when a report artifact exists', async () => {
  // Falsification check for the section-dossier repair: the reported delay to
  // "reviewing" could have been a status-precedence defect. It is not. A run
  // whose executable plan has a failed task reports blocked even with a report
  // on disk, so the user-visible symptom was downstream of invalid section
  // completion and provider failure — no status logic was changed.
  const fixture = await createJourneyFixture({
    executablePlan: executablePlanMarkdown({
      status: 'failed',
      resultFile: 'research/evidence/wave-0/T1.json',
    }),
  })
  try {
    fs.writeFileSync(
      path.join(fixture.researchAssignmentPath, 'research-package.md'),
      '# Partial research package\n',
    )

    const snapshot = await buildJourneySnapshot(fixture)

    assert.equal(snapshot.research?.status, 'blocked')
    assert.equal(snapshot.research?.block?.kind, 'execution')
  } finally {
    fixture.cleanup()
  }
})

test('Deep Research journey distinguishes synthesis from critic review at the report boundary', async () => {
  const fixture = await createJourneyFixture({
    executablePlan: executablePlanMarkdown({
      status: 'completed',
      resultFile: 'research/evidence/wave-0/T1.json',
    }),
  })
  try {
    writeJson(
      path.join(fixture.researchAssignmentPath, 'research/synthesis/current.json'),
      { schemaVersion: 1 },
    )
    writeJson(
      path.join(fixture.researchAssignmentPath, 'research/quality/current-packet.json'),
      { schemaVersion: 1 },
    )

    const synthesizing = await buildJourneySnapshot(fixture)
    assert.equal(synthesizing.research?.status, 'synthesizing')

    fs.writeFileSync(
      path.join(fixture.researchAssignmentPath, 'research-package.md'),
      '# Current research package\n',
    )
    const reviewing = await buildJourneySnapshot(fixture)
    assert.equal(reviewing.research?.status, 'reviewing')
  } finally {
    fixture.cleanup()
  }
})

test('Deep Research journey retains the audited cause during synthesis-only correction', async () => {
  const fixture = await createJourneyFixture({
    executablePlan: executablePlanMarkdown({
      status: 'completed',
      resultFile: 'research/evidence/wave-0/T1.json',
    }),
  })
  try {
    const sourceVerdict: QualityVerdict = {
      schemaVersion: 1,
      verdictId: 'report-revision-zero',
      correctionWave: 0,
      decision: 'REVISE',
      correctionRoute: 'synthesis',
      findings: [{
        code: 'report_evidence_mismatch',
        severity: 'blocking',
        message: 'The report omits a material evidence-backed limitation.',
        taskIds: ['T1'],
        sectionIds: ['section-one'],
        claimIds: [],
        sourceIds: [],
      }],
      correctionRequests: [{
        schemaVersion: 1,
        id: 'rewrite-report',
        type: 'resynthesize',
        claimIds: [],
        taskIds: ['T1'],
        sectionIds: ['section-one'],
        acceptanceCriteria: ['State the evidence-backed limitation.'],
        impactScope: 'local',
      }],
      reviewedAt: '2026-07-17T12:05:00.000Z',
    }
    const sourceVerdictPath = 'research/quality/verdict-wave-0.json'
    writeJson(
      path.join(fixture.researchAssignmentPath, sourceVerdictPath),
      sourceVerdict,
    )
    writeJson(
      path.join(fixture.researchAssignmentPath, 'research/corrections/current.json'),
      {
        schemaVersion: 1,
        wave: 1,
        approvedPlanHash: (await fixture.sessionStore.getRunPlan(fixture.sessionId))
          ?.researchPlan?.approvalHash,
        sourceVerdictPath,
        sourceVerdictHash: hashResearchValue(sourceVerdict),
        taskRequests: {},
      },
    )
    writeJson(
      path.join(fixture.researchAssignmentPath, 'research/synthesis/current.json'),
      { schemaVersion: 1 },
    )

    const snapshot = await buildJourneySnapshot(fixture)
    assert.equal(snapshot.integrity, 'complete')
    assert.equal(snapshot.research?.status, 'synthesizing')
    assert.equal(snapshot.research?.correctionWave, 1)
    assert.equal(snapshot.quality?.decision, 'REVISE')
    assert.equal(snapshot.quality?.correctionRoute, 'synthesis')
    assert.equal(snapshot.quality?.correctionWave, 0)
  } finally {
    fixture.cleanup()
  }
})

test('Deep Research journey fails closed for malformed verdicts and unsafe artifact paths', async () => {
  const fixture = await createJourneyFixture()
  try {
    const outsidePath = path.join(fixture.workspacePath, 'outside-verdict.json')
    fs.writeFileSync(outsidePath, JSON.stringify(escalateVerdict()))
    const verdictPath = path.join(
      fixture.researchAssignmentPath,
      'research/quality/current-verdict.json',
    )
    fs.symlinkSync(outsidePath, verdictPath)
    fs.writeFileSync(
      path.join(fixture.researchAssignmentPath, 'research/quality/escalation.md'),
      '# Generic task failure\n',
    )

    const { buildDeepResearchJourneySnapshot } = await import(
      '../../services/deep-research-journey-service.js'
    )
    const task = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    const runPlan = await fixture.sessionStore.getRunPlan(fixture.sessionId)
    assert.ok(task)
    const snapshot = await buildDeepResearchJourneySnapshot({
      workspacePath: fixture.workspacePath,
      task,
      runPlan,
    })
    assert.equal(snapshot.integrity, 'partial')
    assert.equal(snapshot.phase, 'research')
    assert.equal(snapshot.quality, null)
    assert.equal(snapshot.escalation, null)
    assert.equal(
      snapshot.artifacts.some(
        (artifact) => artifact.relativePath === 'research/quality/current-verdict.json',
      ),
      false,
    )
  } finally {
    fixture.cleanup()
  }
})

test('Deep Research journey projects matching private runtime progress and freshness', async () => {
  const fixture = await createJourneyFixture()
  try {
    const runtimePlanPath = writeRuntimePlan(fixture, {
      status: 'in_progress',
    })
    const runtimeTimestamp = new Date('2099-07-17T12:30:00.000Z')
    fs.utimesSync(runtimePlanPath, runtimeTimestamp, runtimeTimestamp)
    const expectedUpdatedAt = fs.statSync(runtimePlanPath).mtime.toISOString()

    const snapshot = await buildJourneySnapshot(fixture)

    assert.equal(snapshot.integrity, 'complete')
    assert.equal(snapshot.updatedAt, expectedUpdatedAt)
    assert.deepEqual(snapshot.research?.workers, [{
      taskId: 'T1',
      displayRole: 'B2B Marketing Analyst',
      status: 'running',
      attempt: 3,
    }])
    assert.match(
      fs.readFileSync(
        path.join(fixture.researchAssignmentPath, 'research/plan.md'),
        'utf8',
      ),
      /- \*\*Status:\*\* pending/,
    )
    assert.equal(
      snapshot.artifacts.some((artifact) =>
        artifact.relativePath.includes('.runtime')
      ),
      false,
    )
  } finally {
    fixture.cleanup()
  }
})

test('Deep Research journey rejects a stale prior-wave runtime plan and falls back safely', async () => {
  const fixture = await createJourneyFixture()
  try {
    const runtimePlanPath = writeRuntimePlan(fixture, {
      status: 'completed',
      resultFile: 'research/evidence/wave-1/T1.json',
    })
    const staleTimestamp = new Date('2099-07-17T12:30:00.000Z')
    fs.utimesSync(runtimePlanPath, staleTimestamp, staleTimestamp)

    const snapshot = await buildJourneySnapshot(fixture)

    assert.equal(snapshot.integrity, 'partial')
    assert.equal(snapshot.research?.correctionWave, 2)
    assert.equal(snapshot.research?.workers[0]?.status, 'pending')
    assert.equal(snapshot.research?.workers[0]?.attempt, 3)
    assert.notEqual(
      snapshot.updatedAt,
      fs.statSync(runtimePlanPath).mtime.toISOString(),
    )
  } finally {
    fixture.cleanup()
  }
})

test('Deep Research journey rejects symlinked private runtime state', async () => {
  const fixture = await createJourneyFixture()
  try {
    const outsidePlanPath = path.join(fixture.workspacePath, 'outside-plan.md')
    fs.writeFileSync(outsidePlanPath, executablePlanMarkdown({
      status: 'completed',
    }))
    const runtimePlanPath = path.join(
      fixture.researchAssignmentPath,
      '.runtime/pipeline/collect-evidence/plan.md',
    )
    fs.mkdirSync(path.dirname(runtimePlanPath), { recursive: true })
    fs.symlinkSync(outsidePlanPath, runtimePlanPath)

    const snapshot = await buildJourneySnapshot(fixture)

    assert.equal(snapshot.integrity, 'partial')
    assert.equal(snapshot.research?.workers[0]?.status, 'pending')
    assert.equal(
      snapshot.artifacts.some((artifact) =>
        artifact.relativePath.includes('.runtime')
      ),
      false,
    )
  } finally {
    fixture.cleanup()
  }
})

test('Deep Research journey rejects malformed private runtime lifecycle states', async () => {
  const fixture = await createJourneyFixture()
  try {
    const runtimePlanPath = writeRuntimePlan(fixture, {
      status: 'in_progress',
    })
    fs.writeFileSync(
      runtimePlanPath,
      fs.readFileSync(runtimePlanPath, 'utf8').replace(
        '- **Status:** in_progress',
        '- **Status:** still_working',
      ),
    )

    const snapshot = await buildJourneySnapshot(fixture)

    assert.equal(snapshot.integrity, 'partial')
    assert.equal(snapshot.research?.workers[0]?.status, 'pending')
  } finally {
    fixture.cleanup()
  }
})

test('Deep Research journey projects each canonical worker lifecycle state', async () => {
  for (const [runtimeStatus, projectedStatus] of [
    ['pending', 'pending'],
    ['in_progress', 'running'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['blocked', 'blocked'],
    ['skipped', 'skipped'],
  ] as const) {
    const fixture = await createJourneyFixture()
    try {
      writeRuntimePlan(fixture, { status: runtimeStatus })
      const snapshot = await buildJourneySnapshot(fixture)
      assert.equal(snapshot.integrity, 'complete')
      assert.equal(snapshot.research?.workers[0]?.status, projectedStatus)
    } finally {
      fixture.cleanup()
    }
  }
})

test('Deep Research journey rejects duplicate and tracker-injected private statuses', async () => {
  for (const mutate of [
    (content: string) => content.replace(
      '- **Status:** pending',
      '- **Status:** pending\n- **Status:** completed',
    ),
    (content: string) => `${content}\n| T1 | completed |\n`,
  ]) {
    const fixture = await createJourneyFixture()
    try {
      const runtimePlanPath = writeRuntimePlan(fixture)
      fs.writeFileSync(
        runtimePlanPath,
        mutate(fs.readFileSync(runtimePlanPath, 'utf8')),
      )
      const snapshot = await buildJourneySnapshot(fixture)
      assert.equal(snapshot.integrity, 'partial')
      assert.equal(snapshot.research?.workers[0]?.status, 'pending')
    } finally {
      fixture.cleanup()
    }
  }
})

test('Deep Research journey rejects misbound and future-wave retained evidence', async () => {
  const base = makePlan()
  const approvedPlan = approveResearchPlan(makePlan({
    tasks: [{ ...base.tasks[0]!, id: 'T1' }],
  }), CREATED_AT)
  const worker = approvedPlan.workerSpecs[0]!
  const task = approvedPlan.tasks[0]!
  for (const testCase of [
    { packetWave: 0 as const, manifestWave: 0 as const, assignmentId: 'wrong-lane' },
    { packetWave: 1 as const, manifestWave: 0 as const, assignmentId: worker.laneId },
  ]) {
    const fixture = await createJourneyFixture({ approvedPlan })
    try {
      const relativePath = `research/evidence/wave-${testCase.packetWave}/T1.json`
      writeJson(path.join(fixture.researchAssignmentPath, relativePath), {
        schemaVersion: 1,
        assignmentId: testCase.assignmentId,
        taskId: 'T1',
        workerSpecHash: hashResearchValue(worker),
        question: task.question,
        shortAnswer: 'Retained evidence.',
        findings: [],
        sources: [],
        contradictions: [],
        unresolvedQuestions: [],
        stopReason: 'decision_useful',
      })
      writeJson(
        path.join(fixture.researchAssignmentPath, 'research/evidence/current-manifest.json'),
        {
          schemaVersion: 1,
          correctionWave: testCase.manifestWave,
          latestByTask: { T1: relativePath },
        },
      )

      const snapshot = await buildJourneySnapshot(fixture)
      assert.equal(snapshot.integrity, 'partial')
      assert.equal(snapshot.research?.workers[0]?.status, 'pending')
    } finally {
      fixture.cleanup()
    }
  }
})

test('Deep Research correction progress keeps retained evidence completed', async () => {
  const base = makePlan()
  const firstWorker = {
    ...base.workerSpecs[0]!,
    id: 'worker-T1',
    laneId: 'lane-T1',
    question: 'What establishes the baseline?',
  }
  const secondWorker = {
    ...base.workerSpecs[0]!,
    id: 'worker-T2',
    laneId: 'lane-T2',
    question: 'What correction is required?',
  }
  const approvedPlan = approveResearchPlan(makePlan({
    sections: [{
      ...base.sections[0]!,
      taskIds: ['T1', 'T2'],
    }],
    tasks: [
      {
        ...base.tasks[0]!,
        id: 'T1',
        question: firstWorker.question,
        workerSpecId: firstWorker.id,
      },
      {
        ...base.tasks[0]!,
        id: 'T2',
        title: 'Correct the comparison',
        question: secondWorker.question,
        workerSpecId: secondWorker.id,
      },
    ],
    workerSpecs: [firstWorker, secondWorker],
    expectedPeakWorkers: 2,
  }), CREATED_AT)
  const fixture = await createJourneyFixture({
    approvedPlan,
    executablePlan: executablePlanMarkdown({
      taskId: 'T2',
      title: 'Correct the comparison',
      status: 'pending',
      resultFile: 'research/evidence/wave-1/T2.json',
    }),
  })
  try {
    const evidenceDirectory = path.join(
      fixture.researchAssignmentPath,
      'research/evidence/wave-0',
    )
    fs.mkdirSync(evidenceDirectory, { recursive: true })
    writeJson(path.join(evidenceDirectory, 'T1.json'), {
      schemaVersion: 1,
      assignmentId: firstWorker.laneId,
      taskId: 'T1',
      workerSpecHash: hashResearchValue(firstWorker),
      question: firstWorker.question,
      shortAnswer: 'The retained baseline is complete.',
      findings: [],
      sources: [],
      contradictions: [],
      unresolvedQuestions: [],
      stopReason: 'decision_useful',
    })
    writeJson(
      path.join(fixture.researchAssignmentPath, 'research/evidence/current-manifest.json'),
      {
        schemaVersion: 1,
        correctionWave: 0,
        latestByTask: { T1: 'research/evidence/wave-0/T1.json' },
      },
    )

    const snapshot = await buildJourneySnapshot(fixture)

    assert.equal(snapshot.integrity, 'complete')
    assert.equal(snapshot.research?.correctionWave, 1)
    assert.deepEqual(snapshot.research?.workers.map((worker) => ({
      taskId: worker.taskId,
      status: worker.status,
      attempt: worker.attempt,
    })), [
      { taskId: 'T1', status: 'completed', attempt: 1 },
      { taskId: 'T2', status: 'pending', attempt: 2 },
    ])
  } finally {
    fixture.cleanup()
  }
})

test('Deep Research journey follows durable research, editorial, and delivery handoffs automatically', async () => {
  const fixture = await createJourneyFixture()
  try {
    const task = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    const runPlan = await fixture.sessionStore.getRunPlan(fixture.sessionId)
    assert.ok(task?.assignmentPath && task.runPath)
    const stateStore = new FileSystemWorkflowStateStore(task.assignmentPath)
    const researchPackagePath = path.join(
      fixture.researchAssignmentPath,
      'research-package.md',
    )
    fs.writeFileSync(researchPackagePath, '# Audited research package\n')
    fs.mkdirSync(
      path.join(fixture.researchAssignmentPath, 'research', 'reports'),
      { recursive: true },
    )
    fs.writeFileSync(
      path.join(
        fixture.researchAssignmentPath,
        'research',
        'reports',
        'report-wave-0.md',
      ),
      '# Preserved synthesis before quality escalation\n',
    )
    const researchArtifact = await createWorkflowArtifactReference({
      childAssignmentPath: fixture.researchAssignmentPath,
      childRunId: RESEARCH_CHILD_ID,
      relativePath: 'research-package.md',
    })
    await stateStore.update({
      expectedRevision: 2,
      executionAttemptId: 'attempt-one',
      mutate(state) {
        state.currentStepId = 'editorial'
        state.steps[0]!.status = 'completed'
        state.steps[0]!.artifact = researchArtifact
        state.steps[0]!.completedAt = '2026-07-17T12:15:00.000Z'
      },
    })

    const { buildDeepResearchJourneySnapshot } = await import(
      '../../services/deep-research-journey-service.js'
    )
    const editorial = await buildDeepResearchJourneySnapshot({
      workspacePath: fixture.workspacePath,
      task,
      runPlan,
    })
    assert.equal(editorial.phase, 'editorial')
    assert.ok(
      editorial.artifacts.some(
        (artifact) => artifact.kind === 'research_report',
      ),
    )
    assert.ok(editorial.artifacts.some(
      (artifact) =>
        artifact.relativePath === 'research/reports/report-wave-0.md' &&
        artifact.label === 'Synthesized research draft (wave 0)',
    ))

    await stateStore.update({
      expectedRevision: 3,
      executionAttemptId: 'attempt-one',
      mutate(state) {
        state.steps[1]!.status = 'launching'
        state.steps[1]!.attemptCount = 1
        state.steps[1]!.startedAt = '2026-07-17T12:16:00.000Z'
      },
    })
    await stateStore.update({
      expectedRevision: 4,
      executionAttemptId: 'attempt-one',
      mutate(state) {
        state.steps[1]!.status = 'running'
      },
    })
    const editorialAssignmentPath = path.join(
      task.runPath,
      'assignments',
      EDITORIAL_CHILD_ID,
    )
    fs.mkdirSync(editorialAssignmentPath, { recursive: true })
    fs.writeFileSync(
      path.join(editorialAssignmentPath, 'final-draft.md'),
      '# Editorial draft\n',
    )
    const editorialArtifact = await createWorkflowArtifactReference({
      childAssignmentPath: editorialAssignmentPath,
      childRunId: EDITORIAL_CHILD_ID,
      relativePath: 'final-draft.md',
    })
    await stateStore.update({
      expectedRevision: 5,
      executionAttemptId: 'attempt-one',
      mutate(state) {
        state.currentStepId = 'publish'
        state.steps[1]!.status = 'completed'
        state.steps[1]!.artifact = editorialArtifact
        state.steps[1]!.completedAt = '2026-07-17T12:20:00.000Z'
      },
    })

    const delivery = await buildDeepResearchJourneySnapshot({
      workspacePath: fixture.workspacePath,
      task,
      runPlan,
    })
    assert.equal(delivery.phase, 'delivery')
    assert.ok(
      delivery.artifacts.some(
        (artifact) => artifact.kind === 'editorial_draft',
      ),
    )
  } finally {
    fixture.cleanup()
  }
})

async function createJourneyFixture(options: {
  approvedPlan?: ResearchPlan
  executablePlan?: string
} = {}): Promise<{
  workspacePath: string
  sessionStore: FileSystemSessionStore
  sessionId: string
  taskId: string
  researchAssignmentPath: string
  cleanup(): void
}> {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'deep-research-journey-'),
  )
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Journey test' })
  const basePlan = makePlan()
  const approvedPlan = options.approvedPlan ?? approveResearchPlan(makePlan({
    tasks: [{ ...basePlan.tasks[0]!, id: 'T1' }],
  }), CREATED_AT)
  const runPlan: RunPlan = {
    id: 'run-plan-one',
    goal: approvedPlan.request.question,
    summary: 'Run an approved Deep Research plan.',
    status: 'ready',
    selectedWorkflow: {
      id: 'deep-research-report',
      rationale: 'The user requested sourced research.',
      confidence: 'high',
    },
    researchPlan: approvedPlan,
    ...whenDefined(approvedPlan.approvalHash, (researchPlanProposalHash) => ({ researchPlanProposalHash: researchPlanProposalHash })),
    requiredInputs: [],
    brief: '# Approved research brief',
    actions: [],
    warnings: [],
    createdAt: CREATED_AT,
  }
  assert.equal(await sessionStore.saveRunPlan(session.id, runPlan), true)
  const applying = await sessionStore.claimRunPlanForApply(session.id, runPlan.id)
  assert.ok(applying?.claimed)
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'deep-research-report',
    brief: '# Approved research brief',
    runPlanId: runPlan.id,
    ...whenDefined(applying.plan.applyClaimId, (runPlanApplyClaimId) => ({ runPlanApplyClaimId: runPlanApplyClaimId })),
  })
  assert.ok(task?.assignmentPath)
  await sessionStore.updateTaskRecord(session.id, task.id, { status: 'blocked' })

  const stateStore = new FileSystemWorkflowStateStore(task.assignmentPath)
  await stateStore.initialize({
    manifest: {
      taskId: task.id,
      sessionId: session.id,
      rootRunId: task.runId,
      workflowId: 'deep-research-report',
      workflowDefinitionHash: HASH,
      briefHash: HASH,
      teamDefinitionHashes: {
        'research-team': HASH,
        'writing-team': HASH,
      },
      runtimeVersion: 'test',
      createdAt: CREATED_AT,
    },
    executionAttemptId: 'attempt-one',
    steps: [
      {
        stepId: 'research',
        stepIndex: 0,
        stepType: 'team',
        team: 'research-team',
        definitionHash: HASH,
        recoveryPolicy: 'manual',
        childRunId: RESEARCH_CHILD_ID,
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'research-package.md',
        requestedResultType: 'artifact:research-package.md',
      },
      {
        stepId: 'editorial',
        stepIndex: 1,
        stepType: 'team',
        team: 'writing-team',
        definitionHash: HASH,
        recoveryPolicy: 'manual',
        childRunId: EDITORIAL_CHILD_ID,
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'final-draft.md',
        requestedResultType: 'artifact:final-draft.md',
      },
      {
        stepId: 'publish',
        stepIndex: 2,
        stepType: 'transform',
        team: 'transform',
        definitionHash: HASH,
        recoveryPolicy: 'idempotent',
        idempotencyKey: 'publish-once',
        childRunId: PUBLISH_CHILD_ID,
        inputArtifact: 'final-draft.md',
        resultArtifact: 'final-report.md',
        resultArtifacts: ['final-report.md', 'final-report.docx'],
        requestedResultType: 'artifact:final-report.md',
      },
    ],
  })
  await stateStore.update({
    expectedRevision: 0,
    executionAttemptId: 'attempt-one',
    mutate(state) {
      state.currentStepId = 'research'
      state.steps[0]!.status = 'launching'
      state.steps[0]!.attemptCount = 1
      state.steps[0]!.startedAt = CREATED_AT
    },
  })
  await stateStore.update({
    expectedRevision: 1,
    executionAttemptId: 'attempt-one',
    mutate(state) {
      state.steps[0]!.status = 'running'
    },
  })

  const researchAssignmentPath = path.join(
    task.runPath!,
    'assignments',
    RESEARCH_CHILD_ID,
  )
  fs.mkdirSync(path.join(researchAssignmentPath, 'research/quality'), {
    recursive: true,
  })
  writeJson(
    path.join(researchAssignmentPath, 'research/approved-plan.json'),
    approvedPlan,
  )
  fs.writeFileSync(
    path.join(researchAssignmentPath, 'research/plan.md'),
    options.executablePlan ?? executablePlanMarkdown(),
  )

  return {
    workspacePath,
    sessionStore,
    sessionId: session.id,
    taskId: task.id,
    researchAssignmentPath,
    cleanup() {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    },
  }
}

async function buildJourneySnapshot(fixture: {
  workspacePath: string
  sessionStore: FileSystemSessionStore
  sessionId: string
  taskId: string
}): Promise<DeepResearchJourneySnapshot> {
  const { buildDeepResearchJourneySnapshot } = await import(
    '../../services/deep-research-journey-service.js'
  )
  const task = await fixture.sessionStore.getTaskRecord(
    fixture.sessionId,
    fixture.taskId,
  )
  const runPlan = await fixture.sessionStore.getRunPlan(fixture.sessionId)
  assert.ok(task)
  return buildDeepResearchJourneySnapshot({
    workspacePath: fixture.workspacePath,
    task,
    runPlan,
  })
}

function writeRuntimePlan(
  fixture: { researchAssignmentPath: string },
  options: Parameters<typeof executablePlanMarkdown>[0] = {},
): string {
  const runtimePlanPath = path.join(
    fixture.researchAssignmentPath,
    '.runtime/pipeline/collect-evidence/plan.md',
  )
  fs.mkdirSync(path.dirname(runtimePlanPath), { recursive: true })
  fs.writeFileSync(runtimePlanPath, executablePlanMarkdown(options))
  return runtimePlanPath
}

function executablePlanMarkdown(options: {
  status?: 'pending' | 'in_progress' | 'completed' | 'validated' | 'failed' | 'blocked' | 'skipped'
  resultFile?: string
  taskId?: string
  title?: string
} = {}): string {
  const taskId = options.taskId ?? 'T1'
  return [
    '# Plan: Channel research',
    '**Status:** executing',
    '',
    '### S1: Acquisition',
    `#### ${taskId}: ${options.title ?? 'Channel economics'}`,
    '- **Agent:** web-researcher',
    `- **Status:** ${options.status ?? 'pending'}`,
    '- **Validate:** false',
    '- **Depends on:** none',
    '- **Gate:** false',
    `- **Result file:** ${options.resultFile ?? 'research/evidence/wave-2/T1.json'}`,
    '',
  ].join('\n')
}

async function blockResearchWorkflow(fixture: {
  sessionStore: FileSystemSessionStore
  sessionId: string
  taskId: string
}): Promise<void> {
  const task = await fixture.sessionStore.getTaskRecord(
    fixture.sessionId,
    fixture.taskId,
  )
  assert.ok(task?.assignmentPath)
  const stateStore = new FileSystemWorkflowStateStore(task.assignmentPath)
  const snapshot = await stateStore.requireSnapshot()
  await stateStore.update({
    expectedRevision: snapshot.state.revision,
    executionAttemptId: snapshot.state.ownerExecutionAttemptId,
    mutate(state) {
      const researchStep = state.steps.find((step) => step.stepId === 'research')!
      researchStep.status = 'blocked'
      researchStep.summary = 'Research failed before a new quality audit.'
      researchStep.completedAt = '2026-07-17T12:10:00.000Z'
      state.status = 'blocked'
      delete state.currentStepId
      state.terminalOutcome = buildDurableWorkflowTerminalOutcome({
        workflowId: state.workflowId,
        status: 'blocked',
        summary: researchStep.summary,
        requestedResultType: researchStep.requestedResultType,
        outputStepId: researchStep.stepId,
      })
    },
  })
}

function reviseVerdict(): QualityVerdict {
  return {
    schemaVersion: 1,
    verdictId: 'verdict-revise',
    correctionWave: 0,
    decision: 'REVISE',
    findings: [{
      code: 'required_metric_missing',
      severity: 'blocking',
      message: 'CAC evidence is incomplete.',
      taskIds: ['T1'],
      sectionIds: ['section-one'],
      claimIds: [],
      sourceIds: [],
    }],
    correctionRequests: [{
      schemaVersion: 1,
      id: 'correction-one',
      type: 'new_research',
      claimIds: [],
      taskIds: ['T1'],
      sectionIds: ['section-one'],
      question: 'What primary evidence establishes CAC?',
      acceptanceCriteria: ['Provide primary CAC evidence.'],
      impactScope: 'local',
    }],
    reviewedAt: '2026-07-17T12:05:00.000Z',
  }
}

function escalateVerdict(): QualityVerdict {
  return {
    schemaVersion: 1,
    verdictId: 'verdict-escalate',
    correctionWave: 1,
    decision: 'ESCALATE',
    findings: [{
      code: 'required_authority_missing',
      severity: 'blocking',
      message: 'The required authority is unavailable.',
      taskIds: ['T1'],
      sectionIds: ['section-one'],
      claimIds: [],
      sourceIds: [],
    }],
    correctionRequests: [],
    reviewedAt: '2026-07-17T12:10:00.000Z',
  }
}

async function fetchJourney(
  baseUrl: string,
  sessionId: string,
  taskId: string,
): Promise<{ response: Response; snapshot: DeepResearchJourneySnapshot }> {
  const response = await fetch(
    `${baseUrl}/sessions/${sessionId}/tasks/${taskId}/deep-research`,
  )
  return {
    response,
    snapshot: await response.json() as DeepResearchJourneySnapshot,
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}
