/**
 * Content evidence for a generated Agent package.
 *
 * A durable operation records what it staged so that, on a later attempt, it
 * can tell its own published output from an Agent folder that merely carries
 * the same name and ownership marker. A marker plus an existing persona file
 * says who started the work, not that the bytes on disk are the bytes this
 * operation produced.
 *
 * Because the answer is evidence, an incomplete one is worse than none. A
 * directory that cannot be read, a file that cannot be opened, a symlink, or
 * any entry that is neither a regular file nor a directory fails the caller
 * rather than quietly shrinking the map it returns.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Package-relative posix path to the sha256 digest of that file. */
export type AgentPackageHashes = Readonly<Record<string, string>>

/** Raised when a package cannot be described completely and faithfully. */
export class AgentPackageDigestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AgentPackageDigestError'
  }
}

export async function computeAgentPackageHashes(
  packagePath: string,
): Promise<AgentPackageHashes> {
  const root = path.resolve(packagePath)
  assertRealDirectory(root)
  // A package may legally contain a file named `__proto__`, and assigning that
  // key on an ordinary object invokes the prototype setter instead of creating
  // a property: the file would vanish from this record and every later change
  // to it would compare equal. Evidence cannot omit a real file.
  const hashes: Record<string, string> = {}
  Object.setPrototypeOf(hashes, null)
  for (const relativePath of listPackageFiles(root)) {
    const absolute = path.join(root, relativePath)
    let contents: Buffer
    try {
      contents = await fs.promises.readFile(absolute)
    } catch (error) {
      throw new AgentPackageDigestError(
        `Could not read package file ${relativePath}`,
        { cause: error },
      )
    }
    hashes[relativePath] = `sha256:${createHash('sha256').update(contents).digest('hex')}`
  }
  return hashes
}

/**
 * Whether the package on disk still matches recorded evidence exactly.
 *
 * A package that is not there is a definite mismatch. A package that cannot be
 * described is not an answer at all, so the failure reaches the caller instead
 * of being reported as either outcome.
 */
export async function agentPackageMatchesHashes(
  packagePath: string,
  expected: AgentPackageHashes,
): Promise<boolean> {
  if (!fs.existsSync(packagePath)) return false
  assertRealDirectory(path.resolve(packagePath))
  const actual = await computeAgentPackageHashes(packagePath)
  const expectedPaths = Object.keys(expected).sort()
  const actualPaths = Object.keys(actual).sort()
  if (expectedPaths.length !== actualPaths.length) return false
  return expectedPaths.every(
    (relativePath, index) =>
      relativePath === actualPaths[index] && expected[relativePath] === actual[relativePath],
  )
}

/**
 * The package root must be a real directory.
 *
 * A root that is itself a symlink would be followed, and the walk would hash
 * content from wherever it points — the containment the entry-level symlink
 * check exists to provide would be lost before the walk even started.
 */
function assertRealDirectory(root: string): void {
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(root)
  } catch (error) {
    throw new AgentPackageDigestError(`Could not read package directory .`, {
      cause: error,
    })
  }
  if (stats.isSymbolicLink()) {
    throw new AgentPackageDigestError(
      'Package path is a symbolic link, which a package root may not be',
    )
  }
  if (!stats.isDirectory()) {
    throw new AgentPackageDigestError('Package path is not a directory')
  }
}

/** Every file in the package, as sorted normalized package-relative paths. */
function listPackageFiles(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      throw new AgentPackageDigestError(
        `Could not read package directory ${describeRelative(root, directory)}`,
        { cause: error },
      )
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = describeRelative(root, absolute)
      if (entry.isSymbolicLink()) {
        throw new AgentPackageDigestError(
          `Package entry ${relative} is a symbolic link, which a package may not contain`,
        )
      }
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.isFile()) {
        throw new AgentPackageDigestError(
          `Package entry ${relative} is neither a regular file nor a directory`,
        )
      }
      found.push(relative)
    }
  }
  walk(root)
  return found.sort()
}

/** A normalized posix path inside the package, never absolute and never `..`. */
function describeRelative(root: string, absolute: string): string {
  const relative = path.relative(root, absolute).split(path.sep).join('/')
  if (relative === '' ) return '.'
  if (relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new AgentPackageDigestError(
      `Package entry ${relative} resolves outside the package`,
    )
  }
  return relative
}
