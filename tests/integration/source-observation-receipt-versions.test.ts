import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  LEGACY_SOURCE_OBSERVATION_RECEIPT_VERSION,
  SOURCE_OBSERVATION_RECEIPT_VERSION,
} from '../../domains/acquisition/acquisition-types.js'
import { buildSourceRepresentations } from '../../domains/acquisition/source-representations.js'
import { SourceObservationStore } from '../../domains/acquisition/source-observation-store.js'

test('a new observation receipt is written at the current schema version and carries a proxied method', async (context) => {
  const assignmentPath = await makeAssignment(context)
  const store = new SourceObservationStore()

  const persisted = await store.persist(makeObservationInput(assignmentPath, {
    activityId: 'activity-proxied',
    method: 'managed-browser-proxied',
  }))

  assert.equal(persisted.receipt.schemaVersion, SOURCE_OBSERVATION_RECEIPT_VERSION)
  assert.equal(SOURCE_OBSERVATION_RECEIPT_VERSION, 6)
  assert.equal(persisted.receipt.method, 'managed-browser-proxied')

  const onDisk = await readReceipt(assignmentPath, 'activity-proxied')
  assert.equal(onDisk.schemaVersion, 6)
  assert.equal(onDisk.method, 'managed-browser-proxied')

  const roundTripped = await store.readPackage({
    assignmentPath,
    activityScopeId: IDENTITY.activityScopeId,
    contentId: 'activity-proxied',
  })
  assert.ok(roundTripped)
  assert.equal(roundTripped.receiptId, 'activity-proxied')
})

test('a version 6 receipt round-trips the challenge and runtime metadata an operator needs', async (context) => {
  const assignmentPath = await makeAssignment(context)
  const store = new SourceObservationStore()

  await store.persist({
    ...makeObservationInput(assignmentPath, {
      activityId: 'activity-v5',
      method: 'managed-browser-proxied',
    }),
    attempts: [
      {
        method: 'direct-http',
        outcome: 'challenge',
        startedAt: '2026-08-28T00:00:00.000Z',
        durationMs: 11,
        challengeType: 'browser-verification',
      },
      {
        method: 'managed-browser-proxied',
        outcome: 'usable',
        startedAt: '2026-08-28T00:00:01.000Z',
        durationMs: 22,
        browserRuntime: {
          driver: 'puppeteer-core',
          driverVersion: '25.3.0',
          browserVersion: 'Chrome/140.0.0.0',
          mode: 'headless',
          launchProfile: 'stock',
        },
        proxyRuntime: {
          provider: 'webshare',
          mode: 'rotating',
          tier: 'unknown',
        },
      },
    ],
  })

  const onDisk = await readReceipt(assignmentPath, 'activity-v5')
  assert.equal(onDisk.schemaVersion, 6)
  assert.deepEqual(onDisk.attempts, [
    {
      method: 'direct-http',
      outcome: 'challenge',
      startedAt: '2026-08-28T00:00:00.000Z',
      durationMs: 11,
      challengeType: 'browser-verification',
    },
    {
      method: 'managed-browser-proxied',
      outcome: 'usable',
      startedAt: '2026-08-28T00:00:01.000Z',
      durationMs: 22,
      browserRuntime: {
        driver: 'puppeteer-core',
        driverVersion: '25.3.0',
        browserVersion: 'Chrome/140.0.0.0',
        mode: 'headless',
        launchProfile: 'stock',
      },
      proxyRuntime: {
        provider: 'webshare',
        mode: 'rotating',
        tier: 'unknown',
      },
    },
  ])

  const roundTripped = await store.readPackage({
    assignmentPath,
    activityScopeId: IDENTITY.activityScopeId,
    contentId: 'activity-v5',
  })
  assert.ok(roundTripped)
})

test('a stored version 5 receipt keeps its structured representations and is not reported as legacy', async (context) => {
  const assignmentPath = await makeAssignment(context)
  const store = new SourceObservationStore()
  await store.persist(makeObservationInput(assignmentPath, {
    activityId: 'activity-stored-v5',
    method: 'managed-browser-proxied',
  }))
  // Version 5 is what this application wrote until the cloud rung existed, so
  // every receipt already on disk carries it and must keep reading unchanged.
  await rewriteReceiptVersion(assignmentPath, 'activity-stored-v5', 5)

  const stored = await store.readPackage({
    assignmentPath,
    activityScopeId: IDENTITY.activityScopeId,
    contentId: 'activity-stored-v5',
  })

  assert.ok(stored, 'a version 5 receipt must still read')
  assert.ok(stored.representations.representations.length > 0)
  assert.deepEqual(stored.representations.warnings, [])
})

test('a stored version 4 receipt keeps its structured representations and is not reported as legacy', async (context) => {
  const assignmentPath = await makeAssignment(context)
  const store = new SourceObservationStore()
  await store.persist(makeObservationInput(assignmentPath, {
    activityId: 'activity-v4',
    method: 'managed-browser-proxied',
  }))
  await rewriteReceiptVersion(assignmentPath, 'activity-v4', 4)

  const stored = await store.readPackage({
    assignmentPath,
    activityScopeId: IDENTITY.activityScopeId,
    contentId: 'activity-v4',
  })

  assert.ok(stored, 'a version 4 receipt must still read')
  assert.ok(stored.representations.representations.length > 0)
  assert.deepEqual(stored.representations.warnings, [])
})

test('a stored version 3 receipt keeps its structured representations and is not reported as legacy', async (context) => {
  const assignmentPath = await makeAssignment(context)
  const store = new SourceObservationStore()
  await store.persist(makeObservationInput(assignmentPath, {
    activityId: 'activity-v3',
    method: 'direct-http-proxied',
  }))
  await rewriteReceiptVersion(assignmentPath, 'activity-v3', 3)

  const stored = await store.readPackage({
    assignmentPath,
    activityScopeId: IDENTITY.activityScopeId,
    contentId: 'activity-v3',
  })

  assert.ok(stored, 'a version 3 receipt must still read')
  assert.ok(stored.representations.representations.length > 0)
  assert.deepEqual(stored.representations.warnings, [])
})

test('a stored version 2 receipt keeps its structured representations and is not reported as legacy', async (context) => {
  const assignmentPath = await makeAssignment(context)
  const store = new SourceObservationStore()
  await store.persist(makeObservationInput(assignmentPath, {
    activityId: 'activity-v2',
    method: 'direct-http',
  }))

  // A receipt written before this change is byte-identical apart from its
  // version, so rewriting the field reproduces a genuine stored v2 receipt.
  await rewriteReceiptVersion(assignmentPath, 'activity-v2', 2)

  const stored = await store.readPackage({
    assignmentPath,
    activityScopeId: IDENTITY.activityScopeId,
    contentId: 'activity-v2',
  })

  assert.ok(stored, 'a version 2 receipt must still read')
  assert.ok(
    stored.representations.representations.length > 0,
    'a version 2 receipt keeps the structured representations it stored',
  )
  assert.deepEqual(
    stored.representations.warnings,
    [],
    'a version 2 receipt is not reported as predating stored representations',
  )
})

test('a stored version 1 receipt still reads through the legacy branch', async (context) => {
  const assignmentPath = await makeAssignment(context)
  const store = new SourceObservationStore()
  await store.persist(makeObservationInput(assignmentPath, {
    activityId: 'activity-v1',
    method: 'direct-http',
  }))
  await rewriteReceiptVersion(
    assignmentPath,
    'activity-v1',
    LEGACY_SOURCE_OBSERVATION_RECEIPT_VERSION,
  )

  const stored = await store.readPackage({
    assignmentPath,
    activityScopeId: IDENTITY.activityScopeId,
    contentId: 'activity-v1',
  })

  assert.ok(stored, 'a version 1 receipt must still read')
  assert.deepEqual(stored.representations.representations, [])
  assert.match(
    String(stored.representations.warnings[0]),
    /predates stored structured representations/u,
  )
})

test('a receipt whose schema version is unknown is refused', async (context) => {
  const assignmentPath = await makeAssignment(context)
  const store = new SourceObservationStore()
  await store.persist(makeObservationInput(assignmentPath, {
    activityId: 'activity-future',
    method: 'direct-http',
  }))
  await rewriteReceiptVersion(assignmentPath, 'activity-future', 99)

  assert.equal(
    await store.readPackage({
      assignmentPath,
      activityScopeId: IDENTITY.activityScopeId,
      contentId: 'activity-future',
    }),
    null,
  )
})

// ---------------------------------------------------------------------------

const IDENTITY = {
  sessionId: 'session-receipt-versions',
  runId: 'run-receipt-versions',
  assignmentId: 'assignment-receipt-versions',
  activityScopeId: 'lane-receipt-versions',
  agentPath: 'agents/web-researcher',
} as const

async function makeAssignment(context: {
  after(callback: () => Promise<unknown> | unknown): unknown
}): Promise<string> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-versions-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const assignmentPath = path.join(root, 'assignment')
  await fs.mkdir(assignmentPath, { recursive: true })
  return assignmentPath
}

const SOURCE_HTML = `<!doctype html><html><head><title>Report</title>
<script type="application/ld+json">{"headline":"Report","year":"2026"}</script>
</head><body><main><h1>Report</h1><p>${'Readable evidence for the stored observation. '.repeat(8)}</p>
<table><tr><th>Metric</th><th>Value</th></tr><tr><td>Growth</td><td>12.5%</td></tr></table>
</main></body></html>`

function makeObservationInput(
  assignmentPath: string,
  overrides: {
    readonly activityId: string
    readonly method:
      | 'direct-http'
      | 'direct-http-proxied'
      | 'managed-browser-proxied'
  },
) {
  const extracted = buildSourceRepresentations(
    SOURCE_HTML,
    'text/html',
    'https://example.test/report',
  )
  return {
    assignmentPath,
    identity: IDENTITY,
    activityId: overrides.activityId,
    method: overrides.method,
    requestedUrl: 'https://example.test/report',
    finalUrl: 'https://example.test/report',
    mediaType: 'text/html',
    content: extracted.markdown,
    structuredRepresentations: extracted.structured,
    attempts: [
      {
        method: overrides.method,
        outcome: 'usable' as const,
        startedAt: '2026-08-28T00:00:00.000Z',
        durationMs: 5,
      },
    ],
    observedAt: '2026-08-28T00:00:00.000Z',
  }
}

function receiptPath(assignmentPath: string, activityId: string): string {
  return path.join(
    assignmentPath,
    'research',
    'observations',
    IDENTITY.activityScopeId,
    `${activityId}.json`,
  )
}

async function readReceipt(
  assignmentPath: string,
  activityId: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(receiptPath(assignmentPath, activityId), 'utf8'),
  ) as Record<string, unknown>
}

async function rewriteReceiptVersion(
  assignmentPath: string,
  activityId: string,
  schemaVersion: number,
): Promise<void> {
  const file = receiptPath(assignmentPath, activityId)
  const receipt = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
  await fs.writeFile(file, JSON.stringify({ ...receipt, schemaVersion }), 'utf8')
}
