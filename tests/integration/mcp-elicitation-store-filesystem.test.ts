import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  McpElicitationError,
  type McpElicitationExactBinding,
  type McpElicitationRequestInput,
} from '../../domains/mcp/mcp-elicitation.js'
import {
  McpElicitationStore,
  type McpElicitationStoreOptions,
} from '../../domains/mcp/mcp-elicitation-store.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'

const START_TIME = Date.parse('2026-07-12T20:00:00.000Z')

type FormRequest = Extract<McpElicitationRequestInput, { readonly mode: 'form' }>
type UrlRequest = Extract<McpElicitationRequestInput, { readonly mode: 'url' }>

interface Harness {
  readonly workspacePath: string
  readonly assignmentPath: string
  readonly statePath: string
  readonly options: McpElicitationStoreOptions
  readonly store: McpElicitationStore
  readonly now: { value: number }
  cleanup(): void
}

function createHarness(
  prefix = 'mcp-elicitation-fs-',
  optionOverrides: Partial<McpElicitationStoreOptions> = {},
): Harness {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  })
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true, mode: 0o700 })
  const now = { value: START_TIME }
  const options: McpElicitationStoreOptions = {
    workspacePath,
    sessionId: location.sessionId,
    runId: location.runId,
    assignmentId: location.assignmentId,
    now: () => now.value,
    ...optionOverrides,
  }
  return {
    workspacePath,
    assignmentPath: location.assignmentPath,
    statePath: path.join(
      location.assignmentPath,
      'mcp',
      'elicitations',
      'state.json',
    ),
    options,
    store: new McpElicitationStore(options),
    now,
    cleanup() {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    },
  }
}

function formRequest(
  index: number,
  overrides: Partial<FormRequest> = {},
): FormRequest {
  return {
    interactionId: `elicitation-form-${index}`,
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath: 'agents/researcher',
    serverId: 'identity-server',
    parentRequestId: `parent-request-${index}`,
    toolCallId: `tool-call-${index}`,
    namespacedToolName: 'mcp__identity-server__enrich',
    mode: 'form',
    message: 'Provide the non-secret profile fields.',
    schema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 10 },
        displayName: { type: 'string', minLength: 1, maxLength: 80 },
        notify: { type: 'boolean' },
      },
      required: ['displayName', 'count'],
    },
    ...overrides,
  }
}

function urlRequest(
  index: number,
  overrides: Partial<UrlRequest> = {},
): UrlRequest {
  return {
    interactionId: `elicitation-url-${index}`,
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath: 'agents/researcher',
    serverId: 'oauth-server',
    parentRequestId: `parent-url-request-${index}`,
    toolCallId: `url-tool-call-${index}`,
    namespacedToolName: 'mcp__oauth-server__authorize',
    mode: 'url',
    message: 'Open the provider authorization page.',
    url: `https://auth.example.test/authorize?request=${index}`,
    elicitationId: `provider-elicitation-${index}`,
    ...overrides,
  }
}

function exactBinding(input: McpElicitationRequestInput): McpElicitationExactBinding {
  return {
    interactionId: input.interactionId,
    sessionId: input.sessionId,
    runId: input.runId,
    assignmentId: input.assignmentId,
    agentPath: input.agentPath,
    serverId: input.serverId,
    parentRequestId: input.parentRequestId,
    toolCallId: input.toolCallId,
    namespacedToolName: input.namespacedToolName,
  }
}

function hasCode(code: McpElicitationError['code']) {
  return (error: unknown): boolean =>
    error instanceof McpElicitationError && error.code === code
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

test('form and URL views persist canonically while accepted values remain ephemeral', async () => {
  const harness = createHarness()
  const form = formRequest(1)
  const url = urlRequest(1)
  const secretValue = 'ephemeral-user-value-3b2ad1'

  try {
    const pending = await harness.store.createRequest(form)
    assert.equal(pending.mode, 'form')
    assert.equal(pending.status, 'pending')
    assert.equal(pending.parentRequestId, form.parentRequestId)
    assert.equal('values' in pending, false)
    assert.equal('valuesHash' in pending, false)
    assert.equal('responseId' in pending, false)
    assert.equal(
      fs.existsSync(
        path.join(harness.workspacePath, 'assignments', form.assignmentId),
      ),
      false,
    )
    assert.deepEqual(await harness.store.createRequest(form), pending)

    await assert.rejects(
      harness.store.createRequest({ ...form, message: 'Changed message.' }),
      hasCode('binding_mismatch'),
    )

    const acceptedInput = {
      ...exactBinding(form),
      responseId: 'response-form-1',
      mode: 'form',
      action: 'accept',
      values: {
        count: 2,
        displayName: secretValue,
        notify: true,
      },
    } as const
    const accepted = await harness.store.respond(acceptedInput)
    assert.equal(accepted.view.status, 'accepted')
    assert.equal(accepted.view.action, 'accept')
    assert.ok('values' in accepted)
    assert.deepEqual(accepted.values, {
      count: 2,
      displayName: secretValue,
      notify: true,
    })
    assert.equal(JSON.stringify(accepted.view).includes(secretValue), false)
    assert.deepEqual(await harness.store.respond(acceptedInput), accepted)

    await assert.rejects(
      harness.store.respond({
        ...acceptedInput,
        values: { ...acceptedInput.values, count: 3 },
      }),
      hasCode('already_resolved'),
    )
    await assert.rejects(
      harness.store.respond({
        ...acceptedInput,
        parentRequestId: 'different-parent-request',
      }),
      hasCode('binding_mismatch'),
    )
    await assert.rejects(
      harness.store.respond({ ...acceptedInput, sessionId: 'other-session' }),
      hasCode('not_found'),
    )

    const urlPending = await harness.store.createRequest(url)
    assert.equal(urlPending.mode, 'url')
    assert.equal(urlPending.url, url.url)
    const urlResponse = {
      ...exactBinding(url),
      responseId: 'response-url-1',
      mode: 'url',
      elicitationId: url.elicitationId,
      action: 'accept',
    } as const
    const urlAccepted = await harness.store.respond(urlResponse)
    assert.equal(urlAccepted.view.status, 'accepted')
    assert.equal('values' in urlAccepted, false)
    assert.deepEqual(await harness.store.respond(urlResponse), urlAccepted)
    await assert.rejects(
      harness.store.respond({
        ...urlResponse,
        elicitationId: 'different-elicitation',
      }),
      hasCode('binding_mismatch'),
    )

    const persistedText = fs.readFileSync(harness.statePath, 'utf8')
    assert.equal(persistedText.includes(secretValue), false)
    assert.match(persistedText, /"valuesHash":/)
    assert.match(persistedText, /"url": "https:\/\/auth\.example\.test\//)
    const listed = await harness.store.list()
    assert.equal(listed.length, 2)
    for (const view of listed) {
      assert.equal('values' in view, false)
      assert.equal('valuesHash' in view, false)
      assert.equal('responseId' in view, false)
      assert.equal(JSON.stringify(view).includes(secretValue), false)
    }
  } finally {
    harness.cleanup()
  }
})

test('decline, cancel, expiry, and restart interruption are terminal and idempotent', async () => {
  const harness = createHarness()
  const declined = formRequest(10)
  const cancelled = formRequest(11)
  const expired = formRequest(12, { ttlMs: 1_000 })
  const interrupted = formRequest(13)
  const urlDeclined = urlRequest(14)
  const urlCancelled = urlRequest(15)

  try {
    await Promise.all(
      [declined, cancelled, expired, interrupted, urlDeclined, urlCancelled].map(
        (request) => harness.store.createRequest(request),
      ),
    )
    const declineInput = {
      ...exactBinding(declined),
      responseId: 'response-decline',
      mode: 'form',
      action: 'decline',
    } as const
    assert.equal(
      (await harness.store.respond(declineInput)).view.status,
      'declined',
    )
    assert.equal(
      (await harness.store.respond(declineInput)).view.status,
      'declined',
    )

    const cancelInput = {
      ...exactBinding(cancelled),
      responseId: 'response-cancel',
      mode: 'form',
      action: 'cancel',
    } as const
    assert.equal(
      (await harness.store.respond(cancelInput)).view.status,
      'cancelled',
    )
    await assert.rejects(
      harness.store.respond({
        ...cancelInput,
        responseId: 'different-response',
      }),
      hasCode('already_resolved'),
    )

    assert.equal(
      (
        await harness.store.respond({
          ...exactBinding(urlDeclined),
          responseId: 'url-decline-response',
          mode: 'url',
          elicitationId: urlDeclined.elicitationId,
          action: 'decline',
        })
      ).view.status,
      'declined',
    )
    assert.equal(
      (
        await harness.store.respond({
          ...exactBinding(urlCancelled),
          responseId: 'url-cancel-response',
          mode: 'url',
          elicitationId: urlCancelled.elicitationId,
          action: 'cancel',
        })
      ).view.status,
      'cancelled',
    )

    harness.now.value += 1_000
    assert.deepEqual(
      (await harness.store.expirePending()).map((view) => view.interactionId),
      [expired.interactionId],
    )
    await assert.rejects(
      harness.store.respond({
        ...exactBinding(expired),
        responseId: 'late-response',
        mode: 'form',
        action: 'accept',
        values: { count: 1, displayName: 'Late' },
      }),
      hasCode('expired'),
    )

    harness.now.value += 1_000
    const restarted = new McpElicitationStore(harness.options)
    assert.deepEqual(
      (await restarted.recoverPendingAfterRestart()).map(
        (view) => view.interactionId,
      ),
      [interrupted.interactionId],
    )
    assert.equal(
      (await restarted.get(interrupted.interactionId))?.status,
      'interrupted',
    )
    assert.deepEqual(await restarted.recoverPendingAfterRestart(), [])
    await assert.rejects(
      restarted.respond({
        ...exactBinding(interrupted),
        responseId: 'after-restart',
        mode: 'form',
        action: 'decline',
      }),
      hasCode('already_resolved'),
    )
    assert.equal((await restarted.get(declined.interactionId))?.status, 'declined')
  } finally {
    harness.cleanup()
  }
})

test('real filesystem mutations remain atomic across concurrent store instances', async () => {
  const harness = createHarness('mcp-elicitation-concurrency-', {
    maxRecords: 128,
  })
  const firstStore = harness.store
  const secondStore = new McpElicitationStore(harness.options)

  try {
    const requests = Array.from({ length: 48 }, (_value, index) =>
      index % 2 === 0 ? formRequest(index + 100) : urlRequest(index + 100),
    )
    await Promise.all(
      requests.map((request, index) =>
        (index % 2 === 0 ? firstStore : secondStore).createRequest(request),
      ),
    )
    assert.equal((await firstStore.list()).length, requests.length)

    const target = requests[0] as FormRequest
    const competing = await Promise.allSettled([
      firstStore.respond({
        ...exactBinding(target),
        responseId: 'competing-accept',
        mode: 'form',
        action: 'accept',
        values: { count: 1, displayName: 'Concurrent' },
      }),
      secondStore.respond({
        ...exactBinding(target),
        responseId: 'competing-decline',
        mode: 'form',
        action: 'decline',
      }),
    ])
    assert.equal(
      competing.filter((result) => result.status === 'fulfilled').length,
      1,
    )
    const rejected = competing.find((result) => result.status === 'rejected')
    assert.ok(rejected && rejected.status === 'rejected')
    assert.ok(hasCode('already_resolved')(rejected.reason))

    const persisted = JSON.parse(fs.readFileSync(harness.statePath, 'utf8')) as {
      version: number
      requests: Array<{ interactionId: string; mode: string; status: string }>
    }
    assert.equal(persisted.version, 1)
    assert.equal(persisted.requests.length, requests.length)
    assert.equal(
      persisted.requests.filter(
        (record) =>
          record.interactionId === target.interactionId &&
          (record.status === 'accepted' || record.status === 'declined'),
      ).length,
      1,
    )
    assert.equal(
      persisted.requests.filter((record) => record.mode === 'form').length,
      24,
    )
    assert.equal(
      persisted.requests.filter((record) => record.mode === 'url').length,
      24,
    )
    assert.deepEqual(
      fs
        .readdirSync(path.dirname(harness.statePath))
        .filter((entry) => entry.endsWith('.tmp')),
      [],
    )
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(harness.statePath).mode & 0o777, 0o600)
      assert.equal(
        fs.statSync(path.dirname(harness.statePath)).mode & 0o777,
        0o700,
      )
      assert.equal(
        fs.statSync(path.join(harness.assignmentPath, 'mcp')).mode & 0o777,
        0o700,
      )
    }
  } finally {
    harness.cleanup()
  }
})

test('capacity and TTL limits fail without mutating accepted state', async () => {
  const harness = createHarness('mcp-elicitation-capacity-', {
    maxRecords: 2,
  })

  try {
    await harness.store.createRequest(formRequest(200))
    await harness.store.createRequest(urlRequest(201))
    await assert.rejects(
      harness.store.createRequest(formRequest(202)),
      hasCode('capacity_exceeded'),
    )
    assert.equal((await harness.store.list()).length, 2)
    for (const ttlMs of [0, -1, 60 * 60 * 1_000 + 1, Number.NaN]) {
      await assert.rejects(
        harness.store.createRequest(formRequest(203, { ttlMs })),
        hasCode('invalid_request'),
      )
    }
    assert.equal((await harness.store.list()).length, 2)
    assert.throws(
      () => new McpElicitationStore({ ...harness.options, maxRecords: 0 }),
      hasCode('invalid_request'),
    )
    assert.throws(
      () =>
        new McpElicitationStore({
          ...harness.options,
          assignmentId: '../escape',
        }),
      hasCode('invalid_request'),
    )
  } finally {
    harness.cleanup()
  }
})

test('corrupt, future, injected, cross-assignment, and non-canonical state fail closed', async () => {
  const harness = createHarness('mcp-elicitation-tamper-')
  const request = formRequest(300)

  try {
    await harness.store.createRequest(request)
    await harness.store.respond({
      ...exactBinding(request),
      responseId: 'tamper-baseline-response',
      mode: 'form',
      action: 'accept',
      values: { count: 2, displayName: 'Baseline' },
    })
    const valid = JSON.parse(fs.readFileSync(harness.statePath, 'utf8')) as {
      version: number
      assignment: Record<string, unknown>
      requests: Array<Record<string, unknown>>
      [key: string]: unknown
    }
    const future = { ...clone(valid), version: 2 }
    const extraRoot = { ...clone(valid), unexpected: true }
    const crossAssignment = clone(valid)
    crossAssignment.assignment.assignmentId = 'other-assignment'
    const injectedValues = clone(valid)
    injectedValues.requests[0]!.values = { displayName: 'must-not-persist' }
    const secretSchema = clone(valid)
    const schema = secretSchema.requests[0]!.schema as {
      properties: Record<string, Record<string, unknown>>
    }
    schema.properties.displayName!.format = 'password'
    const invalidDigest = clone(valid)
    ;(invalidDigest.requests[0]!.valuesHash as Record<string, unknown>).value =
      'not-a-digest'
    const mismatchedTerminal = clone(valid)
    mismatchedTerminal.requests[0]!.status = 'declined'

    for (const tampered of [
      future,
      extraRoot,
      crossAssignment,
      injectedValues,
      secretSchema,
      invalidDigest,
      mismatchedTerminal,
    ]) {
      fs.writeFileSync(harness.statePath, JSON.stringify(tampered), {
        mode: 0o600,
      })
      await assert.rejects(harness.store.list(), hasCode('storage_invalid'))
    }

    fs.writeFileSync(harness.statePath, '{not-json', { mode: 0o600 })
    await assert.rejects(harness.store.list(), hasCode('storage_invalid'))

    fs.writeFileSync(harness.statePath, JSON.stringify(valid), { mode: 0o600 })
    fs.truncateSync(harness.statePath, 8 * 1_024 * 1_024 + 1)
    await assert.rejects(harness.store.list(), hasCode('storage_invalid'))

    if (process.platform !== 'win32') {
      fs.writeFileSync(harness.statePath, JSON.stringify(valid), { mode: 0o600 })
      fs.chmodSync(harness.statePath, 0o644)
      await assert.rejects(harness.store.list(), hasCode('storage_invalid'))
      fs.chmodSync(harness.statePath, 0o600)

      const directoryPath = path.dirname(harness.statePath)
      fs.chmodSync(directoryPath, 0o755)
      await assert.rejects(harness.store.list(), hasCode('storage_invalid'))
      fs.chmodSync(directoryPath, 0o700)

      const outsideState = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-elicitation-outside-state-')),
        'state.json',
      )
      fs.writeFileSync(outsideState, JSON.stringify(valid), { mode: 0o600 })
      fs.rmSync(harness.statePath)
      fs.symlinkSync(outsideState, harness.statePath)
      await assert.rejects(harness.store.list(), hasCode('storage_invalid'))
      fs.rmSync(path.dirname(outsideState), { recursive: true, force: true })
    }
  } finally {
    harness.cleanup()
  }
})

test('a symlinked canonical assignment is rejected before storage is created', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-elicitation-assignment-symlink-'),
  )
  const outsidePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-elicitation-assignment-outside-'),
  )
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  })
  assert.ok(location)
  fs.mkdirSync(path.dirname(location.assignmentPath), { recursive: true })
  fs.symlinkSync(outsidePath, location.assignmentPath, 'dir')

  try {
    const store = new McpElicitationStore({
      workspacePath,
      sessionId: location.sessionId,
      runId: location.runId,
      assignmentId: location.assignmentId,
    })
    await assert.rejects(store.list(), hasCode('storage_invalid'))
    await assert.rejects(
      store.createRequest(formRequest(400)),
      hasCode('storage_invalid'),
    )
    assert.deepEqual(fs.readdirSync(outsidePath), [])
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(outsidePath, { recursive: true, force: true })
  }
})
