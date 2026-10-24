import assert from 'node:assert/strict'
import test from 'node:test'

import { isSafePathSegment } from '../../core/path-safety.js'
import {
  DEFAULT_MAX_SPAWN_DEPTH,
} from '../../core/constants.js'
import {
  MAX_RUNTIME_ASSIGNMENT_CREDENTIAL_LENGTH,
  RuntimeAssignmentCredentialError,
  deriveRuntimeAssignmentCredential,
  hashRuntimeAssignmentGrantId,
  verifyRuntimeAssignmentCredential,
  type RuntimeAssignmentCredentialSeed,
} from '../../core/runtime-assignment-credential.js'

const ROOT_SEED: RuntimeAssignmentCredentialSeed = {
  sessionId: 'session-credential',
  runId: 'run-credential',
  taskId: 'task-credential',
  rootAssignmentId: 'assignment-root',
  taskProcessIdentity: 'attempt-private-root-identity',
}

test('a root derivation creates a compact safe-segment credential without disclosing the task process identity', () => {
  const credential = deriveFromRoot('assignment-child-1')

  assert.match(credential, /^d1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u)
  assert.equal(isSafePathSegment(credential), true)
  assert.ok(credential.length <= MAX_RUNTIME_ASSIGNMENT_CREDENTIAL_LENGTH)
  assert.equal(decodePayload(credential).includes(ROOT_SEED.taskProcessIdentity), false)
  assert.deepEqual(
    verifyRuntimeAssignmentCredential({
      credential,
      seed: ROOT_SEED,
      assignmentId: 'assignment-child-1',
    }),
    {
      depth: 1,
      rootAssignmentHash: hashRuntimeAssignmentGrantId('assignment-root'),
      assignmentHash: hashRuntimeAssignmentGrantId('assignment-child-1'),
      lineageHashes: [
        hashRuntimeAssignmentGrantId('assignment-root'),
        hashRuntimeAssignmentGrantId('assignment-child-1'),
      ],
    },
  )
})

test('a delegated credential derives and verifies an ordered lineage to the maximum descendant depth', () => {
  const first = deriveFromRoot('assignment-child-1')
  const second = deriveFromCredential(
    first,
    'assignment-child-1',
    'assignment-child-2',
  )
  const third = deriveFromCredential(
    second,
    'assignment-child-2',
    'assignment-child-3',
  )

  const verified = verifyRuntimeAssignmentCredential({
    credential: third,
    seed: ROOT_SEED,
    assignmentId: 'assignment-child-3',
  })

  assert.equal(verified?.depth, DEFAULT_MAX_SPAWN_DEPTH)
  assert.deepEqual(verified?.lineageHashes, [
    hashRuntimeAssignmentGrantId('assignment-root'),
    hashRuntimeAssignmentGrantId('assignment-child-1'),
    hashRuntimeAssignmentGrantId('assignment-child-2'),
    hashRuntimeAssignmentGrantId('assignment-child-3'),
  ])
  assert.ok(third.length <= MAX_RUNTIME_ASSIGNMENT_CREDENTIAL_LENGTH)
})

test('payload and proof tampering fail verification', () => {
  const credential = deriveFromRoot('assignment-child-1')

  assert.equal(
    verifyRuntimeAssignmentCredential({
      credential: tamperPayload(credential),
      seed: ROOT_SEED,
      assignmentId: 'assignment-child-1',
    }),
    null,
  )
  assert.equal(
    verifyRuntimeAssignmentCredential({
      credential: tamperProof(credential),
      seed: ROOT_SEED,
      assignmentId: 'assignment-child-1',
    }),
    null,
  )
})

test('a credential cannot authorize a sibling or different root claim set', () => {
  const credential = deriveFromRoot('assignment-child-1')
  const wrongInputs = [
    { seed: ROOT_SEED, assignmentId: 'assignment-sibling' },
    { seed: { ...ROOT_SEED, sessionId: 'session-other' }, assignmentId: 'assignment-child-1' },
    { seed: { ...ROOT_SEED, runId: 'run-other' }, assignmentId: 'assignment-child-1' },
    { seed: { ...ROOT_SEED, taskId: 'task-other' }, assignmentId: 'assignment-child-1' },
    {
      seed: { ...ROOT_SEED, rootAssignmentId: 'assignment-other-root' },
      assignmentId: 'assignment-child-1',
    },
  ]

  for (const input of wrongInputs) {
    assert.equal(
      verifyRuntimeAssignmentCredential({ credential, ...input }),
      null,
    )
  }
})

test('nested derivation rejects a credential claimed for a different parent assignment', () => {
  const credential = deriveFromRoot('assignment-child-1')

  assert.throws(
    () => deriveFromCredential(
      credential,
      'assignment-sibling',
      'assignment-grandchild',
    ),
    (error: unknown) =>
      error instanceof RuntimeAssignmentCredentialError &&
      error.code === 'invalid_parent',
  )
})

test('a credential becomes invalid when the root task process identity changes', () => {
  const credential = deriveFromRoot('assignment-child-1')

  assert.equal(
    verifyRuntimeAssignmentCredential({
      credential,
      seed: {
        ...ROOT_SEED,
        taskProcessIdentity: 'attempt-restarted-with-new-identity',
      },
      assignmentId: 'assignment-child-1',
    }),
    null,
  )
})

test('derivation rejects descendants beyond the shared spawn-depth limit', () => {
  const first = deriveFromRoot('assignment-child-1')
  const second = deriveFromCredential(
    first,
    'assignment-child-1',
    'assignment-child-2',
  )
  const third = deriveFromCredential(
    second,
    'assignment-child-2',
    'assignment-child-3',
  )

  assert.throws(
    () => deriveFromCredential(
      third,
      'assignment-child-3',
      'assignment-child-4',
    ),
    (error: unknown) =>
      error instanceof RuntimeAssignmentCredentialError &&
      error.code === 'maximum_depth',
  )
})

test('oversized claims and credentials are rejected before hashing or parsing', () => {
  const oversized = 'x'.repeat(513)
  assert.throws(
    () => hashRuntimeAssignmentGrantId(oversized),
    (error: unknown) =>
      error instanceof RuntimeAssignmentCredentialError &&
      error.code === 'invalid_assignment',
  )
  assert.throws(
    () => deriveRuntimeAssignmentCredential({
      parent: {
        kind: 'root',
        seed: { ...ROOT_SEED, taskProcessIdentity: oversized },
      },
      assignmentId: 'assignment-child-1',
    }),
    (error: unknown) =>
      error instanceof RuntimeAssignmentCredentialError &&
      error.code === 'invalid_seed',
  )
  const oversizedCredential = `d1.${'A'.repeat(512)}.${'A'.repeat(43)}`
  assert.ok(oversizedCredential.length > MAX_RUNTIME_ASSIGNMENT_CREDENTIAL_LENGTH)
  assert.equal(
    verifyRuntimeAssignmentCredential({
      credential: oversizedCredential,
      seed: ROOT_SEED,
      assignmentId: 'assignment-child-1',
    }),
    null,
  )
})

test('unknown and non-canonical delegated credentials fail closed', () => {
  const credential = deriveFromRoot('assignment-child-1')
  const [prefix, payload, proof] = credential.split('.')
  assert.ok(prefix && payload && proof)
  const malformed: readonly unknown[] = [
    undefined,
    null,
    {},
    '',
    credential.replace('d1.', 'd2.'),
    `${prefix}.${payload}=.${proof}`,
    `${prefix}.${payload}.short`,
    `${credential}.extra`,
  ]

  for (const value of malformed) {
    assert.equal(
      verifyRuntimeAssignmentCredential({
        credential: value,
        seed: ROOT_SEED,
        assignmentId: 'assignment-child-1',
      }),
      null,
    )
  }
  assert.throws(
    () => deriveRuntimeAssignmentCredential({
      parent: {
        kind: 'delegated',
        credential: {},
        assignmentId: 'assignment-child-1',
      },
      assignmentId: 'assignment-child-2',
    }),
    (error: unknown) =>
      error instanceof RuntimeAssignmentCredentialError &&
      error.code === 'invalid_parent',
  )
})

function deriveFromRoot(assignmentId: string): string {
  return deriveRuntimeAssignmentCredential({
    parent: { kind: 'root', seed: ROOT_SEED },
    assignmentId,
  })
}

function deriveFromCredential(
  credential: string,
  parentAssignmentId: string,
  assignmentId: string,
): string {
  return deriveRuntimeAssignmentCredential({
    parent: {
      kind: 'delegated',
      credential,
      assignmentId: parentAssignmentId,
    },
    assignmentId,
  })
}

function decodePayload(credential: string): string {
  const payload = credential.split('.')[1]
  assert.ok(payload)
  return Buffer.from(payload, 'base64url').toString('utf8')
}

function tamperPayload(credential: string): string {
  const [prefix, payload, proof] = credential.split('.')
  assert.ok(prefix && payload && proof)
  const bytes = Buffer.from(payload, 'base64url')
  const lastByte = bytes[bytes.length - 1]
  assert.ok(lastByte !== undefined)
  bytes[bytes.length - 1] = lastByte ^ 1
  return `${prefix}.${bytes.toString('base64url')}.${proof}`
}

function tamperProof(credential: string): string {
  const [prefix, payload, proof] = credential.split('.')
  assert.ok(prefix && payload && proof)
  const replacement = proof.startsWith('A') ? 'B' : 'A'
  return `${prefix}.${payload}.${replacement}${proof.slice(1)}`
}
