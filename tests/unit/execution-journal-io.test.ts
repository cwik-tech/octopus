import assert from 'node:assert/strict'
import test from 'node:test'

import { ExecutionJournalError } from '../../contracts/execution-journal.js'
import {
  readExactlyBytes,
  writeAllBytes,
} from '../../core/execution-journal.js'

/**
 * Partial reads and writes are legal for the POSIX calls behind Node's
 * FileHandle. The journal's durability claims depend on treating them as
 * such: a short read must never be mistaken for an unterminated tail (which
 * would truncate acknowledged events), and a short write must never be
 * reported as a completed append.
 */

function chunkedReader(
  content: Buffer,
  chunkSize: number,
): { read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>; readonly calls: number } {
  const state = { calls: 0 }
  return {
    get calls() {
      return state.calls
    },
    read: async (buffer, offset, length, position) => {
      state.calls += 1
      const available = Math.max(0, content.byteLength - position)
      const bytesRead = Math.min(chunkSize, length, available)
      content.copy(buffer, offset, position, position + bytesRead)
      return { bytesRead }
    },
  }
}

test('a short read is completed rather than leaving the buffer padded', async () => {
  const content = Buffer.from('{"a":1}\n{"b":2}\n', 'utf8')
  const reader = chunkedReader(content, 4)
  const buffer = Buffer.alloc(content.byteLength)

  await readExactlyBytes(reader, buffer, 0, content.byteLength)

  assert.equal(buffer.toString('utf8'), content.toString('utf8'))
  assert.ok(reader.calls > 1, 'expected the short reads to be resumed')
})

test('a read that ends early fails closed instead of returning padding', async () => {
  const content = Buffer.from('{"a":1}\n', 'utf8')
  const reader = chunkedReader(content, 4)
  const buffer = Buffer.alloc(content.byteLength + 8)

  await assert.rejects(
    readExactlyBytes(reader, buffer, 0, buffer.byteLength),
    (error: unknown) =>
      error instanceof ExecutionJournalError && error.code === 'corrupt',
  )
})

test('a short write is resumed until every byte is durable', async () => {
  const written: Buffer[] = []
  const handle = {
    write: async (buffer: Buffer, offset: number, length: number) => {
      const bytesWritten = Math.min(2, length)
      written.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten)))
      return { bytesWritten }
    },
  }
  const payload = Buffer.from('{"event":1}\n', 'utf8')

  await writeAllBytes(handle, payload)

  assert.equal(Buffer.concat(written).toString('utf8'), payload.toString('utf8'))
})

test('a write that stops making progress fails closed, as a torn write', async () => {
  const handle = {
    write: async () => ({ bytesWritten: 0 }),
  }

  // It still fails closed; what changed is what it is called. This used to
  // raise `corrupt`, which classified a torn final line as damage needing
  // repair — but the line was never acknowledged to any caller, and a reopen
  // truncates it. Calling it damage is what let one stalled write end an
  // assignment's durable history for good (ADR A-2).
  await assert.rejects(
    writeAllBytes(handle, Buffer.from('{"event":1}\n', 'utf8')),
    (error: unknown) =>
      error instanceof ExecutionJournalError &&
      error.code === 'write_incomplete',
  )
})
