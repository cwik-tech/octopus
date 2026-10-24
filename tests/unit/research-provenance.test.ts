import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertEditorialProvenancePreserved,
  buildResearchPublicationAudit,
  canonicalizeResearchCitations,
  parseResearchPublicationAudit,
  summarizeEditorialProvenance,
} from '../../workflows/research-provenance.js'
import { approveResearchPlan } from '../../domains/deep-research/deep-research-approval.js'
import { buildResearchEvidenceGraph } from '../../domains/deep-research/deep-research-evidence-graph.js'
import { buildResearchSynthesisPacket } from '../../domains/deep-research/deep-research-quality.js'
import {
  makeEvidenceGraph as makeCitationEvidenceGraph,
  makeGraphClaim,
} from './deep-research-citation-fixtures.js'
import {
  makeEvidencePacket,
  makePlan,
  TEST_TIME,
} from './deep-research-fixtures.js'

const SOURCE = `---
artifact_type: report
schema_version: 1
---
# Research package

The measured market reached $1.2B in 2025 and adoption was 18%.

## Contradictions and limitations

The sources disagree, so the 18% estimate remains uncertain.

## Sources

- [Regulator 2024 report](https://regulator.example/data?id=42)
- [Independent study](https://research.example/study)
`

test('editorial provenance accepts reordered prose with identical evidence anchors', () => {
  assert.doesNotThrow(() =>
    assertEditorialProvenancePreserved({
      sourceMarkdown: SOURCE,
      publicationMarkdown: `# Final report

Adoption was 18%, while the measured market reached $1.2B in 2025.

## Limitations and contradictions

This remains uncertain because the sources disagree.

## References

- https://research.example/study
- https://regulator.example/data?id=42
`,
    }),
  )
})

test('editorial provenance rejects removed and introduced source URLs', () => {
  assert.throws(
    () =>
      assertEditorialProvenancePreserved({
        sourceMarkdown: SOURCE,
        publicationMarkdown: SOURCE.replace(
          'https://research.example/study',
          'https://new.example/claim',
        ),
      }),
    (error: unknown) => {
      assert.match(
        String(error),
        /removed source URLs: 'https:\/\/research\.example\/study'/,
      )
      assert.match(
        String(error),
        /introduced source URLs: 'https:\/\/new\.example\/claim'/,
      )
      return true
    },
  )
})

test('editorial provenance rejects removed or introduced claim-bearing numerals', () => {
  assert.throws(
    () =>
      assertEditorialProvenancePreserved({
        sourceMarkdown: SOURCE,
        publicationMarkdown: SOURCE.replace('$1.2B', '$1.4B').replace(
          ' in 2025',
          '',
        ),
      }),
    (error: unknown) => {
      assert.match(
        String(error),
        /removed claim-bearing numerals: .*'\$1\.2b'.*'2025'/,
      )
      assert.match(
        String(error),
        /introduced claim-bearing numerals: '\$1\.4b'/,
      )
      return true
    },
  )
})

test('editorial provenance rejects a removed caveat family', () => {
  assert.throws(
    () =>
      assertEditorialProvenancePreserved({
        sourceMarkdown: SOURCE,
        publicationMarkdown: SOURCE.replace(
          'Contradictions and limitations',
          'Evidence review',
        )
          .replace('sources disagree', 'sources align')
          .replace('remains uncertain', 'is established'),
      }),
    /removed caveat markers: .*'contradiction'.*'uncertainty'/,
  )
})

test('editorial provenance recognizes equivalent evidence-insufficiency wording', () => {
  const sourceMarkdown = `# Research package

No evidence-based product winner can be named.

## Sources

- https://research.example/comparison
`
  const publicationMarkdown = `# Final report

The official sources do not establish a defensible product winner.

## Sources

- https://research.example/comparison
`

  assert.deepEqual(
    summarizeEditorialProvenance(sourceMarkdown).caveatMarkers,
    ['insufficient evidence'],
  )
  assert.deepEqual(
    summarizeEditorialProvenance(publicationMarkdown).caveatMarkers,
    ['insufficient evidence'],
  )
  assert.doesNotThrow(() =>
    assertEditorialProvenancePreserved({
      sourceMarkdown,
      publicationMarkdown,
    }),
  )
})

test('provenance summary ignores formatting numerals, trace IDs, and source titles', () => {
  const summary = summarizeEditorialProvenance(`# Report

## 3. Findings

1. Claim 12 reports 40% adoption.
2. The result applies in 2026.

## Sources

- [Annual report 2024](https://example.com/report/2024)
`)

  assert.deepEqual(summary.claimBearingNumerals, ['2026', '40%'])
  assert.deepEqual(summary.sourceUrls, ['https://example.com/report/2024'])
})

test('provenance summary keeps balanced URL parentheses and removes Markdown delimiters', () => {
  const summary = summarizeEditorialProvenance(
    '# Sources\n\n[Study](https://example.com/study_(final)).',
  )

  assert.deepEqual(summary.sourceUrls, ['https://example.com/study_(final)'])
})

test('editorial provenance fails closed when its source has no URLs', () => {
  assert.throws(
    () =>
      assertEditorialProvenancePreserved({
        sourceMarkdown: '# Unsupported package\n\nThe result was 10%.',
        publicationMarkdown: '# Report\n\nThe result was 10%.',
      }),
    /contains no HTTP\(S\) source URLs/,
  )
})

test('publication audit accepts graph-backed sources and URL-backed numeric footnotes', () => {
  const graph = makeEvidenceGraph()
  const sourceMarkdown = `# Research package

The observed result reached 42% in 2026.

## Sources

- https://example.com/report
- https://independent.example.org/benchmark
`
  const publicationMarkdown = `# Final report

The observed result reached 42% in 2026.[^result]

## References

- https://example.com/report
- https://independent.example.org/benchmark

[^result]: Evidence: https://example.com/report
`

  const audit = buildResearchPublicationAudit({
    sourceMarkdown,
    publicationMarkdown,
    evidenceGraph: graph,
    auditedAt: TEST_TIME,
  })

  assert.equal(audit.decision, 'APPROVE')
  assert.deepEqual(audit.violations, [])
  assert.deepEqual(audit.graphCoverage, {
    requiredClaimSourceLinks: 2,
    preservedClaimSourceLinks: 2,
    missingClaimIds: [],
    missingSourceIds: [],
  })
  assert.equal(audit.numericClaimParagraphs.length, 1)
  assert.equal(audit.numericClaimParagraphs[0]?.cited, true)
  assert.deepEqual(
    audit.numericClaimParagraphs[0]?.citationUrls,
    ['https://example.com/report'],
  )
})

test('publication audit reports graph-source removal and an uncited numeric claim independently', () => {
  const graph = makeEvidenceGraph()
  const sourceMarkdown = `# Research package

The observed result reached 42% in 2026.

## Sources

- https://example.com/report
- https://independent.example.org/benchmark
`
  const publicationMarkdown = `# Final report

The observed result reached 42% in 2026.

## References

- https://example.com/report
`

  const audit = buildResearchPublicationAudit({
    sourceMarkdown,
    publicationMarkdown,
    evidenceGraph: graph,
    auditedAt: TEST_TIME,
  })

  assert.equal(audit.decision, 'REVISE')
  assert.ok(
    audit.violations.some((violation) => violation.code === 'source_removed'),
  )
  const graphViolation = audit.violations.find(
    (violation) => violation.code === 'graph_source_missing',
  )
  assert.deepEqual(graphViolation?.claimIds, [graph.claims[0]!.id])
  assert.deepEqual(
    graphViolation?.sourceIds,
    [
      graph.sources.find(
        (source) =>
          source.canonicalUrl ===
          'https://independent.example.org/benchmark',
      )!.id,
    ],
  )
  assert.ok(
    audit.violations.some(
      (violation) => violation.code === 'numeric_claim_uncited',
    ),
  )
})

test('publication audit does not treat URL ports or numeric footnote labels as factual numerals', () => {
  const sourceMarkdown = `# Research package

The bounded finding is supported by the fixture source.

## Sources

- http://localhost:54321/evidence
`
  const publicationMarkdown = `# Final report

The bounded finding is supported by the fixture source.[^1]

## Sources

- http://localhost:54321/evidence

[^1]: http://localhost:54321/evidence
`

  const audit = buildResearchPublicationAudit({
    sourceMarkdown,
    publicationMarkdown,
    auditedAt: TEST_TIME,
  })

  assert.equal(audit.decision, 'APPROVE')
  assert.deepEqual(audit.numericClaimParagraphs, [])
})

function makeEvidenceGraph() {
  const plan = approveResearchPlan(makePlan(), TEST_TIME)
  const synthesis = buildResearchSynthesisPacket({
    plan,
    evidencePackets: [makeEvidencePacket()],
  })
  return buildResearchEvidenceGraph({
    plan,
    synthesis,
    correctionWave: 0,
  })
}

test('numeric claim audit treats a reference-style citation as cited', () => {
  const graph = makeEvidenceGraph()
  const sourceMarkdown = `# Research package

The observed result reached 42% in 2026.

## Sources

- https://example.com/report
- https://independent.example.org/benchmark
`
  const publicationMarkdown = `# Final report

The observed result reached 42% in 2026 [result][r1] [benchmark][r2].

[r1]: https://example.com/report
[r2]: https://independent.example.org/benchmark
`

  const audit = buildResearchPublicationAudit({
    sourceMarkdown,
    publicationMarkdown,
    evidenceGraph: graph,
    auditedAt: TEST_TIME,
  })

  assert.equal(audit.decision, 'APPROVE')
  assert.equal(audit.numericClaimParagraphs.length, 1)
  assert.equal(audit.numericClaimParagraphs[0]?.cited, true)
  assert.deepEqual(audit.numericClaimParagraphs[0]?.citationUrls, [
    'https://example.com/report',
    'https://independent.example.org/benchmark',
  ])
})

test('reference citation labels resolve case-insensitively and in collapsed form', () => {
  const sourceMarkdown = `# Research package

The observed result reached 42%.

## Sources

- https://example.com/report
`
  const publicationMarkdown = `# Final report

The observed result reached 42% [result][R1] and again [r2][].

[R1]: https://example.com/report
[r2]: https://example.com/report
`

  const audit = buildResearchPublicationAudit({
    sourceMarkdown,
    publicationMarkdown,
    auditedAt: TEST_TIME,
  })

  assert.equal(audit.numericClaimParagraphs[0]?.cited, true)
  assert.deepEqual(audit.numericClaimParagraphs[0]?.citationUrls, [
    'https://example.com/report',
  ])
})

test('a reference citation without a matching definition stays uncited', () => {
  const graph = makeEvidenceGraph()
  const sourceMarkdown = `# Research package

The observed result reached 42% in 2026.

## Sources

- https://example.com/report
- https://independent.example.org/benchmark
`
  const publicationMarkdown = `# Final report

The observed result reached 42% in 2026 [result][missing].

## Sources

- https://example.com/report
- https://independent.example.org/benchmark
`

  const audit = buildResearchPublicationAudit({
    sourceMarkdown,
    publicationMarkdown,
    evidenceGraph: graph,
    auditedAt: TEST_TIME,
  })

  assert.equal(audit.decision, 'REVISE')
  assert.ok(
    audit.violations.some(
      (violation) => violation.code === 'numeric_claim_uncited',
    ),
  )
})

test('numeric claim audit resolves duplicate footnote definitions first-wins', () => {
  const sourceMarkdown = `# Research package

The observed result reached 42%.

## Sources

- https://example.com/report
`
  const publicationMarkdown = `# Final report

The observed result reached 42%.[^1]

[^1]: https://example.com/report

[^1]: https://other.example/unvalidated
`

  const audit = buildResearchPublicationAudit({
    sourceMarkdown,
    publicationMarkdown,
    auditedAt: TEST_TIME,
  })

  // GFM resolves the reference to the first matching definition.
  assert.deepEqual(audit.numericClaimParagraphs[0]?.citationUrls, [
    'https://example.com/report',
  ])
})

test('numeric claim audit resolves duplicate footnote labels case-insensitively', () => {
  const sourceMarkdown = `# Research package

The observed result reached 42%.

## Sources

- https://example.com/report
`
  const publicationMarkdown = `# Final report

The observed result reached 42%.[^note]

[^Note]: https://example.com/report

[^NOTE]: https://other.example/unvalidated
`

  const audit = buildResearchPublicationAudit({
    sourceMarkdown,
    publicationMarkdown,
    auditedAt: TEST_TIME,
  })

  assert.equal(audit.numericClaimParagraphs[0]?.cited, true)
  assert.deepEqual(audit.numericClaimParagraphs[0]?.citationUrls, [
    'https://example.com/report',
  ])
})

test('numeric claim audit resolves reference definitions indented up to three spaces', () => {
  const graph = makeEvidenceGraph()
  const sourceMarkdown = `# Research package

The observed result reached 42% in 2026.

## Sources

- https://example.com/report
- https://independent.example.org/benchmark
`
  const publicationMarkdown = [
    '# Final report',
    '',
    'The observed result reached 42% in 2026 [result][r1] [benchmark][r2].',
    '',
    ' [r1]: https://example.com/report',
    '   [r2]: https://independent.example.org/benchmark',
    '',
  ].join('\n')

  const audit = buildResearchPublicationAudit({
    sourceMarkdown,
    publicationMarkdown,
    evidenceGraph: graph,
    auditedAt: TEST_TIME,
  })

  assert.equal(audit.decision, 'APPROVE')
  assert.deepEqual(audit.numericClaimParagraphs[0]?.citationUrls, [
    'https://example.com/report',
    'https://independent.example.org/benchmark',
  ])
})

test('citation definitions inside fenced code blocks are not citations', () => {
  const graph = makeEvidenceGraph()
  const sourceMarkdown = `# Research package

The observed result reached 42% in 2026.

## Sources

- https://example.com/report
- https://independent.example.org/benchmark
`
  const publicationMarkdown = [
    '# Final report',
    '',
    'The observed result reached 42% in 2026 [result][r1][^9].',
    '',
    '```text',
    '[r1]: https://example.com/report',
    '[^9]: https://independent.example.org/benchmark',
    '```',
    '',
    '## Sources',
    '',
    '- https://example.com/report',
    '- https://independent.example.org/benchmark',
    '',
  ].join('\n')

  const audit = buildResearchPublicationAudit({
    sourceMarkdown,
    publicationMarkdown,
    evidenceGraph: graph,
    auditedAt: TEST_TIME,
  })

  assert.equal(audit.decision, 'REVISE')
  assert.ok(
    audit.violations.some(
      (violation) => violation.code === 'numeric_claim_uncited',
    ),
  )
  assert.equal(audit.numericClaimParagraphs[0]?.cited, false)
})

test('an image reference is not a citation for a numeric claim', () => {
  const graph = makeEvidenceGraph()
  const sourceMarkdown = `# Research package

The observed result reached 42% in 2026.

## Sources

- https://example.com/report
- https://independent.example.org/benchmark
`
  const publicationMarkdown = [
    '# Final report',
    '',
    'The observed result reached 42% in 2026 ![chart][r1].',
    '',
    '[r1]: https://example.com/report',
    '',
    '## Sources',
    '',
    '- https://example.com/report',
    '- https://independent.example.org/benchmark',
    '',
  ].join('\n')

  const audit = buildResearchPublicationAudit({
    sourceMarkdown,
    publicationMarkdown,
    evidenceGraph: graph,
    auditedAt: TEST_TIME,
  })

  assert.equal(audit.decision, 'REVISE')
  assert.ok(
    audit.violations.some(
      (violation) => violation.code === 'numeric_claim_uncited',
    ),
  )
  assert.equal(audit.numericClaimParagraphs[0]?.cited, false)
})

test('canonical audit flags an unvalidated URL surviving inside a kept link label', () => {
  const graph = makeCitationEvidenceGraph()
  const { markdown, summary } = canonicalizeResearchCitations({
    markdown:
      'Cited [note https://blog.example/post](https://regulator.example/report).',
    evidenceGraph: graph,
  })

  const audit = buildResearchPublicationAudit({
    sourceMarkdown: '# Package\n\nText https://regulator.example/report.\n',
    publicationMarkdown: markdown,
    evidenceGraph: graph,
    auditedAt: TEST_TIME,
    canonicalization: summary,
  })

  assert.equal(audit.decision, 'REVISE')
  assert.ok(
    audit.violations.some(
      (violation) => violation.code === 'source_introduced',
    ),
  )
})

test('canonical audit flags an unknown image URL the canonicalizer must not edit', () => {
  const graph = makeCitationEvidenceGraph()
  const input = [
    'Cited [filing](https://regulator.example/report).',
    '',
    '![chart](https://invented.example/chart.png)',
    '',
  ].join('\n')
  const { markdown, summary } = canonicalizeResearchCitations({
    markdown: input,
    evidenceGraph: graph,
  })

  // The canonicalizer never edits images; the audit fails closed instead.
  assert.match(
    markdown,
    /!\[chart\]\(https:\/\/invented\.example\/chart\.png\)/u,
  )
  assert.equal(summary.removedUnknownUrls.length, 0)

  const audit = buildResearchPublicationAudit({
    sourceMarkdown: '# Package\n\nText https://regulator.example/report.\n',
    publicationMarkdown: markdown,
    evidenceGraph: graph,
    auditedAt: TEST_TIME,
    canonicalization: summary,
  })

  assert.equal(audit.decision, 'REVISE')
  assert.ok(
    audit.violations.some(
      (violation) => violation.code === 'source_introduced',
    ),
  )
})

test('audit summaries sort URLs by code units, not locale collation', () => {
  const summary = summarizeEditorialProvenance(
    '# Report\n\nSee https://example.com/B and https://example.com/a.\n',
  )

  assert.deepEqual(summary.sourceUrls, [
    'https://example.com/B',
    'https://example.com/a',
  ])
})

test('publication audit fails closed on an unresolvable supporting source', () => {
  const graph = makeCitationEvidenceGraph({
    claims: [
      makeGraphClaim({ sourceIds: ['S1'], supportingSourceIds: ['S9'] }),
    ],
  })
  assert.throws(
    () =>
      buildResearchPublicationAudit({
        sourceMarkdown: '# Package\n\nText https://regulator.example/report.\n',
        publicationMarkdown: '# Report\n\nText https://regulator.example/report.\n',
        evidenceGraph: graph,
        auditedAt: TEST_TIME,
      }),
    /cannot resolve source 'S9'/u,
  )
})

function makeCanonicalAudit() {
  const graph = makeCitationEvidenceGraph()
  const canonicalization = canonicalizeResearchCitations({
    markdown: 'Cited [filing](https://regulator.example/report).',
    evidenceGraph: graph,
  }).summary
  return buildResearchPublicationAudit({
    sourceMarkdown: '# Package\n\nText https://regulator.example/report.\n',
    publicationMarkdown: 'Report\n\nText https://regulator.example/report.\n',
    evidenceGraph: graph,
    auditedAt: TEST_TIME,
    canonicalization,
  })
}

test('parseResearchPublicationAudit round-trips a canonicalization summary', () => {
  const audit = makeCanonicalAudit()
  const parsed = parseResearchPublicationAudit(JSON.parse(JSON.stringify(audit)))
  assert.deepEqual(parsed, audit)
  assert.ok(parsed.canonicalization)
  assert.deepEqual(
    [...(parsed.canonicalization?.graphUrlBaseline ?? [])],
    ['https://regulator.example/report'],
  )
})

test('parseResearchPublicationAudit keeps parsing legacy audits', () => {
  const audit = buildResearchPublicationAudit({
    sourceMarkdown: '# Package\n\nText https://example.com/report.\n',
    publicationMarkdown: '# Report\n\nText https://example.com/report.\n',
    auditedAt: TEST_TIME,
  })
  const parsed = parseResearchPublicationAudit(JSON.parse(JSON.stringify(audit)))
  assert.deepEqual(parsed, audit)
  assert.equal(parsed.canonicalization, undefined)
})

test('parseResearchPublicationAudit rejects every malformed canonicalization field', () => {
  const valid = JSON.parse(JSON.stringify(makeCanonicalAudit())) as {
    canonicalization?: Record<string, unknown>
  }
  const mutations: Array<(record: Record<string, unknown>) => void> = [
    (record) => delete record.inputSha256,
    (record) => { record.inputSha256 = 42 },
    (record) => { record.outputSha256 = null },
    (record) => { record.graphUrlBaseline = 'url' },
    (record) => { record.publicationUrlInventory = [1] },
    (record) => { record.normalizedLinkCount = -1 },
    (record) => { record.generatedSourceCount = 1.5 },
    (record) => { record.removedSourceSectionHeadings = {} },
    (record) => { record.removedUnknownUrls = 'none' },
    (record) => {
      record.removedUnknownUrls = [{ url: 'u', kind: 'bogus', offset: 0 }]
    },
    (record) => {
      record.removedUnknownUrls = [{ url: 'u', kind: 'inline_link', offset: -1 }]
    },
  ]
  for (const mutate of mutations) {
    const mutated = JSON.parse(JSON.stringify(valid)) as {
      canonicalization?: Record<string, unknown>
    }
    mutate(mutated.canonicalization!)
    assert.throws(
      () => parseResearchPublicationAudit(mutated),
      /canonicalization is invalid|canonicalization removal is invalid/u,
    )
  }
  const nulled = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>
  nulled.canonicalization = null
  assert.throws(
    () => parseResearchPublicationAudit(nulled),
    /canonicalization is invalid/u,
  )
})
