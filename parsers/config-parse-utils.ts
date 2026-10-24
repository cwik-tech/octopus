import type { YamlValue } from '../core/yaml-parser.js'

/**
 * Convert an optional YAML list only after verifying its runtime shape.
 * Config parsing must report authoring mistakes rather than letting a cast
 * turn into an uncaught `.map is not a function` at startup.
 */
export function parseYamlList(
  value: YamlValue | undefined,
  field: string,
  errors: string[],
): YamlValue[] {
  if (value == null) return []
  if (Array.isArray(value)) return value
  errors.push(`Invalid ${field}: must be an array`)
  return []
}

/** Validate a string-backed configuration enum and retain a safe typed value. */
export function validateEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
  errors: string[],
): T {
  if (allowed.includes(value as T)) return value as T
  errors.push(`Invalid ${field} '${value}'. Must be one of: ${allowed.join(', ')}`)
  const [fallback] = allowed
  if (fallback === undefined) throw new Error(`validateEnum for ${field} was given no allowed values`)
  return fallback
}
