import {
  isPathEqualOrInside,
  resolveCanonicalDirectory,
} from '../core/path-safety.js'
import type { BatchFolderGrantStore } from '../domains/batches/batch-folder-grant-store.js'

export const BATCH_FOLDER_PICKER_CHANNEL = 'pipeline:select-batch-folder'

interface SenderLike {
  readonly mainFrame?: unknown
  isDestroyed(): boolean
}

interface WindowLike {
  readonly webContents: SenderLike
}

interface InvokeEventLike {
  readonly sender: SenderLike
  readonly senderFrame: unknown
}

interface IpcMainLike {
  handle(
    channel: string,
    handler: (event: InvokeEventLike, ...args: unknown[]) => Promise<unknown>,
  ): void
  removeHandler(channel: string): void
}

export function registerBatchFolderPicker(options: {
  readonly ipcMain: IpcMainLike
  readonly showOpenDialog: (
    owner: WindowLike,
  ) => Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>
  readonly grantStore: Pick<BatchFolderGrantStore, 'grant'>
  readonly workspacePath: string
  readonly repoRootPath: string
  readonly getOwnerWindowForSender?: (sender: SenderLike, senderFrame: unknown) => WindowLike | null
  readonly getOwnerWindow: () => WindowLike | null
  readonly ownerForSender: (sender: SenderLike) => WindowLike | null
}): () => void {
  options.ipcMain.removeHandler(BATCH_FOLDER_PICKER_CHANNEL)
  options.ipcMain.handle(BATCH_FOLDER_PICKER_CHANNEL, async (event, ...args) => {
    if (args.length > 0) throw new Error('Batch folder picker does not accept renderer arguments.')
    const owner = options.getOwnerWindowForSender
      ? options.getOwnerWindowForSender(event.sender, event.senderFrame)
      : options.getOwnerWindow()
    if (
      !owner ||
      event.sender.isDestroyed() ||
      event.sender !== owner.webContents ||
      options.ownerForSender(event.sender) !== owner ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error('Batch folder picker requires the trusted main frame.')
    }
    const result = await options.showOpenDialog(owner)
    const [selectedPath] = result.filePaths
    if (result.canceled || result.filePaths.length !== 1 || selectedPath === undefined) return null
    const canonical = await resolveCanonicalDirectory(selectedPath)
    if (!canonical) throw new Error('Selected Batch folder is not an owned directory.')
    const [workspaceRoot, repositoryRoot] = await Promise.all([
      resolveCanonicalDirectory(options.workspacePath),
      resolveCanonicalDirectory(options.repoRootPath),
    ])
    if (
      !workspaceRoot || !repositoryRoot ||
      (!isPathEqualOrInside(workspaceRoot, canonical) &&
        !isPathEqualOrInside(repositoryRoot, canonical))
    ) {
      await options.grantStore.grant(canonical)
    }
    return { path: canonical }
  })
  return () => options.ipcMain.removeHandler(BATCH_FOLDER_PICKER_CHANNEL)
}
