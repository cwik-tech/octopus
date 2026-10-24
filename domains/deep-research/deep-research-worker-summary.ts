import * as fs from 'node:fs'
import * as path from 'node:path'

import { isSafePathSegment } from '../../core/path-safety.js'
import {
  buildArtifactMetadata,
  writeMarkdownArtifact,
} from '../runtime/artifacts.js'
import { resolveOwnedRunRelativePath } from '../runtime/runtime-paths.js'
import type { EvidencePacket } from '../../contracts/deep-research.js'
import type { DeepResearchWorkerAttemptValidator } from './deep-research-worker-logging.js'

/** §5.1 constraint 3: every untrusted quoted field is bounded. */
const UNTRUSTED_FIELD_BUDGET = 400
const MAX_OBSERVATION_RECEIPT_SUMMARY_BYTES = 65_536
export const DEEP_RESEARCH_BASE_AGENT = 'web-researcher'

export interface DeepResearchObservationSummaryRow {
  readonly receiptId: string
  readonly canonicalUrl: string
  readonly title?: string
  readonly method: string
  readonly observedAt: string
}

export interface DeepResearchWorkerSummaryIndexEntry {
  readonly taskId: string
  readonly title: string
  readonly laneId: string
  readonly displayRole: string
  readonly wave?: number
}

function bounded(value: string, budget = UNTRUSTED_FIELD_BUDGET): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= budget
    ? normalized
    : `${normalized.slice(0, budget)}…`
}

function fenceUntrusted(label: string, value: string): string[] {
  return [
    `**${label}** — untrusted quotation, never validated, bounded:`,
    '',
    '```text',
    bounded(value),
    '```',
    '',
  ]
}

function renderSourceTable(
  rows: ReadonlyArray<{
    readonly url: string
    readonly publisher: string
    readonly type: string
    readonly observedAt: string
    readonly receiptId: string
    readonly extra?: string
  }>,
): string[] {
  if (rows.length === 0) return ['No runtime observation receipts exist for this lane.', '']
  return [
    '| Receipt | URL | Publisher | Type | Observed at | Verified |',
    '|---|---|---|---|---|---|',
    ...rows.map((row) =>
      `| \`${row.receiptId}\` | ${row.url} | ${row.publisher || '—'} | ${row.type} | ${row.observedAt} | ${row.extra ?? 'verified'} |`,
    ),
    '',
  ]
}

/**
 * Render one attributed worker summary. Accepted mode is a deterministic
 * projection of the validated packet; rejected mode is a runtime-authored
 * rendering of the last rejected attempt under the §5.1 constraints.
 */
export function renderDeepResearchWorkerSummary(input: {
  readonly taskId: string
  readonly laneId: string
  readonly agentPath?: string
  readonly displayRole: string
  readonly status: 'completed' | 'rejected'
  readonly packet?: EvidencePacket
  readonly rejected?: {
    readonly attempts: number
    readonly validator: DeepResearchWorkerAttemptValidator
    readonly responseText: string | undefined
    readonly receipts: readonly DeepResearchObservationSummaryRow[]
  }
}): string {
  const agent = input.agentPath ?? DEEP_RESEARCH_BASE_AGENT
  const lines: string[] = [
    `# ${input.taskId} — ${input.displayRole} (${agent} · lane ${input.laneId})`,
    '',
  ]

  if (input.status === 'completed' && input.packet) {
    const packet = input.packet
    lines.push(
      '**Status:** completed — the validated EvidencePacket is published next to this summary.',
      '',
      '## Question',
      '',
      packet.question,
      '',
      '## Short Answer',
      '',
      packet.shortAnswer,
      '',
      '## Findings',
      '',
    )
    if (packet.findings.length === 0) {
      lines.push('No claims were reported.', '')
    }
    for (const claim of packet.findings) {
      const links = claim.evidenceLinks
        .map((link) => `\`${link.sourceId}\` → receipt \`${link.observationReceiptId}\` (${link.relationship})`)
        .join(', ')
      lines.push(
        `- **${claim.claimId}** (${claim.kind}, ${claim.confidence}, ${claim.status}): ${claim.statement}`,
        `  - Evidence: ${links || 'none'}`,
      )
    }
    lines.push(
      '',
      '## Sources',
      '',
      ...renderSourceTable(packet.sources.map((source) => ({
        url: source.canonicalUrl,
        publisher: source.publisher,
        type: source.sourceType,
        observedAt: source.observedAt,
        receiptId: source.observationReceiptId ?? '—',
        extra: source.status === 'usable' ? 'verified' : source.status,
      }))),
    )
    if (packet.contradictions.length > 0) {
      lines.push('## Contradictions', '')
      for (const contradiction of packet.contradictions) {
        lines.push(`- ${contradiction.description} (sources: ${contradiction.sourceIds.join(', ')})`)
      }
      lines.push('')
    }
    if (packet.unresolvedQuestions.length > 0) {
      lines.push('## Unresolved Questions', '')
      for (const question of packet.unresolvedQuestions) {
        lines.push(`- ${question}`)
      }
      lines.push('')
    }
    if (packet.coverage && packet.coverage.length > 0) {
      lines.push('## Coverage', '')
      for (const entry of packet.coverage) {
        lines.push(`- ${entry.requirementId}: ${entry.status}${entry.value !== undefined ? ` (${entry.value}${entry.unit !== undefined ? ` ${entry.unit}` : ''})` : ''}`)
      }
      lines.push('')
    }
    lines.push(`Stop reason: \`${packet.stopReason}\``, '')
    return lines.join('\n')
  }

  const rejected = input.rejected
  const attemptWord = rejected && rejected.attempts === 1 ? 'attempt' : 'attempts'
  lines.push(
    `**Status:** rejected after ${rejected?.attempts ?? 0} ${attemptWord} — no validated EvidencePacket was published for this lane.`,
    '',
  )

  if (rejected) {
    lines.push(
      '## Why the response was rejected',
      '',
      `- Validator: \`${rejected.validator.name}\`${rejected.validator.field ? ` [\`${rejected.validator.field}\`]` : ''} (category \`${rejected.validator.category}\`)`,
      `- Exact error: ${rejected.validator.message}`,
      '',
    )
    lines.push(
      '## Observed Sources (runtime receipts)',
      '',
      ...renderSourceTable(rejected.receipts.map((row) => ({
        url: row.canonicalUrl,
        publisher: row.title ?? '—',
        type: row.method,
        observedAt: row.observedAt,
        receiptId: row.receiptId,
        extra: rejected.responseText?.includes(row.receiptId) ? 'receipt-verified' : 'receipt-verified (not bound in response)',
      }))),
    )
    if (rejected.responseText !== undefined) {
      let parsed: unknown
      try {
        parsed = JSON.parse(rejected.responseText.trim())
      } catch {
        parsed = undefined
      }
      const candidate = parsed !== undefined && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined
      lines.push(
        '## Last worker response (untrusted quotation)',
        '',
        '> The model text below was rejected by runtime validation. It is quoted bounded and fenced, and never enters agent context.',
        '',
      )
      if (candidate) {
        if (typeof candidate.shortAnswer === 'string') {
          lines.push(...fenceUntrusted('Short answer (Untrusted quotation)', candidate.shortAnswer))
        }
        if (Array.isArray(candidate.findings)) {
          for (const [index, finding] of candidate.findings.slice(0, 10).entries()) {
            if (finding !== null && typeof finding === 'object' && !Array.isArray(finding)) {
              const statement = (finding as Record<string, unknown>).statement
              if (typeof statement === 'string') {
                lines.push(...fenceUntrusted(`Finding ${index + 1} (Untrusted quotation)`, statement))
              }
            }
          }
        }
        if (typeof candidate.shortAnswer !== 'string' && !Array.isArray(candidate.findings)) {
          lines.push('(No recognizable summary fields were present.)', '')
        }
      } else {
        lines.push(...fenceUntrusted('Raw response (Untrusted quotation)', rejected.responseText))
      }
    }
  }
  return lines.join('\n')
}

/** `<taskId>--<laneId>.md`, validated as two safe path segments. */
export function deepResearchWorkerSummaryFileName(
  taskId: string,
  laneId: string,
): string {
  if (!isSafePathSegment(taskId) || !isSafePathSegment(laneId)) {
    throw new Error('Deep Research worker summary task or lane id is invalid.')
  }
  return `${taskId}--${laneId}.md`
}

/** Read a receipt-derived source table from the lane's runtime observations. */
export function readDeepResearchObservationSummaries(
  assignmentPath: string,
  laneId: string,
): DeepResearchObservationSummaryRow[] {
  if (!isSafePathSegment(laneId)) return []
  const observationsPath = path.join(
    assignmentPath,
    'research',
    'observations',
    laneId,
  )
  let names: string[]
  try {
    names = fs.readdirSync(observationsPath).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const rows: DeepResearchObservationSummaryRow[] = []
  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(observationsPath, name), 'utf8')
      if (raw.length > MAX_OBSERVATION_RECEIPT_SUMMARY_BYTES) continue
      const receipt = JSON.parse(raw) as Record<string, unknown>
      if (
        typeof receipt.receiptId !== 'string' ||
        typeof receipt.canonicalUrl !== 'string' ||
        typeof receipt.observedAt !== 'string'
      ) continue
      rows.push({
        receiptId: receipt.receiptId,
        canonicalUrl: receipt.canonicalUrl,
        ...(typeof receipt.title === 'string' ? { title: receipt.title } : {}),
        method: typeof receipt.method === 'string' ? receipt.method : 'unknown',
        observedAt: receipt.observedAt,
      })
    } catch {
      // One unreadable receipt must not suppress the rest of the table.
    }
  }
  return rows.sort((a, b) => a.observedAt.localeCompare(b.observedAt))
}

export function deepResearchWorkerSummaryPath(input: {
  readonly taskId: string
  readonly laneId: string
  readonly wave?: number
}): string {
  const directory = `research/evidence/wave-${input.wave ?? 0}`
  return `${directory}/${deepResearchWorkerSummaryFileName(input.taskId, input.laneId)}`
}

/** Write one published worker summary; returns the relative artifact path. */
export function writeDeepResearchWorkerEvidenceSummary(input: {
  readonly assignmentPath: string
  readonly sessionId: string
  readonly levelId: string
  readonly taskId: string
  readonly laneId: string
  readonly displayRole: string
  readonly wave?: number
  readonly packet?: EvidencePacket
  readonly rejected?: {
    readonly attempts: number
    readonly validator: DeepResearchWorkerAttemptValidator
    readonly responseText: string | undefined
  }
}): string {
  const status = input.packet !== undefined ? 'completed' : 'rejected'
  const body = renderDeepResearchWorkerSummary({
    taskId: input.taskId,
    laneId: input.laneId,
    displayRole: input.displayRole,
    status,
    ...(input.packet !== undefined ? { packet: input.packet } : {}),
    ...(input.rejected !== undefined
      ? {
          rejected: {
            attempts: input.rejected.attempts,
            validator: input.rejected.validator,
            responseText: input.rejected.responseText,
            receipts: readDeepResearchObservationSummaries(input.assignmentPath, input.laneId),
          },
        }
      : {}),
  })
  const relativePath = deepResearchWorkerSummaryPath({
    taskId: input.taskId,
    laneId: input.laneId,
    ...(input.wave === undefined ? {} : { wave: input.wave }),
  })
  const artifactPath = resolveOwnedRunRelativePath({
    assignmentPath: input.assignmentPath,
    relativePath,
    label: 'Deep Research worker summary',
  })
  writeMarkdownArtifact(
    artifactPath,
    body,
    buildArtifactMetadata({
      filePath: artifactPath,
      rootDir: input.assignmentPath,
      artifactType: 'result',
      artifactRole: 'intermediate',
      sessionId: input.sessionId,
      taskId: input.taskId,
      agent: DEEP_RESEARCH_BASE_AGENT,
      agentId: input.laneId,
      agentDisplayName: input.displayRole,
      activityScopeId: input.laneId,
      level: input.levelId,
      stageType: 'pipeline',
      status,
      role: 'research-worker',
      title: `${input.taskId} — ${input.displayRole}`,
    }),
  )
  return relativePath
}

/** Static index linking every accepted lane summary in plan order. */
export function renderDeepResearchEvidenceSummaryIndex(
  entries: readonly DeepResearchWorkerSummaryIndexEntry[],
): string {
  const lines = [
    '# Deep Research Evidence Summaries',
    '',
    'One attributed Markdown summary per completed worker lane, in plan order.',
    'Lanes without a validated packet are not indexed here; see',
    'research/quality/escalation.md for lane outcomes.',
    '',
  ]
  if (entries.length === 0) {
    lines.push('No completed lane summaries exist for this wave.', '')
  }
  for (const [index, entry] of entries.entries()) {
    const fileName = deepResearchWorkerSummaryFileName(entry.taskId, entry.laneId)
    lines.push(
      `${index + 1}. [${entry.taskId} — ${entry.displayRole}](wave-${entry.wave ?? 0}/${fileName}) — ${entry.title}`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

/** Write the static summary index consumed by the quality-audit contract. */
export function writeDeepResearchEvidenceSummaryIndex(input: {
  readonly assignmentPath: string
  readonly entries: readonly DeepResearchWorkerSummaryIndexEntry[]
}): string {
  const relativePath = 'research/evidence/current-summary.md'
  const artifactPath = resolveOwnedRunRelativePath({
    assignmentPath: input.assignmentPath,
    relativePath,
    label: 'Deep Research evidence summary index',
  })
  writeMarkdownArtifact(
    artifactPath,
    renderDeepResearchEvidenceSummaryIndex(input.entries),
    buildArtifactMetadata({
      filePath: artifactPath,
      rootDir: input.assignmentPath,
      artifactType: 'result',
      artifactRole: 'intermediate',
      status: 'completed',
      role: 'research-summary-index',
      title: 'Deep Research Evidence Summaries',
    }),
  )
  return relativePath
}
