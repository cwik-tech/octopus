import { createHash } from 'node:crypto'

import {
  CanonicalJsonError,
  canonicalizeJson,
  type CanonicalJsonDocument,
  type CanonicalJsonObject,
  type CanonicalJsonValue,
} from '../contracts/canonical-json.js'

export function hashCanonicalJson(value: unknown): CanonicalJsonDocument['hash'] {
  return hashCanonicalJsonText(canonicalizeJson(value))
}

export function normalizeCanonicalJsonObject(value: unknown): CanonicalJsonDocument {
  const canonical = canonicalizeJson(value)
  const parsed: unknown = JSON.parse(canonical)
  if (!isCanonicalJsonObject(parsed)) throw new CanonicalJsonError()
  freezeCanonicalJsonValue(parsed)
  return {
    value: parsed,
    canonical,
    hash: hashCanonicalJsonText(canonical),
  }
}

function freezeCanonicalJsonValue(value: CanonicalJsonValue): void {
  if (!value || typeof value !== 'object') return
  // Object.values yields an array's elements as well as an object's values.
  for (const entry of Object.values(value)) freezeCanonicalJsonValue(entry)
  Object.freeze(value)
}

function hashCanonicalJsonText(
  canonical: string,
): CanonicalJsonDocument['hash'] {
  return {
    algorithm: 'sha256',
    value: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  }
}

function isCanonicalJsonObject(value: unknown): value is CanonicalJsonObject {
  if (!isPlainObject(value)) return false
  return Object.values(value).every(isCanonicalJsonValue)
}

function isCanonicalJsonValue(value: unknown): value is CanonicalJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isCanonicalJsonValue)
  return isCanonicalJsonObject(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
