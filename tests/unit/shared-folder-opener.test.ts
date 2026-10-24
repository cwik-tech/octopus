import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import {
  SHARED_FOLDER_OPENER_CHANNEL,
  registerSharedFolderOpener,
} from '../../electron/shared-folder-picker.js'

/**
 * Opening a shared folder in Finder or Explorer from its name.
 *
 * The renderer names a path, so the handler opens it only when it is exactly a
 * folder the person picked: an arbitrary path from a compromised page must not
 * reach the operating system's file manager.
 */

type OpenerOptions = Parameters<typeof registerSharedFolderOpener>[0]
type Handler = Parameters<OpenerOptions['ipcMain']['handle']>[1]
type InvokeEvent = Parameters<Handler>[0]

async function setUp(t: TestContext, openPathError = '') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shared-folder-opener-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const granted = path.join(root, 'Contracts')
  const other = path.join(root, 'Other')
  await fs.mkdir(granted)
  await fs.mkdir(other)
  const grantStore = new BatchFolderGrantStore(path.join(root, 'grants.json'))
  await grantStore.initialize()
  await grantStore.grant(granted)
  const mainFrame = { id: 1 }
  const ownerWebContents = { mainFrame, isDestroyed: () => false }
  const ownerWindow = { webContents: ownerWebContents }
  const opened: string[] = []
  let handler: Handler | undefined
  const dispose = registerSharedFolderOpener({
    ipcMain: {
      handle(channel, next) {
        assert.equal(channel, SHARED_FOLDER_OPENER_CHANNEL)
        handler = next
      },
      removeHandler() {
        handler = undefined
      },
    },
    grantStore,
    // Electron's shell.openPath resolves with an error message, or '' on success.
    openPath: async (folderPath) => {
      opened.push(folderPath)
      return openPathError
    },
    getOwnerWindow: () => ownerWindow,
    ownerForSender: (sender) => (sender === ownerWebContents ? ownerWindow : null),
  })
  const invoke = (event: InvokeEvent, ...args: unknown[]): Promise<unknown> => {
    assert.ok(handler, 'the opener is registered')
    return handler(event, ...args)
  }
  return {
    granted, other, opened, dispose, invoke,
    trusted: { sender: ownerWebContents, senderFrame: mainFrame },
    otherFrame: { sender: ownerWebContents, senderFrame: { id: 2 } },
  }
}

test('a granted folder is opened in the file manager', async (t) => {
  const opener = await setUp(t)

  assert.deepEqual(await opener.invoke(opener.trusted, opener.granted), { opened: true })
  assert.deepEqual(opener.opened, [opener.granted])
})

test('a folder that was never granted, a subfolder of a granted one, or a file is not opened', async (t) => {
  const opener = await setUp(t)
  const sub = path.join(opener.granted, 'Clients')
  await fs.mkdir(sub)
  const file = path.join(opener.granted, 'note.txt')
  await fs.writeFile(file, 'x')

  for (const candidate of [opener.other, sub, file, 'Contracts', path.join(opener.granted, '..', 'Other')]) {
    await assert.rejects(opener.invoke(opener.trusted, candidate), /not a shared folder/i, candidate)
  }
  assert.deepEqual(opener.opened, [])
})

test('a request from another frame, or with anything but one path, is refused', async (t) => {
  const opener = await setUp(t)

  await assert.rejects(opener.invoke(opener.otherFrame, opener.granted), /trusted main frame/i)
  await assert.rejects(opener.invoke(opener.trusted), /one folder path/i)
  await assert.rejects(opener.invoke(opener.trusted, opener.granted, 'extra'), /one folder path/i)
  await assert.rejects(opener.invoke(opener.trusted, 42), /one folder path/i)
  assert.deepEqual(opener.opened, [])
})

test('a failure reported by the file manager is passed back', async (t) => {
  const opener = await setUp(t, 'Finder could not open it')

  await assert.rejects(opener.invoke(opener.trusted, opener.granted), /Finder could not open it/)
})
