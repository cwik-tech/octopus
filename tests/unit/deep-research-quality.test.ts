import { whenDefined } from '../../core/optional-properties.js'
import { requiredValue } from '../../core/required-value.js'
import assert from 'node:assert/strict'
import test from 'node:test'

import { DEEP_RESEARCH_SCHEMA_VERSION, type EvidencePacket, type ResearchPlan } from '../../contracts/deep-research.js'
import {
  buildResearchQualityPacket,
  buildResearchSynthesisPacket,
  evaluateResearchQuality,
  mergeQualityFindings,
  routeQualityVerdict,
} from '../../domains/deep-research/deep-research-quality.js'
import { createResearchWorkerSpec, hashResearchValue } from '../../domains/deep-research/deep-research-worker-policy.js'
import {
  TEST_TIME,
  makeEvidencePacket,
  makeLegacyEvidencePacket,
  makeLegacyWorkerSpec,
  makePlan,
  makeSource,
  makeWorkerSpec,
} from './deep-research-fixtures.js'

test('complete independently sourced research produces deterministic approval packets', () => {
  const plan = makePlan()
  const evidence = makeEvidencePacket()
  const synthesis = buildResearchSynthesisPacket({ plan, evidencePackets: [evidence] })
  const qualityPacket = buildResearchQualityPacket({ plan, evidencePackets: [evidence] })
  const verdict = evaluateResearchQuality({
    plan,
    evidencePackets: [evidence],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })

  assert.equal(synthesis.coverage[0]?.isCovered, true)
  assert.deepEqual(synthesis.claims.map((claim) => claim.claimId), ['task-one--claim-one'])
  assert.equal(qualityPacket.claimSourceMatrix[0]?.independentPublisherCount, 2)
  assert.equal(verdict.decision, 'APPROVE')
  assert.deepEqual(verdict.findings, [])
  assert.deepEqual(routeQualityVerdict(verdict), { action: 'publish' })
})

test('structured coverage passes without repeating requirement labels in prose', () => {
  const workerSpec = makeWorkerSpec({
    coverageRequirements: [{
      schemaVersion: 2,
      id: 'venue-name',
      label: 'Venue name',
      kind: 'fact',
      validation: 'claim_support',
      required: true,
    }],
  })
  const packet = makeEvidencePacket({
    workerSpecHash: hashResearchValue(workerSpec),
    shortAnswer: 'Milk & Froth qualifies for the requested comparison.',
    findings: [{
      ...makeEvidencePacket().findings[0]!,
      statement: 'Milk & Froth operates at the observed downtown location.',
      applicableScope: ['Downtown eligibility'],
    }],
    coverage: [{
      schemaVersion: 2,
      requirementId: 'venue-name',
      status: 'satisfied',
      claimIds: ['claim-one'],
      sourceIds: ['source-one', 'source-two'],
      value: 'Milk & Froth',
    }],
  })

  const verdict = evaluateResearchQuality({
    plan: makePlan({ workerSpecs: [workerSpec] }),
    evidencePackets: [packet],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })

  assert.equal(verdict.decision, 'APPROVE')
  assert.equal(packet.shortAnswer.includes('Venue name'), false)
})

test('legacy requirement labels use explicit claim scope metadata instead of prose matching', () => {
  const workerSpec = makeLegacyWorkerSpec(['Venue name', 'Street address'])
  const packet = makeLegacyEvidencePacket({
    workerSpecHash: hashResearchValue(workerSpec),
    shortAnswer: 'Milk & Froth qualifies at 535 Griswold Street.',
    findings: [{
      ...requiredValue(makeEvidencePacket().findings[0], 'primary evidence finding'),
      statement: 'Milk & Froth qualifies at 535 Griswold Street.',
      applicableScope: ['Venue name; Street address'],
    }],
  })

  const verdict = evaluateResearchQuality({
    plan: makePlan({ workerSpecs: [workerSpec] }),
    evidencePackets: [packet],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })

  assert.equal(verdict.decision, 'APPROVE')
})

test('quality findings merge by stable root-cause identity instead of message text', () => {
  const shared = {
    code: 'unresolved_question' as const,
    severity: 'warning' as const,
    taskIds: ['task-one'],
    sectionIds: ['section-one'],
    claimIds: [],
    sourceIds: [],
  }
  const merged = mergeQualityFindings([
    { ...shared, message: 'The primary menu was unavailable.' },
    { ...shared, message: 'The primary menu was unavailable' },
  ])

  assert.equal(merged.length, 1)
  assert.match(merged[0]!.message, /primary menu/)

  const deterministic = 'Non-blocking open questions remain: benchmark evidence is unavailable.'
  const critic = `No product winner is supported. ${deterministic}`
  const contained = mergeQualityFindings([
    { ...shared, message: deterministic },
    { ...shared, message: critic },
  ])
  assert.equal(contained[0]?.message, critic)
})

test('missing tasks create targeted correction work instead of rerunning healthy lanes', () => {
  const verdict = evaluateResearchQuality({
    plan: makePlan(),
    evidencePackets: [],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })
  assert.equal(verdict.decision, 'REVISE')
  assert.equal(verdict.correctionRoute, 'research')
  assert.deepEqual(verdict.findings.map((finding) => finding.code), ['task_missing'])
  assert.deepEqual(verdict.correctionRequests[0]?.taskIds, ['task-one'])
  assert.equal(verdict.correctionRequests[0]?.impactScope, 'local')
  assert.deepEqual(routeQualityVerdict(verdict), {
    action: 'correct',
    requests: verdict.correctionRequests,
    nextWave: 1,
  })
})

test('a broad regional lane cannot satisfy a separately required locality', () => {
  // Falsification check for the geographic-lane invariant. Requirement
  // coverage is task-scoped, so a regional lane's claims — even ones whose
  // prose names the core city — leave the city lane's own requirement
  // unsatisfied and route correction work back to that lane.
  const cityWorker = makeWorkerSpec({
    id: 'worker-city',
    laneId: 'lane-city',
    sectionId: 'section-city',
    question: 'What are core-city acquisition economics?',
    coverageRequirements: [{
      schemaVersion: 2,
      id: 'city-cac',
      label: 'Core-city CAC',
      kind: 'quantitative_metric',
      validation: 'quantitative_value',
      required: true,
    }],
  })
  const regionWorker = makeWorkerSpec({
    id: 'worker-region',
    laneId: 'lane-region',
    sectionId: 'section-region',
    question: 'What are surrounding-region acquisition economics?',
    coverageRequirements: [{
      schemaVersion: 2,
      id: 'region-cac',
      label: 'Surrounding-region CAC',
      kind: 'quantitative_metric',
      validation: 'quantitative_value',
      required: true,
    }],
  })
  const plan = makePlan({
    sections: [
      {
        schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
        id: 'section-city',
        title: 'Core city',
        objective: 'Core-city acquisition economics.',
        taskIds: ['task-city'],
      },
      {
        schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
        id: 'section-region',
        title: 'Surrounding region',
        objective: 'Surrounding-region acquisition economics.',
        taskIds: ['task-region'],
      },
    ],
    tasks: [
      {
        schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
        id: 'task-city',
        sectionId: 'section-city',
        title: 'Core city economics',
        question: cityWorker.question,
        purpose: 'evidence_acquisition',
        workerSpecId: cityWorker.id,
        dependsOn: [],
        correctionWave: 0,
      },
      {
        schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
        id: 'task-region',
        sectionId: 'section-region',
        title: 'Regional economics',
        question: regionWorker.question,
        purpose: 'evidence_acquisition',
        workerSpecId: regionWorker.id,
        dependsOn: [],
        correctionWave: 0,
      },
    ],
    workerSpecs: [cityWorker, regionWorker],
    expectedPeakWorkers: 2,
  })

  // Only the regional lane reported, and its claim explicitly names the metro
  // area including the core city — the aggregate result a planner might expect
  // to cover both.
  // The regional lane is independently complete on its own terms: two
  // publishers, both observed, both supporting its claim. Nothing about it is
  // deficient, which is what makes the core-city lane's failure attributable
  // to scope rather than to a thin fixture.
  const regionalSources = [
    makeSource({
      assignmentId: 'lane-region',
      sourceId: 'source-region-primary',
      canonicalUrl: 'https://example.com/metro-report',
      publisher: 'Metro Research',
      independenceKey: 'metro-research',
    }),
    makeSource({
      assignmentId: 'lane-region',
      sourceId: 'source-region-independent',
      canonicalUrl: 'https://independent.example.org/metro-benchmark',
      publisher: 'Independent Metro Benchmark',
      independenceKey: 'independent-metro-benchmark',
      sourceType: 'industry',
      contentSha256: 'e'.repeat(64),
    }),
  ]
  const regionalSourceIds = regionalSources.map((source) => source.sourceId)
  const regionalPacket = makeEvidencePacket({
    assignmentId: 'lane-region',
    taskId: 'task-region',
    workerSpecHash: hashResearchValue(regionWorker),
    question: regionWorker.question,
    sources: regionalSources,
    findings: [{
      schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
      claimId: 'claim-region',
      taskId: 'task-region',
      sectionId: 'section-region',
      statement: 'Metro-wide CAC, including the core city, averages $140.',
      kind: 'fact',
      evidenceStandard: 'independent_corroboration',
      sourceIds: regionalSourceIds,
      evidenceLinks: regionalSources.map((source) => ({
        sourceId: source.sourceId,
        observationReceiptId: requiredValue(source.observationReceiptId),
        observedExcerpt: 'Metro-wide CAC averages $140 including the core city.',
        locator: 'Table 2',
        relationship: 'supports' as const,
      })),
      confidence: 'high',
      status: 'supported',
      applicableScope: ['Metro area including the core city'],
    }],
    coverage: [{
      schemaVersion: 2,
      requirementId: 'region-cac',
      status: 'satisfied',
      claimIds: ['claim-region'],
      sourceIds: regionalSourceIds,
      value: '$140',
      unit: 'USD per acquired customer',
      asOf: TEST_TIME,
      scope: ['Metro area including the core city'],
    }],
  })

  const synthesis = buildResearchSynthesisPacket({
    plan,
    evidencePackets: [regionalPacket],
  })
  const cityCoverage = synthesis.coverage.find(
    (entry) => entry.taskId === 'task-city',
  )
  assert.ok(cityCoverage, 'the plan lost its core-city lane')
  assert.equal(cityCoverage.isCovered, false)
  assert.deepEqual(cityCoverage.claimIds, [])

  const verdict = evaluateResearchQuality({
    plan,
    evidencePackets: [regionalPacket],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })
  assert.equal(verdict.decision, 'REVISE')
  assert.deepEqual(
    verdict.correctionRequests.flatMap((request) => request.taskIds),
    ['task-city'],
    'correction did not target exactly the unsatisfied core-city lane',
  )
})

test('search-only records cannot masquerade as claim evidence', () => {
  const searchSource = makeSource({
    accessMethod: 'web.search',
    status: 'usable',
  })
  assert.throws(() => evaluateResearchQuality({
    plan: makePlan(),
    evidencePackets: [makeEvidencePacket({
      sources: [searchSource],
      findings: [{
        ...makeEvidencePacket().findings[0]!,
        sourceIds: [searchSource.sourceId],
        evidenceLinks: [{
          sourceId: searchSource.sourceId,
          observationReceiptId: 'invented-receipt',
          observedExcerpt: 'A search result snippet.',
          locator: 'Search result',
          relationship: 'supports',
        }],
      }],
    })],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  }), /search snippets are not evidence/)
})

test('corroborated claims require distinct runtime-verified hosts, not merely two URLs', () => {
  const sources = [
    makeSource(),
    makeSource({
      sourceId: 'source-two',
      canonicalUrl: 'https://example.com/copied-report',
      contentSha256: 'b'.repeat(64),
    }),
  ]
  const packet = makeEvidencePacket({ sources })
  const verdict = evaluateResearchQuality({
    plan: makePlan(),
    evidencePackets: [packet],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })
  assert.ok(verdict.findings.some((finding) => finding.code === 'source_not_independent'))
  assert.ok(
    verdict.correctionRequests.some(
      (request) => request.type === 'cross_verify',
    ),
  )
})

test('the third negative quality result escalates instead of creating a third correction wave', () => {
  const verdict = evaluateResearchQuality({
    plan: makePlan(),
    evidencePackets: [],
    correctionWave: 2,
    reviewedAt: TEST_TIME,
  })
  assert.equal(verdict.decision, 'ESCALATE')
  assert.deepEqual(verdict.correctionRequests, [])
  assert.deepEqual(routeQualityVerdict(verdict), {
    action: 'escalate',
    findings: verdict.findings,
  })
})

test('stale or cross-overlay evidence is rejected before synthesis', () => {
  assert.throws(() => buildResearchSynthesisPacket({
    plan: makePlan(),
    evidencePackets: [makeEvidencePacket({ workerSpecHash: 'f'.repeat(64) })],
  }), /does not match its approved worker specification/)
})

test('minor unresolved questions remain visible warnings without forcing wasteful correction work', () => {
  const packet = makeEvidencePacket({
    unresolvedQuestions: ['Which attribution window applies?'],
  })
  const verdict = evaluateResearchQuality({
    plan: makePlan(),
    evidencePackets: [packet],
    correctionWave: 1,
    reviewedAt: TEST_TIME,
  })
  assert.equal(verdict.decision, 'APPROVE')
  assert.deepEqual(verdict.correctionRequests, [])
  assert.deepEqual(verdict.findings.map(({ code, severity }) => ({ code, severity })), [{
    code: 'unresolved_question',
    severity: 'warning',
  }])
  assert.equal(routeQualityVerdict(verdict).action, 'publish')
})

test('explicitly insufficient evidence remains a material targeted blocker', () => {
  const verdict = evaluateResearchQuality({
    plan: makePlan(),
    evidencePackets: [makeEvidencePacket({
      unresolvedQuestions: ['Which attribution window applies?'],
      stopReason: 'insufficient_evidence',
    })],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })

  assert.equal(verdict.decision, 'REVISE')
  assert.ok(verdict.findings.some(({ code, severity }) => code === 'task_not_answered' && severity === 'blocking'))
  assert.ok(verdict.correctionRequests.some((request) => request.taskIds.includes('task-one')))
})

test('missing structured coverage and empty task answers are deterministic blockers', () => {
  const verdict = evaluateResearchQuality({
    plan: makePlan(),
    evidencePackets: [makeEvidencePacket({
      shortAnswer: '',
      findings: [],
    })],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })
  const codes = new Set(verdict.findings.map((finding) => finding.code))

  assert.equal(verdict.decision, 'REVISE')
  assert.ok(codes.has('task_not_answered'))
  assert.ok(codes.has('required_coverage_missing'))
  assert.ok(verdict.correctionRequests.some((request) =>
    request.type === 'restructure_packet',
  ))
})

test('explicitly declared authority source types remain binding requirements', () => {
  const workerSpec = makeWorkerSpec({
    sourceRequirements: {
      preferredTypes: ['primary', 'regulatory'],
      requiredAuthorityTypes: ['regulatory'],
      queryHints: [],
    },
  })
  const verdict = evaluateResearchQuality({
    plan: makePlan({ workerSpecs: [workerSpec] }),
    evidencePackets: [makeEvidencePacket({
      workerSpecHash: hashResearchValue(workerSpec),
    })],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })

  assert.equal(verdict.decision, 'REVISE')
  assert.ok(verdict.findings.some((finding) =>
    finding.code === 'required_authority_missing' &&
    finding.message.includes('regulatory'),
  ))
})

test('source-authority coverage accepts the authority types approved in the worker specification', () => {
  const workerSpec = makeWorkerSpec({
    sourceRequirements: {
      preferredTypes: ['primary', 'secondary'],
      requiredAuthorityTypes: ['secondary'],
      queryHints: [],
    },
    coverageRequirements: [{
      schemaVersion: 2,
      id: 'tourist-authority',
      label: 'Independent tourist authority',
      kind: 'source_authority',
      validation: 'source_authority',
      required: true,
    }],
  })
  const sources = [
    makeSource(),
    makeSource({
      sourceId: 'source-two',
      canonicalUrl: 'https://travel.example.org/guide',
      sourceType: 'secondary',
      contentSha256: 'b'.repeat(64),
    }),
  ]
  const packet = makeEvidencePacket({
    workerSpecHash: hashResearchValue(workerSpec),
    sources,
    coverage: [{
      schemaVersion: 2,
      requirementId: 'tourist-authority',
      status: 'satisfied',
      claimIds: ['claim-one'],
      sourceIds: ['source-two'],
      value: 'Independent destination guidance',
    }],
  })

  const verdict = evaluateResearchQuality({
    plan: makePlan({ workerSpecs: [workerSpec] }),
    evidencePackets: [packet],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })

  assert.equal(verdict.decision, 'APPROVE')
  assert.equal(verdict.findings.some((finding) =>
    finding.code === 'claim_unsupported' ||
    finding.code === 'required_authority_missing',
  ), false)
})

test('first-party vendor documentation counts toward the primary-source minimum', () => {
  const workerSpec = makeWorkerSpec({
    sourceRequirements: {
      preferredTypes: ['vendor'],
      requiredAuthorityTypes: ['vendor'],
      queryHints: [],
    },
    stopRule: {
      minimumPrimarySources: 2,
      minimumIndependentSources: 2,
      maximumSources: 6,
    },
  })
  const sources = [
    makeSource({
      sourceType: 'vendor',
      publisher: 'Vendor One',
      independenceKey: 'vendor-one',
    }),
    makeSource({
      sourceId: 'source-two',
      canonicalUrl: 'https://vendor-two.example.org/docs',
      sourceType: 'vendor',
      publisher: 'Vendor Two',
      independenceKey: 'vendor-two',
      contentSha256: 'b'.repeat(64),
    }),
  ]
  const verdict = evaluateResearchQuality({
    plan: makePlan({ workerSpecs: [workerSpec] }),
    evidencePackets: [makeEvidencePacket({
      workerSpecHash: hashResearchValue(workerSpec),
      sources,
    })],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })

  assert.equal(verdict.decision, 'APPROVE')
  assert.equal(verdict.findings.some(({ code }) =>
    code === 'primary_source_missing' || code === 'required_authority_missing',
  ), false)
})

test('first-party vendor documentation satisfies a generic primary authority requirement', () => {
  const workerSpec = makeWorkerSpec({
    sourceRequirements: {
      preferredTypes: ['primary', 'vendor'],
      requiredAuthorityTypes: ['primary'],
      queryHints: [],
    },
    stopRule: {
      minimumPrimarySources: 1,
      minimumIndependentSources: 1,
      maximumSources: 6,
    },
  })
  const source = makeSource({
    sourceType: 'vendor',
    publisher: 'Vendor One',
    independenceKey: 'vendor-one',
  })
  const verdict = evaluateResearchQuality({
    plan: makePlan({ workerSpecs: [workerSpec] }),
    evidencePackets: [makeEvidencePacket({
      workerSpecHash: hashResearchValue(workerSpec),
      sources: [source],
    })],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })

  assert.equal(verdict.findings.some(({ code }) =>
    code === 'required_authority_missing',
  ), false)
})

test('required authority types are accepted alternatives rather than cumulative requirements', () => {
  const workerSpec = makeWorkerSpec({
    sourceRequirements: {
      preferredTypes: ['primary', 'vendor'],
      requiredAuthorityTypes: ['primary', 'vendor'],
      queryHints: [],
    },
    stopRule: {
      minimumPrimarySources: 1,
      minimumIndependentSources: 1,
      maximumSources: 6,
    },
  })
  const source = makeSource({
    sourceType: 'vendor',
    publisher: 'Vendor One',
    independenceKey: 'vendor-one',
  })
  const verdict = evaluateResearchQuality({
    plan: makePlan({ workerSpecs: [workerSpec] }),
    evidencePackets: [makeEvidencePacket({
      workerSpecHash: hashResearchValue(workerSpec),
      sources: [source],
    })],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })

  assert.equal(verdict.findings.some(({ code }) => code === 'required_authority_missing'), false)
})

test('resolved contradictions remain auditable without blocking publication', () => {
  const resolved = evaluateResearchQuality({
    plan: makePlan(),
    evidencePackets: [makeEvidencePacket({
      contradictions: [{
        description: 'The older benchmark and current first-party report use different dates.',
        sourceIds: ['source-one', 'source-two'],
        status: 'resolved',
        resolution: 'Use the current first-party value for 2026 and retain the older benchmark only as dated context.',
      }],
    })],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })
  const legacyUnresolved = evaluateResearchQuality({
    plan: makePlan(),
    evidencePackets: [makeEvidencePacket({
      contradictions: [{
        description: 'Two sources report incompatible current values.',
        sourceIds: ['source-one', 'source-two'],
      }],
    })],
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })

  assert.equal(resolved.decision, 'APPROVE')
  assert.equal(
    resolved.findings.some((finding) => finding.code === 'contradiction_unresolved'),
    false,
  )
  assert.equal(legacyUnresolved.decision, 'REVISE')
  assert.ok(legacyUnresolved.findings.some((finding) =>
    finding.code === 'contradiction_unresolved',
  ))
})

test('synthesis and quality policy handle 200 independently bound lanes within 500 milliseconds', () => {
  const { plan, packets } = buildScaledResearch(200)
  const startedAt = performance.now()
  const verdict = evaluateResearchQuality({
    plan,
    evidencePackets: packets,
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })
  const qualityPacket = buildResearchQualityPacket({ plan, evidencePackets: packets })
  const elapsedMs = performance.now() - startedAt

  assert.equal(verdict.decision, 'APPROVE')
  assert.equal(qualityPacket.synthesis.coverage.length, 200)
  assert.equal(qualityPacket.synthesis.sources.length, 400)
  assert.ok(elapsedMs < 500, `Expected scaled packet processing under 500ms, received ${elapsedMs.toFixed(1)}ms`)
})

test('synthesis namespaces task-local claim and source IDs across independent lanes', () => {
  const { plan, packets } = buildScaledResearch(2)
  const taskLocalPackets = packets.map(useTaskLocalIdentifiers)

  const synthesis = buildResearchSynthesisPacket({
    plan,
    evidencePackets: taskLocalPackets,
  })
  const qualityPacket = buildResearchQualityPacket({
    plan,
    evidencePackets: taskLocalPackets,
  })
  const verdict = evaluateResearchQuality({
    plan,
    evidencePackets: taskLocalPackets,
    correctionWave: 0,
    reviewedAt: TEST_TIME,
  })

  assert.deepEqual(
    synthesis.claims.map((claim) => claim.claimId),
    ['task-001--C1', 'task-002--C1'],
  )
  assert.deepEqual(
    synthesis.sources.map((source) => source.sourceId),
    ['task-001--S1', 'task-001--S2', 'task-002--S1', 'task-002--S2'],
  )
  for (const claim of synthesis.claims) {
    assert.ok(
      claim.sourceIds.every((sourceId) => sourceId.startsWith(`${claim.taskId}--`)),
    )
    assert.deepEqual(
      claim.evidenceLinks.map((link) => link.sourceId),
      claim.sourceIds,
    )
  }
  assert.deepEqual(
    synthesis.coverage.map(({ claimIds, sourceIds }) => ({ claimIds, sourceIds })),
    [
      {
        claimIds: ['task-001--C1'],
        sourceIds: ['task-001--S1', 'task-001--S2'],
      },
      {
        claimIds: ['task-002--C1'],
        sourceIds: ['task-002--S1', 'task-002--S2'],
      },
    ],
  )
  assert.deepEqual(
    qualityPacket.claimSourceMatrix.map(({ claimId, independentPublisherCount }) => ({
      claimId,
      independentPublisherCount,
    })),
    [
      { claimId: 'task-001--C1', independentPublisherCount: 2 },
      { claimId: 'task-002--C1', independentPublisherCount: 2 },
    ],
  )
  assert.deepEqual(qualityPacket.reviewScope, {
    stage: 'research',
    criterion: 'safe_to_write',
    downstreamPublicationPending: true,
    excludedArtifacts: ['final-report.md', 'final-report.docx'],
  })
  assert.equal(verdict.decision, 'APPROVE')

  const alreadyNamespaced = taskLocalPackets.map((packet) => {
    const prefix = `${packet.taskId}--`
    return {
      ...packet,
      findings: packet.findings.map((claim) => ({
        ...claim,
        claimId: `${prefix}${claim.claimId}`,
        sourceIds: claim.sourceIds.map((sourceId) => `${prefix}${sourceId}`),
        evidenceLinks: claim.evidenceLinks.map((link) => ({
          ...link,
          sourceId: `${prefix}${link.sourceId}`,
        })),
      })),
      sources: packet.sources.map((source) => ({
        ...source,
        sourceId: `${prefix}${source.sourceId}`,
      })),
      contradictions: packet.contradictions.map((contradiction) => ({
        ...contradiction,
        sourceIds: contradiction.sourceIds.map((sourceId) => `${prefix}${sourceId}`),
      })),
      coverage: packet.coverage?.map((entry) => ({
        ...entry,
        claimIds: entry.claimIds.map((claimId) => `${prefix}${claimId}`),
        sourceIds: entry.sourceIds.map((sourceId) => `${prefix}${sourceId}`),
      })),
    }
  })
  const stableSynthesis = buildResearchSynthesisPacket({
    plan,
    evidencePackets: alreadyNamespaced,
  })
  assert.deepEqual(
    stableSynthesis.claims.map((claim) => claim.claimId),
    ['task-001--C1', 'task-002--C1'],
  )
})

function buildScaledResearch(count: number): {
  readonly plan: ResearchPlan
  readonly packets: readonly EvidencePacket[]
} {
  const tasks: ResearchPlan['tasks'][number][] = []
  const workerSpecs: ResearchPlan['workerSpecs'][number][] = []
  const packets: EvidencePacket[] = []
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index + 1).padStart(3, '0')
    const taskId = `task-${suffix}`
    const workerSpec = createResearchWorkerSpec({
      ...makeWorkerSpec(),
      id: `worker-${suffix}`,
      laneId: `lane-${suffix}`,
      question: `Research bounded question ${suffix}.`,
    })
    workerSpecs.push(workerSpec)
    tasks.push({
      schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
      id: taskId,
      sectionId: 'section-one',
      title: `Task ${suffix}`,
      question: workerSpec.question,
      purpose: 'evidence_acquisition',
      workerSpecId: workerSpec.id,
      dependsOn: [],
      correctionWave: 0,
    })
    const sources = [
      makeSource({
        sourceId: `source-${suffix}-a`,
        assignmentId: `assignment-${suffix}`,
        canonicalUrl: `https://primary-${suffix}.example.com/report`,
        independenceKey: `primary-${suffix}`,
        contentSha256: hashResearchValue(`source-${suffix}-a`),
      }),
      makeSource({
        sourceId: `source-${suffix}-b`,
        assignmentId: `assignment-${suffix}`,
        canonicalUrl: `https://secondary-${suffix}.example.org/report`,
        independenceKey: `secondary-${suffix}`,
        sourceType: 'industry',
        contentSha256: hashResearchValue(`source-${suffix}-b`),
      }),
    ]
    packets.push({
      schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
      assignmentId: `assignment-${suffix}`,
      taskId,
      workerSpecHash: hashResearchValue(workerSpec),
      question: workerSpec.question,
      shortAnswer: `Answer ${suffix} includes CAC and payback period.`,
      findings: [{
        schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
        claimId: `claim-${suffix}`,
        taskId,
        sectionId: 'section-one',
        statement: `Supported CAC and payback period claim ${suffix}.`,
        kind: 'fact',
        evidenceStandard: 'independent_corroboration',
        sourceIds: sources.map((source) => source.sourceId),
        evidenceLinks: sources.map((source) => ({
          sourceId: source.sourceId,
          observationReceiptId: source.observationReceiptId!,
          observedExcerpt: `Observed evidence ${suffix}.`,
          locator: `Source ${source.sourceId}`,
          relationship: 'supports' as const,
        })),
        confidence: 'high',
        status: 'supported',
        applicableScope: ['Test'],
      }],
      sources,
      contradictions: [],
      unresolvedQuestions: [],
      coverage: [
        {
          schemaVersion: 2,
          requirementId: 'cac',
          status: 'satisfied',
          claimIds: [`claim-${suffix}`],
          sourceIds: sources.map((source) => source.sourceId),
          value: '$120',
          unit: 'USD per acquired customer',
          asOf: TEST_TIME,
          scope: ['Test'],
        },
        {
          schemaVersion: 2,
          requirementId: 'payback-period',
          status: 'satisfied',
          claimIds: [`claim-${suffix}`],
          sourceIds: sources.map((source) => source.sourceId),
          value: '9',
          unit: 'months',
          asOf: TEST_TIME,
          scope: ['Test'],
        },
      ],
      stopReason: 'decision_useful',
    })
  }
  return {
    plan: makePlan({
      sections: [{
        schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
        id: 'section-one',
        title: 'Scaled section',
        objective: 'Exercise deterministic packet construction.',
        taskIds: tasks.map((task) => task.id),
      }],
      tasks,
      workerSpecs,
      expectedPeakWorkers: 8,
    }),
    packets,
  }
}

function useTaskLocalIdentifiers(packet: EvidencePacket): EvidencePacket {
  const sourceIds = new Map(
    packet.sources.map((source, index) => [source.sourceId, `S${index + 1}`]),
  )
  const localSourceId = (sourceId: string): string => {
    const localId = sourceIds.get(sourceId)
    assert.ok(localId, `Expected source '${sourceId}' in packet '${packet.taskId}'`)
    return localId
  }
  const claimIds = new Map(
    packet.findings.map((claim, index) => [claim.claimId, `C${index + 1}`]),
  )

  return {
    ...packet,
    findings: packet.findings.map((claim, index) => ({
      ...claim,
      claimId: `C${index + 1}`,
      sourceIds: claim.sourceIds.map(localSourceId),
      evidenceLinks: claim.evidenceLinks.map((link) => ({
        ...link,
        sourceId: localSourceId(link.sourceId),
      })),
    })),
    sources: packet.sources.map((source) => ({
      ...source,
      sourceId: localSourceId(source.sourceId),
    })),
    contradictions: packet.contradictions.map((contradiction) => ({
      ...contradiction,
      sourceIds: contradiction.sourceIds.map(localSourceId),
    })),
    ...whenDefined(packet.coverage?.map((entry) => ({
      ...entry,
      claimIds: entry.claimIds.map((claimId) => claimIds.get(claimId)!),
      sourceIds: entry.sourceIds.map(localSourceId),
    })), (coverage) => ({ coverage: coverage })),
  }
}
