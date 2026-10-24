import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { BatchResultArtifact } from '../domains/batches/batch-types.js'
import type { RunStore } from '../domains/run/run-store.js'
import type { VerifiedTaskArtifact } from '../domains/sessions/task-recovery-manager.js'

export const BATCH_ARTIFACT_COUNT_LIMIT = 10
export const BATCH_ARTIFACT_BYTE_LIMIT = 25 * 1024 * 1024
export const BATCH_ITEM_RESULT_BYTE_LIMIT = 100 * 1024 * 1024

export type BatchArtifactPublication =
  | {
      readonly status: 'published'
      readonly artifacts: readonly BatchResultArtifact[]
      readonly retainedBytes: number
    }
  | {
      readonly status: 'failed'
      readonly code: 'artifact_too_large' | 'artifact_copy_failed'
      readonly detail: string
    }

export class BatchArtifactWriter {
  private readonly resultsPath: string

  constructor(private readonly options: {
    readonly workspacePath: string
    readonly runStore: Pick<RunStore, 'readArtifact'>
  }) {
    this.resultsPath = path.join(path.resolve(options.workspacePath), 'batch-results')
  }

  async publish(input: {
    readonly batchId: string
    readonly executionId: string
    readonly itemId: string
    readonly artifacts: readonly VerifiedTaskArtifact[]
  }): Promise<BatchArtifactPublication> {
    const limitsFailure = validateLimits(input.artifacts)
    if (limitsFailure) return limitsFailure
    const executionDirectory = path.join(this.resultsPath, input.batchId, input.executionId)
    const itemDirectory = path.join(executionDirectory, input.itemId)
    const expected = expectedArtifacts(input)
    const existing = await this.verifyExisting(itemDirectory, expected)
    if (existing) return existing

    await fs.mkdir(executionDirectory, { recursive: true, mode: 0o700 })
    await fs.chmod(executionDirectory, 0o700)
    const temporaryDirectory = path.join(
      executionDirectory,
      `.${input.itemId}.${crypto.randomUUID()}.tmp`,
    )
    await fs.mkdir(temporaryDirectory, { mode: 0o700 })
    try {
      const published: BatchResultArtifact[] = []
      for (const [index, verified] of input.artifacts.entries()) {
        const artifact = await this.options.runStore.readArtifact(
          verified.childRunId,
          verified.path,
          { maxBytes: BATCH_ARTIFACT_BYTE_LIMIT },
        )
        if (!artifact) {
          throw new Error(`Verified artifact is unavailable: ${verified.childRunId}/${verified.path}`)
        }
        const content = Buffer.isBuffer(artifact.content)
          ? artifact.content
          : Buffer.from(artifact.content, 'utf8')
        if (content.byteLength !== verified.byteLength || sha256(content) !== verified.sha256) {
          throw new Error(`Verified artifact content changed: ${verified.childRunId}/${verified.path}`)
        }
        const expectedArtifact = expected[index]
        if (!expectedArtifact) {
          throw new Error(`No expected destination for artifact: ${verified.childRunId}/${verified.path}`)
        }
        const destinationFile = path.join(temporaryDirectory, path.basename(expectedArtifact.destinationPath))
        const handle = await fs.open(destinationFile, 'wx', 0o600)
        try {
          await handle.writeFile(content)
          await handle.sync()
        } finally {
          await handle.close()
        }
        published.push({
          ...expectedArtifact,
          mediaType: artifact.contentType,
        })
      }
      await syncDirectory(temporaryDirectory)
      await fs.rename(temporaryDirectory, itemDirectory).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error
      })
      await syncDirectory(executionDirectory)
      const final = await this.verifyExisting(itemDirectory, published)
      if (!final) throw new Error('Batch result directory did not verify after atomic publication.')
      return final
    } catch (error) {
      return {
        status: 'failed',
        code: 'artifact_copy_failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  private async verifyExisting(
    itemDirectory: string,
    artifacts: readonly BatchResultArtifact[],
  ): Promise<Extract<BatchArtifactPublication, { status: 'published' }> | null> {
    const stat = await fs.lstat(itemDirectory).catch(() => null)
    if (!stat) return null
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null
    const entries = await fs.readdir(itemDirectory, { withFileTypes: true })
    if (
      entries.length !== artifacts.length ||
      entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    ) return null
    for (const artifact of artifacts) {
      const fileName = path.basename(artifact.destinationPath)
      if (!entries.some((entry) => entry.name === fileName)) return null
      const content = await fs.readFile(path.join(itemDirectory, fileName))
      if (content.byteLength !== artifact.byteLength || sha256(content) !== artifact.sha256) return null
    }
    return {
      status: 'published',
      artifacts,
      retainedBytes: artifacts.reduce((total, artifact) => total + artifact.byteLength, 0),
    }
  }
}

function expectedArtifacts(input: {
  readonly batchId: string
  readonly executionId: string
  readonly itemId: string
  readonly artifacts: readonly VerifiedTaskArtifact[]
}): BatchResultArtifact[] {
  return input.artifacts.map((artifact, index) => ({
    role: artifact.role === 'primary' ? 'final' : 'secondary',
    sourceRunId: artifact.childRunId,
    sourcePath: artifact.path,
    destinationPath: path.posix.join(
      input.batchId,
      input.executionId,
      input.itemId,
      `${String(index + 1).padStart(2, '0')}-${path.posix.basename(artifact.path)}`,
    ),
    mediaType: mediaTypeForPath(artifact.path),
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
  }))
}

function validateLimits(
  artifacts: readonly VerifiedTaskArtifact[],
): Extract<BatchArtifactPublication, { status: 'failed' }> | null {
  if (artifacts.length > BATCH_ARTIFACT_COUNT_LIMIT) {
    return {
      status: 'failed',
      code: 'artifact_too_large',
      detail: 'Verified publication exceeds the 10 artifact limit.',
    }
  }
  if (artifacts.some((artifact) => artifact.byteLength > BATCH_ARTIFACT_BYTE_LIMIT)) {
    return {
      status: 'failed',
      code: 'artifact_too_large',
      detail: 'A verified artifact exceeds the 25 MiB per-artifact limit.',
    }
  }
  const total = artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0)
  if (total > BATCH_ITEM_RESULT_BYTE_LIMIT) {
    return {
      status: 'failed',
      code: 'artifact_too_large',
      detail: 'Verified publication exceeds the 100 MiB per-item result limit.',
    }
  }
  return null
}

function mediaTypeForPath(artifactPath: string): string {
  const extension = path.posix.extname(artifactPath).toLowerCase()
  if (extension === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (extension === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (extension === '.json') return 'application/json; charset=utf-8'
  if (extension === '.md') return 'text/markdown; charset=utf-8'
  return 'text/plain; charset=utf-8'
}

function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
