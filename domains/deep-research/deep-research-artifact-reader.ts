import * as fs from 'node:fs'

import {
  resolveExistingPathInside,
  resolveRelativePathInside,
} from '../../core/path-safety.js'

interface OwnedResearchArtifactRequest {
  readonly assignmentPath: string
  readonly relativePath: string
  readonly maximumBytes: number
  readonly label: string
}

/**
 * Read one JSON artifact the run owns.
 *
 * Every Deep Research artifact read shares the same four rules: the path stays
 * inside the assignment, the target is a regular file rather than a symlink
 * out of it, its size is bounded before it is read, and a parse failure is
 * reported against the artifact rather than swallowed. Keeping them in one
 * place is what makes "runtime-owned materialization" a boundary instead of a
 * habit.
 */
export function readOwnedResearchJson(
  input: OwnedResearchArtifactRequest,
): unknown {
  const artifactPath = resolveOwnedResearchArtifactPath(input)
  try {
    return JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `${input.label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Read one bounded UTF-8 artifact owned by the current assignment. */
export function readOwnedResearchText(
  input: OwnedResearchArtifactRequest,
): string {
  return fs.readFileSync(resolveOwnedResearchArtifactPath(input), 'utf8')
}

function resolveOwnedResearchArtifactPath(
  input: OwnedResearchArtifactRequest,
): string {
  const candidatePath = resolveRelativePathInside(
    input.assignmentPath,
    input.relativePath,
  )
  if (!candidatePath) throw new Error(`${input.label} path is unsafe.`)
  const artifactPath = resolveExistingPathInside(
    input.assignmentPath,
    candidatePath,
  )
  if (!artifactPath) throw new Error(`${input.label} does not exist.`)
  const linkStats = fs.lstatSync(candidatePath)
  if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
    throw new Error(`${input.label} must be a regular file.`)
  }
  if (fs.statSync(artifactPath).size > input.maximumBytes) {
    throw new Error(`${input.label} exceeds its ${input.maximumBytes}-byte limit.`)
  }
  return artifactPath
}
