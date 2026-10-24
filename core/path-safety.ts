import * as fs from 'node:fs'
import * as path from 'node:path'

const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/i
const MAX_VALIDATION_DECODE_PASSES = 4

function hasUnsafePathStructure(value: string): boolean {
  return (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  )
}

/**
 * Returns true only for one filesystem path segment.
 *
 * Encoded separators and dot segments are rejected across several encoded
 * forms without returning a repeatedly-decoded value to callers.
 */
export function isSafePathSegment(value: string): boolean {
  let candidate = value

  for (let pass = 0; pass < MAX_VALIDATION_DECODE_PASSES; pass += 1) {
    if (
      hasUnsafePathStructure(candidate) ||
      ENCODED_PATH_SEPARATOR.test(candidate)
    ) {
      return false
    }

    let decoded: string
    try {
      decoded = decodeURIComponent(candidate)
    } catch {
      return false
    }

    if (decoded === candidate) return true
    candidate = decoded
  }

  return (
    !hasUnsafePathStructure(candidate) &&
    !ENCODED_PATH_SEPARATOR.test(candidate)
  )
}

/** Decode exactly once after validating that no encoded form is structural. */
export function decodeSafePathSegment(value: string): string | null {
  if (!isSafePathSegment(value)) return null

  try {
    const decoded = decodeURIComponent(value)
    return isSafePathSegment(decoded) ? decoded : null
  } catch {
    return null
  }
}

export function isPathInside(
  basePath: string,
  candidatePath: string,
): boolean {
  const relative = path.relative(path.resolve(basePath), path.resolve(candidatePath))
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

export function isPathEqualOrInside(
  basePath: string,
  candidatePath: string,
): boolean {
  return path.resolve(basePath) === path.resolve(candidatePath) ||
    isPathInside(basePath, candidatePath)
}

export async function resolveCanonicalDirectory(
  candidatePath: string,
): Promise<string | null> {
  if (!path.isAbsolute(candidatePath)) return null
  const canonicalPath = await fs.promises.realpath(candidatePath).catch(() => null)
  if (!canonicalPath) return null
  const stat = await fs.promises.lstat(canonicalPath).catch(() => null)
  return stat?.isDirectory() && !stat.isSymbolicLink() ? canonicalPath : null
}

export function resolveExistingPathInside(
  basePath: string,
  candidatePath: string,
): string | null {
  try {
    const realBasePath = fs.realpathSync(basePath)
    const realCandidatePath = fs.realpathSync(candidatePath)
    return isPathInside(realBasePath, realCandidatePath)
      ? realCandidatePath
      : null
  } catch {
    return null
  }
}

/** Resolve a slash-delimited relative path and keep it strictly below basePath. */
export function resolveRelativePathInside(
  basePath: string,
  relativePath: string,
): string | null {
  if (path.isAbsolute(relativePath) || relativePath.includes('\0')) return null

  const segments = relativePath.split('/')
  if (segments.some((segment) => !isSafePathSegment(segment))) return null

  const resolvedBase = path.resolve(basePath)
  const resolvedPath = path.resolve(resolvedBase, ...segments)
  return isPathInside(resolvedBase, resolvedPath) ? resolvedPath : null
}
