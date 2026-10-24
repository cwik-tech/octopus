import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'

import { DEFAULT_MAX_SPAWN_DEPTH } from './constants.js'
import { isSafePathSegment } from './path-safety.js'

export const MAX_RUNTIME_ASSIGNMENT_CREDENTIAL_LENGTH = 512

const CREDENTIAL_PREFIX = 'd1'
const HASH_BYTE_LENGTH = 32
const HASH_SEGMENT_LENGTH = 43
const MAX_IDENTIFIER_LENGTH = 512
const ROOT_SEED_DOMAIN = 'pipeline.runtime-assignment.root.v1'
const ASSIGNMENT_HASH_DOMAIN = 'pipeline.runtime-assignment.grant.v1'
const CREDENTIAL_PROOF_DOMAIN = 'pipeline.runtime-assignment.proof.v1'

export interface RuntimeAssignmentCredentialSeed {
  readonly sessionId: string
  readonly runId: string
  readonly taskId: string
  readonly rootAssignmentId: string
  readonly taskProcessIdentity: string
}

export type RuntimeAssignmentCredentialParent =
  | {
      readonly kind: 'root'
      readonly seed: RuntimeAssignmentCredentialSeed
    }
  | {
      readonly kind: 'delegated'
      readonly credential: unknown
      readonly assignmentId: unknown
    }

export interface DeriveRuntimeAssignmentCredentialInput {
  readonly parent: RuntimeAssignmentCredentialParent
  readonly assignmentId: unknown
}

export interface VerifyRuntimeAssignmentCredentialInput {
  readonly credential: unknown
  readonly seed: RuntimeAssignmentCredentialSeed
  readonly assignmentId: unknown
}

export interface RuntimeAssignmentCredentialClaims {
  readonly depth: number
  readonly rootAssignmentHash: string
  readonly assignmentHash: string
  readonly lineageHashes: readonly string[]
}

export type RuntimeAssignmentCredentialErrorCode =
  | 'invalid_assignment'
  | 'invalid_parent'
  | 'invalid_seed'
  | 'maximum_depth'
  | 'credential_too_large'

export class RuntimeAssignmentCredentialError extends Error {
  constructor(readonly code: RuntimeAssignmentCredentialErrorCode) {
    super('Runtime assignment credential could not be created.')
    this.name = 'RuntimeAssignmentCredentialError'
  }
}

interface ParsedRuntimeAssignmentCredential {
  readonly credential: string
  readonly depth: number
  readonly lineageHashBytes: readonly Buffer[]
}

export function hashRuntimeAssignmentGrantId(assignmentId: unknown): string {
  const hash = readRuntimeAssignmentGrantHash(assignmentId)
  if (!hash) {
    throw new RuntimeAssignmentCredentialError('invalid_assignment')
  }
  return hash.toString('base64url')
}

export function deriveRuntimeAssignmentCredential(
  input: DeriveRuntimeAssignmentCredentialInput,
): string {
  if (!isDerivationInput(input)) {
    throw new RuntimeAssignmentCredentialError('invalid_parent')
  }

  const assignmentHash = readRuntimeAssignmentGrantHash(input.assignmentId)
  if (!assignmentHash) {
    throw new RuntimeAssignmentCredentialError('invalid_assignment')
  }

  if (input.parent.kind === 'root') {
    if (!isRuntimeAssignmentCredentialSeed(input.parent.seed)) {
      throw new RuntimeAssignmentCredentialError('invalid_seed')
    }
    const rootAssignmentHash = readRuntimeAssignmentGrantHash(
      input.parent.seed.rootAssignmentId,
    )
    if (!rootAssignmentHash) {
      throw new RuntimeAssignmentCredentialError('invalid_seed')
    }
    return createCredential(
      encodePayload(1, [rootAssignmentHash, assignmentHash]),
      createRootSeed(input.parent.seed),
    )
  }

  const parentCredential = parseCredential(input.parent.credential)
  const parentAssignmentHash = readRuntimeAssignmentGrantHash(
    input.parent.assignmentId,
  )
  const credentialAssignmentHash = parentCredential?.lineageHashBytes.at(-1)
  if (
    !parentCredential ||
    !parentAssignmentHash ||
    !credentialAssignmentHash ||
    !equalHashes(credentialAssignmentHash, parentAssignmentHash)
  ) {
    throw new RuntimeAssignmentCredentialError('invalid_parent')
  }
  if (parentCredential.depth >= DEFAULT_MAX_SPAWN_DEPTH) {
    throw new RuntimeAssignmentCredentialError('maximum_depth')
  }
  const depth = parentCredential.depth + 1
  return createCredential(
    encodePayload(depth, [
      ...parentCredential.lineageHashBytes,
      assignmentHash,
    ]),
    Buffer.from(parentCredential.credential, 'utf8'),
  )
}

export function verifyRuntimeAssignmentCredential(
  input: VerifyRuntimeAssignmentCredentialInput,
): RuntimeAssignmentCredentialClaims | null {
  if (
    !isVerificationInput(input) ||
    !isRuntimeAssignmentCredentialSeed(input.seed)
  ) {
    return null
  }
  const credential = parseCredential(input.credential)
  const assignmentHash = readRuntimeAssignmentGrantHash(input.assignmentId)
  const rootAssignmentHash = readRuntimeAssignmentGrantHash(
    input.seed.rootAssignmentId,
  )
  if (!credential || !assignmentHash || !rootAssignmentHash) return null

  const firstHash = credential.lineageHashBytes.at(0)
  const lastHash = credential.lineageHashBytes.at(-1)
  if (
    !firstHash ||
    !lastHash ||
    !equalHashes(firstHash, rootAssignmentHash) ||
    !equalHashes(lastHash, assignmentHash)
  ) {
    return null
  }

  let expectedCredential = ''
  for (let depth = 1; depth <= credential.depth; depth += 1) {
    const key = depth === 1
      ? createRootSeed(input.seed)
      : Buffer.from(expectedCredential, 'utf8')
    expectedCredential = createCredential(
      encodePayload(
        depth,
        credential.lineageHashBytes.slice(0, depth + 1),
      ),
      key,
    )
  }
  if (!equalCredentialStrings(credential.credential, expectedCredential)) {
    return null
  }

  const lineageHashes = Object.freeze(
    credential.lineageHashBytes.map((hash) => hash.toString('base64url')),
  )
  const verifiedRootHash = lineageHashes.at(0)
  const verifiedAssignmentHash = lineageHashes.at(-1)
  if (!verifiedRootHash || !verifiedAssignmentHash) return null
  return Object.freeze({
    depth: credential.depth,
    rootAssignmentHash: verifiedRootHash,
    assignmentHash: verifiedAssignmentHash,
    lineageHashes,
  })
}

export function isRuntimeAssignmentCredentialSeed(
  value: unknown,
): value is RuntimeAssignmentCredentialSeed {
  if (!isRecord(value) || !hasExactKeys(value, [
    'rootAssignmentId',
    'runId',
    'sessionId',
    'taskId',
    'taskProcessIdentity',
  ])) {
    return false
  }
  return isIdentifier(value.sessionId) &&
    isIdentifier(value.runId) &&
    isIdentifier(value.taskId) &&
    isAssignmentId(value.rootAssignmentId) &&
    isIdentifier(value.taskProcessIdentity)
}

function createRootSeed(seed: RuntimeAssignmentCredentialSeed): Buffer {
  return createHmac('sha256', seed.taskProcessIdentity)
    .update(JSON.stringify([
      ROOT_SEED_DOMAIN,
      seed.sessionId,
      seed.runId,
      seed.taskId,
      seed.rootAssignmentId,
    ]), 'utf8')
    .digest()
}

function readRuntimeAssignmentGrantHash(value: unknown): Buffer | null {
  if (!isAssignmentId(value)) return null
  return createHash('sha256')
    .update(ASSIGNMENT_HASH_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest()
}

function createCredential(payload: Buffer, key: Buffer): string {
  const payloadSegment = payload.toString('base64url')
  const proofSegment = createHmac('sha256', key)
    .update(CREDENTIAL_PROOF_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(payloadSegment, 'ascii')
    .digest('base64url')
  const credential = `${CREDENTIAL_PREFIX}.${payloadSegment}.${proofSegment}`
  if (
    credential.length > MAX_RUNTIME_ASSIGNMENT_CREDENTIAL_LENGTH ||
    !isSafePathSegment(credential)
  ) {
    throw new RuntimeAssignmentCredentialError('credential_too_large')
  }
  return credential
}

function encodePayload(
  depth: number,
  lineageHashBytes: readonly Buffer[],
): Buffer {
  const payload = Buffer.alloc(1 + lineageHashBytes.length * HASH_BYTE_LENGTH)
  payload.writeUInt8(depth, 0)
  for (const [index, hash] of lineageHashBytes.entries()) {
    hash.copy(payload, 1 + index * HASH_BYTE_LENGTH)
  }
  return payload
}

function parseCredential(value: unknown): ParsedRuntimeAssignmentCredential | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RUNTIME_ASSIGNMENT_CREDENTIAL_LENGTH ||
    !isSafePathSegment(value)
  ) {
    return null
  }
  const parts = value.split('.')
  if (
    parts.length !== 3 ||
    parts[0] !== CREDENTIAL_PREFIX ||
    !isCanonicalBase64Url(parts[1]) ||
    !isCanonicalBase64Url(parts[2], HASH_SEGMENT_LENGTH)
  ) {
    return null
  }

  const payload = decodeCanonicalBase64Url(parts[1])
  const proof = decodeCanonicalBase64Url(parts[2])
  if (!payload || !proof || proof.length !== HASH_BYTE_LENGTH) return null
  const depth = payload.readUInt8(0)
  const lineageLength = depth + 1
  if (
    depth < 1 ||
    depth > DEFAULT_MAX_SPAWN_DEPTH ||
    payload.length !== 1 + lineageLength * HASH_BYTE_LENGTH
  ) {
    return null
  }

  const lineageHashBytes: Buffer[] = []
  for (let index = 0; index < lineageLength; index += 1) {
    const start = 1 + index * HASH_BYTE_LENGTH
    lineageHashBytes.push(Buffer.from(
      payload.subarray(start, start + HASH_BYTE_LENGTH),
    ))
  }
  return {
    credential: value,
    depth,
    lineageHashBytes,
  }
}

function decodeCanonicalBase64Url(value: string | undefined): Buffer | null {
  if (!value || !isCanonicalBase64Url(value)) return null
  try {
    const bytes = Buffer.from(value, 'base64url')
    return bytes.toString('base64url') === value ? bytes : null
  } catch {
    return null
  }
}

function isCanonicalBase64Url(
  value: string | undefined,
  expectedLength?: number,
): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    (expectedLength === undefined || value.length === expectedLength) &&
    /^[A-Za-z0-9_-]+$/u.test(value)
}

function equalHashes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function equalCredentialStrings(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
}

function isDerivationInput(
  value: unknown,
): value is DeriveRuntimeAssignmentCredentialInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['assignmentId', 'parent']) ||
    !isRecord(value.parent)
  ) {
    return false
  }
  if (value.parent.kind === 'root') {
    return hasExactKeys(value.parent, ['kind', 'seed'])
  }
  return value.parent.kind === 'delegated' &&
    hasExactKeys(value.parent, ['assignmentId', 'credential', 'kind'])
}

function isVerificationInput(
  value: unknown,
): value is VerifyRuntimeAssignmentCredentialInput {
  return isRecord(value) &&
    hasExactKeys(value, ['assignmentId', 'credential', 'seed'])
}

function isAssignmentId(value: unknown): value is string {
  return isIdentifier(value) && isSafePathSegment(value)
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !/[\0-\x1f\x7f]/u.test(value)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== 'string')) return false
  const actual = ownKeys.filter(isString).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
}

function isString(value: string | symbol): value is string {
  return typeof value === 'string'
}
