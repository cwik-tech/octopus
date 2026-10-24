import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { isPathEqualOrInside, resolveCanonicalDirectory } from '../core/path-safety.js'
import type { BatchFolderGrantStore } from '../domains/batches/batch-folder-grant-store.js'

/**
 * The native folder picker for folders shared with agents
 * (docs/feature-local-folder-access.md, SEC-1).
 *
 * Same trusted-frame rules as the Batch picker: no renderer arguments, and only
 * the owner window's main frame may open it. Unlike the Batch picker it grants
 * the folder it accepts, because the API admits a shared folder only with a
 * grant for that exact folder. The app's data folder, the workspace, or a
 * folder inside either is returned without a grant: the API refuses it with
 * its own reason, and a grant left behind would only widen what the grant list
 * admits. A parent of them, such as the home folder, is granted.
 */

export const SHARED_FOLDER_PICKER_CHANNEL = 'pipeline:select-shared-folder'

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

export function registerSharedFolderPicker(options: {
  readonly ipcMain: IpcMainLike
  readonly showOpenDialog: (
    owner: WindowLike,
  ) => Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>
  readonly grantStore: Pick<BatchFolderGrantStore, 'grant'>
  /** The app data folder and the workspace. */
  readonly protectedPaths: readonly string[]
  readonly getOwnerWindowForSender?: (sender: SenderLike, senderFrame: unknown) => WindowLike | null
  readonly getOwnerWindow: () => WindowLike | null
  readonly ownerForSender: (sender: SenderLike) => WindowLike | null
}): () => void {
  options.ipcMain.removeHandler(SHARED_FOLDER_PICKER_CHANNEL)
  options.ipcMain.handle(SHARED_FOLDER_PICKER_CHANNEL, async (event, ...args) => {
    if (args.length > 0) throw new Error('Shared folder picker does not accept renderer arguments.')
    const owner = trustedOwner(event, options)
    if (!owner) throw new Error('Shared folder picker requires the trusted main frame.')
    const result = await options.showOpenDialog(owner)
    const [selectedPath] = result.filePaths
    if (result.canceled || result.filePaths.length !== 1 || selectedPath === undefined) return null
    const canonical = await resolveCanonicalDirectory(selectedPath)
    if (!canonical) throw new Error('The selected item is not a folder.')
    const protectedRoots = await Promise.all(options.protectedPaths.map((protectedPath) =>
      fs.realpath(protectedPath).catch(() => path.resolve(protectedPath))))
    const insideProtected = protectedRoots.some((protectedRoot) => isPathEqualOrInside(protectedRoot, canonical))
    if (!insideProtected) await options.grantStore.grant(canonical)
    return { path: canonical }
  })
  return () => options.ipcMain.removeHandler(SHARED_FOLDER_PICKER_CHANNEL)
}

/** The owner window, when the request comes from its main frame; otherwise null. */
function trustedOwner(
  event: InvokeEventLike,
  options: {
    readonly getOwnerWindowForSender?: (sender: SenderLike, senderFrame: unknown) => WindowLike | null
    readonly getOwnerWindow: () => WindowLike | null
    readonly ownerForSender: (sender: SenderLike) => WindowLike | null
  },
): WindowLike | null {
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
    return null
  }
  return owner
}

export const SHARED_FOLDER_OPENER_CHANNEL = 'pipeline:open-shared-folder'

/**
 * Opens a shared folder in Finder or Explorer when the person clicks its name.
 *
 * The renderer names the path, so it is opened only when it is exactly a
 * folder in the shared-folder grant list, the folders the person picked in the
 * native dialog. Any other path, a subfolder or a file is refused.
 */
export function registerSharedFolderOpener(options: {
  readonly ipcMain: IpcMainLike
  readonly grantStore: Pick<BatchFolderGrantStore, 'list'>
  /** Electron's shell.openPath: resolves with an error message, or '' on success. */
  readonly openPath: (folderPath: string) => Promise<string>
  readonly getOwnerWindowForSender?: (sender: SenderLike, senderFrame: unknown) => WindowLike | null
  readonly getOwnerWindow: () => WindowLike | null
  readonly ownerForSender: (sender: SenderLike) => WindowLike | null
}): () => void {
  options.ipcMain.removeHandler(SHARED_FOLDER_OPENER_CHANNEL)
  options.ipcMain.handle(SHARED_FOLDER_OPENER_CHANNEL, async (event, ...args) => {
    if (!trustedOwner(event, options)) throw new Error('Opening a shared folder requires the trusted main frame.')
    const [requested] = args
    if (args.length !== 1 || typeof requested !== 'string') {
      throw new Error('Opening a shared folder takes exactly one folder path.')
    }
    const canonical = await resolveCanonicalDirectory(requested)
    if (!canonical || !(await options.grantStore.list()).includes(canonical)) {
      throw new Error('This is not a shared folder.')
    }
    const failure = await options.openPath(canonical)
    if (failure) throw new Error(failure)
    return { opened: true }
  })
  return () => options.ipcMain.removeHandler(SHARED_FOLDER_OPENER_CHANNEL)
}
