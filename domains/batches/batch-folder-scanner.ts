export interface BatchScanLimits {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}
export interface BatchScannedFile {
  readonly ordinal: number
  readonly fileName: string
  readonly sourceSize: number
  readonly sourceMtime: string
  readonly sourceSha256: string
  readonly canonicalPath: string
}
export interface BatchFolderScanResult {
  readonly canonicalFolderPath: string
  readonly files: readonly BatchScannedFile[]
  readonly totalBytes: number
  readonly sourceSnapshotSha256: string
}
export interface ScanBatchFolderInput {
  readonly folderPath: string
  readonly fileExtensions: readonly string[]
  readonly limits?: BatchScanLimits
  readonly signal?: AbortSignal
}
export class BatchFolderScanError extends Error {
  constructor(
    readonly code: 'batch_too_large' | 'folder_access_denied' | 'source_changed',
    message: string = code,
    readonly detail?: {
      readonly fileCount: number
      readonly totalBytes: number
      readonly maxFiles: number
      readonly maxFileBytes: number
      readonly maxTotalBytes: number
      readonly fileName?: string
    },
  ) {
    super(message)
    this.name = 'BatchFolderScanError'
  }
}

export async function scanBatchFolder(input: ScanBatchFolderInput): Promise<BatchFolderScanResult> {
  throwIfSignalAborted(input.signal)
  const limits = input.limits ?? DEFAULT_BATCH_SCAN_LIMITS
  validateLimits(limits)
  const canonicalFolderPath = await fs.realpath(input.folderPath).catch(() => null)
  if (!canonicalFolderPath) {
    throw new BatchFolderScanError('folder_access_denied', 'Batch folder does not exist.')
  }
  const folderStat = await fs.lstat(canonicalFolderPath).catch(() => null)
  if (!folderStat?.isDirectory() || folderStat.isSymbolicLink()) {
    throw new BatchFolderScanError('folder_access_denied', 'Batch folder is not a regular directory.')
  }
  const extensionFilter = new Set(input.fileExtensions.map((value) => value.toLowerCase()))
  const entries = await fs.readdir(canonicalFolderPath, { withFileTypes: true })
  const eligible = entries
    .filter((entry) =>
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      !entry.name.startsWith('.') &&
      entry.name !== '_manifest.json' &&
      (extensionFilter.size === 0 || extensionFilter.has(path.extname(entry.name).toLowerCase())),
    )
    .sort((left, right) => Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8')))

  if (eligible.length > limits.maxFiles) {
    throw tooLarge(eligible.length, 0, limits)
  }

  const candidates: Array<{
    fileName: string
    canonicalPath: string
    size: number
    mtime: string
  }> = []
  let totalBytes = 0
  for (const entry of eligible) {
    throwIfSignalAborted(input.signal)
    const entryPath = path.join(canonicalFolderPath, entry.name)
    const [entryStat, canonicalPath] = await Promise.all([
      fs.lstat(entryPath).catch(() => null),
      fs.realpath(entryPath).catch(() => null),
    ])
    if (
      !entryStat?.isFile() ||
      entryStat.isSymbolicLink() ||
      !canonicalPath ||
      !isPathInside(canonicalFolderPath, canonicalPath)
    ) {
      continue
    }
    totalBytes += entryStat.size
    if (entryStat.size > limits.maxFileBytes || totalBytes > limits.maxTotalBytes) {
      throw tooLarge(eligible.length, totalBytes, limits, entry.name)
    }
    candidates.push({
      fileName: entry.name,
      canonicalPath,
      size: entryStat.size,
      mtime: entryStat.mtime.toISOString(),
    })
  }

  const files: BatchScannedFile[] = []
  for (const [ordinal, candidate] of candidates.entries()) {
    throwIfSignalAborted(input.signal)
    const handle = await fs.open(candidate.canonicalPath, 'r')
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size !== candidate.size || before.mtime.toISOString() !== candidate.mtime) {
        throw new BatchFolderScanError('source_changed', `Batch source changed during scan: ${candidate.fileName}`)
      }
      const hash = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        throwIfSignalAborted(input.signal)
        // A stream opened without an encoding yields Buffers; Node types the
        // chunk as `any`, so it is checked before it reaches the hash.
        if (!Buffer.isBuffer(chunk)) throw new Error('Batch source stream yielded a non-binary chunk.')
        hash.update(chunk)
      }
      const after = await handle.stat()
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new BatchFolderScanError('source_changed', `Batch source changed during scan: ${candidate.fileName}`)
      }
      files.push({
        ordinal,
        fileName: candidate.fileName,
        sourceSize: before.size,
        sourceMtime: before.mtime.toISOString(),
        sourceSha256: hash.digest('hex'),
        canonicalPath: candidate.canonicalPath,
      })
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  const snapshot = createHash('sha256')
  for (const file of files) {
    const name = Buffer.from(file.fileName, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(name.length)
    snapshot.update(header)
    snapshot.update(name)
    snapshot.update('\0')
    snapshot.update(String(file.sourceSize))
    snapshot.update('\0')
    snapshot.update(file.sourceMtime)
    snapshot.update('\0')
    snapshot.update(file.sourceSha256)
    snapshot.update('\n')
  }
  return {
    canonicalFolderPath,
    files,
    totalBytes,
    sourceSnapshotSha256: snapshot.digest('hex'),
  }
}

function validateLimits(limits: BatchScanLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Batch scan limit ${key} must be a positive integer.`)
    }
  }
}

function tooLarge(
  fileCount: number,
  totalBytes: number,
  limits: BatchScanLimits,
  fileName?: string,
): BatchFolderScanError {
  return new BatchFolderScanError(
    'batch_too_large',
    'Batch folder exceeds fixed processing limits.',
    {
      fileCount,
      totalBytes,
      maxFiles: limits.maxFiles,
      maxFileBytes: limits.maxFileBytes,
      maxTotalBytes: limits.maxTotalBytes,
      ...(fileName ? { fileName } : {}),
    },
  )
}
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { throwIfSignalAborted } from '../../core/file-mutation.js'
import { isPathInside } from '../../core/path-safety.js'

export const DEFAULT_BATCH_SCAN_LIMITS: BatchScanLimits = {
  maxFiles: 50,
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
}
