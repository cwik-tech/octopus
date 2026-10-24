/**
 * The retention sidecars are authority, so their writes have to behave like it.
 *
 * The admission document decides whether a conversation may take more work, and
 * the terminal record decides what may be forgotten. Both are ordinary files in
 * a workspace, which means every failure mode of an ordinary file applies to
 * them — and every one of those, unhandled, fails open: a read that quietly
 * returns less than the file holds, a truncation that silently does nothing, a
 * directory listing that cannot be read and is reported as an empty one.
 *
 * These are the cases where "could not tell" was being answered as "nothing
 * here".
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { reserveConversationActivity } from '../../services/conversation-admission-reservation.js'
import {
  ensureSafeWorkspaceDirectory,
  readAllBounded,
  readPrivateFile,
  UnsafeWorkspacePathError,
} from '../../services/safe-workspace-directory.js'

const CASE_TIMEOUT_MS = 5_000

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
  return { directory, workspacePath, sessionId }
}

const owner = (sessionId: string) => ({
  kind: 'run-session' as const,
  conversationId: sessionId,
  sessionId,
})

const activitiesRoot = (workspacePath: string, sessionId: string) =>
  path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
  )

test(
  'the bound is decided by the read, at the byte where it matters',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory } = makeWorkspace('sidecar-bound-')
    const exact = path.join(directory, 'exact.json')
    const over = path.join(directory, 'over.json')
    try {
      // Read at most one byte past the bound and judge from what came back,
      // rather than measuring the file and then fetching it. Measuring and
      // reading are two operations and a file can grow between them, so a bound
      // established by a stat is a bound on what the file used to be.
      //
      // That window cannot be forced from inside one process on a regular file,
      // so what is asserted here is the boundary itself: the last size that is
      // inside the bound reads, and the first size past it does not. The
      // ordering — that no allocation is sized from a stat — is verified by
      // reading the implementation.
      fs.writeFileSync(exact, 'x'.repeat(128), 'utf8')
      assert.equal((await readPrivateFile(exact, { maxBytes: 128 }))?.length, 128)

      fs.writeFileSync(over, 'x'.repeat(129), 'utf8')
      await assert.rejects(
        readPrivateFile(over, { maxBytes: 128 }),
        UnsafeWorkspacePathError,
        'one byte past the bound is refused, not truncated into an answer',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a path segment carrying a separator or a NUL names nothing',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeWorkspace('sidecar-segment-')
    try {
      // `.` and `..` were refused; a segment that is itself a path was not, so
      // one caller-supplied identifier could reach across the workspace. A NUL
      // is worse: the kernel sees a shorter string than the checks did.
      const unsafe = [
        'sessions/elsewhere',
        'sessions' + String.fromCharCode(92) + 'elsewhere',
        'ok' + String.fromCharCode(0) + 'truncated',
      ]
      for (const segment of unsafe) {
        await assert.rejects(
          ensureSafeWorkspaceDirectory({
            workspacePath,
            segments: ['sessions', segment],
          }),
          UnsafeWorkspacePathError,
          'a segment that is itself a path was treated as one directory name',
        )
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a conversation whose activities cannot be listed refuses admission',
  { timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const { directory, workspacePath, sessionId } = makeWorkspace('sidecar-opendir-')
    const root = activitiesRoot(workspacePath, sessionId)
    try {
      // Reading "is there any activity here?" as "no" when the directory could
      // not be listed is a fail-open: a conversation with a lost admission
      // document and unreadable activities would be handed a fresh, empty count
      // and admit work without limit.
      //
      // Write and execute without read is exactly that state — the lock and the
      // document can still be opened by name, and only enumeration fails — so
      // this reaches the branch rather than tripping an earlier check.
      fs.mkdirSync(root, { recursive: true })
      fs.mkdirSync(path.join(root, randomUUID()))
      fs.chmodSync(root, 0o300)

      let enumerationDenied = true
      try {
        fs.readdirSync(root)
        enumerationDenied = false
      } catch {
        enumerationDenied = true
      }
      if (!enumerationDenied) {
        // Reported as skipped rather than passed. This user is not constrained
        // by the permission bits — root, typically — so the branch cannot be
        // reached here, and a green tick would count an unexercised branch as
        // covered.
        t.skip(
          'this user can enumerate a directory with no read bit, so the ' +
            'unreadable-listing branch cannot be reached on this machine',
        )
        return
      }

      const outcome = await reserveConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: randomUUID(),
      })
      assert.equal(
        outcome.kind,
        'indeterminate',
        'a listing that could not be read is not an empty conversation',
      )
    } finally {
      fs.chmodSync(root, 0o700)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'a read that arrives in pieces is still the whole file',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // A read is allowed to return fewer bytes than asked for, and that is not
    // end of file. Treating the first short answer as the whole file truncates
    // the admission and retention records silently — valid JSON becomes half a
    // document, and a healthy authority reads as damaged.
    //
    // Driven through the narrow read interface rather than the local
    // filesystem, which will usually fill the buffer and prove nothing.
    const whole = Buffer.from('{"turnIds":["a-turn"],"retained":[]}', 'utf8')
    let position = 0
    const oneByteAtATime = {
      read: async (
        buffer: Buffer,
        offset: number,
        length: number,
      ): Promise<{ readonly bytesRead: number }> => {
        if (position >= whole.length || length === 0) return { bytesRead: 0 }
        buffer[offset] = whole[position] as number
        position += 1
        return { bytesRead: 1 }
      },
    }

    const contents = await readAllBounded(oneByteAtATime, 1_024)
    assert.notEqual(contents, 'over-bound')
    assert.equal(
      contents === 'over-bound' ? '' : contents.toString('utf8'),
      whole.toString('utf8'),
    )
  },
)

test(
  'a file that arrives in pieces is still refused past its bound',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const whole = Buffer.alloc(200, 0x61)
    let position = 0
    const inPieces = {
      read: async (
        buffer: Buffer,
        offset: number,
        length: number,
      ): Promise<{ readonly bytesRead: number }> => {
        const take = Math.min(7, length, whole.length - position)
        if (take <= 0) return { bytesRead: 0 }
        whole.copy(buffer, offset, position, position + take)
        position += take
        return { bytesRead: take }
      },
    }
    assert.equal(await readAllBounded(inPieces, 100), 'over-bound')
  },
)
