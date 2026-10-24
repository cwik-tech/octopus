import type { BatchRerunPolicy, BatchExecution } from './batch-types.js'
import type { BatchScannedFile } from './batch-folder-scanner.js'

export interface BatchFileSelection {
  readonly file: BatchScannedFile
  readonly selected: boolean
  readonly skipReason?: 'already_processed' | 'unchanged'
}

export function selectBatchFiles(
  policy: BatchRerunPolicy,
  files: readonly BatchScannedFile[],
  history: readonly BatchExecution[],
): BatchFileSelection[] {
  const latestSuccess = new Map<string, { hash: string; order: string }>()
  for (const execution of history) {
    for (const item of execution.items) {
      if (item.status !== 'done') continue
      const order = `${item.completedAt ?? execution.completedAt ?? execution.updatedAt}\0${execution.id}\0${item.id}`
      const current = latestSuccess.get(item.fileName)
      if (!current || order > current.order) {
        latestSuccess.set(item.fileName, { hash: item.sourceSha256, order })
      }
    }
  }
  return files.map((file) => {
    if (policy === 'always') return { file, selected: true }
    const successful = latestSuccess.get(file.fileName)
    if (!successful) return { file, selected: true }
    if (policy === 'new_only') {
      return { file, selected: false, skipReason: 'already_processed' }
    }
    return successful.hash === file.sourceSha256
      ? { file, selected: false, skipReason: 'unchanged' }
      : { file, selected: true }
  })
}
