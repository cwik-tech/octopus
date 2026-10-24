import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Opening a file this process owns, refusing to be redirected out of it.
 *
 * Agents hold write access to the run workspace, so anything under it can be
 * replaced with a symlink between one write and the next. A plain `open` would
 * follow it and write outside; a plain `readFile` would read outside. The
 * checks here are the ones the capability-evidence writer has always made,
 * extracted so the canonical projection and that writer cannot drift apart —
 * two copies of a security check that must agree, in different layers, is the
 * shape this exists to avoid.
 *
 * Three properties, together:
 *
 * - `O_NOFOLLOW` refuses a symlink at the final component, at open time.
 * - The opened handle is cross-checked against `lstat` by device and inode, so
 *   a swap between the open and the check is caught rather than trusted.
 * - The parent directory is canonicalised and must still be where the caller
 *   said it was, which is what catches a redirected directory — `O_NOFOLLOW`
 *   says nothing about the path leading to the file.
 *
 * The container is canonicalised too, rather than compared literally, so a
 * workspace reached through an ancestor symlink is fine. That is ordinary on
 * macOS, where `/var` is a link to `/private/var`. What is refused is a
 * redirect *inside* the container.
 */
export interface OwnedFileRequest {
  /**
   * The directory this file belongs to. Canonicalised, then required to
   * contain the file's parent at exactly the expected relative path.
   */
  readonly containerPath: string
  /**
   * The file itself. It must sit in `containerPath` or one directory below
   * it — deeper is refused rather than created, so the check never has to
   * create a directory on a path it has not yet proven.
   */
  readonly filePath: string
}

/** A path that could not be shown to be the one the caller meant. */
export class UnsafeOwnedFileError extends Error {
  constructor(reason: string, options?: { readonly cause?: unknown }) {
    super(`Owned file path is unsafe: ${reason}`, options)
    this.name = 'UnsafeOwnedFileError'
  }
}

/**
 * Create the file's parent directory if needed, and return its canonical path.
 *
 * Separate from opening because a caller that publishes atomically — writing a
 * temporary file and renaming over the target — never opens the target itself,
 * yet still needs the directory proven before it writes into it.
 */
export async function ensureOwnedDirectory(
  request: OwnedFileRequest,
): Promise<string> {
  const directoryPath = path.dirname(path.resolve(request.filePath))
  const containerPath = path.resolve(request.containerPath)
  const relative = path.relative(containerPath, directoryPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new UnsafeOwnedFileError('the file is outside its container')
  }
  // At most one directory below the container, checked before anything is
  // created. A recursive `mkdir` would walk `container/a/b` and create `b`
  // inside whatever `a` points at, discovering the redirect only afterwards —
  // with the directory already made outside. Refusing depth keeps the promise
  // that nothing outside is touched, and one level is what both callers need;
  // supporting more would mean validating each component as it is created,
  // which is a larger primitive than either has asked for.
  const segments = relative === '' ? [] : relative.split(path.sep)
  if (segments.length > 1) {
    throw new UnsafeOwnedFileError(
      'the file is more than one directory below its container',
    )
  }

  const canonicalContainer = await canonicalDirectory(containerPath)
  if (segments.length === 1) {
    await fs
      .mkdir(directoryPath, { mode: 0o700 })
      .catch((error: unknown) => {
        if (!hasNodeErrorCode(error, 'EEXIST')) throw error
      })
  }
  const canonicalDirectoryPath = await canonicalDirectory(directoryPath)
  const expected = path.join(canonicalContainer, ...segments)
  if (canonicalDirectoryPath !== expected) {
    throw new UnsafeOwnedFileError('the parent directory is redirected')
  }
  return canonicalDirectoryPath
}

/** Open an owned file for append, creating it if it does not exist. */
export async function openOwnedFileForAppend(
  request: OwnedFileRequest,
): Promise<fs.FileHandle> {
  const handle = await openOwned(
    request,
    fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      fsConstants.O_WRONLY |
      noFollowFlag(),
  )
  if (!handle) {
    // `O_CREAT` was set, so absence is not a possible outcome.
    throw new UnsafeOwnedFileError('the file could not be opened for append')
  }
  return handle
}

/**
 * Open an owned file for reading, or report that it is absent.
 *
 * `undefined` distinguishes "nothing is there" from "something is there and it
 * is not ours" — the second is an error, and collapsing them would let a
 * redirected read look like an empty file.
 */
export async function openOwnedFileForRead(
  request: OwnedFileRequest,
): Promise<fs.FileHandle | undefined> {
  return openOwned(request, fsConstants.O_RDONLY | noFollowFlag())
}

async function openOwned(
  request: OwnedFileRequest,
  flags: number,
): Promise<fs.FileHandle | undefined> {
  const canonicalDirectoryPath = await ensureOwnedDirectory(request)
  const filePath = path.resolve(request.filePath)
  let handle: fs.FileHandle
  try {
    handle = await fs.open(filePath, flags, 0o600)
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) return undefined
    // `ELOOP` is what `O_NOFOLLOW` reports for a symlinked final component.
    throw new UnsafeOwnedFileError('the file could not be opened safely', {
      cause: error,
    })
  }
  try {
    await validateOpenedFile(handle, filePath, canonicalDirectoryPath)
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
  return handle
}

async function validateOpenedFile(
  handle: fs.FileHandle,
  filePath: string,
  canonicalDirectoryPath: string,
): Promise<void> {
  const [handleStat, fileStat, canonicalFilePath] = await Promise.all([
    handle.stat(),
    fs.lstat(filePath),
    fs.realpath(filePath),
  ])
  if (
    !handleStat.isFile() ||
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    handleStat.dev !== fileStat.dev ||
    handleStat.ino !== fileStat.ino ||
    canonicalFilePath !==
      path.join(canonicalDirectoryPath, path.basename(filePath))
  ) {
    throw new UnsafeOwnedFileError('the opened file is not the named file')
  }
}

async function canonicalDirectory(directoryPath: string): Promise<string> {
  const [stat, canonicalPath] = await Promise.all([
    fs.lstat(directoryPath),
    fs.realpath(directoryPath),
  ])
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new UnsafeOwnedFileError('a directory on the path is not a directory')
  }
  return canonicalPath
}

/**
 * Platforms without `O_NOFOLLOW` fall back to `0`. The handle cross-check
 * below still catches a symlinked file there, because `lstat` reports the link
 * rather than its target.
 */
function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === 'number'
    ? fsConstants.O_NOFOLLOW
    : 0
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  )
}
