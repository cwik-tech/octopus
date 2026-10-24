import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  ResearchEvaluationCase,
  ResearchEvaluationCorpus,
  ResearchEvaluationReport,
} from '../contracts/deep-research.js'
import { writeFileAtomicSync } from '../core/file-mutation.js'
import {
  buildDeepResearchEvaluationReport,
  parseResearchEvaluationCorpus,
  parseResearchEvaluationReport,
} from '../domains/deep-research/deep-research-evaluation.js'
import { parseResearchEvidenceGraph } from '../domains/deep-research/deep-research-evidence-graph.js'
import { parseResearchPublicationAudit } from '../domains/deep-research/deep-research-publication-audit.js'
import {
  parseMarkdownArtifact,
  stripArtifactFrontmatter,
} from '../domains/runtime/artifacts.js'

interface RunFile {
  readonly absolutePath: string
  readonly relativePath: string
  readonly modifiedAtMs: number
}

export function loadDeepResearchEvaluationCorpus(
  corpusPath: string,
): ResearchEvaluationCorpus {
  return parseResearchEvaluationCorpus(
    JSON.parse(fs.readFileSync(corpusPath, 'utf8')),
  )
}

export function loadDeepResearchEvaluationReport(
  reportPath: string,
): ResearchEvaluationReport {
  return parseResearchEvaluationReport(
    JSON.parse(fs.readFileSync(reportPath, 'utf8')),
  )
}

export function evaluateDeepResearchRunDirectory(params: {
  readonly runPath: string
  readonly evaluationCase: ResearchEvaluationCase
  readonly baseline?: unknown
  readonly outputPath?: string
  readonly elapsedMs?: number
  readonly costUsd?: number
  readonly evaluatedAt?: string
}): ResearchEvaluationReport {
  const runPath = requireRealDirectory(params.runPath)
  const files = walkRegularFiles(runPath)
  const finalMarkdownFile = requireLatestFile(
    files,
    (file) => path.basename(file.relativePath) === 'final-report.md',
    'final-report.md',
  )
  const finalDocxFile = requireLatestFile(
    files,
    (file) => path.basename(file.relativePath) === 'final-report.docx',
    'final-report.docx',
  )
  const finalDraftFile = requireApprovedDraft(files)
  const graphFile = requireLatestValidJson(
    files.filter((file) =>
      normalized(file.relativePath).endsWith(
        'research/evidence-graph/current.json',
      ),
    ),
    parseResearchEvidenceGraph,
    'research/evidence-graph/current.json',
    (left, right) => left.value.correctionWave - right.value.correctionWave,
  )
  const researchAssignmentPath = path.resolve(
    path.dirname(graphFile.file.absolutePath),
    '..',
    '..',
  )
  const canonicalResearchPackagePath = path.join(
    researchAssignmentPath,
    'research-package.md',
  )
  const researchPackageFile =
    files.find(
      (file) => file.absolutePath === canonicalResearchPackagePath,
    ) ??
    requireLatestFile(
      files,
      (file) =>
        path.basename(file.relativePath) === 'research-package.md',
      'research-package.md',
    )
  const auditFile = requireLatestValidJson(
    files.filter(
      (file) => path.basename(file.relativePath) === 'publication-audit.json',
    ),
    parseResearchPublicationAudit,
    'publication-audit.json',
  )

  const finalMarkdown = fs.readFileSync(
    finalMarkdownFile.absolutePath,
    'utf8',
  )
  const finalDocx = fs.readFileSync(finalDocxFile.absolutePath)
  const graph = graphFile.value
  const audit = auditFile.value
  const sectionIds = uniqueSorted([
    ...graph.requirements.map((requirement) => requirement.sectionId),
    ...graph.claims.map((claim) => claim.sectionId),
  ])
  const dossierFiles = files.filter((file) =>
    sectionIds.some((sectionId) =>
      normalized(file.relativePath).endsWith(
        `research/sections/${sectionId}/dossier-current.json`,
      ),
    ),
  )
  const sectionDraftFiles = files.filter((file) =>
    sectionIds.some((sectionId) =>
      new RegExp(
        `research/sections/${escapeRegExp(sectionId)}/draft-wave-[0-2]\\.md$`,
        'u',
      ).test(normalized(file.relativePath)),
    ),
  )
  let elapsedMs = params.elapsedMs
  let costUsd = params.costUsd
  if (elapsedMs === undefined || costUsd === undefined) {
    const storedMetrics = readStoredRunMetrics(runPath, files, finalMarkdownFile.modifiedAtMs)
    elapsedMs ??= storedMetrics.elapsedMs
    costUsd ??= storedMetrics.costUsd
  }
  const taskIds = uniqueSorted([
    ...graph.requirements.map((requirement) => requirement.taskId),
    ...graph.claims.map((claim) => claim.taskId),
  ])
  const finalDraft = fs.readFileSync(finalDraftFile.absolutePath, 'utf8')
  const draftMetadata = parseMarkdownArtifact(finalDraft).metadata
  const researchPackage = fs.readFileSync(
    researchPackageFile.absolutePath,
    'utf8',
  )
  const retainedArtifacts = uniqueSorted([
    graphFile.file.relativePath,
    auditFile.file.relativePath,
    finalMarkdownFile.relativePath,
    finalDocxFile.relativePath,
    finalDraftFile.relativePath,
    researchPackageFile.relativePath,
    ...dossierFiles.map((file) => file.relativePath),
    ...sectionDraftFiles.map((file) => file.relativePath),
  ])
  const report = buildDeepResearchEvaluationReport({
    evaluationCase: params.evaluationCase,
    evidenceGraph: graph,
    publicationAudit: audit,
    observation: {
      semanticReviewApproved:
        draftMetadata.status?.toLowerCase() === 'approved' &&
        draftMetadata.verdict?.toUpperCase() === 'APPROVE',
      approvedTaskCount: taskIds.length,
      usableObservedSources: graph.sources.filter(
        (source) => source.status === 'usable',
      ).length,
      elapsedMs,
      costUsd,
      artifactChecks: {
        evidence_graph: true,
        section_dossiers:
          sectionIds.length > 0 &&
          sectionIds.every((sectionId) =>
            dossierFiles.some((file) =>
              normalized(file.relativePath).endsWith(
                `research/sections/${sectionId}/dossier-current.json`,
              ),
            ),
          ),
        section_drafts:
          sectionIds.length > 0 &&
          sectionIds.every((sectionId) =>
            sectionDraftFiles.some((file) =>
              new RegExp(
                `research/sections/${escapeRegExp(sectionId)}/draft-wave-[0-2]\\.md$`,
                'u',
              ).test(normalized(file.relativePath)),
            ),
          ),
        research_package:
          stripArtifactFrontmatter(researchPackage).trim().length > 0,
        publication_audit: true,
        final_markdown:
          stripArtifactFrontmatter(finalMarkdown).trim().length > 0,
        final_docx: isDocx(finalDocx),
      },
      finalMarkdown,
      finalDocx,
      retainedArtifacts,
    },
    ...(params.baseline === undefined
      ? {}
      : { baseline: params.baseline }),
    evaluatedAt: params.evaluatedAt ?? audit.auditedAt,
  })

  if (params.outputPath) {
    const outputPath = path.resolve(params.outputPath)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    writeFileAtomicSync(
      outputPath,
      `${JSON.stringify(report, null, 2)}\n`,
    )
  }
  return report
}

function requireApprovedDraft(files: readonly RunFile[]): RunFile {
  const candidates = files
    .filter((file) => path.basename(file.relativePath) === 'final-draft.md')
    .filter((file) => {
      const metadata = parseMarkdownArtifact(
        fs.readFileSync(file.absolutePath, 'utf8'),
      ).metadata
      return metadata.status?.toLowerCase() === 'approved' &&
        metadata.verdict?.toUpperCase() === 'APPROVE'
    })
  return requireLatestFile(
    candidates,
    () => true,
    'approved final-draft.md',
  )
}

function readStoredRunMetrics(
  runPath: string,
  files: readonly RunFile[],
  fallbackCompletedAtMs: number,
): { elapsedMs: number; costUsd: number } {
  const exactWorkflowStatePath = path.join(
    runPath,
    '.runtime',
    'workflow-state.json',
  )
  const exactWorkflowStateFile = files.find(
    (file) => file.absolutePath === exactWorkflowStatePath,
  )
  const workflowStateFile =
    exactWorkflowStateFile ??
    [...files]
      .filter((file) =>
        normalized(file.relativePath).endsWith(
          '.runtime/workflow-state.json',
        ),
      )
      .sort(
        (left, right) =>
          pathDepth(left.relativePath) - pathDepth(right.relativePath) ||
          right.modifiedAtMs - left.modifiedAtMs,
      )[0]
  if (workflowStateFile) {
    const value = JSON.parse(
      fs.readFileSync(workflowStateFile.absolutePath, 'utf8'),
    ) as unknown
    if (
      !isRecord(value) ||
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.updatedAt)) ||
      typeof value.totalCostUsd !== 'number' ||
      !Number.isFinite(value.totalCostUsd) ||
      value.totalCostUsd < 0
    ) {
      throw new Error(
        'Deep Research durable workflow metrics are invalid.',
      )
    }
    return {
      elapsedMs: Math.max(
        0,
        Date.parse(value.updatedAt) - Date.parse(value.createdAt),
      ),
      costUsd: value.totalCostUsd,
    }
  }

  const exactPath = path.join(runPath, '.runtime', 'checkpoint.json')
  const exact = files.find((file) => file.absolutePath === exactPath)
  const checkpointFile = exact ??
    [...files]
      .filter((file) =>
        normalized(file.relativePath).endsWith(
          '.runtime/checkpoint.json',
        ),
      )
      .sort(
        (left, right) =>
          pathDepth(left.relativePath) - pathDepth(right.relativePath) ||
          right.modifiedAtMs - left.modifiedAtMs,
      )[0]
  if (!checkpointFile) {
    throw new Error(
      'Deep Research evaluation requires durable workflow state or a runtime checkpoint for elapsed-time and cost metrics.',
    )
  }
  const value = JSON.parse(
    fs.readFileSync(checkpointFile.absolutePath, 'utf8'),
  ) as unknown
  if (
    !isRecord(value) ||
    typeof value.startTime !== 'number' ||
    !Number.isFinite(value.startTime) ||
    value.startTime < 0 ||
    typeof value.totalCost !== 'number' ||
    !Number.isFinite(value.totalCost) ||
    value.totalCost < 0
  ) {
    throw new Error('Deep Research runtime checkpoint metrics are invalid.')
  }
  return {
    elapsedMs: Math.max(0, fallbackCompletedAtMs - value.startTime),
    costUsd: value.totalCost,
  }
}

function requireLatestValidJson<T>(
  files: readonly RunFile[],
  parse: (value: unknown) => T,
  label: string,
  compareValues?: (
    left: { file: RunFile; value: T },
    right: { file: RunFile; value: T },
  ) => number,
): { file: RunFile; value: T } {
  const parsed = files.flatMap((file) => {
    try {
      return [{
        file,
        value: parse(
          JSON.parse(fs.readFileSync(file.absolutePath, 'utf8')),
        ),
      }]
    } catch {
      return []
    }
  })
  const [latest] = parsed.sort(
    (left, right) =>
      (compareValues?.(right, left) ?? 0) ||
      right.file.modifiedAtMs - left.file.modifiedAtMs ||
      left.file.relativePath.localeCompare(right.file.relativePath),
  )
  if (!latest) {
    throw new Error(
      `Deep Research evaluation could not find a valid ${label}.`,
    )
  }
  return latest
}

function requireLatestFile(
  files: readonly RunFile[],
  predicate: (file: RunFile) => boolean,
  label: string,
): RunFile {
  const [latest] = files
    .filter(predicate)
    .sort(
      (left, right) =>
        right.modifiedAtMs - left.modifiedAtMs ||
        left.relativePath.localeCompare(right.relativePath),
    )
  if (!latest) {
    throw new Error(
      `Deep Research evaluation could not find ${label}.`,
    )
  }
  return latest
}

function walkRegularFiles(rootPath: string): RunFile[] {
  const files: RunFile[] = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        visit(entryPath)
        continue
      }
      if (!entry.isFile()) continue
      const stats = fs.statSync(entryPath)
      files.push({
        absolutePath: entryPath,
        relativePath: path.relative(rootPath, entryPath),
        modifiedAtMs: stats.mtimeMs,
      })
    }
  }
  visit(rootPath)
  return files
}

function requireRealDirectory(value: string): string {
  const resolved = path.resolve(value)
  const realPath = fs.realpathSync(resolved)
  if (!fs.statSync(realPath).isDirectory()) {
    throw new Error(`Deep Research run path is not a directory: ${value}`)
  }
  return realPath
}

function isDocx(value: Uint8Array): boolean {
  return value.byteLength > 1_000 &&
    value[0] === 0x50 &&
    value[1] === 0x4b
}

function normalized(value: string): string {
  return value.split(path.sep).join('/')
}

function pathDepth(value: string): number {
  return normalized(value).split('/').length
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right),
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
