/**
 * Narrowing for Node's errno-bearing errors.
 *
 * `catch` binds `unknown`, and the usual way to read `.code` off it is a type
 * assertion. `AGENTS.md` asks for a guard instead: an assertion here would
 * claim a shape the runtime never checked, and an error object without a
 * `code` — a plain `Error`, a thrown string — would read as `undefined` by
 * luck rather than by design.
 */

/** The error's `code`, when it carries a string one. */
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  const { code } = error
  return typeof code === 'string' ? code : undefined
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return errorCodeOf(error) === code
}
