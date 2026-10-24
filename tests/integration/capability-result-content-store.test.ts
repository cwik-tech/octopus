import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {
  CapabilityResultContentReceipt,
  CapabilityResultContentStore,
} from '../../contracts/durable-dispatch.js'
import {
  capabilityResultsDirectoryPath,
  createAssignmentCapabilityResultStore,
} from '../../services/capability-result-content-store.js'

/**
 * Phase 3: exact capability results are owned by the assignment and kept
 * outside its execution journal. The store is the only thing that may hold
 * them, so every way it can hand back something other than the exact accepted
 * bytes has to be its own answer rather than an empty read.
 */

const CANONICAL = '{"kind":"browser.snapshot","text":"content-store-sentinel"}'
const DIGEST = createHash('sha256').update(CANONICAL, 'utf8').digest('hex')
const BYTE_LENGTH = Buffer.byteLength(CANONICAL, 'utf8')

test('a written result lands in the assignment store and never in the journal', async () => {
  await withAssignment(async ({ assignmentPath, store }) => {
    const written = await store.write(CANONICAL)

    assert.equal(written.kind, 'stored')
    if (written.kind !== 'stored') return
    assert.deepEqual(written.receipt, {
      contentId: DIGEST,
      contentSha256: DIGEST,
      byteLength: BYTE_LENGTH,
      mediaType: 'application/json',
      resultSchemaVersion: 2,
    })

    const storeDirectory = capabilityResultsDirectoryPath(assignmentPath)
    assert.equal(
      storeDirectory,
      path.join(assignmentPath, '.runtime', 'capability-results'),
    )
    const entries = fs.readdirSync(storeDirectory)
    assert.deepEqual(entries, [`${DIGEST}.json`])
    assert.equal(fs.statSync(storeDirectory).mode & 0o777, 0o700)
    assert.equal(
      fs.statSync(path.join(storeDirectory, `${DIGEST}.json`)).mode & 0o777,
      0o600,
    )
    assert.equal(
      fs.existsSync(
        path.join(assignmentPath, '.runtime', 'execution-journal', 'results'),
      ),
      false,
    )
  })
})

test('writing the same bytes twice keeps one file and the same receipt', async () => {
  await withAssignment(async ({ assignmentPath, store }) => {
    const first = await store.write(CANONICAL)
    const second = await store.write(CANONICAL)

    assert.equal(first.kind, 'stored')
    assert.equal(second.kind, 'stored')
    if (first.kind !== 'stored' || second.kind !== 'stored') return
    assert.deepEqual(second.receipt, first.receipt)
    assert.equal(
      fs.readdirSync(capabilityResultsDirectoryPath(assignmentPath)).length,
      1,
    )
  })
})

test('an identity already holding different bytes conflicts instead of being overwritten', async () => {
  await withAssignment(async ({ assignmentPath, store }) => {
    await store.write(CANONICAL)
    const contentPath = path.join(
      capabilityResultsDirectoryPath(assignmentPath),
      `${DIGEST}.json`,
    )
    fs.writeFileSync(contentPath, '{"kind":"tampered"}', { mode: 0o600 })

    const rewritten = await store.write(CANONICAL)

    assert.equal(rewritten.kind, 'conflict')
    if (rewritten.kind !== 'conflict') return
    assert.equal(rewritten.contentId, DIGEST)
    assert.equal(fs.readFileSync(contentPath, 'utf8'), '{"kind":"tampered"}')
  })
})

test('a write leaves no temporary file behind', async () => {
  await withAssignment(async ({ assignmentPath, store }) => {
    await store.write(CANONICAL)

    const entries = fs.readdirSync(capabilityResultsDirectoryPath(assignmentPath))
    assert.deepEqual(
      entries.filter((entry) => entry.includes('.tmp-')),
      [],
    )
  })
})

test('a result past the store bound is refused rather than written', async () => {
  await withAssignment(
    async ({ assignmentPath, store }) => {
      const written = await store.write(CANONICAL)

      assert.equal(written.kind, 'too_large')
      if (written.kind !== 'too_large') return
      assert.equal(written.byteLength, BYTE_LENGTH)
      assert.equal(written.maxByteLength, 8)
      assert.equal(
        fs.existsSync(capabilityResultsDirectoryPath(assignmentPath)),
        false,
      )
    },
    { maxByteLength: 8 },
  )
})

test('content larger than the configured bound is refused rather than read', async () => {
  await withAssignment(
    async ({ assignmentPath, store }) => {
      // Written straight to disk, as a file that grew past the bound after it
      // was stored would be. The read must stop at the bound rather than pull
      // the whole thing in to discover it is too big.
      const storeDirectory = capabilityResultsDirectoryPath(assignmentPath)
      fs.mkdirSync(storeDirectory, { mode: 0o700, recursive: true })
      fs.writeFileSync(
        path.join(storeDirectory, `${DIGEST}.json`),
        CANONICAL,
        { mode: 0o600 },
      )

      assert.deepEqual(await store.read(makeReceipt()), {
        kind: 'mismatched',
        reason: 'byte_length',
      })
    },
    { maxByteLength: 8 },
  )
})

test('a stored result reads back exactly', async () => {
  await withAssignment(async ({ store }) => {
    const written = await store.write(CANONICAL)
    assert.equal(written.kind, 'stored')
    if (written.kind !== 'stored') return

    const read = await store.read(written.receipt)

    assert.deepEqual(read, { kind: 'content', canonical: CANONICAL })
  })
})

test('content that was never written reads as absent', async () => {
  await withAssignment(async ({ store }) => {
    assert.deepEqual(await store.read(makeReceipt()), { kind: 'absent' })
  })
})

test('a read verifies the digest before returning any bytes', async () => {
  await withAssignment(async ({ assignmentPath, store }) => {
    await store.write(CANONICAL)
    const tampered =
      '{"kind":"browser.snapshot","text":"swapped-content-value!"}'
    assert.equal(Buffer.byteLength(tampered, 'utf8'), BYTE_LENGTH)
    fs.writeFileSync(
      path.join(capabilityResultsDirectoryPath(assignmentPath), `${DIGEST}.json`),
      tampered,
      { mode: 0o600 },
    )

    assert.deepEqual(await store.read(makeReceipt()), {
      kind: 'mismatched',
      reason: 'digest',
    })
  })
})

test('a read whose byte count disagrees with the receipt is refused', async () => {
  await withAssignment(async ({ store }) => {
    await store.write(CANONICAL)

    assert.deepEqual(
      await store.read(makeReceipt({ byteLength: BYTE_LENGTH + 1 })),
      { kind: 'mismatched', reason: 'byte_length' },
    )
  })
})

test('a receipt that is not a content identity is refused before any path is built', async () => {
  await withAssignment(async ({ assignmentPath, store }) => {
    await store.write(CANONICAL)
    const escape = path.join(assignmentPath, 'escape.json')
    fs.writeFileSync(escape, CANONICAL, { mode: 0o600 })

    for (const contentId of ['../escape', '..', `${DIGEST}/../${DIGEST}`, 'Z'.repeat(64)]) {
      assert.deepEqual(await store.read(makeReceipt({ contentId })), {
        kind: 'mismatched',
        reason: 'receipt',
      })
    }
  })
})

test('a link standing in for content is refused even when it points at the exact bytes', async () => {
  await withAssignment(async ({ assignmentPath, store }) => {
    await store.write(CANONICAL)
    // The link target is byte-identical to the accepted result, so a read that
    // followed the link would verify its digest and hand the bytes back. Only
    // a no-follow open can tell the two apart, and the store must open the
    // name it was given rather than whatever that name now points at.
    const outside = path.join(assignmentPath, 'outside.json')
    fs.writeFileSync(outside, CANONICAL, { mode: 0o600 })
    const contentPath = path.join(
      capabilityResultsDirectoryPath(assignmentPath),
      `${DIGEST}.json`,
    )
    fs.rmSync(contentPath)
    fs.symlinkSync(outside, contentPath)

    assert.deepEqual(await store.read(makeReceipt()), {
      kind: 'unsafe',
      reason: 'symlink',
    })
  })
})

test('a private runtime directory linked out of the assignment is refused', async () => {
  await withAssignment(async ({ assignmentPath, store }) => {
    // A store that only compared its own directory against its own parent
    // would accept this: the parent is a real directory holding a real
    // `capability-results`, and both resolve consistently. What is wrong with
    // it is that neither is inside the assignment any more.
    const elsewhere = fs.mkdtempSync(
      path.join(os.tmpdir(), 'capability-result-content-store-elsewhere-'),
    )
    try {
      const plantedStore = path.join(elsewhere, 'capability-results')
      fs.mkdirSync(plantedStore, { mode: 0o700 })
      fs.writeFileSync(path.join(plantedStore, `${DIGEST}.json`), CANONICAL, {
        mode: 0o600,
      })
      fs.symlinkSync(elsewhere, path.join(assignmentPath, '.runtime'))

      assert.deepEqual(await store.read(makeReceipt()), {
        kind: 'unsafe',
        reason: 'escapes_store',
      })
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

test('a store directory replaced by a link out of the assignment is refused', async () => {
  await withAssignment(async ({ assignmentPath, store }) => {
    await store.write(CANONICAL)
    const storeDirectory = capabilityResultsDirectoryPath(assignmentPath)
    const elsewhere = path.join(assignmentPath, 'elsewhere')
    fs.mkdirSync(elsewhere, { mode: 0o700 })
    fs.writeFileSync(path.join(elsewhere, `${DIGEST}.json`), CANONICAL, {
      mode: 0o600,
    })
    fs.rmSync(storeDirectory, { recursive: true, force: true })
    fs.symlinkSync(elsewhere, storeDirectory)

    assert.deepEqual(await store.read(makeReceipt()), {
      kind: 'unsafe',
      reason: 'escapes_store',
    })
  })
})

test('a content file anyone can read is refused', async () => {
  await withAssignment(async ({ assignmentPath, store }) => {
    await store.write(CANONICAL)
    // The directory being private is not enough: the file is what holds the
    // result, and a mode that widened after it was written says something
    // outside this owner can read it.
    fs.chmodSync(
      path.join(capabilityResultsDirectoryPath(assignmentPath), `${DIGEST}.json`),
      0o644,
    )

    assert.deepEqual(await store.read(makeReceipt()), {
      kind: 'unsafe',
      reason: 'permissions',
    })
  })
})

test('a store directory anyone can read is refused', async () => {
  await withAssignment(async ({ assignmentPath, store }) => {
    await store.write(CANONICAL)
    fs.chmodSync(capabilityResultsDirectoryPath(assignmentPath), 0o755)

    assert.deepEqual(await store.read(makeReceipt()), {
      kind: 'unsafe',
      reason: 'permissions',
    })
  })
})

test('content that is intact but not a JSON object reads as corrupt', async () => {
  await withAssignment(async ({ assignmentPath, store }) => {
    const notAnObject = '"a bare string"'
    const digest = createHash('sha256').update(notAnObject, 'utf8').digest('hex')
    await store.write(CANONICAL)
    fs.writeFileSync(
      path.join(capabilityResultsDirectoryPath(assignmentPath), `${digest}.json`),
      notAnObject,
      { mode: 0o600 },
    )

    assert.deepEqual(
      await store.read(
        makeReceipt({
          contentId: digest,
          contentSha256: digest,
          byteLength: Buffer.byteLength(notAnObject, 'utf8'),
        }),
      ),
      { kind: 'corrupt' },
    )
  })
})

test('removing the assignment removes its journal and its results together', async () => {
  await withAssignment(async ({ assignmentPath, store }) => {
    await store.write(CANONICAL)
    const journalDirectory = path.join(
      assignmentPath,
      '.runtime',
      'execution-journal',
    )
    fs.mkdirSync(journalDirectory, { mode: 0o700, recursive: true })
    fs.writeFileSync(path.join(journalDirectory, 'journal.jsonl'), '', {
      mode: 0o600,
    })
    const storeDirectory = capabilityResultsDirectoryPath(assignmentPath)
    assert.equal(fs.existsSync(storeDirectory), true)

    // Both owners sit under the assignment, so the deletion an owner already
    // performs — one recursive removal of its root — takes both. Nothing has
    // to remember to delete the results separately, which is what would leave
    // a journal naming content that is gone.
    fs.rmSync(assignmentPath, { recursive: true, force: true })

    assert.equal(fs.existsSync(journalDirectory), false)
    assert.equal(fs.existsSync(storeDirectory), false)
    fs.mkdirSync(assignmentPath, { recursive: true })
  })
})

function makeReceipt(
  overrides: Partial<CapabilityResultContentReceipt> = {},
): CapabilityResultContentReceipt {
  return {
    contentId: DIGEST,
    contentSha256: DIGEST,
    byteLength: BYTE_LENGTH,
    mediaType: 'application/json',
    resultSchemaVersion: 2,
    ...overrides,
  }
}

async function withAssignment(
  use: (fixture: {
    readonly assignmentPath: string
    readonly store: CapabilityResultContentStore
  }) => Promise<void>,
  options: { readonly maxByteLength?: number } = {},
): Promise<void> {
  const assignmentPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'capability-result-content-store-'),
  )
  try {
    const store = createAssignmentCapabilityResultStore({
      assignmentPath,
      ...(options.maxByteLength === undefined
        ? {}
        : { maxByteLength: options.maxByteLength }),
    })
    await use({ assignmentPath, store })
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
}
