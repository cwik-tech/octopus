const MAX_JSON_DEPTH = 64
const MAX_JSON_KEY_LENGTH = 512
const FORBIDDEN_JSON_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
])

export type CanonicalJsonPrimitive = string | number | boolean | null
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | CanonicalJsonObject
export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue
}

export interface CanonicalJsonHash {
  readonly algorithm: 'sha256'
  readonly value: string
}

export interface CanonicalJsonDocument {
  readonly value: CanonicalJsonObject
  readonly canonical: string
  readonly hash: CanonicalJsonHash
}

export class CanonicalJsonError extends Error {
  constructor() {
    super('Value must be a strict finite JSON object.')
    this.name = 'CanonicalJsonError'
  }
}

/**
 * Produces the strict recursively key-sorted form used for invocation binding.
 * The root must be an object. Hidden/accessor values and ambiguous object shapes
 * are rejected before any property value is read.
 */
export function canonicalizeJson(value: unknown): string {
  if (!isPlainObject(value)) throw new CanonicalJsonError()
  return canonicalizeJsonValue(value, new Set<object>(), 0)
}

/**
 * Validating conversion into the canonical object shape. Everything the
 * canonical form rejects — non-object roots, non-finite numbers, functions,
 * cycles, accessors — is rejected here too, so callers hand the journal a
 * value it can durably reproduce instead of asserting that it can.
 */
export function toCanonicalJsonObject(value: unknown): CanonicalJsonObject {
  const canonical = canonicalizeJson(value)
  // Re-reading the canonical text yields only JSON values by construction,
  // so the parsed root is a canonical object once its shape is confirmed.
  const parsed: unknown = JSON.parse(canonical)
  if (!isCanonicalJsonObject(parsed)) throw new CanonicalJsonError()
  return parsed
}

// Checks the root's shape only: callers pass text `canonicalizeJson`
// produced, whose nested values are JSON values by construction.
function isCanonicalJsonObject(
  value: unknown,
): value is CanonicalJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalizeJsonValue(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): string {
  if (depth > MAX_JSON_DEPTH) throw new CanonicalJsonError()
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalJsonError()
    return JSON.stringify(value)
  }
  if (isUnknownArray(value)) {
    return withAncestor(value, ancestors, () => {
      assertStrictArrayShape(value)
      const entries: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!isEnumerableDataDescriptor(descriptor)) {
          throw new CanonicalJsonError()
        }
        entries.push(
          canonicalizeJsonValue(descriptor.value, ancestors, depth + 1),
        )
      }
      return `[${entries.join(',')}]`
    })
  }
  if (!isPlainObject(value)) throw new CanonicalJsonError()
  return withAncestor(value, ancestors, () => {
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some((key) => typeof key !== 'string')) {
      throw new CanonicalJsonError()
    }
    const stringKeys = ownKeys.filter(isString).sort()
    const entries = stringKeys.map((key) => {
      assertSafeJsonKey(key)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!isEnumerableDataDescriptor(descriptor)) {
        throw new CanonicalJsonError()
      }
      return `${JSON.stringify(key)}:${canonicalizeJsonValue(
        descriptor.value,
        ancestors,
        depth + 1,
      )}`
    })
    return `{${entries.join(',')}}`
  })
}

function assertStrictArrayShape(value: readonly unknown[]): void {
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) {
    throw new CanonicalJsonError()
  }
  const stringKeys = keys.filter(isString)
  for (const key of stringKeys) {
    if (key === 'length') continue
    const numeric = Number(key)
    if (
      !Number.isInteger(numeric) ||
      numeric < 0 ||
      numeric >= value.length ||
      String(numeric) !== key
    ) {
      throw new CanonicalJsonError()
    }
  }
  if (stringKeys.length !== value.length + 1) {
    throw new CanonicalJsonError()
  }
}

function assertSafeJsonKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > MAX_JSON_KEY_LENGTH ||
    /[\0-\x1f\x7f]/.test(key) ||
    FORBIDDEN_JSON_KEYS.has(key)
  ) {
    throw new CanonicalJsonError()
  }
}

function withAncestor<T>(
  value: object,
  ancestors: Set<object>,
  operation: () => T,
): T {
  if (ancestors.has(value)) throw new CanonicalJsonError()
  ancestors.add(value)
  try {
    return operation()
  } finally {
    ancestors.delete(value)
  }
}

function isEnumerableDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { readonly value: unknown } {
  return Boolean(
    descriptor &&
      descriptor.enumerable &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value'),
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function isString(value: string | symbol): value is string {
  return typeof value === 'string'
}
