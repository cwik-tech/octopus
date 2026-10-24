import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MCP_RESOURCE_IMPORT_MANIFEST_VERSION,
  McpResourceImportStore,
  McpResourceImportStoreError,
  selectMcpResourceProvenanceByInputFilenames,
  type McpResourceImportManifest,
} from '../../domains/mcp/mcp-resource-import-store.js'

const firstSnapshotId = '11111111-1111-4111-8111-111111111111'
const secondSnapshotId = '22222222-2222-4222-8222-222222222222'
const resourceId = `mcp_resource_${'a'.repeat(64)}`
const contentId = `mcp_content_${'b'.repeat(64)}`

function manifest(params: {
  snapshotId: string
  capturedAt: string
  filename: string
}): McpResourceImportManifest {
  return {
    version: MCP_RESOURCE_IMPORT_MANIFEST_VERSION,
    snapshotId: params.snapshotId,
    sessionId: '33333333-3333-4333-8333-333333333333',
    capturedAt: params.capturedAt,
    server: { id: 'fixture-server', name: 'Fixture server' },
    resource: {
      id: resourceId,
      uri: 'mcp-fixture://resources/text',
      name: 'Fixture resource',
    },
    totalBytes: 4,
    contents: [{
      id: contentId,
      sourceUri: 'mcp-fixture://resources/text',
      mimeType: 'text/plain',
      kind: 'text',
      byteLength: 4,
      sha256: 'c'.repeat(64),
      storedPath: `contents/00-${'b'.repeat(64)}.txt`,
      materializedInputFilename: params.filename,
    }],
  }
}

function hasStoreError(code: McpResourceImportStoreError['code']) {
  return (error: unknown): boolean =>
    error instanceof McpResourceImportStoreError && error.code === code
}

test('provenance selection matches current filenames and sorts deterministically', () => {
  const older = manifest({
    snapshotId: firstSnapshotId,
    capturedAt: '2026-07-12T10:00:00.000Z',
    filename: 'older-11111111111141118111111111111111.txt',
  })
  const newer = manifest({
    snapshotId: secondSnapshotId,
    capturedAt: '2026-07-12T11:00:00.000Z',
    filename: 'newer-22222222222242228222222222222222.txt',
  })
  const manifests = [older, newer]

  const selected = selectMcpResourceProvenanceByInputFilenames(
    manifests,
    [
      'User_Upload.TXT',
      older.contents[0]!.materializedInputFilename,
      newer.contents[0]!.materializedInputFilename,
      newer.contents[0]!.materializedInputFilename,
    ],
  )

  assert.deepEqual(selected.map((entry) => entry.snapshotId), [
    secondSnapshotId,
    firstSnapshotId,
  ])
  assert.deepEqual(manifests.map((entry) => entry.snapshotId), [
    firstSnapshotId,
    secondSnapshotId,
  ])
  assert.deepEqual(
    selectMcpResourceProvenanceByInputFilenames(manifests, ['unrelated.txt']),
    [],
  )
  assert.deepEqual(
    selectMcpResourceProvenanceByInputFilenames(manifests, []),
    [],
  )
})

test('provenance selection accepts ordinary session filenames with spaces when no MCP snapshot matches', () => {
  const entry = manifest({
    snapshotId: firstSnapshotId,
    capturedAt: '2026-07-12T10:00:00.000Z',
    filename: 'mcp-resource-11111111111141118111111111111111.txt',
  })

  assert.deepEqual(
    selectMcpResourceProvenanceByInputFilenames(
      [entry],
      ['ExampleCo Pitch Deck.pdf', 'DemoCo - Pitch Deck.pdf'],
    ),
    [],
  )
})

test('provenance selection rejects unsafe current input filenames', () => {
  const entry = manifest({
    snapshotId: firstSnapshotId,
    capturedAt: '2026-07-12T10:00:00.000Z',
    filename: 'safe-11111111111141118111111111111111.txt',
  })

  assert.throws(
    () => selectMcpResourceProvenanceByInputFilenames([entry], ['../input.txt']),
    hasStoreError('invalid_request'),
  )
  assert.throws(
    () => selectMcpResourceProvenanceByInputFilenames(
      [entry],
      ['%2e%2e%2finput.txt'],
    ),
    hasStoreError('invalid_request'),
  )
})

test('store construction rejects unsafe aggregate limits', () => {
  assert.throws(
    () => new McpResourceImportStore({ workspacePath: '/tmp', maxAggregateBytes: 0 }),
    hasStoreError('invalid_request'),
  )
  assert.throws(
    () => new McpResourceImportStore({
      workspacePath: '/tmp',
      maxAggregateBytes: 67_108_865,
    }),
    hasStoreError('invalid_request'),
  )
})
