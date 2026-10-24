import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  acquireProcessFileLock,
  createCrossProcessFileLockRecord,
  crossProcessFileLockAdapter,
  ProcessFileLockError,
  readProcessFileLockRecord,
} from '../../core/cross-process-file-lock.js'
import { hasErrorCode } from '../../core/node-errors.js'

/**
 * A lock file that is gone and a lock file that is unreadable are different
 * facts, and only one of them is damage.
 *
 * `acquireProcessFileLock` loses the exclusive create when someone else holds
 * the lock, and then reads the record that beat it. If that holder releases in
 * between, the file is simply absent — the lock is free. Collapsing that into
 * the same "could not read a record" answer as malformed bytes is what let a
 * benign hand-off be reported as `corrupt`, which the execution journal treats
 * as permanent: it takes this lock on every append, so an enrolled assignment
 * could be failed closed for good by nothing worse than contention.
 *
 * These cases pin the distinction at the boundary that has to make it, using a
 * real temporary filesystem so ENOENT is a real ENOENT and malformed bytes are
 * really on disk. Nothing here races, sleeps, polls, or mocks a module.
 */
test('a lock path with no file reports missing rather than invalid', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-record-missing-'))
  try {
    const read = await readProcessFileLockRecord(
      path.join(directory, 'journal.lock'),
      crossProcessFileLockAdapter,
    )
    assert.equal(
      read.kind,
      'missing',
      'a lock nobody holds is absent, not damaged — this is the release case',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a lock file holding malformed bytes reports invalid', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-record-invalid-'))
  try {
    const lockPath = path.join(directory, 'journal.lock')
    fs.writeFileSync(lockPath, 'not-json\n', { mode: 0o600 })

    const read = await readProcessFileLockRecord(lockPath, crossProcessFileLockAdapter)
    assert.equal(read.kind, 'invalid', 'bytes that exist and do not parse are damage')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a lock file holding JSON the adapter rejects reports invalid', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-record-rejected-'))
  try {
    const lockPath = path.join(directory, 'journal.lock')
    // Parses as JSON, but carries no usable pid or nonce.
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 'nope' })}\n`, { mode: 0o600 })

    const read = await readProcessFileLockRecord(lockPath, crossProcessFileLockAdapter)
    assert.equal(
      read.kind,
      'invalid',
      'a well-formed document that is not a lock record is still damage',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a lock file holding a real record reports it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-record-present-'))
  try {
    const lockPath = path.join(directory, 'journal.lock')
    const written = createCrossProcessFileLockRecord()
    fs.writeFileSync(lockPath, `${JSON.stringify(written)}\n`, { mode: 0o600 })

    const read = await readProcessFileLockRecord(lockPath, crossProcessFileLockAdapter)
    // Narrowed by assertion rather than by an early return, so the field
    // checks below always run instead of being silently skipped.
    assert.ok(
      read.kind === 'record',
      `a published record must read back as one, got: ${read.kind}`,
    )
    assert.equal(read.record.pid, written.pid)
    assert.equal(read.record.nonce, written.nonce)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * Absence is the only read failure this boundary is allowed to interpret.
 *
 * A read that fails for any other reason — a permission change, a directory
 * where the lock belongs, an I/O fault — carries no information about what the
 * record contains. Flattening it into `invalid` would report damage that was
 * never observed, and `missing` would report a free lock that may well be
 * held. Both are worse than surfacing the real error, so it is rethrown.
 */
test('a read that fails for a reason other than absence keeps its own error', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-record-unreadable-'))
  try {
    const lockPath = path.join(directory, 'journal.lock')
    // A directory standing where the lock file belongs: reading it fails with
    // EISDIR on a real filesystem, with no guessing and no injected fault.
    fs.mkdirSync(lockPath)

    await assert.rejects(
      readProcessFileLockRecord(lockPath, crossProcessFileLockAdapter),
      (error: unknown) => hasErrorCode(error, 'EISDIR'),
      'a read failure that is not absence must surface as itself rather than ' +
        'becoming a verdict about a record nobody managed to read',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * The counterpart the distinction must not cost us: a record that is *there*
 * and unreadable is damage, and acquisition must still fail closed on it.
 */
test('acquisition still fails closed on a lock record that exists and cannot be parsed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-acquire-corrupt-'))
  try {
    const lockPath = path.join(directory, 'journal.lock')
    fs.writeFileSync(lockPath, 'not-json\n', { mode: 0o600 })

    await assert.rejects(
      acquireProcessFileLock({
        lockPath,
        record: createCrossProcessFileLockRecord(),
        adapter: crossProcessFileLockAdapter,
        timeoutMs: 0,
        waitDescription: 'corrupt record probe',
      }),
      (error: unknown) =>
        error instanceof ProcessFileLockError && error.code === 'corrupt',
      'an unparseable record present on disk must still be reported as corrupt',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
