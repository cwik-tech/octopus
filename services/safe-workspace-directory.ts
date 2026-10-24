/**
 * Create a directory under the workspace, refusing any link on the way.
 *
 * Lives in `services/` rather than `core/` because it touches the filesystem;
 * `core/` holds the pure path arithmetic this builds on.
 *
 * Containment is not enough on its own. A symlink whose target is *inside* the
 * workspace passes a "resolves within the root" check while still redirecting
 * writes — one session's activities into another's directory, one conversation's
 * admission index into another's. So the rule here is stricter and simpler: no
 * segment of the path may be a symbolic link, wherever it points.
 *
 * Checked before each descent rather than after the whole path is built,
 * because a recursive create follows whatever is already there. Verifying
 * afterwards reports the escape only once something outside has been touched.
 *
 * One primitive, shared by every writer under the workspace, so the rule cannot
 * drift between them.
 */
import { Buffer } from 'node:buffer'
import { logProcessWarning } from '../domains/runtime/logger.js'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export class UnsafeWorkspacePathError extends Error {
  readonly relativePath: string

  constructor(relativePath: string, reason: string) {
    super(`Refusing ${relativePath}: ${reason}.`)
    this.relativePath = relativePath
    this.name = 'UnsafeWorkspacePathError'
  }
}

/**
 * Resolve and create `segments` beneath `workspacePath`, private at every level.
 *
 * Returns the created directory's real path. Throws `UnsafeWorkspacePathError`
 * before creating anything further if a segment exists and is not a plain
 * directory.
 */
export async function ensureSafeWorkspaceDirectory(input: {
  readonly workspacePath: string
  readonly segments: readonly string[]
  readonly mode?: number
  /**
   * How many leading segments must already exist rather than be created.
   *
   * Provisioning may create what belongs to a conversation and never what
   * belongs to its owner. A recursive create does not know the difference, so a
   * turn that arrives just after its session was deleted would rebuild
   * `sessions/<id>` on its way past — and what comes back is a session
   * directory holding a reservation and an activity journal under an owner that
   * no longer exists.
   */
  readonly requireExisting?: number
}): Promise<string> {
  const mode = input.mode ?? 0o700
  const relativePath = input.segments.join('/')
  let current: string
  try {
    current = await fs.realpath(input.workspacePath)
  } catch (error) {
    throw new UnsafeWorkspacePathError(
      relativePath,
      `the workspace root could not be resolved (${describe(error)})`,
    )
  }

  const requireExisting = input.requireExisting ?? 0
  for (const [index, segment] of input.segments.entries()) {
    if (!isSafeDirectorySegment(segment)) {
      throw new UnsafeWorkspacePathError(relativePath, 'it is not a safe segment')
    }
    const next = path.join(current, segment)
    const stat = await lstatIfPresent(next)
    if (stat === undefined) {
      if (index < requireExisting) {
        throw new UnsafeWorkspacePathError(
          relativePath,
          `'${segment}' does not exist and is not this caller's to create`,
        )
      }
      await fs.mkdir(next, { mode })
    } else if (stat.isSymbolicLink()) {
      // The whole point: refused whether or not it points inside.
      throw new UnsafeWorkspacePathError(
        relativePath,
        `'${segment}' is a symbolic link`,
      )
    } else if (!stat.isDirectory()) {
      throw new UnsafeWorkspacePathError(
        relativePath,
        `'${segment}' is not a directory`,
      )
    }
    current = next
  }
  return current
}

/**
 * Write a private file beneath an already-verified directory, refusing links.
 *
 * A verified directory says nothing about the files in it: any of them can be
 * replaced by a link, and a plain `writeFile` follows it. `O_NOFOLLOW` makes
 * that a failure instead of a redirect.
 */
export async function writePrivateFile(
  filePath: string,
  contents: string,
): Promise<void> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      fsConstants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(contents, 'utf8')
    // These sidecars are authority: the admission document decides whether a
    // conversation may take more work, and the terminal record decides what may
    // be forgotten. Authority that lives only in the page cache is authority a
    // power cut can roll back to a state the journals have already moved past.
    await handle.sync()
  } finally {
    await handle.close()
  }
  // And the entry that names it. Flushing the contents without flushing the
  // directory leaves a file that survives with no name pointing at it.
  await syncDirectoryOf(filePath)
}


/**
 * Errnos that mean this filesystem does not flush directories, rather than that
 * this flush failed.
 *
 * Deliberately short. Anything outside it is a real failure of an authority
 * write and is thrown, because the alternative is a write that reports success
 * while the name it created may not survive a power cut.
 */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])

/**
 * Flush the directory entry naming `filePath`.
 *
 * Flushing a file's contents without flushing the directory leaves a file that
 * survives with nothing pointing at it, and a rename that is not followed by
 * one leaves the old name in place — so for an authority write this is half the
 * operation, not a refinement of it.
 */
export async function syncDirectoryOf(filePath: string): Promise<void> {
  const directoryPath = path.dirname(filePath)
  let directory: fs.FileHandle | undefined
  try {
    directory = await fs.open(directoryPath, fsConstants.O_RDONLY)
    await directory.sync()
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(codeOf(error) ?? '')) throw error
    // Said out loud rather than absorbed. An operator running on a filesystem
    // that cannot do this should know the durability they are getting is the
    // file's and not the name's.
    logProcessWarning(
      'durable-write',
      `This filesystem does not flush directories (${codeOf(error)}), so the ` +
        `name ${directoryPath} gives to a file it holds is not itself ` +
        'power-loss durable.',
    )
  } finally {
    await directory?.close().catch(() => undefined)
  }
}

/**
 * Replace a private file with new contents, durably and all at once.
 *
 * The whole sequence in one place because it is one operation: stage the
 * contents, flush them, put the name in place, flush the directory that holds
 * the name. Leaving the last step to the caller is how the authoritative change
 * — the rename — ends up being the only part that is not durable.
 */
export async function replacePrivateFileAtomically(input: {
  readonly targetPath: string
  readonly temporaryPath: string
  readonly contents: string
}): Promise<void> {
  try {
    await writePrivateFile(input.temporaryPath, input.contents)
    await fs.rename(input.temporaryPath, input.targetPath)
    await syncDirectoryOf(input.targetPath)
  } finally {
    await fs.rm(input.temporaryPath, { force: true }).catch(() => undefined)
  }
}

/**
 * One directory name, not a path and not something the kernel reads shorter
 * than these checks did.
 *
 * `.` and `..` were refused and a segment that is itself a path was not, so one
 * caller-supplied identifier could reach across the workspace in a single step.
 * A NUL is the same problem in a form that defeats every check above it: the
 * string these rules examined and the string the syscall receives are different
 * strings.
 */
function isSafeDirectorySegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false
  if (segment.includes('/') || segment.includes(String.fromCharCode(92))) {
    return false
  }
  return !segment.includes(String.fromCharCode(0))
}

/**
 * Read a private file, refusing to follow a link where a file belongs.
 *
 * `undefined` when absent. Throws when it exists and is not a regular file,
 * because reading through a link would let something outside this directory
 * answer a question about what is inside it.
 */
export async function readPrivateFile(
  filePath: string,
  options: { readonly maxBytes: number },
): Promise<string | undefined> {
  let handle: fs.FileHandle
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    )
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined
    // ELOOP is the open refusing a link, which is the point of O_NOFOLLOW.
    if (codeOf(error) === 'ELOOP') {
      throw new UnsafeWorkspacePathError(filePath, 'it is a symbolic link')
    }
    throw error
  }
  try {
    // Measured from the opened handle, so the size describes the file actually
    // being read rather than whatever the name pointed at a moment ago — and
    // measured before any content is pulled into memory, because checking
    // afterwards has already done the damage.
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new UnsafeWorkspacePathError(filePath, 'it is not a regular file')
    }
    // One byte past the bound, read from the handle rather than measured and
    // then fetched. Measuring and reading are two operations and a file can
    // grow between them, so a bound established by a stat is a bound on what
    // the file used to be — and reading "whatever is there now" against it is
    // how a bound stops bounding.
    const contents = await readAllBounded(handle, options.maxBytes)
    if (contents === 'over-bound') {
      throw new UnsafeWorkspacePathError(
        filePath,
        `it is over the ${options.maxBytes}-byte bound`,
      )
    }
    return contents.toString('utf8')
  } finally {
    await handle.close()
  }
}



/** The part of a file handle a bounded read needs. */
export interface BoundedReadSource {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>
}

/**
 * Read a whole file, refusing anything past `maxBytes`.
 *
 * A loop, not one call. A read is allowed to return fewer bytes than asked for
 * — that is not end of file — and treating the first short answer as the whole
 * file truncates the records this layer exists to protect: valid JSON becomes
 * half a document, and a healthy authority reads as damaged.
 *
 * Takes the narrow read interface rather than a handle so the short-read
 * behaviour can be exercised deterministically instead of hoping the local
 * filesystem obliges.
 */
export async function readAllBounded(
  source: BoundedReadSource,
  maxBytes: number,
): Promise<Buffer | 'over-bound'> {
  const buffer = Buffer.alloc(maxBytes + 1)
  let filled = 0
  for (;;) {
    const { bytesRead } = await source.read(
      buffer,
      filled,
      buffer.length - filled,
      filled,
    )
    if (bytesRead === 0) break
    filled += bytesRead
    // Filling the extra byte is what says "over the bound" without pulling in
    // the remainder.
    if (filled > maxBytes) return 'over-bound'
  }
  return buffer.subarray(0, filled)
}

async function lstatIfPresent(
  target: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined
    throw error
  }
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  // Read through the narrowing `in` gave us, rather than asserting a shape
  // onto a value that came from outside.
  const code: unknown = error.code
  return typeof code === 'string' ? code : undefined
}

function describe(error: unknown): string {
  return codeOf(error) ?? 'unknown'
}
