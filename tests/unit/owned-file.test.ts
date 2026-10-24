import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  ensureOwnedDirectory,
  openOwnedFileForAppend,
  openOwnedFileForRead,
} from '../../core/owned-file.js'

/**
 * AC20: the primitive both evidence writers share.
 *
 * Its promise is that a redirected path is refused *and* that nothing outside
 * the container is touched while finding that out. The second half is the
 * easier one to lose: a check that creates directories on the way to
 * discovering it should not have already written outside.
 */

async function makeRoot(t: { after(fn: () => unknown): void }): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-file-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('a nested parent is refused before anything is created', async (t) => {
  const root = await makeRoot(t)
  const container = path.join(root, 'container')
  const outside = path.join(root, 'outside')
  await fs.mkdir(container, { recursive: true, mode: 0o700 })
  await fs.mkdir(outside, { recursive: true, mode: 0o700 })
  // `container/a` leads out of the container. A recursive `mkdir` on
  // `container/a/b` would create `b` inside `outside` and only then discover
  // that the path was redirected — the damage already done.
  await fs.symlink(outside, path.join(container, 'a'), 'dir')

  const request = {
    containerPath: container,
    filePath: path.join(container, 'a', 'b', 'view.jsonl'),
  }
  const outcome = await ensureOwnedDirectory(request).then(
    () => 'created',
    (error: unknown) => String(error),
  )

  assert.deepEqual(
    await fs.readdir(outside),
    [],
    'nothing may be created outside the container while checking the path',
  )
  assert.match(outcome, /unsafe/i, 'and the request must be refused')
})

test('a file directly in the container is allowed', async (t) => {
  const root = await makeRoot(t)
  const container = path.join(root, 'container')
  await fs.mkdir(container, { recursive: true, mode: 0o700 })

  const handle = await openOwnedFileForAppend({
    containerPath: container,
    filePath: path.join(container, 'view.jsonl'),
  })
  try {
    await handle.writeFile('line\n', 'utf8')
  } finally {
    await handle.close()
  }

  assert.equal(
    await fs.readFile(path.join(container, 'view.jsonl'), 'utf8'),
    'line\n',
  )
})

test('one directory below the container is created and used', async (t) => {
  const root = await makeRoot(t)
  const container = path.join(root, 'container')
  await fs.mkdir(container, { recursive: true, mode: 0o700 })

  const request = {
    containerPath: container,
    filePath: path.join(container, 'logs', 'view.jsonl'),
  }
  const handle = await openOwnedFileForAppend(request)
  try {
    await handle.writeFile('line\n', 'utf8')
  } finally {
    await handle.close()
  }

  const read = await openOwnedFileForRead(request)
  assert.ok(read, 'the file it just wrote is readable through the same check')
  try {
    assert.equal(await read.readFile('utf8'), 'line\n')
  } finally {
    await read.close()
  }
})

test('an absent file reads as absent rather than as an error', async (t) => {
  const root = await makeRoot(t)
  const container = path.join(root, 'container')
  await fs.mkdir(container, { recursive: true, mode: 0o700 })

  assert.equal(
    await openOwnedFileForRead({
      containerPath: container,
      filePath: path.join(container, 'logs', 'missing.jsonl'),
    }),
    undefined,
    '"nothing is there" and "something is there and it is not ours" are ' +
      'different answers; only the second is an error',
  )
})

test('a file outside the container is refused', async (t) => {
  const root = await makeRoot(t)
  const container = path.join(root, 'container')
  await fs.mkdir(container, { recursive: true, mode: 0o700 })

  await assert.rejects(
    ensureOwnedDirectory({
      containerPath: container,
      filePath: path.join(root, 'elsewhere.jsonl'),
    }),
    /unsafe/i,
  )
})
