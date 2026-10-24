/**
 * A no-follow read still has to be a bounded read.
 *
 * The file is untrusted input: refusing to follow a link stops it pointing
 * somewhere else, and says nothing about how large it is. Checking the size
 * after reading has already done the damage, so the bound is taken from the
 * opened handle — after the open, so it describes the file actually read, and
 * before any content is pulled into memory.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  readPrivateFile,
  UnsafeWorkspacePathError,
} from '../../services/safe-workspace-directory.js'

function makeDirectory(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

test('a file larger than the bound is refused rather than read', async () => {
  const directory = makeDirectory('safe-read-oversized-')
  try {
    const target = path.join(directory, 'oversized.json')
    fs.writeFileSync(target, 'x'.repeat(4096), 'utf8')

    await assert.rejects(
      readPrivateFile(target, { maxBytes: 1024 }),
      (error: unknown) => error instanceof UnsafeWorkspacePathError,
      'the bound is enforced from the handle, not after the content is in memory',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a file within the bound reads normally', async () => {
  const directory = makeDirectory('safe-read-ok-')
  try {
    const target = path.join(directory, 'small.json')
    fs.writeFileSync(target, 'hello', 'utf8')
    assert.equal(await readPrivateFile(target, { maxBytes: 1024 }), 'hello')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an absent file is absent, not an error', async () => {
  const directory = makeDirectory('safe-read-absent-')
  try {
    assert.equal(
      await readPrivateFile(path.join(directory, 'nothing'), { maxBytes: 1024 }),
      undefined,
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
