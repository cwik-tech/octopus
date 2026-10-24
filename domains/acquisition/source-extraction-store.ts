import { whenDefined } from '../../core/optional-properties.js'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as path from 'node:path'

import { publishRuntimeArtifactWrittenEvent } from '../runtime/artifacts.js'
import { isSafePathSegment, resolveRelativePathInside } from '../../core/path-safety.js'
import {
  SOURCE_EXTRACTION_RECEIPT_VERSION,
  type SourceArtifactReference,
  type SourceExtractionReceipt,
  type SourceExtractionResult,
  type SourceExtractionView,
} from './acquisition-types.js'
import type { ObservationIdentity } from './source-observation-store.js'

const MAX_EXTRACTION_RESULT_BYTES = 4 * 1_024 * 1_024

export interface PersistExtractionInput {
  readonly assignmentPath: string
  readonly identity: ObservationIdentity
  readonly extractionId: string
  readonly sourceReceiptId: string
  readonly request: Readonly<Record<string, unknown>>
  readonly result: SourceExtractionResult
  readonly provider?: string
  readonly model?: string
  readonly durationMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cost: number
  readonly costTracked: boolean
  readonly repairCount: number
  readonly createdAt: string
}

export class SourceExtractionStore {
  async persist(input: PersistExtractionInput): Promise<{
    readonly receipt: SourceExtractionReceipt
    readonly view: SourceExtractionView
  }> {
    assertIdentity(input.identity)
    if (
      !isSafePathSegment(input.extractionId) ||
      !isSafePathSegment(input.sourceReceiptId)
    ) {
      throw new Error('Extraction identity is invalid.')
    }
    const assignmentPath = path.resolve(input.assignmentPath)
    await assertRegularDirectory(assignmentPath)
    const base = [
      'research',
      'extractions',
      input.identity.activityScopeId,
      input.extractionId,
    ].join('/')
    const requestRelativePath = `${base}/request.json`
    const resultRelativePath = `${base}/result.json`
    const receiptRelativePath = `${base}/receipt.json`
    const requestBuffer = jsonBuffer(input.request)
    const resultBuffer = jsonBuffer(input.result)
    if (resultBuffer.byteLength > MAX_EXTRACTION_RESULT_BYTES) {
      throw new Error('Extraction result exceeds the 4 MB artifact limit.')
    }
    await writeExclusiveFile(assignmentPath, requestRelativePath, requestBuffer)
    await writeExclusiveFile(assignmentPath, resultRelativePath, resultBuffer)
    const receipt: SourceExtractionReceipt = {
      schemaVersion: SOURCE_EXTRACTION_RECEIPT_VERSION,
      extractionId: input.extractionId,
      sourceReceiptId: input.sourceReceiptId,
      ...input.identity,
      sourceContentSha256: input.result.sourceContentSha256,
      schemaSha256: input.result.schemaSha256,
      request: artifactReference(requestRelativePath, requestBuffer),
      result: artifactReference(resultRelativePath, resultBuffer),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      createdAt: input.createdAt,
      durationMs: Math.max(0, input.durationMs),
      inputTokens: Math.max(0, input.inputTokens),
      outputTokens: Math.max(0, input.outputTokens),
      cost: Math.max(0, input.cost),
      costTracked: input.costTracked,
      repairCount: input.repairCount,
    }
    const receiptBuffer = jsonBuffer(receipt)
    await writeExclusiveFile(assignmentPath, receiptRelativePath, receiptBuffer)
    publishRuntimeArtifactWrittenEvent({
      outputDir: assignmentPath,
      relativePath: receiptRelativePath,
      artifactType: 'source-extraction-receipt',
      artifactRole: 'intermediate',
      createdAt: input.createdAt,
      sessionId: input.identity.assignmentId,
      rootSessionId: input.identity.runId,
      agentId: input.identity.activityScopeId,
      agentName:
        input.identity.agentDisplayName ??
        input.identity.activityScopeId,
      ...whenDefined(input.identity.agentPath.split('/').at(-1), (definedValue) => ({ agentBaseName: definedValue })),
      activityScopeId: input.identity.activityScopeId,
      emitterName: 'source-extraction-store',
      title: `Source extraction ${input.extractionId}`,
    })
    return {
      receipt,
      view: {
        extractionId: input.extractionId,
        resultRelativePath,
        receiptRelativePath,
        complete: input.result.complete,
        requirementsMet: input.result.requirementsMet,
        data: input.result.data,
        fields: input.result.fields,
        methodsAttempted: input.result.methodsAttempted,
        warnings: input.result.warnings,
      },
    }
  }
}

function artifactReference(
  relativePath: string,
  value: Uint8Array,
): SourceArtifactReference {
  return {
    relativePath,
    sha256: createHash('sha256').update(value).digest('hex'),
    bytes: value.byteLength,
  }
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeExclusiveFile(
  assignmentPath: string,
  relativePath: string,
  contents: Buffer,
): Promise<void> {
  const target = resolveRelativePathInside(assignmentPath, relativePath)
  if (!target) throw new Error('Extraction artifact path is unsafe.')
  const directory = path.dirname(target)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700)
  const directoryReal = await fs.realpath(directory)
  if (
    directoryReal !== directory ||
    !directoryReal.startsWith(`${assignmentPath}${path.sep}`)
  ) {
    throw new Error('Extraction artifact directory is unsafe.')
  }
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(
      target,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
    await handle.writeFile(contents)
    await handle.sync()
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      stat.size !== contents.byteLength ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)
    ) {
      throw new Error('Extraction artifact could not be verified.')
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function assertRegularDirectory(directory: string): Promise<void> {
  const [stat, real] = await Promise.all([fs.lstat(directory), fs.realpath(directory)])
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== directory) {
    throw new Error('Research assignment must be a regular directory.')
  }
}

function assertIdentity(identity: ObservationIdentity): void {
  for (const value of [
    identity.sessionId,
    identity.runId,
    identity.assignmentId,
    identity.activityScopeId,
  ]) {
    if (!isSafePathSegment(value)) {
      throw new Error('Extraction runtime identity is invalid.')
    }
  }
  if (!identity.agentPath.trim() || identity.agentPath.includes('\0')) {
    throw new Error('Extraction agent path is invalid.')
  }
}
