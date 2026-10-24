import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import { registerBatchFolderPicker } from '../../electron/batch-folder-picker.js'
import { registerSharedFolderPicker, registerSharedFolderOpener } from '../../electron/shared-folder-picker.js'

type Handler = Parameters<Parameters<typeof registerBatchFolderPicker>[0]['ipcMain']['handle']>[1]
type Sender = Parameters<Parameters<typeof registerBatchFolderPicker>[0]['ownerForSender']>[0]
const registrations = [
  { register: registerBatchFolderPicker, expected: null },
  { register: registerSharedFolderPicker, expected: null },
  { register: registerSharedFolderOpener, expected: 'Opening a shared folder takes exactly one folder path.' },
]
for (const { register, expected } of registrations) test(`${register.name} accepts each registered window and refuses a foreign frame`, async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'registered-folder-test-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const grantStore = new BatchFolderGrantStore(path.join(directory, 'grants.json'))
  await grantStore.initialize()
  // Native IPC and dialogs are unavailable to node:test; only those platform ports are substituted.
  const firstSender = { mainFrame: {}, isDestroyed: () => false }
  const secondSender = { mainFrame: {}, isDestroyed: () => false }
  const first = { webContents: firstSender }
  const second = { webContents: secondSender }
  const windows = [first, second]
  let handler: Handler | undefined
  const options = {
    ipcMain: { handle: (_channel: string, next: Handler) => { handler = next }, removeHandler: () => {} },
    getOwnerWindow: () => second,
    ownerForSender: (sender: Sender) => windows.find((window) => window.webContents === sender) ?? null,
    getOwnerWindowForSender: (sender: Sender, frame: unknown) => frame === sender.mainFrame ? windows.find((window) => window.webContents === sender) ?? null : null,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    grantStore,
    workspacePath: '/unused', repoRootPath: '/unused', protectedPaths: [],
    openPath: async () => '',
  }
  register(options)
  assert.ok(handler)
  const invoke = handler
  // An argument-shape failure proves a trusted opener reached its next boundary;
  // pickers have no arguments and return cancellation from their real handler.
  const outcome = (sender: Sender) => invoke({ sender, senderFrame: sender.mainFrame }).catch((error: unknown) => error instanceof Error ? error.message : String(error))
  assert.equal(await outcome(firstSender), expected)
  assert.equal(await outcome(secondSender), expected)
  await assert.rejects(invoke({ sender: firstSender, senderFrame: {} }), /trusted main frame/)
  const foreign = { mainFrame: {}, isDestroyed: () => false }
  await assert.rejects(invoke({ sender: foreign, senderFrame: foreign.mainFrame }), /trusted main frame/)
})
