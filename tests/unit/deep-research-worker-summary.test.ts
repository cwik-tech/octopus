/**
 * Deep Research worker evidence summaries (P2).
 *
 * Contract: every research worker lane renders one attributed Markdown
 * summary next to its JSON packet — a deterministic projection of the
 * validated packet when accepted, or a runtime-authored, bounded, explicitly
 * untrusted rendering of the last rejected attempt. Rejected summaries carry
 * `status: rejected` frontmatter and are never referenced by any stage input
 * contract or synthesis input path.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { EvidencePacket } from '../../contracts/deep-research.js'
import {
  deepResearchWorkerSummaryFileName,
  readDeepResearchObservationSummaries,
  renderDeepResearchEvidenceSummaryIndex,
  renderDeepResearchWorkerSummary,
  writeDeepResearchWorkerEvidenceSummary,
} from '../../domains/deep-research/deep-research-worker-summary.js'

const RECEIPTS = [
  {
    receiptId: 'receipt-one',
    canonicalUrl: 'https://example.com/report',
    title: 'Direct demand report',
    method: 'managed-browser',
    observedAt: '2026-07-16T12:00:00.000Z',
  },
  {
    receiptId: 'receipt-two',
    canonicalUrl: 'https://other.example.org/prices',
    title: 'Price list',
    method: 'managed-browser',
    observedAt: '2026-07-16T12:05:00.000Z',
  },
]

function acceptedPacket(): EvidencePacket {
  return {
    schemaVersion: 1,
    assignmentId: 'lane-market',
    taskId: 'T1',
    workerSpecHash: 'a'.repeat(64),
    question: 'What establishes current demand?',
    shortAnswer: 'Two independently published sources show demand.',
    findings: [{
      schemaVersion: 1,
      claimId: 'claim-one',
      taskId: 'T1',
      sectionId: 'section-market',
      statement: 'Demand grew 23 percent year over year.',
      kind: 'fact',
      evidenceStandard: 'single',
      sourceIds: ['source-one'],
      evidenceLinks: [{
        sourceId: 'source-one',
        observationReceiptId: 'receipt-one',
        observedExcerpt: 'Observed demand grew 23 percent year over year.',
        locator: 'Market report, demand paragraph',
        relationship: 'supports',
      }],
      confidence: 'high',
      status: 'supported',
      applicableScope: ['Current market'],
    }],
    sources: [{
      schemaVersion: 1,
      sourceId: 'source-one',
      assignmentId: 'lane-market',
      canonicalUrl: 'https://example.com/report',
      title: 'Direct demand report',
      publisher: 'Example Research',
      independenceKey: 'example-research',
      sourceType: 'primary',
      accessMethod: 'managed-browser',
      observationReceiptId: 'receipt-one',
      observedAt: '2026-07-16T12:00:00.000Z',
      contentSha256: 'b'.repeat(64),
      status: 'usable',
    }],
    contradictions: [],
    unresolvedQuestions: ['What portion of demand is seasonal?'],
    coverage: [],
    stopReason: 'decision_useful',
  }
}

const BASE = {
  taskId: 'T1',
  laneId: 'lane-market',
  agentPath: 'web-researcher',
  displayRole: 'B2B Market Evidence Analyst',
  levelId: 'collect-evidence',
}

// ─── Accepted mode ───────────────────────────────────────────────────────────

test('accepted summary projects the validated packet deterministically', () => {
  const markdown = renderDeepResearchWorkerSummary({
    ...BASE,
    status: 'completed',
    packet: acceptedPacket(),
  })

  assert.match(markdown, /^# T1 — B2B Market Evidence Analyst \(web-researcher · lane lane-market\)/m)
  assert.match(markdown, /## Question/)
  assert.match(markdown, /What establishes current demand\?/)
  assert.match(markdown, /Two independently published sources show demand\./)
  assert.match(markdown, /## Findings/)
  assert.match(markdown, /Demand grew 23 percent year over year\./)
  assert.match(markdown, /## Sources/)
  assert.match(markdown, /https:\/\/example\.com\/report/)
  assert.match(markdown, /receipt-one/)
  assert.match(markdown, /## Unresolved Questions/)
  assert.match(markdown, /What portion of demand is seasonal\?/)
  assert.match(markdown, /decision_useful/)
  assert.doesNotMatch(markdown, /Untrusted/)
})

test('rejected summary states attempts and the exact validator error over receipt-derived sources', () => {
  const markdown = renderDeepResearchWorkerSummary({
    ...BASE,
    status: 'rejected',
    rejected: {
      attempts: 2,
      validator: {
        name: 'DeepResearchValidationError',
        field: 'source.contentSha256',
        message: 'source.contentSha256 must be a lowercase SHA-256 digest',
        category: 'response_schema_invalid',
      },
      responseText: JSON.stringify(acceptedPacket()),
      receipts: RECEIPTS,
    },
  })

  assert.match(markdown, /# T1 — B2B Market Evidence Analyst/)
  assert.match(markdown, /rejected after 2 attempts/i)
  assert.match(markdown, /source\.contentSha256 must be a lowercase SHA-256 digest/)
  assert.match(markdown, /## Observed Sources/)
  assert.match(markdown, /https:\/\/example\.com\/report/)
  assert.match(markdown, /receipt-one/)
  assert.match(markdown, /https:\/\/other\.example\.org\/prices/)
  assert.match(markdown, /Untrusted quotation/)
})

test('rejected summary handles unparseable model output and still emits the source table', () => {
  const markdown = renderDeepResearchWorkerSummary({
    ...BASE,
    status: 'rejected',
    rejected: {
      attempts: 1,
      validator: {
        name: 'Error',
        message: 'Researcher response must contain only one valid EvidencePacket JSON object.',
        category: 'response_schema_invalid',
      },
      responseText: 'here is my research: <not json>',
      receipts: RECEIPTS,
    },
  })

  assert.match(markdown, /rejected after 1 attempt/i)
  assert.match(markdown, /only one valid EvidencePacket JSON object/)
  assert.match(markdown, /## Observed Sources/)
  assert.match(markdown, /receipt-two/)
})

test('rejected summary bounds every untrusted quotation to a fixed field budget', () => {
  const packet: EvidencePacket = { ...acceptedPacket(), shortAnswer: 'X'.repeat(5_000) }
  const markdown = renderDeepResearchWorkerSummary({
    ...BASE,
    status: 'rejected',
    rejected: {
      attempts: 1,
      validator: {
        name: 'Error',
        message: 'binding failure',
        category: 'binding_invalid',
      },
      responseText: JSON.stringify(packet),
      receipts: [],
    },
  })
  const quoted = markdown.match(/Untrusted quotation[\s\S]{0,80}([\s\S]*?)```/)?.[1] ?? ''
  assert.ok(quoted.length < 1_000, `quotation must be bounded, got ${quoted.length}`)
})

// ─── Attribution and filename safety ─────────────────────────────────────────

test('summary filename carries task and lane identity and rejects unsafe segments', () => {
  assert.equal(
    deepResearchWorkerSummaryFileName('T1', 'lane-market'),
    'T1--lane-market.md',
  )
  assert.throws(() => deepResearchWorkerSummaryFileName('T/1', 'lane-market'), /invalid/i)
  assert.throws(() => deepResearchWorkerSummaryFileName('T1', '../escape'), /invalid/i)
})

test('written summary frontmatter attributes agent, lane, task, and status', () => {
  const assignmentPath = fs.mkdtempSync(path.join(os.tmpdir(), 'research-summary-'))
  try {
    const relativePath = writeDeepResearchWorkerEvidenceSummary({
      assignmentPath,
      sessionId: 'session-one',
      levelId: 'collect-evidence',
      taskId: 'T1',
      laneId: 'lane-market',
      displayRole: 'B2B Market Evidence Analyst',
      packet: acceptedPacket(),
    })
    assert.equal(relativePath, 'research/evidence/wave-0/T1--lane-market.md')

    const raw = fs.readFileSync(
      path.join(assignmentPath, 'research', 'evidence', 'wave-0', 'T1--lane-market.md'),
      'utf8',
    )
    const frontmatter = raw.split('---')[1] ?? ''
    assert.match(frontmatter, /artifact_type: "result"/)
    assert.match(frontmatter, /agent: "web-researcher"/)
    assert.match(frontmatter, /agent_id: "lane-market"/)
    assert.match(frontmatter, /agent_display_name: "B2B Market Evidence Analyst"/)
    assert.match(frontmatter, /activity_scope_id: "lane-market"/)
    assert.match(frontmatter, /task_id: "T1"/)
    assert.match(frontmatter, /status: "completed"/)
    assert.match(frontmatter, /role: "research-worker"/)
    assert.match(frontmatter, /level: "collect-evidence"/)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('written rejected summary carries status rejected frontmatter and public permissions', () => {
  const assignmentPath = fs.mkdtempSync(path.join(os.tmpdir(), 'research-summary-rej-'))
  try {
    const observationsDir = path.join(
      assignmentPath,
      'research',
      'observations',
      'lane-market',
    )
    fs.mkdirSync(observationsDir, { recursive: true })
    fs.writeFileSync(path.join(observationsDir, 'receipt-one.json'), JSON.stringify({
      receiptId: 'receipt-one',
      canonicalUrl: 'https://example.com/report',
      title: 'Direct demand report',
      method: 'managed-browser',
      observedAt: '2026-07-16T12:00:00.000Z',
    }))

    writeDeepResearchWorkerEvidenceSummary({
      assignmentPath,
      sessionId: 'session-one',
      levelId: 'collect-evidence',
      taskId: 'T1',
      laneId: 'lane-market',
      displayRole: 'B2B Market Evidence Analyst',
      rejected: {
        attempts: 2,
        validator: {
          name: 'Error',
          message: "Claim 'c1' excerpt was not found in observation receipt 'receipt-one'.",
          category: 'binding_invalid',
        },
        responseText: 'not json',
      },
    })

    const filePath = path.join(
      assignmentPath,
      'research',
      'evidence',
      'wave-0',
      'T1--lane-market.md',
    )
    const raw = fs.readFileSync(filePath, 'utf8')
    const frontmatter = raw.split('---')[1] ?? ''
    assert.match(frontmatter, /status: "rejected"/)
    assert.match(raw, /excerpt was not found/)
    assert.match(raw, /https:\/\/example\.com\/report/)
    // Published tier: the summary lives in the public artifact tree, never
    // under the private runtime directory.
    assert.doesNotMatch(filePath, /\.runtime/)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

// ─── Summary index ───────────────────────────────────────────────────────────

test('evidence summary index links accepted lane summaries in plan order', () => {
  const index = renderDeepResearchEvidenceSummaryIndex([
    { taskId: 'T1', title: 'Measure demand', laneId: 'lane-market', displayRole: 'Market Analyst' },
    { taskId: 'T2', title: 'Assess prices', laneId: 'lane-prices', displayRole: 'Price Analyst' },
  ])
  assert.match(index, /1\. \[T1 — Market Analyst\]\(wave-0\/T1--lane-market\.md\)/)
  assert.match(index, /2\. \[T2 — Price Analyst\]\(wave-0\/T2--lane-prices\.md\)/)
})

test('observation summaries are read from the runtime observation directory', () => {
  const assignmentPath = fs.mkdtempSync(path.join(os.tmpdir(), 'research-summary-obs-'))
  try {
    const observationsDir = path.join(
      assignmentPath,
      'research',
      'observations',
      'lane-market',
    )
    fs.mkdirSync(observationsDir, { recursive: true })
    fs.writeFileSync(
      path.join(observationsDir, 'receipt-one.json'),
      JSON.stringify(RECEIPTS[0]),
    )
    const rows = readDeepResearchObservationSummaries(assignmentPath, 'lane-market')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.receiptId, 'receipt-one')
    assert.equal(rows[0]?.canonicalUrl, 'https://example.com/report')
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

// ─── §5.1 constraint 2: rejected summaries never feed agent context ─────────

test('no stage input contract or synthesis input path resolves a worker summary', async () => {
  const teamsDir = path.join(process.cwd(), 'teams')
  const violations: string[] = []
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(fullPath)
        continue
      }
      if (entry.name !== 'team.yaml') continue
      const content = fs.readFileSync(fullPath, 'utf8')
      for (const match of content.matchAll(/path:\s*(\S+)/g)) {
        const declared = match[1] ?? ''
        // Worker summaries are per-lane dynamic paths; declaring any
        // task--lane summary would let rejected output enter agent context.
        if (/^research\/evidence\/.*--.*\.md$/.test(declared)) {
          violations.push(`${fullPath}: ${declared}`)
        }
      }
    }
  }
  visit(teamsDir)
  assert.deepEqual(violations, [])

  // The static index is the only declared evidence-tree summary path, and it
  // only references accepted lanes.
  const index = renderDeepResearchEvidenceSummaryIndex([
    { taskId: 'T1', title: 'Measure demand', laneId: 'lane-market', displayRole: 'Market Analyst' },
  ])
  assert.doesNotMatch(index, /rejected/)
})

