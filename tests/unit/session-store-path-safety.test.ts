import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-path-safety-'))
}

test('FileSystemSessionStore rejects traversal filenames and unsafe parsed outputs', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Path safety' })
    const metadataPath = path.join(
      workspacePath,
      'sessions',
      session.id,
      'session.json',
    )

    assert.equal(await store.deleteFile(session.id, '../session.json'), false)
    assert.equal(await store.deleteFile(session.id, '%2e%2e%2fsession.json'), false)
    assert.equal(fs.existsSync(metadataPath), true)

    await store.saveUploadedFile(session.id, {
      filename: 'notes.txt',
      contents: Buffer.from('notes'),
    })
    const parsedDir = path.join(store.inputsDir(session.id), 'parsed')
    fs.mkdirSync(parsedDir, { recursive: true })
    fs.writeFileSync(
      path.join(parsedDir, '_manifest.json'),
      JSON.stringify({
        generated_at: new Date().toISOString(),
        files: [{
          source: 'notes.txt',
          status: 'success',
          outputs: { text: '../../session.json' },
        }],
      }),
    )

    assert.equal(await store.deleteFile(session.id, 'notes.txt'), true)
    assert.equal(fs.existsSync(metadataPath), true)
    assert.ok(await store.getSession(session.id))
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemSessionStore rejects non-UUID task identifiers', async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Task ids' })

    assert.equal(await store.getTaskRecord(session.id, '../task'), null)
    assert.equal(
      await store.updateTaskRecord(session.id, '%2e%2e', { status: 'failed' }),
      null,
    )
    assert.throws(
      () => store.taskDir(session.id, '../task'),
      /Invalid session or task id/,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemSessionStore rejects input directories that escape through symlinks', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Symlink guard' })
    const outsideDir = path.join(workspacePath, 'outside-inputs')
    const inputsDir = path.join(workspacePath, 'sessions', session.id, 'inputs')
    fs.mkdirSync(outsideDir, { recursive: true })
    fs.symlinkSync(outsideDir, inputsDir)

    const saved = await store.saveUploadedFile(session.id, {
      filename: 'notes.txt',
      contents: Buffer.from('notes'),
    })

    assert.equal(saved, null)
    assert.equal(fs.existsSync(path.join(outsideDir, 'notes.txt')), false)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemSessionStore does not follow a dangling upload symlink', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Dangling symlink guard' })
    const inputsDir = store.inputsDir(session.id)
    const outsidePath = path.join(workspacePath, 'outside-upload.txt')
    fs.mkdirSync(inputsDir, { recursive: true })
    fs.symlinkSync(outsidePath, path.join(inputsDir, 'notes.txt'))

    const saved = await store.saveUploadedFile(session.id, {
      filename: 'notes.txt',
      contents: Buffer.from('must stay inside'),
    })

    assert.equal(saved, null)
    assert.equal(fs.existsSync(outsidePath), false)
    assert.equal(fs.lstatSync(path.join(inputsDir, 'notes.txt')).isSymbolicLink(), true)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemSessionStore does not list uploaded-file symlinks', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = makeWorkspace()
  try {
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Listed symlink guard' })
    const inputsDir = store.inputsDir(session.id)
    const outsidePath = path.join(workspacePath, 'outside-existing.txt')
    fs.mkdirSync(inputsDir, { recursive: true })
    fs.writeFileSync(outsidePath, 'outside')
    fs.symlinkSync(outsidePath, path.join(inputsDir, 'linked.txt'))

    assert.deepEqual(await store.listFiles(session.id), [])
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
