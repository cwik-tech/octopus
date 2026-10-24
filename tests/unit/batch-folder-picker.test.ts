import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import {
  BATCH_FOLDER_PICKER_CHANNEL,
  registerBatchFolderPicker,
} from '../../electron/batch-folder-picker.js'

test('Batch folder picker accepts only the owned main frame and grants only external canonical folders', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-folder-picker-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const externalPath = path.join(root, 'external')
  await Promise.all([workspacePath, repoRootPath, externalPath].map((directory) => fs.mkdir(directory)))
  const grantStore = new BatchFolderGrantStore(path.join(root, 'grants.json'))
  await grantStore.initialize()
  const mainFrame = { id: 1 }
  const ownerWebContents = { id: 1, mainFrame, isDestroyed: () => false }
  const ownerWindow = { webContents: ownerWebContents }
  let handler: ((event: any, ...args: unknown[]) => Promise<unknown>) | undefined
  const ipcMain = {
    handle(channel: string, next: typeof handler) {
      assert.equal(channel, BATCH_FOLDER_PICKER_CHANNEL)
      handler = next
    },
    removeHandler() {
      handler = undefined
    },
  }
  let selectedPath = externalPath
  const dispose = registerBatchFolderPicker({
    ipcMain,
    async showOpenDialog() {
      return { canceled: false, filePaths: [selectedPath] }
    },
    grantStore,
    workspacePath,
    repoRootPath,
    getOwnerWindow: () => ownerWindow,
    ownerForSender: (sender) => sender === ownerWebContents ? ownerWindow : null,
  })
  assert.ok(handler)
  const trustedEvent = { sender: ownerWebContents, senderFrame: mainFrame }

  assert.deepEqual(await handler!(trustedEvent), { path: await fs.realpath(externalPath) })
  assert.deepEqual(await grantStore.list(), [await fs.realpath(externalPath)])
  await assert.rejects(handler!(trustedEvent, { rendererOption: true }), /arguments/i)
  await assert.rejects(
    handler!({ sender: { id: 2, mainFrame, isDestroyed: () => false }, senderFrame: mainFrame }),
    /trusted main frame/i,
  )
  await assert.rejects(
    handler!({ sender: ownerWebContents, senderFrame: { id: 2 } }),
    /trusted main frame/i,
  )

  selectedPath = workspacePath
  assert.deepEqual(await handler!(trustedEvent), { path: await fs.realpath(workspacePath) })
  assert.deepEqual(await grantStore.list(), [await fs.realpath(externalPath)])
  dispose()
  assert.equal(handler, undefined)
})
