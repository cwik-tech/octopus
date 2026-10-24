import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import {
  SHARED_FOLDER_PICKER_CHANNEL,
  registerSharedFolderPicker,
} from '../../electron/shared-folder-picker.js'

/**
 * The native picker for shared folders (LF-01; SEC-1).
 *
 * It keeps the Batch picker's trusted-frame rules, but grants every folder it
 * accepts. The Batch picker skips the grant inside the repository, and a shared
 * folder without a grant would then be refused by the API.
 */

type PickerOptions = Parameters<typeof registerSharedFolderPicker>[0]
type Handler = Parameters<PickerOptions['ipcMain']['handle']>[1]
type InvokeEvent = Parameters<Handler>[0]

async function setUp(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shared-folder-picker-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const repoFolder = path.join(root, 'repo', 'docs')
  const externalFolder = path.join(root, 'external')
  const appData = path.join(root, 'home', 'Library', 'App')
  await fs.mkdir(appData, { recursive: true })
  await fs.mkdir(repoFolder, { recursive: true })
  await fs.mkdir(externalFolder)
  const grantStore = new BatchFolderGrantStore(path.join(root, 'grants.json'))
  await grantStore.initialize()
  const mainFrame = { id: 1 }
  const ownerWebContents = { mainFrame, isDestroyed: () => false }
  const ownerWindow = { webContents: ownerWebContents }
  let handler: Handler | undefined
  let dialog: { canceled: boolean; filePaths: string[] } = { canceled: false, filePaths: [externalFolder] }
  const dispose = registerSharedFolderPicker({
    ipcMain: {
      handle(channel, next) {
        assert.equal(channel, SHARED_FOLDER_PICKER_CHANNEL)
        handler = next
      },
      removeHandler() {
        handler = undefined
      },
    },
    showOpenDialog: async () => dialog,
    grantStore,
    protectedPaths: [appData],
    getOwnerWindow: () => ownerWindow,
    ownerForSender: (sender) => (sender === ownerWebContents ? ownerWindow : null),
  })
  const invoke = (event: InvokeEvent, ...args: unknown[]): Promise<unknown> => {
    assert.ok(handler, 'the picker is registered')
    return handler(event, ...args)
  }
  return {
    grantStore, repoFolder, externalFolder, appData, home: path.join(root, 'home'), dispose, invoke,
    trusted: { sender: ownerWebContents, senderFrame: mainFrame },
    otherSender: { sender: { mainFrame, isDestroyed: () => false }, senderFrame: mainFrame },
    otherFrame: { sender: ownerWebContents, senderFrame: { id: 2 } },
    choose: (next: { canceled: boolean; filePaths: string[] }) => { dialog = next },
    isRegistered: () => handler !== undefined,
  }
}

test('a folder chosen in the dialog is granted and returned by its canonical path', async (t) => {
  const picker = await setUp(t)

  assert.deepEqual(await picker.invoke(picker.trusted), { path: picker.externalFolder })
  assert.deepEqual(await picker.grantStore.list(), [picker.externalFolder])
})

test('a folder inside the repository is granted too', async (t) => {
  const picker = await setUp(t)
  picker.choose({ canceled: false, filePaths: [picker.repoFolder] })

  assert.deepEqual(await picker.invoke(picker.trusted), { path: picker.repoFolder })
  assert.deepEqual(await picker.grantStore.list(), [picker.repoFolder])
})

test('a cancelled dialog grants nothing', async (t) => {
  const picker = await setUp(t)
  picker.choose({ canceled: true, filePaths: [] })

  assert.equal(await picker.invoke(picker.trusted), null)
  assert.deepEqual(await picker.grantStore.list(), [])
})

test('renderer arguments and untrusted senders are refused before any dialog opens', async (t) => {
  const picker = await setUp(t)

  await assert.rejects(picker.invoke(picker.trusted, '/etc'), /arguments/i)
  await assert.rejects(picker.invoke(picker.otherSender), /trusted main frame/i)
  await assert.rejects(picker.invoke(picker.otherFrame), /trusted main frame/i)
  assert.deepEqual(await picker.grantStore.list(), [])
  picker.dispose()
  assert.equal(picker.isRegistered(), false)
})

test('the app data folder, or one inside it, is returned but never granted, while a parent of it is granted', async (t) => {
  const picker = await setUp(t)
  const insideAppData = path.join(picker.appData, 'browser-profile')
  await fs.mkdir(insideAppData)

  for (const chosen of [picker.appData, insideAppData]) {
    picker.choose({ canceled: false, filePaths: [chosen] })
    assert.deepEqual(await picker.invoke(picker.trusted), { path: chosen })
  }
  // The API refuses these with its own reason. A grant left behind would widen
  // what else the grant list admits.
  assert.deepEqual(await picker.grantStore.list(), [])

  picker.choose({ canceled: false, filePaths: [picker.home] })
  assert.deepEqual(await picker.invoke(picker.trusted), { path: picker.home })
  assert.deepEqual(await picker.grantStore.list(), [picker.home])
})
