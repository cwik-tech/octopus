import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { PlanState, PlanTask } from '../../parsers/plan-parser.js'
import type { EvidencePacket, SourceRecord } from '../../contracts/deep-research.js'
import { approveResearchPlan } from '../../domains/deep-research/deep-research-approval.js'
import { hashResearchValue } from '../../domains/deep-research/deep-research-worker-policy.js'
import {
  buildDeepResearchQualityReviewFailureVerdict,
  canonicalizeModelEvidencePacketClericalFields,
  parseDeepResearchEvidenceResult,
  parseDeepResearchQualityReviewResult,
  resolveDeepResearchDeadline,
  resolveDeepResearchExecutionLimits,
  resolveDeepResearchTaskOverlay,
} from '../../domains/deep-research/deep-research-pipeline-adapter.js'

function researchPlan() {
  return approveResearchPlan({
    schemaVersion: 1,
    planId: 'plan-1',
    requestId: 'request-1',
    request: {
      schemaVersion: 1,
      requestId: 'request-1',
      question: 'What directly observed evidence establishes current demand?',
      objective: 'Decide whether the segment is attractive.',
      audience: 'B2B software decision makers',
      includedScope: ['Current B2B software demand'],
      excludedScope: [],
      desiredSections: ['Market evidence'],
      jurisdictions: [],
      freshnessAsOf: '2026-07-16T12:00:00.000Z',
      authenticatedDomains: [],
      sourceRequirements: ['Use directly observed primary and independent sources.'],
      maxDurationMinutes: 20,
      maxResearcherAgents: 8,
      outputFormats: ['markdown', 'docx'],
    },
    sections: [{
      schemaVersion: 1,
      id: 'section-market',
      title: 'Market evidence',
      objective: 'Determine current market conditions.',
      taskIds: ['T1'],
    }],
    tasks: [{
      schemaVersion: 1,
      id: 'T1',
      sectionId: 'section-market',
      title: 'Measure demand',
      question: 'What directly observed evidence establishes current demand?',
      purpose: 'evidence_acquisition',
      workerSpecId: 'worker-T1',
      dependsOn: [],
      correctionWave: 0,
    }],
    workerSpecs: [{
      schemaVersion: 1,
      id: 'worker-T1',
      laneId: 'lane-market',
      sectionId: 'section-market',
      baseAgent: 'web-researcher',
      displayRole: 'B2B Market Evidence Analyst',
      domain: 'B2B software',
      lens: 'market',
      methodCardIds: ['marketing-channel-analysis-v1'],
      specialistStance:
        'Approach this assignment as a B2B market evidence analyst. Separate direct demand observations from proxy signals.',
      question: 'What directly observed evidence establishes current demand?',
      decisionUse: 'Decide whether the segment is attractive.',
      workingDefinitions: [
        'Treat demand as current only when the source observation falls within the approved freshness boundary.',
      ],
      dependencyClaimIds: [],
      sourceRequirements: {
        preferredTypes: ['primary', 'industry'],
        requiredAuthorityTypes: ['primary'],
        queryHints: ['current demand data'],
      },
      requiredMetrics: ['growth rate'],
      prohibitedAssumptions: ['Search snippets are evidence.'],
      stopRule: {
        minimumPrimarySources: 1,
        minimumIndependentSources: 2,
        maximumSources: 8,
      },
      limits: { deadlineMs: 1_200_000 },
    }],
    maxDurationMinutes: 20,
    maxResearcherAgents: 8,
    expectedPeakWorkers: 1,
    authenticatedDomains: [],
  }, '2026-07-16T12:00:00.000Z')
}

function executableTask(agent = 'web-researcher'): PlanTask {
  return {
    id: 'T1',
    title: 'Measure demand',
    agent,
    status: 'pending',
    validate: false,
    dependsOn: [],
    gate: false,
    resultFile: 'research/tasks/T1/evidence.json',
    sprintId: 'S1',
  }
}

function executablePlan(task = executableTask()): PlanState {
  return {
    title: 'Research',
    status: 'executing',
    sprints: [{ id: 'S1', name: 'Research', taskIds: [task.id], gateTaskId: null }],
    tasks: new Map([[task.id, task]]),
  }
}

function dependentResearchPlan() {
  const first = researchPlan()
  const { approvedAt: _approvedAt, approvalHash: _approvalHash, ...base } = first
  const secondWorker = {
    ...first.workerSpecs[0],
    id: 'worker-T2',
    laneId: 'lane-decision',
    displayRole: 'Decision Evidence Analyst',
    question: 'How does the baseline evidence affect the decision?',
  }
  return approveResearchPlan({
    ...base,
    sections: [{ ...first.sections[0], taskIds: ['T1', 'T2'] }],
    tasks: [
      first.tasks[0],
      {
        schemaVersion: 1,
        id: 'T2',
        sectionId: 'section-market',
        title: 'Assess decision impact',
        question: secondWorker.question,
        purpose: 'evidence_verification',
        workerSpecId: secondWorker.id,
        dependsOn: ['T1'],
        correctionWave: 0,
      },
    ],
    workerSpecs: [first.workerSpecs[0], secondWorker],
    expectedPeakWorkers: 1,
  }, '2026-07-16T12:00:00.000Z')
}

function fanInResearchPlan() {
  const first = researchPlan()
  const { approvedAt: _approvedAt, approvalHash: _approvalHash, ...base } = first
  const tasks = Array.from({ length: 4 }, (_, index) => {
    const number = index + 1
    return {
      schemaVersion: 1,
      id: `T${number}`,
      sectionId: 'section-market',
      title: number === 4 ? 'Cross-verify the evidence' : `Collect evidence ${number}`,
      question: number === 4
        ? 'What independent evidence verifies the three completed research tasks?'
        : `What directly observed evidence supports input ${number}?`,
      purpose: number === 4
        ? 'evidence_verification' as const
        : 'evidence_acquisition' as const,
      workerSpecId: `worker-T${number}`,
      dependsOn: number === 4 ? ['T1', 'T2', 'T3'] : [],
      correctionWave: 0,
    }
  })
  const workerSpecs = tasks.map((task, index) => ({
    ...first.workerSpecs[0],
    id: task.workerSpecId,
    laneId: `lane-${index + 1}`,
    displayRole: index === 3 ? 'Evidence Synthesis Analyst' : `Evidence Analyst ${index + 1}`,
    question: task.question,
  }))
  return approveResearchPlan({
    ...base,
    sections: [{ ...first.sections[0], taskIds: tasks.map((task) => task.id) }],
    tasks,
    workerSpecs,
    expectedPeakWorkers: 3,
  }, '2026-07-16T12:00:00.000Z')
}

test('approved research task becomes a bounded role overlay on the trusted agent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-adapter-'))
  try {
    fs.mkdirSync(path.join(dir, 'research'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'research', 'plan.json'), JSON.stringify(researchPlan()))
    const task = executableTask()

    const overlay = resolveDeepResearchTaskOverlay({
      assignmentPath: dir,
      planArtifact: 'research/plan.json',
      executablePlan: executablePlan(task),
      task,
      now: new Date('2026-07-16T12:00:00.000Z'),
    })

    assert.equal(overlay.displayRole, 'B2B Market Evidence Analyst')
    assert.equal(overlay.laneId, 'lane-market')
    assert.match(overlay.system, /trusted web-researcher capability/)
    assert.match(overlay.user, /marketing-channel-analysis-v1/)
    assert.match(overlay.user, /directly observed evidence establishes current demand/)
    assert.match(overlay.user, /observationReceiptId/)
    assert.match(
      overlay.user,
      /status is supported must have at least one evidenceLink whose relationship is supports/,
    )
    assert.match(overlay.user, /Search-result snippets.*cannot appear in claim sourceIds/)
    assert.match(overlay.user, /asOf as YYYY-MM-DD or a full canonical UTC timestamp/)
    assert.match(overlay.user, /unattended research lane cannot approve mutating browser actions/)
    assert.match(overlay.user, /after at most 18 total acquisition and browser calls/)
    assert.match(overlay.user, /no more than 8 usable source records/)
    assert.match(overlay.user, /keep each observedExcerpt to at most 500 characters/)
    assert.match(
      overlay.user,
      /every named capability, workflow, control, mode, scope, or qualification.*linked excerpts/is,
    )
    assert.match(
      overlay.user,
      /never combine.*merely to reduce the finding count/is,
    )
    assert.doesNotMatch(overlay.user, /prefer one finding/i)
    assert.match(overlay.assignmentHash, /^[a-f0-9]{64}$/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a first-pass research task is dispatched in the evidence-acquiring mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-adapter-acquire-'))
  try {
    fs.mkdirSync(path.join(dir, 'research'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'research', 'plan.json'), JSON.stringify(researchPlan()))
    const task = executableTask()

    const overlay = resolveDeepResearchTaskOverlay({
      assignmentPath: dir,
      planArtifact: 'research/plan.json',
      executablePlan: executablePlan(task),
      task,
      now: new Date('2026-07-16T12:00:00.000Z'),
    })

    assert.equal(overlay.governedWebEvidenceMode, 'acquire')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fan-in research overlay compacts verbose dependency evidence within the prompt budget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-adapter-fan-in-'))
  try {
    const plan = fanInResearchPlan()
    const evidenceDir = path.join(dir, 'research', 'evidence', 'wave-0')
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'research', 'approved-plan.json'), JSON.stringify(plan))

    const latestByTask: Record<string, string> = {}
    for (const taskId of ['T1', 'T2', 'T3']) {
      const workerSpec = plan.workerSpecs.find((candidate) => candidate.id === `worker-${taskId}`)!
      const resultPath = `research/evidence/wave-0/${taskId}.json`
      latestByTask[taskId] = resultPath
      fs.writeFileSync(path.join(dir, resultPath), JSON.stringify({
        schemaVersion: 1,
        assignmentId: workerSpec.laneId,
        taskId,
        workerSpecHash: hashResearchValue(workerSpec),
        question: workerSpec.question,
        shortAnswer: `${taskId} summary ${'verbose evidence '.repeat(100)}`,
        findings: Array.from({ length: 3 }, (_, index) => ({
          schemaVersion: 1,
          claimId: `${taskId}-claim-${index + 1}`,
          taskId,
          sectionId: 'section-market',
          statement: `${taskId} finding ${index + 1} ${'detailed finding '.repeat(60)}`,
          kind: 'uncertainty',
          evidenceStandard: 'single',
          sourceIds: [],
          evidenceLinks: [],
          confidence: 'low',
          status: 'unsupported',
          applicableScope: [],
        })),
        sources: [],
        contradictions: [],
        unresolvedQuestions: [`${taskId} ${'unresolved '.repeat(100)}`],
        stopReason: 'insufficient_evidence',
      }))
    }
    fs.writeFileSync(path.join(dir, 'research', 'evidence', 'current-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      correctionWave: 0,
      latestByTask,
    }))

    const executableTasks = new Map<string, PlanTask>()
    for (const task of plan.tasks) {
      executableTasks.set(task.id, {
        id: task.id,
        title: task.title,
        agent: 'web-researcher',
        status: task.id === 'T4' ? 'pending' : 'completed',
        validate: false,
        dependsOn: [...task.dependsOn],
        gate: false,
        resultFile: `research/evidence/wave-0/${task.id}.json`,
        sprintId: 'S1',
      })
    }
    const finalTask = executableTasks.get('T4')!
    const overlay = resolveDeepResearchTaskOverlay({
      assignmentPath: dir,
      planArtifact: 'research/approved-plan.json',
      executablePlan: {
        title: 'Research',
        status: 'executing',
        sprints: [{ id: 'S1', name: 'Research', taskIds: [...executableTasks.keys()], gateTaskId: null }],
        tasks: executableTasks,
      },
      task: finalTask,
    })

    const digestMatch = overlay.user.match(
      /DEPENDENCY_DIGEST_TEXT\n---BEGIN UNTRUSTED DATA---\n([\s\S]*?)\n---END UNTRUSTED DATA---/,
    )
    assert.ok(digestMatch)
    const digest = digestMatch[1]!
    assert.ok(Buffer.byteLength(digest, 'utf8') <= 1_600)
    const parsed = JSON.parse(digest) as {
      dependencyResults: Array<{ id: string; summary: string }>
    }
    assert.deepEqual(parsed.dependencyResults.map((entry) => entry.id), ['T1', 'T2', 'T3'])
    assert.ok(parsed.dependencyResults.every((entry) => entry.summary.length > 0))
    assert.ok(parsed.dependencyResults.every((entry) => entry.summary.length < 1_000))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('research overlay rejects changed approvals and alternate agent identities', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-adapter-security-'))
  try {
    fs.mkdirSync(path.join(dir, 'research'), { recursive: true })
    const changed = {
      ...researchPlan(),
      expectedPeakWorkers: 2,
    }
    fs.writeFileSync(path.join(dir, 'research', 'plan.json'), JSON.stringify(changed))
    const task = executableTask()

    assert.throws(() => resolveDeepResearchTaskOverlay({
      assignmentPath: dir,
      planArtifact: 'research/plan.json',
      executablePlan: executablePlan(task),
      task,
    }), /unapproved or changed/)

    fs.writeFileSync(path.join(dir, 'research', 'plan.json'), JSON.stringify(researchPlan()))
    const alternateTask = executableTask('domain-researcher')
    assert.throws(() => resolveDeepResearchTaskOverlay({
      assignmentPath: dir,
      planArtifact: 'research/plan.json',
      executablePlan: executablePlan(alternateTask),
      task: alternateTask,
    }), /must dispatch through 'web-researcher'/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('research overlay refuses plan symlinks even when their target is inside the run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-adapter-link-'))
  try {
    fs.mkdirSync(path.join(dir, 'research'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'approved.json'), JSON.stringify(researchPlan()))
    fs.symlinkSync(path.join(dir, 'approved.json'), path.join(dir, 'research', 'plan.json'))
    const task = executableTask()

    assert.throws(() => resolveDeepResearchTaskOverlay({
      assignmentPath: dir,
      planArtifact: 'research/plan.json',
      executablePlan: executablePlan(task),
      task,
    }), /regular file/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('research evidence response is strict JSON bound to the approved assignment', () => {
  const overlayHash = 'a'.repeat(64)
  const packet = {
    schemaVersion: 1,
    assignmentId: 'lane-market',
    taskId: 'T1',
    workerSpecHash: overlayHash,
    question: 'What establishes current demand?',
    shortAnswer: 'Two independently published sources show demand.',
    findings: [],
    sources: [],
    contradictions: [],
    unresolvedQuestions: [],
    stopReason: 'decision_useful',
  }

  assert.deepEqual(parseDeepResearchEvidenceResult({
    text: JSON.stringify(packet),
    taskId: 'T1',
    sectionId: 'section-market',
    assignmentId: 'lane-market',
    workerSpecHash: overlayHash,
    assignmentPath: process.cwd(),
  }), packet)

  for (const [field, value, pattern] of [
    ['taskId', 'T2', /taskId/],
    ['assignmentId', 'lane-other', /assignmentId/],
    ['workerSpecHash', 'b'.repeat(64), /workerSpecHash/],
  ] as const) {
    assert.throws(() => parseDeepResearchEvidenceResult({
      text: JSON.stringify({ ...packet, [field]: value }),
      taskId: 'T1',
      sectionId: 'section-market',
      assignmentId: 'lane-market',
      workerSpecHash: overlayHash,
      assignmentPath: process.cwd(),
    }), pattern)
  }

  assert.throws(() => parseDeepResearchEvidenceResult({
    text: `\`\`\`json\n${JSON.stringify(packet)}\n\`\`\``,
    taskId: 'T1',
    sectionId: 'section-market',
    assignmentId: 'lane-market',
    workerSpecHash: overlayHash,
    assignmentPath: process.cwd(),
  }), /only one valid EvidencePacket JSON object/)
})

test('worker claim ownership is derived from the approved task and section', () => {
  const overlayHash = 'a'.repeat(64)
  const packet = {
    schemaVersion: 1,
    assignmentId: 'lane-market',
    taskId: 'T1',
    workerSpecHash: overlayHash,
    question: 'What establishes current demand?',
    shortAnswer: 'The remaining evidence gap is explicit.',
    findings: [{
      schemaVersion: 1,
      claimId: 'claim-one',
      taskId: 'T2',
      sectionId: 'coverage-requirement-id',
      statement: 'Current demand remains uncertain.',
      kind: 'uncertainty',
      evidenceStandard: 'single',
      sourceIds: [],
      evidenceLinks: [],
      confidence: 'low',
      status: 'unsupported',
      applicableScope: [],
    }],
    sources: [],
    contradictions: [],
    unresolvedQuestions: ['Current demand is not established.'],
    stopReason: 'insufficient_evidence',
  }

  const result = parseDeepResearchEvidenceResult({
    text: JSON.stringify(packet),
    taskId: 'T1',
    sectionId: 'section-market',
    assignmentId: 'lane-market',
    workerSpecHash: overlayHash,
    assignmentPath: process.cwd(),
  })

  assert.equal(result.findings[0]?.taskId, 'T1')
  assert.equal(result.findings[0]?.sectionId, 'section-market')
})

function createReceiptBackedEvidence(
  accessMethod: 'managed-browser' | 'document-parser' = 'managed-browser',
) {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'research-observation-binding-')),
  )
  const assignmentPath = path.join(
    workspacePath,
    'sessions',
    'session-one',
    'runs',
    'run-one',
    'assignments',
    'runtime-assignment-one',
  )
  const laneId = 'lane-market'
  const receiptId = 'receipt-one'
  const contentRelativePath =
    `research/acquisitions/${laneId}/${receiptId}/content.md`
  const contentPath = path.join(assignmentPath, contentRelativePath)
  const receiptPath = path.join(
    assignmentPath,
    'research',
    'observations',
    laneId,
    `${receiptId}.json`,
  )
  const observedExcerpt = 'Observed demand grew 23 percent year over year.'
  const content = Buffer.from(
    `Market report\n\n${observedExcerpt}\nThe sample covers 1,200 buyers.\n`,
    'utf8',
  )
  const contentSha256 = crypto.createHash('sha256').update(content).digest('hex')
  fs.mkdirSync(path.dirname(contentPath), { recursive: true })
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  fs.writeFileSync(contentPath, content)
  const receipt = {
    schemaVersion: 1,
    receiptId,
    sessionId: 'session-one',
    runId: 'run-one',
    assignmentId: 'runtime-assignment-one',
    activityScopeId: laneId,
    activityId: receiptId,
    agentPath: 'agents/web-researcher',
    agentDisplayName: 'Product Evidence Analyst',
    method: accessMethod,
    requestedUrl: 'https://example.com/report',
    finalUrl: 'https://example.com/report',
    canonicalUrl: 'https://example.com/report',
    title: 'Direct demand report',
    mediaType: accessMethod === 'document-parser'
      ? 'application/pdf'
      : 'text/html',
    observedAt: '2026-07-16T12:00:00.000Z',
    contentRelativePath,
    contentSha256,
    contentBytes: content.byteLength,
    quality: 'usable',
    attempts: [{
      method: accessMethod,
      outcome: 'usable',
      startedAt: '2026-07-16T11:59:59.000Z',
      durationMs: 1_000,
      contentBytes: content.byteLength,
    }],
  }
  fs.writeFileSync(receiptPath, JSON.stringify(receipt))
  const packet = {
    schemaVersion: 1 as const,
    assignmentId: laneId,
    taskId: 'T1',
    workerSpecHash: 'a'.repeat(64),
    question: 'What establishes current demand?',
    shortAnswer: 'Direct observation establishes current growth.',
    findings: [{
      schemaVersion: 1 as const,
      claimId: 'claim-one',
      taskId: 'T1',
      sectionId: 'section-market',
      statement: 'Demand grew 23 percent year over year.',
      kind: 'fact' as const,
      evidenceStandard: 'single' as const,
      sourceIds: ['source-one'],
      evidenceLinks: [{
        sourceId: 'source-one',
        observationReceiptId: receiptId,
        observedExcerpt,
        locator: 'Market report, demand paragraph',
        relationship: 'supports' as const,
      }],
      confidence: 'high' as const,
      status: 'supported' as const,
      applicableScope: ['Current market'],
    }],
    sources: [{
      schemaVersion: 1 as const,
      sourceId: 'source-one',
      assignmentId: laneId,
      canonicalUrl: 'https://example.com/report',
      title: 'Direct demand report',
      publisher: 'Example Research',
      independenceKey: 'example-research',
      sourceType: 'primary' as const,
      accessMethod,
      observationReceiptId: receiptId,
      observedAt: '2026-07-16T12:00:00.000Z',
      contentSha256,
      status: 'usable' as const,
    }],
    contradictions: [],
    unresolvedQuestions: [],
    stopReason: 'decision_useful' as const,
  }
  return {
    workspacePath,
    assignmentPath,
    contentPath,
    receiptPath,
    receipt,
    packet,
  }
}

function validateReceiptBackedEvidence(
  fixture: ReturnType<typeof createReceiptBackedEvidence>,
  packet: EvidencePacket = fixture.packet,
) {
  return parseDeepResearchEvidenceResult({
    text: JSON.stringify(packet),
    taskId: 'T1',
    sectionId: 'section-market',
    assignmentId: packet.assignmentId,
    workerSpecHash: packet.workerSpecHash,
    assignmentPath: fixture.assignmentPath,
  })
}

function addReceiptBackedSource(
  fixture: ReturnType<typeof createReceiptBackedEvidence>,
  input: {
    readonly sourceId: string
    readonly receiptId: string
    readonly canonicalUrl: string
    readonly independenceKey: string
  },
): SourceRecord {
  const receipt = {
    ...fixture.receipt,
    receiptId: input.receiptId,
    activityId: input.receiptId,
    requestedUrl: input.canonicalUrl,
    finalUrl: input.canonicalUrl,
    canonicalUrl: input.canonicalUrl,
  }
  const receiptPath = path.join(
    fixture.assignmentPath,
    'research',
    'observations',
    fixture.packet.assignmentId,
    `${input.receiptId}.json`,
  )
  fs.writeFileSync(receiptPath, JSON.stringify(receipt))
  return {
    ...requiredValue(fixture.packet.sources[0], 'primary source record'),
    sourceId: input.sourceId,
    canonicalUrl: input.canonicalUrl,
    independenceKey: input.independenceKey,
    observationReceiptId: input.receiptId,
  }
}

/** A second fully materialized receipt with its own runtime-owned content. */
function materializeSecondReceiptBackedSource(
  fixture: ReturnType<typeof createReceiptBackedEvidence>,
  input: {
    readonly sourceId: string
    readonly receiptId: string
    readonly canonicalUrl: string
    readonly independenceKey: string
    readonly content: string
  },
): SourceRecord {
  const laneId = fixture.packet.assignmentId
  const contentRelativePath =
    `research/acquisitions/${laneId}/${input.receiptId}/content.md`
  const contentPath = path.join(fixture.assignmentPath, contentRelativePath)
  const content = Buffer.from(input.content, 'utf8')
  fs.mkdirSync(path.dirname(contentPath), { recursive: true })
  fs.writeFileSync(contentPath, content)
  const receipt = {
    ...fixture.receipt,
    receiptId: input.receiptId,
    activityId: input.receiptId,
    requestedUrl: input.canonicalUrl,
    finalUrl: input.canonicalUrl,
    canonicalUrl: input.canonicalUrl,
    contentRelativePath,
    contentSha256: crypto.createHash('sha256').update(content).digest('hex'),
    contentBytes: content.byteLength,
  }
  fs.writeFileSync(
    path.join(
      fixture.assignmentPath,
      'research',
      'observations',
      laneId,
      `${input.receiptId}.json`,
    ),
    JSON.stringify(receipt),
  )
  return {
    ...requiredValue(fixture.packet.sources[0], 'primary source record'),
    sourceId: input.sourceId,
    canonicalUrl: input.canonicalUrl,
    independenceKey: input.independenceKey,
    observationReceiptId: input.receiptId,
    contentSha256: receipt.contentSha256,
  }
}

test('claim evidence accepts real runtime receipts for browser and parsed documents', () => {
  for (const accessMethod of ['managed-browser', 'document-parser'] as const) {
    const fixture = createReceiptBackedEvidence(accessMethod)
    try {
      assert.deepEqual(validateReceiptBackedEvidence(fixture), fixture.packet)
    } finally {
      fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
    }
  }
})

test('claim evidence repairs a source ID from its unique runtime receipt binding', () => {
  // The 2026-08-31 Anthropic live lane copied the receipt and excerpt from its
  // Auto mode source but left the evidence link and claim sourceIds pointing
  // at its sandboxing source. Receipt identity is runtime-verifiable and is
  // therefore the authoritative join key for this transcription repair.
  const fixture = createReceiptBackedEvidence()
  try {
    const second = materializeSecondReceiptBackedSource(fixture, {
      sourceId: 'source-two',
      receiptId: 'receipt-two',
      canonicalUrl: 'https://example.org/auto-mode',
      independenceKey: 'example-auto-mode',
      content: 'Auto mode is a new mode that lets Claude decide whether to proceed with an action.\n',
    })
    const claim = requiredValue(fixture.packet.findings[0], 'receipt-repair-claim')
    const link = requiredValue(claim.evidenceLinks[0], 'receipt-repair-link')

    const packet = validateReceiptBackedEvidence(fixture, {
      ...fixture.packet,
      sources: [...fixture.packet.sources, second],
      findings: [{
        ...claim,
        sourceIds: ['source-one'],
        evidenceLinks: [{
          ...link,
          sourceId: 'source-one',
          observationReceiptId: 'receipt-two',
          observedExcerpt:
            'Auto mode is a new mode that lets Claude decide whether to proceed with an action.',
        }],
      }],
    })

    const repairedClaim = requiredValue(packet.findings[0], 'repaired-claim')
    assert.deepEqual(repairedClaim.sourceIds, ['source-two'])
    assert.equal(repairedClaim.evidenceLinks[0]?.sourceId, 'source-two')
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('clerical repair leaves the packet as authored when two usable sources share one receipt', () => {
  // Receipt identity is an authoritative join key only while one source owns
  // the receipt. When two do, nothing proves which source a link belongs to,
  // so the repair invents no owner and hands validation the packet the worker
  // wrote. Read at the repair step rather than through a parse, because the
  // parser rejects this packet whether or not the repair ran: which message it
  // reports depends only on the order of its own checks.
  const fixture = createReceiptBackedEvidence()
  try {
    const primary = requiredValue(fixture.packet.sources[0], 'shared-receipt-primary-source')
    const rival: SourceRecord = {
      ...primary,
      sourceId: 'source-two',
      canonicalUrl: 'https://example.org/mirror',
      independenceKey: 'example-mirror',
    }
    const claim = requiredValue(fixture.packet.findings[0], 'shared-receipt-claim')
    const link = requiredValue(claim.evidenceLinks[0], 'shared-receipt-link')
    const authored = {
      ...fixture.packet,
      sources: [primary, rival],
      findings: [{
        ...claim,
        sourceIds: ['source-one', 'source-two'],
        evidenceLinks: [link, { ...link, sourceId: 'source-two' }],
      }],
    }

    const canonicalized = canonicalizeModelEvidencePacketClericalFields(authored, {
      taskId: 'T1',
      sectionId: 'section-market',
    })

    assert.equal(JSON.stringify(canonicalized), JSON.stringify(authored))
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('an observation receipt claimed by two usable sources is refused, not repaired', () => {
  // The operator-facing half of the rule above: the surfaced failure names the
  // receipt reuse that caused it, not a duplicate link the worker never wrote.
  // Which message wins depends on the parser's check order, so the repair
  // itself is pinned by the test above.
  const fixture = createReceiptBackedEvidence()
  try {
    const primary = requiredValue(fixture.packet.sources[0], 'ambiguous-primary-source')
    const rival: SourceRecord = {
      ...primary,
      sourceId: 'source-two',
      canonicalUrl: 'https://example.org/mirror',
      independenceKey: 'example-mirror',
    }
    const claim = requiredValue(fixture.packet.findings[0], 'ambiguous-claim')
    const link = requiredValue(claim.evidenceLinks[0], 'ambiguous-link')

    assert.throws(
      () => validateReceiptBackedEvidence(fixture, {
        ...fixture.packet,
        sources: [primary, rival],
        findings: [{
          ...claim,
          sourceIds: ['source-one', 'source-two'],
          evidenceLinks: [link, { ...link, sourceId: 'source-two' }],
        }],
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /cannot be reused across different source records/)
        assert.doesNotMatch(message, /duplicate values/)
        return true
      },
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('a context-only uncertainty is retained as unsupported without weakening factual claims', () => {
  // The 2026-08-31 Anthropic retry grounded a documentation gap with context
  // evidence but labeled the uncertainty itself supported. The safe repair is
  // to retain the limitation and downgrade its status, never promote context
  // into supporting evidence.
  const fixture = createReceiptBackedEvidence()
  try {
    const claim = requiredValue(fixture.packet.findings[0], 'uncertainty-claim')
    const link = requiredValue(claim.evidenceLinks[0], 'uncertainty-link')
    const contextOnlyClaim = {
      ...claim,
      kind: 'uncertainty' as const,
      status: 'supported' as const,
      evidenceLinks: [{ ...link, relationship: 'context' as const }],
    }
    const contextOnly = { ...fixture.packet, findings: [contextOnlyClaim] }

    const packet = validateReceiptBackedEvidence(fixture, contextOnly)
    assert.equal(packet.findings[0]?.status, 'unsupported')
    assert.equal(packet.findings[0]?.evidenceLinks[0]?.relationship, 'context')

    assert.throws(
      () => validateReceiptBackedEvidence(fixture, {
        ...contextOnly,
        findings: [{ ...contextOnlyClaim, kind: 'fact' as const }],
      }),
      /A supported claim requires at least one supporting observation link/,
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('claim evidence tolerates presentation whitespace but rejects non-contiguous composed excerpts', () => {
  const fixture = createReceiptBackedEvidence()
  try {
    const link = fixture.packet.findings[0]!.evidenceLinks[0]!
    const whitespaceVariant = {
      ...fixture.packet,
      findings: [{
        ...fixture.packet.findings[0]!,
        evidenceLinks: [{
          ...link,
          observedExcerpt: 'Observed   demand grew 23 percent\n year over year.',
        }],
      }],
    }
    // The quotation binds despite presentation whitespace, and what is stored
    // is the observation's own text rather than the worker's transcription.
    assert.equal(
      validateReceiptBackedEvidence(fixture, whitespaceVariant)
        .findings[0]?.evidenceLinks[0]?.observedExcerpt,
      'Observed demand grew 23 percent year over year.',
    )

    const composed = {
      ...fixture.packet,
      findings: [{
        ...fixture.packet.findings[0]!,
        evidenceLinks: [{
          ...link,
          observedExcerpt: `${link.observedExcerpt} omitted words The sample covers 1,200 buyers.`,
        }],
      }],
    }
    assert.throws(
      () => validateReceiptBackedEvidence(fixture, composed),
      /excerpt was not found/,
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('local correction rejects regressions to non-targeted claims and their sources', () => {
  const fixture = createReceiptBackedEvidence()
  try {
    const priorPacket = {
      ...fixture.packet,
      findings: [
        fixture.packet.findings[0]!,
        {
          ...fixture.packet.findings[0]!,
          claimId: 'claim-two',
          statement: 'The same observed report establishes the retained comparison baseline.',
        },
      ],
    }
    const evidenceDirectory = path.join(fixture.assignmentPath, 'research', 'evidence')
    fs.mkdirSync(path.join(evidenceDirectory, 'wave-0'), { recursive: true })
    fs.mkdirSync(path.join(fixture.assignmentPath, 'research', 'corrections'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(evidenceDirectory, 'wave-0', 'T1.json'),
      JSON.stringify(priorPacket),
    )
    fs.writeFileSync(
      path.join(evidenceDirectory, 'current-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        correctionWave: 0,
        latestByTask: { T1: 'research/evidence/wave-0/T1.json' },
      }),
    )
    fs.writeFileSync(
      path.join(fixture.assignmentPath, 'research', 'corrections', 'current.json'),
      JSON.stringify({
        schemaVersion: 1,
        wave: 1,
        taskRequests: {
          T1: [{
            schemaVersion: 1,
            id: 'correct-claim-one',
            type: 'restructure_packet',
            claimIds: ['T1--claim-one'],
            taskIds: ['T1'],
            sectionIds: ['section-market'],
            acceptanceCriteria: ['Correct only claim one.'],
            impactScope: 'local',
          }],
        },
      }),
    )

    const allowed = {
      ...priorPacket,
      findings: [
        { ...priorPacket.findings[0]!, confidence: 'medium' as const },
        priorPacket.findings[1]!,
      ],
    }
    assert.equal(validateReceiptBackedEvidence(fixture, allowed).findings[0]?.confidence, 'medium')

    assert.throws(
      () => validateReceiptBackedEvidence(fixture, {
        ...allowed,
        findings: [
          allowed.findings[0]!,
          { ...allowed.findings[1]!, statement: 'A rewritten non-targeted claim.' },
        ],
      }),
      /changed non-targeted claim 'claim-two'/,
    )
    assert.throws(
      () => validateReceiptBackedEvidence(fixture, {
        ...allowed,
        sources: [{ ...allowed.sources[0]!, title: 'Rewritten source record' }],
      }),
      /changed source 'source-one' used by a non-targeted claim/,
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('receipt binding accepts an aliased workspace ancestor but rejects controlled-path symlinks', () => {
  const fixture = createReceiptBackedEvidence()
  const aliasHolder = fs.mkdtempSync(path.join(os.tmpdir(), 'research-binding-alias-'))
  const aliasWorkspace = path.join(aliasHolder, 'workspace')
  try {
    fs.symlinkSync(fixture.workspacePath, aliasWorkspace, 'dir')
    const aliasAssignmentPath = path.join(
      aliasWorkspace,
      path.relative(fixture.workspacePath, fixture.assignmentPath),
    )
    assert.deepEqual(
      validateReceiptBackedEvidence({ ...fixture, assignmentPath: aliasAssignmentPath }),
      fixture.packet,
    )

    const sessionsPath = path.join(fixture.workspacePath, 'sessions')
    const relocatedSessionsPath = path.join(
      fixture.workspacePath,
      'relocated',
      'sessions',
    )
    fs.mkdirSync(path.dirname(relocatedSessionsPath), { recursive: true })
    fs.renameSync(sessionsPath, relocatedSessionsPath)
    fs.symlinkSync(relocatedSessionsPath, sessionsPath, 'dir')
    assert.throws(
      () => validateReceiptBackedEvidence(fixture),
      /canonical and contain no symbolic links/,
    )
  } finally {
    fs.rmSync(aliasHolder, { recursive: true, force: true })
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('claim evidence rejects missing, wrong-lane, and reused observation receipts', () => {
  const missing = createReceiptBackedEvidence()
  try {
    fs.rmSync(missing.receiptPath)
    assert.throws(() => validateReceiptBackedEvidence(missing), /does not exist/)
  } finally {
    fs.rmSync(missing.workspacePath, { recursive: true, force: true })
  }

  const wrongLane = createReceiptBackedEvidence()
  try {
    fs.writeFileSync(wrongLane.receiptPath, JSON.stringify({
      ...wrongLane.receipt,
      activityScopeId: 'lane-other',
      contentRelativePath:
        `research/acquisitions/lane-other/${wrongLane.receipt.receiptId}/content.md`,
    }))
    assert.throws(() => validateReceiptBackedEvidence(wrongLane), /identity does not match/)
  } finally {
    fs.rmSync(wrongLane.workspacePath, { recursive: true, force: true })
  }

  const reused = createReceiptBackedEvidence()
  try {
    const secondSource = {
      ...requiredValue(reused.packet.sources[0], 'primary source record'),
      sourceId: 'source-two',
    }
    const reusedPacket = {
      ...reused.packet,
      findings: [{
        ...requiredValue(reused.packet.findings[0], 'primary finding'),
        sourceIds: ['source-one', 'source-two'],
        evidenceLinks: [
          ...requiredValue(reused.packet.findings[0], 'tests/unit/deep-research-pipeline-adapter.test.ts:782').evidenceLinks,
          {
            ...requiredValue(
              requiredValue(reused.packet.findings[0], 'primary finding').evidenceLinks[0],
              'primary evidence link',
            ),
            sourceId: 'source-two',
          },
        ],
      }],
      sources: [...reused.packet.sources, secondSource],
    }
    assert.throws(
      () => validateReceiptBackedEvidence(reused, reusedPacket),
      /cannot be reused across different source records/,
    )
  } finally {
    fs.rmSync(reused.workspacePath, { recursive: true, force: true })
  }
})

test('uncited usable sources cannot pad quality thresholds without real receipts', () => {
  const fixture = createReceiptBackedEvidence()
  try {
    const paddedPacket = {
      ...fixture.packet,
      sources: [
        ...fixture.packet.sources,
        {
          ...requiredValue(fixture.packet.sources[0], 'primary source record'),
          sourceId: 'source-padding',
          canonicalUrl: 'https://padding.example.org/invented',
          publisher: 'Invented Independent Publisher',
          independenceKey: 'invented-independent-publisher',
          observationReceiptId: 'receipt-padding',
        },
      ],
    }
    assert.throws(
      () => validateReceiptBackedEvidence(fixture, paddedPacket),
      /Observation receipt 'receipt-padding' does not exist/,
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('receipt-backed source padding cannot forge URL or hostname independence', () => {
  const duplicateUrl = createReceiptBackedEvidence()
  try {
    const secondSource = addReceiptBackedSource(duplicateUrl, {
      sourceId: 'source-duplicate-url',
      receiptId: 'receipt-duplicate-url',
      canonicalUrl: requiredValue(duplicateUrl.packet.sources[0], 'tests/unit/deep-research-pipeline-adapter.test.ts:832').canonicalUrl,
      independenceKey: 'invented-independent-publisher',
    })
    assert.throws(
      () => validateReceiptBackedEvidence(duplicateUrl, {
        ...duplicateUrl.packet,
        sources: [...duplicateUrl.packet.sources, secondSource],
      }),
      /reuse the same canonical URL/,
    )
  } finally {
    fs.rmSync(duplicateUrl.workspacePath, { recursive: true, force: true })
  }

  const sameHost = createReceiptBackedEvidence()
  try {
    const secondSource = addReceiptBackedSource(sameHost, {
      sourceId: 'source-same-host',
      receiptId: 'receipt-same-host',
      canonicalUrl: 'https://example.com/another-report',
      independenceKey: 'invented-independent-publisher',
    })
    assert.throws(
      () => validateReceiptBackedEvidence(sameHost, {
        ...sameHost.packet,
        sources: [...sameHost.packet.sources, secondSource],
      }),
      /hostname 'example.com' must use the same independenceKey/,
    )
  } finally {
    fs.rmSync(sameHost.workspacePath, { recursive: true, force: true })
  }
})

test('claim evidence rejects altered receipt metadata, bytes, content hashes, and excerpts', () => {
  for (const [name, mutate, pattern] of [
    [
      'canonical URL',
      (fixture: ReturnType<typeof createReceiptBackedEvidence>) => {
        fs.writeFileSync(fixture.receiptPath, JSON.stringify({
          ...fixture.receipt,
          canonicalUrl: 'https://other.example.com/report',
        }))
      },
      /was issued for .* but source .* claims/,
    ],
    [
      'byte count',
      (fixture: ReturnType<typeof createReceiptBackedEvidence>) => {
        fs.writeFileSync(fixture.receiptPath, JSON.stringify({
          ...fixture.receipt,
          contentBytes: fixture.receipt.contentBytes + 1,
        }))
      },
      /content byte count/,
    ],
    [
      'content tampering',
      (fixture: ReturnType<typeof createReceiptBackedEvidence>) => {
        const original = fs.readFileSync(fixture.contentPath, 'utf8')
        fs.writeFileSync(fixture.contentPath, original.replace('23 percent', '24 percent'))
      },
      /content hash/,
    ],
    [
      'unobserved excerpt',
      (fixture: ReturnType<typeof createReceiptBackedEvidence>) => {
        requiredValue(requiredValue(fixture.packet.findings[0], 'tests/unit/deep-research-pipeline-adapter.test.ts:899').evidenceLinks[0], 'tests/unit/deep-research-pipeline-adapter.test.ts:900').observedExcerpt =
          'This sentence was never observed.'
      },
      /excerpt was not found/,
    ],
  ] as const) {
    const fixture = createReceiptBackedEvidence()
    try {
      mutate(fixture)
      assert.throws(() => validateReceiptBackedEvidence(fixture), pattern, name)
    } finally {
      fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
    }
  }
})

test('a mis-paired observation receipt is still rejected after runtime derivation', () => {
  // A2 guard: deriving acquisition facts from the receipt must not turn a
  // source paired with the wrong page into a silently accepted packet.
  const fixture = createReceiptBackedEvidence()
  try {
    const source = requiredValue(
      fixture.packet.sources[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:mis-paired-source',
    )
    assert.throws(
      () => validateReceiptBackedEvidence(fixture, {
        ...fixture.packet,
        sources: [{ ...source, canonicalUrl: 'https://unrelated.example.org/other' }],
      }),
      /was issued for 'https:\/\/example\.com\/report' but source 'source-one' claims/,
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('a trailing-slash canonical URL binds and the runtime copy is stored', () => {
  const fixture = createReceiptBackedEvidence()
  try {
    const source = requiredValue(
      fixture.packet.sources[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:trailing-slash-source',
    )
    const packet = validateReceiptBackedEvidence(fixture, {
      ...fixture.packet,
      sources: [{ ...source, canonicalUrl: 'https://example.com/report/' }],
    })
    assert.equal(
      requiredValue(packet.sources[0], 'trailing-slash-bound').canonicalUrl,
      'https://example.com/report',
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('runtime derivation replaces mistyped acquisition facts with the receipt copy', () => {
  const fixture = createReceiptBackedEvidence()
  try {
    const source = requiredValue(
      fixture.packet.sources[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:derived-source',
    )
    const packet = validateReceiptBackedEvidence(fixture, {
      ...fixture.packet,
      sources: [{
        ...source,
        // The exact defects that killed the 2026-08-16 run: a digest one
        // character too long and a drifted observation time.
        contentSha256: `${source.contentSha256}a`,
        observedAt: '2026-07-16T12:00:01.000Z',
        accessMethod: 'managed-reader' as const,
      }],
    })
    const bound = requiredValue(packet.sources[0], 'derived-bound')
    assert.equal(bound.contentSha256, fixture.receipt.contentSha256)
    assert.equal(bound.observedAt, fixture.receipt.observedAt)
    assert.equal(bound.accessMethod, fixture.receipt.method)
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('an excerpt that differs only in capitalization still binds', () => {
  // The 2026-08-17 T3 failure: the worker sentence-cased a span that begins
  // mid-sentence, and one capital letter cost the whole lane.
  const fixture = createReceiptBackedEvidence()
  try {
    const claim = requiredValue(
      fixture.packet.findings[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:case-claim',
    )
    const link = requiredValue(
      claim.evidenceLinks[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:case-link',
    )
    const packet = validateReceiptBackedEvidence(fixture, {
      ...fixture.packet,
      findings: [{
        ...claim,
        evidenceLinks: [{
          ...link,
          observedExcerpt: 'OBSERVED DEMAND GREW 23 PERCENT year over year.',
        }],
      }],
    })
    assert.equal(packet.taskId, 'T1')
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('an excerpt binds across Markdown emphasis markers inserted by acquisition', () => {
  // The 2026-08-31 OpenAI live retry quoted the exact visible sentence, while
  // the acquired Markdown retained bold markers around the list-item label.
  // Formatting syntax is not evidence text; the runtime still republishes its
  // own stored spelling after the words bind contiguously.
  const fixture = createReceiptBackedEvidence()
  try {
    const second = materializeSecondReceiptBackedSource(fixture, {
      sourceId: 'source-two',
      receiptId: 'receipt-two',
      canonicalUrl: 'https://example.org/codex-cli',
      independenceKey: 'example-codex-cli',
      content:
        '- **Work against your local repository:** Let Codex inspect files, make edits, and run the tools already installed on your machine.\n',
    })
    const claim = requiredValue(fixture.packet.findings[0], 'markdown-claim')
    const link = requiredValue(claim.evidenceLinks[0], 'markdown-link')
    const packet = validateReceiptBackedEvidence(fixture, {
      ...fixture.packet,
      sources: [...fixture.packet.sources, second],
      findings: [{
        ...claim,
        sourceIds: ['source-two'],
        evidenceLinks: [{
          ...link,
          sourceId: 'source-two',
          observationReceiptId: 'receipt-two',
          observedExcerpt:
            'Work against your local repository: Let Codex inspect files, make edits, and run the tools already installed on your machine.',
        }],
      }],
    })

    assert.equal(
      packet.findings[0]?.evidenceLinks[0]?.observedExcerpt,
      'Work against your local repository:** Let Codex inspect files, make edits, and run the tools already installed on your machine.',
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('an excerpt binds when Markdown emphasis closes before punctuation', () => {
  // The 2026-09-01 live T1 packet quoted the visible sentence exactly, but the
  // stored Markdown closed bold emphasis immediately before the colon. That
  // single formatting delimiter rejected eight otherwise valid sources and
  // forced an avoidable correction wave.
  const fixture = createReceiptBackedEvidence()
  try {
    const second = materializeSecondReceiptBackedSource(fixture, {
      sourceId: 'source-two',
      receiptId: 'receipt-two',
      canonicalUrl: 'https://example.org/codex-security',
      independenceKey: 'example-codex-security',
      content:
        '**Codex cloud**: Runs in isolated OpenAI-managed containers, preventing access to your host system or unrelated data.\n',
    })
    const claim = requiredValue(fixture.packet.findings[0], 'punctuation-markdown-claim')
    const link = requiredValue(claim.evidenceLinks[0], 'punctuation-markdown-link')
    const packet = validateReceiptBackedEvidence(fixture, {
      ...fixture.packet,
      sources: [...fixture.packet.sources, second],
      findings: [{
        ...claim,
        sourceIds: ['source-two'],
        evidenceLinks: [{
          ...link,
          sourceId: 'source-two',
          observationReceiptId: 'receipt-two',
          observedExcerpt:
            'Codex cloud: Runs in isolated OpenAI-managed containers, preventing access to your host system or unrelated data.',
        }],
      }],
    })

    assert.equal(
      packet.findings[0]?.evidenceLinks[0]?.observedExcerpt,
      'Codex cloud**: Runs in isolated OpenAI-managed containers, preventing access to your host system or unrelated data.',
    )
    const rebound = validateReceiptBackedEvidence(fixture, packet)
    assert.equal(
      rebound.findings[0]?.evidenceLinks[0]?.observedExcerpt,
      packet.findings[0]?.evidenceLinks[0]?.observedExcerpt,
    )
    assert.throws(
      () => validateReceiptBackedEvidence(fixture, {
        ...fixture.packet,
        sources: [...fixture.packet.sources, second],
        findings: [{
          ...claim,
          sourceIds: ['source-two'],
          evidenceLinks: [{
            ...link,
            sourceId: 'source-two',
            observationReceiptId: 'receipt-two',
            observedExcerpt:
              'Codex cloud; Runs in isolated OpenAI-managed containers, preventing access to your host system or unrelated data.',
          }],
        }],
      }),
      /excerpt was not found/,
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('an excerpt beginning inside emphasized text still binds when the packet is read again', () => {
  // The 2026-09-01 wave read: the worker quoted a span starting in the middle
  // of a bold label, the runtime republished its own copy carrying the orphaned
  // closing delimiter, and every later parse of that stored packet rejected the
  // excerpt the runtime had just written.
  const fixture = createReceiptBackedEvidence()
  try {
    const second = materializeSecondReceiptBackedSource(fixture, {
      sourceId: 'source-two',
      receiptId: 'receipt-two',
      canonicalUrl: 'https://example.org/codex-cloud',
      independenceKey: 'example-codex-cloud',
      content:
        '**Codex cloud** runs the pipeline in isolated OpenAI-managed containers.\n',
    })
    const claim = requiredValue(fixture.packet.findings[0], 'mid-span-markdown-claim')
    const link = requiredValue(claim.evidenceLinks[0], 'mid-span-markdown-link')
    const packet = validateReceiptBackedEvidence(fixture, {
      ...fixture.packet,
      sources: [...fixture.packet.sources, second],
      findings: [{
        ...claim,
        sourceIds: ['source-two'],
        evidenceLinks: [{
          ...link,
          sourceId: 'source-two',
          observationReceiptId: 'receipt-two',
          observedExcerpt:
            'cloud runs the pipeline in isolated OpenAI-managed containers.',
        }],
      }],
    })

    assert.equal(
      packet.findings[0]?.evidenceLinks[0]?.observedExcerpt,
      'cloud** runs the pipeline in isolated OpenAI-managed containers.',
    )
    const rebound = validateReceiptBackedEvidence(fixture, packet)
    assert.equal(
      rebound.findings[0]?.evidenceLinks[0]?.observedExcerpt,
      'cloud** runs the pipeline in isolated OpenAI-managed containers.',
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('an excerpt binds when emphasis closes against the word that follows it', () => {
  // Acquisition converts `<strong>SHA-256</strong>based` into
  // `**SHA-256**based`. CommonMark pairs that closer — the punctuation
  // conditions that would refuse it belong to `_`, not `*` — but the fold this
  // replaced applied the underscore rules to asterisk runs and left the closer
  // stranded. The page reads as one word either way, so a worker quoting what
  // it sees must not lose its lane over the conversion's delimiters.
  const fixture = createReceiptBackedEvidence()
  try {
    const second = materializeSecondReceiptBackedSource(fixture, {
      sourceId: 'source-two',
      receiptId: 'receipt-two',
      canonicalUrl: 'https://example.org/observation-digests',
      independenceKey: 'example-observation-digests',
      content: 'Every observation stores a **SHA-256**based content digest.\n',
    })
    const claim = requiredValue(fixture.packet.findings[0], 'unpaired-markdown-claim')
    const link = requiredValue(claim.evidenceLinks[0], 'unpaired-markdown-link')
    const packet = validateReceiptBackedEvidence(fixture, {
      ...fixture.packet,
      sources: [...fixture.packet.sources, second],
      findings: [{
        ...claim,
        sourceIds: ['source-two'],
        evidenceLinks: [{
          ...link,
          sourceId: 'source-two',
          observationReceiptId: 'receipt-two',
          observedExcerpt: 'stores a SHA-256based content digest.',
        }],
      }],
    })

    assert.equal(
      packet.findings[0]?.evidenceLinks[0]?.observedExcerpt,
      'stores a **SHA-256**based content digest.',
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('a bound excerpt is stored as the observation reads, not as the worker typed it', () => {
  // Single source of truth: once the link binds, the published evidence should
  // quote the runtime's own copy of the page, so nothing downstream ever reads
  // a model transcription.
  const fixture = createReceiptBackedEvidence()
  try {
    const second = materializeSecondReceiptBackedSource(fixture, {
      sourceId: 'source-two',
      receiptId: 'receipt-two',
      canonicalUrl: 'https://other.example.org/directory',
      independenceKey: 'other-example',
      content: "Love's Ice Cream , located inside The Grand Rapids Downtown Market . Open year-round.\n",
    })
    const claim = requiredValue(
      fixture.packet.findings[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:repair-claim',
    )
    const link = requiredValue(
      claim.evidenceLinks[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:repair-link',
    )
    const packet = validateReceiptBackedEvidence(fixture, {
      ...fixture.packet,
      sources: [...fixture.packet.sources, second],
      findings: [{
        ...claim,
        sourceIds: ['source-two'],
        evidenceLinks: [{
          ...link,
          sourceId: 'source-two',
          observationReceiptId: 'receipt-two',
          observedExcerpt:
            "love's ICE CREAM, located inside The Grand Rapids Downtown Market. Open year-round.",
        }],
      }],
    })

    const storedExcerpt = requiredValue(
      requiredValue(packet.findings[0], 'repair-stored-claim').evidenceLinks[0],
      'repair-stored-link',
    ).observedExcerpt
    assert.equal(
      storedExcerpt,
      "Love's Ice Cream , located inside The Grand Rapids Downtown Market . Open year-round.",
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('a paraphrase presented as a quotation is still rejected', () => {
  // The guard on case folding: typography may differ, wording may not.
  const fixture = createReceiptBackedEvidence()
  try {
    const claim = requiredValue(
      fixture.packet.findings[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:paraphrase-claim',
    )
    const link = requiredValue(
      claim.evidenceLinks[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:paraphrase-link',
    )
    assert.throws(
      () => validateReceiptBackedEvidence(fixture, {
        ...fixture.packet,
        findings: [{
          ...claim,
          evidenceLinks: [{
            ...link,
            observedExcerpt: 'Observed demand grew by roughly 23 percent over the year.',
          }],
        }],
      }),
      /excerpt was not found/,
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('an excerpt verbatim in another bound receipt names that receipt', () => {
  const fixture = createReceiptBackedEvidence()
  try {
    const second = materializeSecondReceiptBackedSource(fixture, {
      sourceId: 'source-two',
      receiptId: 'receipt-two',
      canonicalUrl: 'https://other.example.org/directory',
      independenceKey: 'other-example',
      content: 'Directory listing\n\nOpen daily from noon until nine.\n',
    })
    const claim = requiredValue(
      fixture.packet.findings[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:misattributed-claim',
    )
    const link = requiredValue(
      claim.evidenceLinks[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:misattributed-link',
    )
    assert.throws(
      () => validateReceiptBackedEvidence(fixture, {
        ...fixture.packet,
        sources: [...fixture.packet.sources, second],
        findings: [{
          ...claim,
          sourceIds: ['source-two'],
          // Faithful quotation, pointed at the wrong page.
          evidenceLinks: [{
            ...link,
            sourceId: 'source-two',
            observationReceiptId: 'receipt-two',
          }],
        }],
      }),
      /is verbatim in observation receipt 'receipt-one'.*not in the cited receipt 'receipt-two'/s,
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('an excerpt binds across whitespace the page conversion left before punctuation', () => {
  // The 2026-08-17 T1 failure: stripping inline link markup left the stored
  // observation reading "Downtown Market . Open year-round", and the worker
  // quoted the sentence as it reads. A space before a period is a conversion
  // artifact, not evidence.
  const fixture = createReceiptBackedEvidence()
  try {
    const second = materializeSecondReceiptBackedSource(fixture, {
      sourceId: 'source-two',
      receiptId: 'receipt-two',
      canonicalUrl: 'https://other.example.org/directory',
      independenceKey: 'other-example',
      content: "Love's Ice Cream , located inside The Grand Rapids Downtown Market . Open year-round.\n",
    })
    const claim = requiredValue(
      fixture.packet.findings[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:punctuation-claim',
    )
    const link = requiredValue(
      claim.evidenceLinks[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:punctuation-link',
    )
    const packet = validateReceiptBackedEvidence(fixture, {
      ...fixture.packet,
      sources: [...fixture.packet.sources, second],
      findings: [{
        ...claim,
        sourceIds: ['source-two'],
        evidenceLinks: [{
          ...link,
          sourceId: 'source-two',
          observationReceiptId: 'receipt-two',
          observedExcerpt:
            "Love's Ice Cream, located inside The Grand Rapids Downtown Market. Open year-round.",
        }],
      }],
    })
    assert.equal(packet.taskId, 'T1')
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('an unmatched excerpt reports where it diverged from the observed content', () => {
  const fixture = createReceiptBackedEvidence()
  try {
    const claim = requiredValue(
      fixture.packet.findings[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:divergence-claim',
    )
    const link = requiredValue(
      claim.evidenceLinks[0],
      'tests/unit/deep-research-pipeline-adapter.test.ts:divergence-link',
    )
    assert.throws(
      () => validateReceiptBackedEvidence(fixture, {
        ...fixture.packet,
        findings: [{
          ...claim,
          evidenceLinks: [{
            ...link,
            // Contiguous in the rendered page, but skips a line of the
            // stored observation — the 2026-08-16 T1 failure shape.
            observedExcerpt:
              'Observed demand grew 23 percent year over year. The sample covers 12 buyers.',
          }],
        }],
      }),
      /reads contiguously up to .* and then diverges: the excerpt continues .* where the observation reads/s,
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('claim evidence rejects traversal and symlinks in runtime observation artifacts', () => {
  const traversal = createReceiptBackedEvidence()
  try {
    fs.writeFileSync(traversal.receiptPath, JSON.stringify({
      ...traversal.receipt,
      contentRelativePath: 'browser-content/../outside.txt',
    }))
    assert.throws(() => validateReceiptBackedEvidence(traversal), /contentRelativePath is unsafe/)
  } finally {
    fs.rmSync(traversal.workspacePath, { recursive: true, force: true })
  }

  const linked = createReceiptBackedEvidence()
  try {
    const targetPath = path.join(
      path.dirname(linked.contentPath),
      'target.md',
    )
    fs.renameSync(linked.contentPath, targetPath)
    fs.symlinkSync(targetPath, linked.contentPath)
    assert.throws(() => validateReceiptBackedEvidence(linked), /symbolic links/)
  } finally {
    fs.rmSync(linked.workspacePath, { recursive: true, force: true })
  }
})

test('approved execution limits and one absolute deadline constrain the research run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-deadline-'))
  try {
    fs.mkdirSync(path.join(dir, 'research'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'research', 'plan.json'), JSON.stringify(researchPlan()))
    fs.writeFileSync(path.join(dir, 'research', 'runtime-limits.json'), JSON.stringify({
      schemaVersion: 1,
      planId: 'plan-1',
      maxDurationMinutes: 20,
      startedAt: '2026-07-16T12:00:00.000Z',
      deadlineAt: '2026-07-16T12:20:00.000Z',
    }))

    assert.deepEqual(resolveDeepResearchExecutionLimits({
      assignmentPath: dir,
      planArtifact: 'research/plan.json',
    }), { maxConcurrency: 1, maxDurationMinutes: 20 })
    assert.deepEqual(resolveDeepResearchDeadline({
      assignmentPath: dir,
      planArtifact: 'research/plan.json',
      deadlineArtifact: 'research/runtime-limits.json',
      now: new Date('2026-07-16T12:05:00.000Z'),
    }), {
      startedAt: '2026-07-16T12:00:00.000Z',
      deadlineAt: '2026-07-16T12:20:00.000Z',
      remainingMs: 15 * 60_000,
      // Carried so a stage declaring only a deadline artifact can still
      // diagnose a declared timeout that can never fire.
      maxDurationMinutes: 20,
    })

    fs.writeFileSync(path.join(dir, 'research', 'runtime-limits.json'), JSON.stringify({
      schemaVersion: 1,
      planId: 'plan-1',
      maxDurationMinutes: 20,
      startedAt: '2026-07-16T12:00:00.000Z',
      deadlineAt: '2026-07-16T12:30:00.000Z',
    }))
    assert.throws(() => resolveDeepResearchDeadline({
      assignmentPath: dir,
      planArtifact: 'research/plan.json',
      deadlineArtifact: 'research/runtime-limits.json',
    }), /interval is invalid/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runtime quality validation prevents the critic from downgrading deterministic blockers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-quality-review-'))
  try {
    fs.mkdirSync(path.join(dir, 'research', 'quality'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'research', 'approved-plan.json'), JSON.stringify(researchPlan()))
    fs.writeFileSync(path.join(dir, 'research', 'quality', 'current-packet.json'), JSON.stringify({
      schemaVersion: 1,
      planId: 'plan-1',
      synthesis: { claims: [], sources: [] },
    }))
    const finding = {
      code: 'primary_source_missing',
      severity: 'blocking',
      message: 'The required primary source is missing.',
      taskIds: ['T1'],
      sectionIds: ['section-market'],
      claimIds: [],
      sourceIds: [],
    }
    const correction = {
      schemaVersion: 1,
      id: 'correction-primary-source',
      type: 'new_research',
      claimIds: [],
      taskIds: ['T1'],
      sectionIds: ['section-market'],
      question: 'Find the required primary source.',
      acceptanceCriteria: ['Provide directly observed primary evidence.'],
      impactScope: 'local',
    }
    fs.writeFileSync(path.join(dir, 'research', 'quality', 'deterministic-verdict.json'), JSON.stringify({
      schemaVersion: 1,
      verdictId: 'deterministic-zero',
      correctionWave: 0,
      decision: 'REVISE',
      findings: [finding],
      correctionRequests: [correction],
      reviewedAt: '2026-07-16T12:00:00.000Z',
    }))
    const criticApproval = JSON.stringify({
      schemaVersion: 1,
      verdictId: 'critic-zero',
      correctionWave: 0,
      decision: 'APPROVE',
      findings: [],
      correctionRequests: [],
      reviewedAt: '2026-07-16T12:01:00.000Z',
    })

    assert.throws(() => parseDeepResearchQualityReviewResult({
      text: criticApproval,
      assignmentPath: dir,
    }), /cannot approve while deterministic evidence blockers remain/)

    const authoritative = parseDeepResearchQualityReviewResult({
      text: JSON.stringify({
        ...JSON.parse(criticApproval),
        decision: 'REVISE',
        findings: [finding],
        correctionRequests: [correction],
      }),
      assignmentPath: dir,
    })
    assert.equal(authoritative.decision, 'REVISE')
    assert.deepEqual(authoritative.correctionRequests[0]?.taskIds, ['T1'])
    assert.match(authoritative.verdictId, /^authoritative-0-/)

    fs.mkdirSync(path.join(dir, 'research', 'corrections'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'research', 'corrections', 'current.json'),
      JSON.stringify({ wave: 1 }),
    )
    assert.throws(
      () => buildDeepResearchQualityReviewFailureVerdict({ assignmentPath: dir }),
      /stale for the current correction wave/,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runtime quality validation routes report-only corrections directly to synthesis', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-quality-resynthesis-'))
  try {
    fs.mkdirSync(path.join(dir, 'research', 'quality'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'research', 'approved-plan.json'), JSON.stringify(researchPlan()))
    fs.writeFileSync(path.join(dir, 'research', 'quality', 'current-packet.json'), JSON.stringify({
      schemaVersion: 1,
      planId: 'plan-1',
      requiredTaskIds: ['T1'],
      synthesis: {
        schemaVersion: 1,
        planId: 'plan-1',
        coverage: [],
        claims: [],
        sources: [],
        contradictions: [],
        unresolvedQuestions: [],
      },
      claimSourceMatrix: [],
    }))
    fs.writeFileSync(path.join(dir, 'research', 'quality', 'deterministic-verdict.json'), JSON.stringify({
      schemaVersion: 1,
      verdictId: 'deterministic-zero',
      correctionWave: 0,
      decision: 'APPROVE',
      findings: [],
      correctionRequests: [],
      reviewedAt: '2026-07-16T12:00:00.000Z',
    }))
    const authoritative = parseDeepResearchQualityReviewResult({
      assignmentPath: dir,
      text: JSON.stringify({
        schemaVersion: 1,
        verdictId: 'critic-zero',
        correctionWave: 0,
        decision: 'REVISE',
        correctionRoute: 'synthesis',
        findings: [{
          code: 'report_evidence_mismatch',
          severity: 'blocking',
          message: 'The report omits a material limitation present in the evidence packet.',
          taskIds: ['T1'],
          sectionIds: ['section-market'],
          claimIds: [],
          sourceIds: [],
        }],
        correctionRequests: [{
          schemaVersion: 1,
          id: 'rewrite-market-section',
          type: 'resynthesize',
          claimIds: [],
          taskIds: ['T1'],
          sectionIds: ['section-market'],
          acceptanceCriteria: ['State the limitation in the report.'],
          impactScope: 'local',
        }],
        reviewedAt: '2026-07-16T12:01:00.000Z',
      }),
    })

    assert.equal(authoritative.decision, 'REVISE')
    assert.equal(authoritative.correctionRoute, 'synthesis')
    assert.deepEqual(authoritative.correctionRequests.map((request) => request.type), [
      'resynthesize',
    ])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('targeted correction keeps approved dependency evidence without rescheduling that task', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-correction-dependency-'))
  try {
    const plan = dependentResearchPlan()
    fs.mkdirSync(path.join(dir, 'research', 'evidence', 'wave-0'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'research', 'quality'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'research', 'corrections'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'research', 'approved-plan.json'), JSON.stringify(plan))
    fs.writeFileSync(path.join(dir, 'research', 'evidence', 'wave-0', 'T1.json'), JSON.stringify({
      schemaVersion: 1,
      assignmentId: 'lane-market',
      taskId: 'T1',
      workerSpecHash: hashResearchValue(plan.workerSpecs[0]),
      question: requiredValue(plan.tasks[0], 'tests/unit/deep-research-pipeline-adapter.test.ts:1150').question,
      shortAnswer: 'Baseline demand increased in the directly observed period.',
      findings: [],
      sources: [],
      contradictions: [],
      unresolvedQuestions: [],
      stopReason: 'decision_useful',
    }))
    fs.writeFileSync(path.join(dir, 'research', 'evidence', 'wave-0', 'T2.json'), JSON.stringify({
      schemaVersion: 1,
      assignmentId: 'lane-decision',
      taskId: 'T2',
      workerSpecHash: hashResearchValue(plan.workerSpecs[1]),
      question: requiredValue(plan.tasks[1], 'tests/unit/deep-research-pipeline-adapter.test.ts:1163').question,
      shortAnswer: 'The prior decision-impact packet remains the correction baseline.',
      findings: [{
        schemaVersion: 1,
        claimId: 'claim-one',
        taskId: 'T2',
        sectionId: 'section-market',
        statement: 'The decision impact still needs direct support.',
        kind: 'uncertainty',
        evidenceStandard: 'single',
        sourceIds: [],
        evidenceLinks: [],
        confidence: 'low',
        status: 'unsupported',
        applicableScope: [],
      }],
      sources: [],
      contradictions: [],
      unresolvedQuestions: ['The supported decision impact remains unresolved.'],
      stopReason: 'insufficient_evidence',
    }))
    fs.writeFileSync(path.join(dir, 'research', 'evidence', 'current-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      correctionWave: 0,
      latestByTask: {
        T1: 'research/evidence/wave-0/T1.json',
        T2: 'research/evidence/wave-0/T2.json',
      },
    }))
    const correctionRequest = {
      schemaVersion: 1,
      id: 'correction-decision-impact',
      type: 'resynthesize',
      claimIds: ['claim-one'],
      taskIds: ['T2'],
      sectionIds: ['section-market'],
      question: 'Resolve the decision impact using the retained baseline.',
      acceptanceCriteria: ['Return a supported decision impact assessment.'],
      impactScope: 'local',
    }
    const sourceVerdict = {
      schemaVersion: 1,
      verdictId: 'authoritative-zero',
      correctionWave: 0,
      decision: 'REVISE',
      findings: [{
        code: 'claim_unsupported',
        severity: 'blocking',
        message: 'Decision impact is unsupported.',
        taskIds: ['T2'],
        sectionIds: ['section-market'],
        claimIds: ['claim-one'],
        sourceIds: [],
      }],
      correctionRequests: [correctionRequest],
      reviewedAt: '2026-07-16T12:10:00.000Z',
    }
    fs.writeFileSync(path.join(dir, 'research', 'quality', 'verdict-wave-0.json'), JSON.stringify(sourceVerdict))
    fs.writeFileSync(path.join(dir, 'research', 'corrections', 'current.json'), JSON.stringify({
      schemaVersion: 1,
      wave: 1,
      approvedPlanHash: plan.approvalHash,
      sourceVerdictPath: 'research/quality/verdict-wave-0.json',
      sourceVerdictHash: hashResearchValue(sourceVerdict),
      taskRequests: { T2: [correctionRequest] },
    }))
    const correctionTask: PlanTask = {
      id: 'T2',
      title: 'Assess decision impact',
      agent: 'web-researcher',
      status: 'pending',
      validate: false,
      dependsOn: [],
      gate: false,
      resultFile: 'research/evidence/wave-1/T2.json',
      sprintId: 'S1',
    }

    const overlay = resolveDeepResearchTaskOverlay({
      assignmentPath: dir,
      planArtifact: 'research/approved-plan.json',
      executablePlan: executablePlan(correctionTask),
      task: correctionTask,
    })

    assert.match(overlay.user, /Targeted Correction Wave/)
    assert.match(overlay.user, /Baseline demand increased/)
    assert.match(overlay.user, /Resolve the decision impact/)
    assert.match(overlay.user, /remove that claim and update coverage, conclusions/)
    assert.match(overlay.user, /Every factual component retained in a claim/)
    assert.match(overlay.user, /prior EvidencePacket below is the binding baseline/)
    assert.match(overlay.user, /Prior runtime-validated EvidencePacket/)
    assert.match(overlay.user, /decision-impact packet remains the correction baseline/)
    assert.match(overlay.user, /do not browse, re-observe sources, add duplicate source records/)
    assert.equal(overlay.minimumDispatchMs, 30_000)
    assert.equal(overlay.governedWebEvidenceMode, 'reuse-existing')
    assert.doesNotMatch(overlay.user, /research the baseline task again/i)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a source-verification correction wave is dispatched in the evidence-acquiring mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-correction-verify-source-'))
  try {
    const plan = researchPlan()
    fs.mkdirSync(path.join(dir, 'research', 'evidence', 'wave-1'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'research', 'quality'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'research', 'corrections'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'research', 'approved-plan.json'), JSON.stringify(plan))
    const correctionRequest = {
      schemaVersion: 1,
      id: 'correction-verify-demand-source',
      type: 'verify_source',
      claimIds: ['claim-one'],
      taskIds: ['T1'],
      sectionIds: ['section-market'],
      question: 'Re-observe the demand source that could not be verified.',
      acceptanceCriteria: ['Bind every retained claim to a re-observed source.'],
      impactScope: 'local',
    }
    const sourceVerdict = {
      schemaVersion: 1,
      verdictId: 'verify-source-zero',
      correctionWave: 0,
      decision: 'REVISE',
      findings: [{
        code: 'source_unobserved',
        severity: 'blocking',
        message: 'The demand source was never observed.',
        taskIds: ['T1'],
        sectionIds: ['section-market'],
        claimIds: ['claim-one'],
        sourceIds: ['source-one'],
      }],
      correctionRequests: [correctionRequest],
      reviewedAt: '2026-07-16T12:10:00.000Z',
    }
    fs.writeFileSync(path.join(dir, 'research', 'quality', 'verdict-wave-0.json'), JSON.stringify(sourceVerdict))
    fs.writeFileSync(path.join(dir, 'research', 'corrections', 'current.json'), JSON.stringify({
      schemaVersion: 1,
      wave: 1,
      approvedPlanHash: plan.approvalHash,
      sourceVerdictPath: 'research/quality/verdict-wave-0.json',
      sourceVerdictHash: hashResearchValue(sourceVerdict),
      taskRequests: { T1: [correctionRequest] },
    }))
    const correctionTask: PlanTask = {
      ...executableTask(),
      resultFile: 'research/evidence/wave-1/T1.json',
    }

    const overlay = resolveDeepResearchTaskOverlay({
      assignmentPath: dir,
      planArtifact: 'research/approved-plan.json',
      executablePlan: executablePlan(correctionTask),
      task: correctionTask,
    })

    assert.match(overlay.user, /Targeted Correction Wave/)
    assert.equal(overlay.governedWebEvidenceMode, 'acquire')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('same-wave correction dependency uses the newly completed packet instead of the prior manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-correction-current-dependency-'))
  try {
    const plan = dependentResearchPlan()
    fs.mkdirSync(path.join(dir, 'research', 'evidence', 'wave-0'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'research', 'evidence', 'wave-1'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'research', 'approved-plan.json'), JSON.stringify(plan))
    const workerSpec = plan.workerSpecs.find((candidate) => candidate.id === 'worker-T1')!
    const packet = (shortAnswer: string) => ({
      schemaVersion: 1,
      assignmentId: workerSpec.laneId,
      taskId: 'T1',
      workerSpecHash: hashResearchValue(workerSpec),
      question: workerSpec.question,
      shortAnswer,
      findings: [],
      sources: [],
      contradictions: [],
      unresolvedQuestions: [],
      stopReason: 'decision_useful',
    })
    fs.writeFileSync(
      path.join(dir, 'research', 'evidence', 'wave-0', 'T1.json'),
      JSON.stringify(packet('OLD wave zero evidence')),
    )
    fs.writeFileSync(
      path.join(dir, 'research', 'evidence', 'wave-1', 'T1.json'),
      JSON.stringify(packet('NEW corrected wave one evidence')),
    )
    fs.writeFileSync(path.join(dir, 'research', 'evidence', 'current-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      correctionWave: 0,
      latestByTask: { T1: 'research/evidence/wave-0/T1.json' },
    }))
    const dependencyTask: PlanTask = {
      id: 'T1',
      title: 'Measure demand',
      agent: 'web-researcher',
      status: 'completed',
      validate: false,
      dependsOn: [],
      gate: false,
      resultFile: 'research/evidence/wave-1/T1.json',
      sprintId: 'S1',
    }
    const dependentTask: PlanTask = {
      id: 'T2',
      title: 'Assess decision impact',
      agent: 'web-researcher',
      status: 'pending',
      validate: false,
      dependsOn: ['T1'],
      gate: false,
      resultFile: 'research/evidence/wave-1/T2.json',
      sprintId: 'S1',
    }

    const overlay = resolveDeepResearchTaskOverlay({
      assignmentPath: dir,
      planArtifact: 'research/approved-plan.json',
      executablePlan: {
        title: 'Research',
        status: 'executing',
        sprints: [{ id: 'S1', name: 'Research', taskIds: ['T1', 'T2'], gateTaskId: null }],
        tasks: new Map([
          ['T1', dependencyTask],
          ['T2', dependentTask],
        ]),
      },
      task: dependentTask,
    })

    assert.match(overlay.user, /NEW corrected wave one evidence/)
    assert.doesNotMatch(overlay.user, /OLD wave zero evidence/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── Quality verdict transport recovery ──────────────────────────────────────

/**
 * A critic assignment whose plan, quality packet, and deterministic verdict all
 * approve, so the only thing a verdict can fail on is its own contract.
 */
function makeApprovingQualityAssignment(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-verdict-transport-'))
  fs.mkdirSync(path.join(dir, 'research', 'quality'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'research', 'approved-plan.json'),
    JSON.stringify(researchPlan()),
  )
  fs.writeFileSync(
    path.join(dir, 'research', 'quality', 'current-packet.json'),
    JSON.stringify({
      schemaVersion: 1,
      planId: 'plan-1',
      synthesis: { claims: [], sources: [] },
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'research', 'quality', 'deterministic-verdict.json'),
    JSON.stringify({
      schemaVersion: 1,
      verdictId: 'deterministic-zero',
      correctionWave: 0,
      decision: 'APPROVE',
      findings: [],
      correctionRequests: [],
      reviewedAt: '2026-07-16T12:00:00.000Z',
    }),
  )
  return dir
}

function makeApprovalVerdict(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    verdictId: 'critic-zero',
    correctionWave: 0,
    decision: 'APPROVE',
    findings: [],
    correctionRequests: [],
    reviewedAt: '2026-07-16T12:01:00.000Z',
    ...overrides,
  }
}

test('one valid quality verdict inside a Markdown fence is recovered', () => {
  const dir = makeApprovingQualityAssignment()
  try {
    const verdict = parseDeepResearchQualityReviewResult({
      text: `\`\`\`json\n${JSON.stringify(makeApprovalVerdict())}\n\`\`\``,
      assignmentPath: dir,
    })

    assert.equal(verdict.decision, 'APPROVE')
    assert.equal(verdict.correctionWave, 0)
    assert.equal(verdict.reviewedAt, '2026-07-16T12:01:00.000Z')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('one valid quality verdict wrapped in prose is recovered', () => {
  const dir = makeApprovingQualityAssignment()
  try {
    const verdict = parseDeepResearchQualityReviewResult({
      text:
        'Here is my audit of the research package.\n\n' +
        `${JSON.stringify(makeApprovalVerdict())}\n\n` +
        'Let me know if you need more detail.',
      assignmentPath: dir,
    })

    assert.equal(verdict.decision, 'APPROVE')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('quality verdict recovery keeps braces and escaped quotes inside string fields', () => {
  const dir = makeApprovingQualityAssignment()
  try {
    const message =
      'The claim quotes "{\\"unbalanced\\": true" and is still unsupported }'
    const revision = makeApprovalVerdict({
      verdictId: 'critic-revise-zero',
      decision: 'REVISE',
      findings: [{
        code: 'claim_unsupported',
        severity: 'blocking',
        message,
        taskIds: ['T1'],
        sectionIds: ['section-market'],
        claimIds: [],
        sourceIds: [],
      }],
      correctionRequests: [{
        schemaVersion: 1,
        id: 'correction-unsupported-claim',
        type: 'new_research',
        claimIds: [],
        taskIds: ['T1'],
        sectionIds: ['section-market'],
        acceptanceCriteria: ['Observe a primary source that supports the claim.'],
        impactScope: 'local',
      }],
      correctionRoute: 'research',
    })

    const verdict = parseDeepResearchQualityReviewResult({
      text: `\`\`\`json\n${JSON.stringify(revision)}\n\`\`\``,
      assignmentPath: dir,
    })

    assert.equal(verdict.decision, 'REVISE')
    assert.equal(verdict.findings[0]?.message, message)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('two distinct valid quality verdicts are rejected as ambiguous', () => {
  const dir = makeApprovingQualityAssignment()
  try {
    const first = JSON.stringify(makeApprovalVerdict())
    const second = JSON.stringify(makeApprovalVerdict({ verdictId: 'critic-zero-b' }))

    assert.throws(
      () => parseDeepResearchQualityReviewResult({
        text: `\`\`\`json\n${first}\n\`\`\`\n\n\`\`\`json\n${second}\n\`\`\``,
        assignmentPath: dir,
      }),
      /exactly one/i,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a fenced but semantically invalid quality verdict is still rejected', () => {
  const dir = makeApprovingQualityAssignment()
  try {
    const invalid = makeApprovalVerdict({
      findings: [{
        code: 'claim_unsupported',
        severity: 'error',
        message: 'The claim is unsupported.',
        taskIds: ['T1'],
        sectionIds: ['section-market'],
        claimIds: [],
        sourceIds: [],
      }],
    })

    assert.throws(() => parseDeepResearchQualityReviewResult({
      text: `\`\`\`json\n${JSON.stringify(invalid)}\n\`\`\``,
      assignmentPath: dir,
    }))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a quality response larger than 64 KiB is rejected before candidate recovery', () => {
  const dir = makeApprovingQualityAssignment()
  try {
    const padding = 'x'.repeat(64 * 1024)
    assert.throws(
      () => parseDeepResearchQualityReviewResult({
        text: `${padding}\n\`\`\`json\n${JSON.stringify(makeApprovalVerdict())}\n\`\`\``,
        assignmentPath: dir,
      }),
      /too large/i,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a malformed quality response is still rejected', () => {
  const dir = makeApprovingQualityAssignment()
  try {
    assert.throws(
      () => parseDeepResearchQualityReviewResult({
        text: '```json\n{"decision":"APPROVE"\n```',
        assignmentPath: dir,
      }),
      /QualityVerdict/,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('identical verdicts spelled two ways count as one answer', () => {
  const dir = makeApprovingQualityAssignment()
  try {
    const verdict = makeApprovalVerdict()

    // Same audit, two transports and two spellings: compact inside a fence and
    // pretty-printed in the prose beside it. Raw text differs; the answer does not.
    const recovered = parseDeepResearchQualityReviewResult({
      text:
        `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`\n\n` +
        `For reference, the same verdict again:\n${JSON.stringify(verdict, null, 2)}`,
      assignmentPath: dir,
    })

    assert.equal(recovered.decision, 'APPROVE')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an assignment-invalid candidate does not hide the one valid verdict', () => {
  const dir = makeApprovingQualityAssignment()
  try {
    // Contract-valid but not valid for this assignment: T9 is not an approved task.
    const unknownTask = makeApprovalVerdict({
      verdictId: 'critic-unknown-task',
      decision: 'REVISE',
      findings: [{
        code: 'task_missing',
        severity: 'blocking',
        message: 'A task is missing.',
        taskIds: ['T9'],
        sectionIds: [],
        claimIds: [],
        sourceIds: [],
      }],
      correctionRequests: [{
        schemaVersion: 1,
        id: 'correction-unknown-task',
        type: 'new_research',
        claimIds: [],
        taskIds: ['T9'],
        sectionIds: [],
        acceptanceCriteria: ['Answer the missing task.'],
        impactScope: 'local',
      }],
      correctionRoute: 'research',
    })

    const recovered = parseDeepResearchQualityReviewResult({
      text:
        `\`\`\`json\n${JSON.stringify(unknownTask)}\n\`\`\`\n\n` +
        `\`\`\`json\n${JSON.stringify(makeApprovalVerdict())}\n\`\`\``,
      assignmentPath: dir,
    })

    assert.equal(recovered.decision, 'APPROVE')
    assert.equal(recovered.verdictId.startsWith('authoritative-'), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an assignment-invalid verdict alone reports its own validation failure', () => {
  const dir = makeApprovingQualityAssignment()
  try {
    const unknownSection = makeApprovalVerdict({
      decision: 'ESCALATE',
      findings: [{
        code: 'scope_mismatch',
        severity: 'blocking',
        message: 'The section is out of scope.',
        taskIds: ['T1'],
        sectionIds: ['section-not-in-plan'],
        claimIds: [],
        sourceIds: [],
      }],
    })

    assert.throws(
      () => parseDeepResearchQualityReviewResult({
        text: `\`\`\`json\n${JSON.stringify(unknownSection)}\n\`\`\``,
        assignmentPath: dir,
      }),
      /unknown research section/,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the quality response limit is measured in UTF-8 bytes, not characters', () => {
  const dir = makeApprovingQualityAssignment()
  try {
    const limit = 64 * 1024
    const fenced = (padding: string): string =>
      `${padding}\n\`\`\`json\n${JSON.stringify(makeApprovalVerdict())}\n\`\`\``

    // Euro signs are three UTF-8 bytes each, so this response is well under the
    // limit by character count and over it by the measure that matters.
    const multibyte = fenced('€'.repeat(limit / 2))
    assert.ok(multibyte.length < limit, 'the multibyte case must be short in characters')
    assert.ok(Buffer.byteLength(multibyte, 'utf8') > limit)
    assert.throws(
      () => parseDeepResearchQualityReviewResult({ text: multibyte, assignmentPath: dir }),
      /too large/i,
    )

    // Exactly at the limit is still a response the critic is allowed to send.
    const atLimit = fenced('')
    const exact = fenced('a'.repeat(limit - Buffer.byteLength(atLimit, 'utf8')))
    assert.equal(Buffer.byteLength(exact, 'utf8'), limit)
    assert.equal(
      parseDeepResearchQualityReviewResult({ text: exact, assignmentPath: dir }).decision,
      'APPROVE',
    )

    // One byte past it is not.
    assert.throws(
      () => parseDeepResearchQualityReviewResult({ text: `${exact}a`, assignmentPath: dir }),
      /too large/i,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the strict provider wire shape is accepted and its empty requirementIds survive', () => {
  const dir = makeApprovingQualityAssignment()
  try {
    // Exactly what the provider schema asks for: every property present, with
    // neutral values where the canonical form would omit the key.
    const wireVerdict = {
      schemaVersion: 1,
      verdictId: 'critic-wire-zero',
      correctionWave: 0,
      decision: 'REVISE',
      findings: [{
        code: 'claim_unsupported',
        severity: 'blocking',
        message: 'The launch claim is unsupported.',
        taskIds: ['T1'],
        sectionIds: ['section-market'],
        claimIds: [],
        sourceIds: [],
        requirementIds: [],
      }],
      correctionRequests: [{
        schemaVersion: 1,
        id: 'correction-wire',
        type: 'new_research',
        claimIds: [],
        taskIds: ['T1'],
        sectionIds: ['section-market'],
        requirementIds: [],
        question: '',
        acceptanceCriteria: ['Observe a primary source that supports the claim.'],
        impactScope: 'local',
      }],
      correctionRoute: 'research',
      reviewedAt: '2026-07-16T12:01:00.000Z',
    }

    const verdict = parseDeepResearchQualityReviewResult({
      text: `\`\`\`json\n${JSON.stringify(wireVerdict)}\n\`\`\``,
      assignmentPath: dir,
    })

    assert.equal(verdict.decision, 'REVISE')
    assert.equal(verdict.correctionRoute, 'research')
    // An empty question cannot be a question, so it is absent. An empty
    // requirement list is an answer, so it stays.
    assert.equal(verdict.correctionRequests[0]?.question, undefined)
    assert.deepEqual(verdict.correctionRequests[0]?.requirementIds, [])
    assert.deepEqual(verdict.findings[0]?.requirementIds, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Version 5 receipts at the runtime reader.
 *
 * The reader validates a receipt it did not write, against an exact allowed-key
 * set. A field the writer now emits and the reader does not know about is not a
 * harmless extra: it makes a valid stored receipt unreadable, which fails the
 * research turn that depends on it.
 */
test('a version 5 receipt carrying challenge and runtime metadata still reads', () => {
  const fixture = createReceiptBackedEvidence()
  try {
    fs.writeFileSync(fixture.receiptPath, JSON.stringify({
      ...fixture.receipt,
      schemaVersion: 5,
      attempts: [
        {
          method: 'direct-http',
          outcome: 'challenge',
          startedAt: '2026-07-16T11:59:58.000Z',
          durationMs: 11,
          challengeType: 'browser-verification',
        },
        {
          ...fixture.receipt.attempts[0],
          browserRuntime: {
            driver: 'puppeteer-core',
            driverVersion: '25.3.0',
            browserVersion: 'Chrome/151.0.0.0',
            mode: 'headless',
            launchProfile: 'stock',
          },
          proxyRuntime: {
            provider: 'webshare',
            mode: 'rotating',
            tier: 'unknown',
          },
        },
      ],
    }))

    const result = validateReceiptBackedEvidence(fixture)

    assert.equal(result.sources[0]?.status, 'usable')
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('a version 5 receipt with malformed attempt metadata is refused', () => {
  const malformed = [
    { why: 'an unknown challenge subtype', challengeType: 'definitely-not-a-wall' },
    { why: 'a browser runtime that is not an object', browserRuntime: 'stock' },
    {
      why: 'a browser runtime naming another driver',
      browserRuntime: {
        driver: 'playwright',
        driverVersion: '1.0.0',
        browserVersion: 'Chrome/151.0.0.0',
        mode: 'headless',
        launchProfile: 'stock',
      },
    },
    {
      why: 'a proxy runtime naming an unknown tier',
      proxyRuntime: { provider: 'webshare', mode: 'rotating', tier: 'mobile' },
    },
    // The metadata is non-secret by construction, and the guarded object is the
    // one that is kept, so an extra key would ride into the receipt with it.
    {
      why: 'a browser runtime carrying an unexpected key',
      browserRuntime: {
        driver: 'puppeteer-core',
        driverVersion: '25.3.0',
        browserVersion: 'Chrome/151.0.0.0',
        mode: 'headless',
        launchProfile: 'stock',
        unexpectedField: 'unexpected-value',
      },
    },
    {
      why: 'a proxy runtime carrying an endpoint',
      proxyRuntime: {
        provider: 'webshare',
        mode: 'rotating',
        tier: 'unknown',
        endpoint: 'redacted',
      },
    },
  ] as const

  for (const entry of malformed) {
    const fixture = createReceiptBackedEvidence()
    try {
      const { why: _why, ...overrides } = entry
      fs.writeFileSync(fixture.receiptPath, JSON.stringify({
        ...fixture.receipt,
        schemaVersion: 5,
        attempts: [{ ...fixture.receipt.attempts[0], ...overrides }],
      }))

      assert.throws(
        () => validateReceiptBackedEvidence(fixture),
        /acquisition attempts are invalid/u,
        entry.why,
      )
    } finally {
      fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
    }
  }
})

test('a version 4 receipt without the new metadata still reads', () => {
  const fixture = createReceiptBackedEvidence()
  try {
    fs.writeFileSync(fixture.receiptPath, JSON.stringify({
      ...fixture.receipt,
      schemaVersion: 4,
    }))

    assert.equal(
      validateReceiptBackedEvidence(fixture).sources[0]?.status,
      'usable',
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})
