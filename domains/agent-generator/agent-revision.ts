/**
 * The optimistic revision of an Agent package, as a skill update sees it.
 *
 * A skill update is authorized against exactly two things: the persona it must
 * not touch, and the skills it is about to change. Those are what the revision
 * covers. Runtime experience under `experience/` and the ownership marker are
 * deliberately outside it — they change whenever the Agent runs, and a stored
 * proposal that went stale on every session would never survive long enough to
 * be applied.
 *
 * Nothing here reads through anything it did not verify first. The package
 * root, the `skills` root, and every entry beneath them are inspected with
 * `lstat` before they are opened, because a symlink at any of those points
 * would be followed to content the package does not own and hashed as though
 * it were part of the package. Only a genuinely missing `skills` folder means
 * "no skills": a regular file, a device, or a directory that cannot be read
 * fails the caller, since reading any of them as an empty skill set would
 * silently drop every file the revision exists to cover.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { validateExactAgentName } from './agent-name-rules.js'

/** Package-relative posix path to that file's exact bytes. */
export type AgentRevisionFiles = ReadonlyMap<string, Buffer>

/**
 * Why a package could not be described.
 *
 * The distinction is load-bearing for callers: `absent` and `invalid_id` mean
 * there is no Agent here, while `unsupported` and `unreadable` mean there is
 * one and it cannot be described. Reporting the second pair as the first would
 * tell a user to create an Agent that already exists and would never name the
 * real problem.
 */
export type AgentRevisionErrorCode =
  | 'absent'
  | 'invalid_id'
  | 'unsupported'
  | 'unreadable'

export class AgentRevisionError extends Error {
  constructor(
    readonly code: AgentRevisionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AgentRevisionError'
  }
}

/** Whether this error says the Agent is not there at all. */
export function isMissingAgentError(error: unknown): boolean {
  return (
    error instanceof AgentRevisionError &&
    (error.code === 'absent' || error.code === 'invalid_id')
  )
}

/**
 * The id, confirmed to be exactly one Agent name and not an alias for one.
 *
 * Path arithmetic cannot do this on its own: `path.resolve` and `path.join`
 * both normalize, so `elsewhere/../michigan-contract-lawyer` and
 * `michigan-contract-lawyer/` agree with the package they are aliases for and
 * a comparison of resolved paths accepts them. Two spellings of one target are
 * two revisions and two locks over the same files, so the id is checked
 * against the repository's own naming rule before any path is built from it.
 */
export function assertExactAgentId(agentId: string): string {
  try {
    return validateExactAgentName(agentId)
  } catch (error) {
    throw new AgentRevisionError(
      'invalid_id',
      `Agent id must be an exact kebab-case Agent name: ${agentId}`,
      { cause: error },
    )
  }
}

/** Absolute path of one Agent package, refusing any id that escapes `agents/`. */
export function agentPackagePath(repoRoot: string, agentId: string): string {
  return path.join(path.resolve(repoRoot, 'agents'), assertExactAgentId(agentId))
}

/**
 * Every file the revision covers, as normalized package-relative posix paths
 * mapped to that file's exact bytes.
 *
 * The persona is required: an Agent without one is not a package this update
 * can be authorized against, and reporting a revision for it would pin a
 * proposal to something that does not exist.
 */
export function readAgentRevisionFiles(
  repoRoot: string,
  agentId: string,
): AgentRevisionFiles {
  const packageRoot = agentPackagePath(repoRoot, assertExactAgentId(agentId))
  assertRealDirectory(packageRoot, `agents/${agentId}`, {
    missing: `Agent '${agentId}' has no package at agents/${agentId}`,
  })

  const files = new Map<string, Buffer>()
  const personaRelative = `${agentId}.md`
  files.set(
    personaRelative,
    readPersona(path.join(packageRoot, personaRelative), agentId, personaRelative),
  )

  const skillsRoot = path.join(packageRoot, 'skills')
  if (assertRealDirectory(skillsRoot, 'skills', { absentIsEmpty: true })) {
    collectRegularFiles(skillsRoot, 'skills', files)
  }
  return files
}

/**
 * The revision of a file map: each normalized path and that file's exact bytes.
 *
 * Every part is preceded by its own byte length. A separator character cannot
 * be used instead, because file content is arbitrary bytes and can spell any
 * separator: one file holding `X<sep>b<sep>Y` and two files holding `X` and
 * `Y` would serialize identically, and two different packages would share one
 * revision. A length says how far to read and nothing inside the bytes can
 * change that.
 *
 * Paths are sorted and framed with the content, so a file moved between two
 * paths changes the revision even when its bytes do not.
 */
export function digestAgentRevisionFiles(files: AgentRevisionFiles): string {
  const digest = createHash('sha256')
  for (const relative of [...files.keys()].sort()) {
    const pathBytes = Buffer.from(relative, 'utf8')
    const contentBytes = files.get(relative) ?? Buffer.alloc(0)
    digest.update(`${pathBytes.byteLength}:`, 'utf8')
    digest.update(pathBytes)
    digest.update(`${contentBytes.byteLength}:`, 'utf8')
    digest.update(contentBytes)
  }
  return `sha256:${digest.digest('hex')}`
}

/** Digest of the persona and every file under `skills/`, read from disk. */
export function computeAgentRevision(repoRoot: string, agentId: string): string {
  return digestAgentRevisionFiles(readAgentRevisionFiles(repoRoot, agentId))
}

/** sha256 of one file's exact bytes, in the same `sha256:<hex>` spelling. */
export function digestFileContents(contents: Buffer | string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

/**
 * The persona's exact bytes.
 *
 * Absence and "present but not something I can hash" are different answers. A
 * symlinked persona reported as missing would say the Agent does not exist,
 * when what is true is that this package cannot be described faithfully.
 */
function readPersona(personaPath: string, agentId: string, relative: string): Buffer {
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(personaPath)
  } catch (error) {
    if (isMissingEntry(error)) {
      throw new AgentRevisionError(
        'absent',
        `Agent '${agentId}' has no persona file at agents/${agentId}/${relative}`,
      )
    }
    throw new AgentRevisionError('unreadable', `Could not read ${relative}`, {
      cause: error,
    })
  }
  if (stats.isSymbolicLink()) {
    throw new AgentRevisionError(
      'unsupported',
      `${relative} is a symbolic link, which an Agent package may not contain`,
    )
  }
  if (!stats.isFile()) {
    throw new AgentRevisionError('unsupported', `${relative} is not a regular file`)
  }
  try {
    return fs.readFileSync(personaPath)
  } catch (error) {
    throw new AgentRevisionError('unreadable', `Could not read ${relative}`, {
      cause: error,
    })
  }
}

/**
 * Whether `target` is a real directory, refusing anything it is not.
 *
 * With `absentIsEmpty`, a genuinely missing entry answers `false` and the
 * caller treats it as nothing to walk. Every other outcome — a symlink, a
 * regular file, a device, an unreadable entry — throws, because none of them
 * is an empty directory and reading them as one would hide content.
 */
function assertRealDirectory(
  target: string,
  relative: string,
  options: { absentIsEmpty?: boolean; missing?: string } = {},
): boolean {
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(target)
  } catch (error) {
    if (isMissingEntry(error)) {
      if (options.absentIsEmpty) return false
      throw new AgentRevisionError(
        'absent',
        options.missing ?? `${relative} does not exist`,
      )
    }
    throw new AgentRevisionError('unreadable', `Could not read ${relative}`, {
      cause: error,
    })
  }
  if (stats.isSymbolicLink()) {
    throw new AgentRevisionError(
      'unsupported',
      `${relative} is a symbolic link, which an Agent package may not contain`,
    )
  }
  if (!stats.isDirectory()) {
    throw new AgentRevisionError('unsupported', `${relative} is not a directory`)
  }
  return true
}

/** Adds every regular file under `directory` to `files`, refusing the rest. */
function collectRegularFiles(
  directory: string,
  relativeRoot: string,
  files: Map<string, Buffer>,
): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    throw new AgentRevisionError('unreadable', `Could not read ${relativeRoot}`, {
      cause: error,
    })
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    const relative = `${relativeRoot}/${entry.name}`
    if (entry.isSymbolicLink()) {
      throw new AgentRevisionError(
        'unsupported',
        `${relative} is a symbolic link, which an Agent package may not contain`,
      )
    }
    if (entry.isDirectory()) {
      collectRegularFiles(absolute, relative, files)
      continue
    }
    if (!entry.isFile()) {
      throw new AgentRevisionError(
        'unsupported',
        `${relative} is neither a regular file nor a directory`,
      )
    }
    try {
      files.set(relative, fs.readFileSync(absolute))
    } catch (error) {
      throw new AgentRevisionError('unreadable', `Could not read ${relative}`, {
        cause: error,
      })
    }
  }
}

/** Only a genuinely absent entry. `ENOTDIR` is a wrong shape, not an absence. */
function isMissingEntry(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === 'ENOENT'
}
