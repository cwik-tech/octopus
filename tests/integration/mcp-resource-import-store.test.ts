import { whenDefined } from '../../core/optional-properties.js'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type {
  McpResourceContent,
  McpResourceReadResult,
} from '../../domains/mcp/mcp-resource-client-service.js'
import {
  McpResourceImportStore,
  McpResourceImportStoreError,
  type McpResourceImportManifest,
  type McpResourceImportResult,
} from '../../domains/mcp/mcp-resource-import-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

interface WorkspaceFixture {
  readonly workspacePath: string
  readonly sessionId: string
  readonly sessionPath: string
}

function hashId(prefix: 'mcp_resource' | 'mcp_content', value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex')}`
}

function makeTextContent(
  marker: string,
  uri = `mcp-import-fixture://resources/${marker}`,
): Extract<McpResourceContent, { kind: 'text' }> {
  const text = `text:${marker}`
  return {
    id: hashId('mcp_content', `${marker}:text`),
    uri,
    mimeType: 'text/plain',
    kind: 'text',
    byteLength: Buffer.byteLength(text),
    text,
  }
}

function makeBinaryContent(
  marker: string,
  uri = `mcp-import-fixture://resources/${marker}`,
): Extract<McpResourceContent, { kind: 'binary' }> {
  const buffer = Buffer.from('89504e470d0a1a0a', 'hex')
  return {
    id: hashId('mcp_content', `${marker}:binary`),
    uri,
    mimeType: 'image/png',
    kind: 'binary',
    byteLength: buffer.byteLength,
    base64: buffer.toString('base64'),
  }
}

function makeReadResult(
  marker: string,
  contents: readonly McpResourceContent[] = [makeTextContent(marker)],
): McpResourceReadResult {
  const uri = `mcp-import-fixture://resources/${marker}`
  return {
    resource: {
      id: hashId('mcp_resource', marker),
      serverId: 'import-fixture-server',
      serverName: 'Import fixture server',
      uri,
      name: `Resource ${marker}`,
      ...whenDefined(contents.length === 1 ? contents[0]?.mimeType : undefined, (mimeType) => ({ mimeType: mimeType })),
      disposition: contents.length === 1 ? contents[0]!.kind : 'unknown',
    },
    contents,
    totalBytes: contents.reduce((total, content) => total + content.byteLength, 0),
  }
}

async function createWorkspaceFixture(prefix: string): Promise<WorkspaceFixture> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const session = await new FileSystemSessionStore(workspacePath)
    .createSession({ title: 'MCP resource import fixture' })
  return {
    workspacePath,
    sessionId: session.id,
    sessionPath: path.join(workspacePath, 'sessions', session.id),
  }
}

function mode(filePath: string): number {
  return fs.lstatSync(filePath).mode & 0o777
}

function hasStoreError(code: McpResourceImportStoreError['code']) {
  return (error: unknown): boolean =>
    error instanceof McpResourceImportStoreError && error.code === code
}

function snapshotContentsPath(
  imported: McpResourceImportResult,
  index: number,
): string {
  return path.join(
    imported.snapshotPath,
    ...imported.manifest.contents[index]!.storedPath.split('/'),
  )
}

function readManifest(snapshotPath: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(snapshotPath, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>
}

function writeManifest(snapshotPath: string, manifest: unknown): void {
  const manifestPath = path.join(snapshotPath, 'manifest.json')
  fs.chmodSync(manifestPath, 0o600)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  fs.chmodSync(manifestPath, 0o400)
}

test('real filesystem import atomically stores exact text/binary bytes and returns input proposals only', async () => {
  const fixture = await createWorkspaceFixture('mcp-resource-import-files-')
  try {
    const store = new McpResourceImportStore({
      workspacePath: fixture.workspacePath,
    })
    const resourceUri = 'mcp-import-fixture://resources/multiple'
    const readResult = makeReadResult('multiple', [
      makeTextContent('multiple', `${resourceUri}#text`),
      makeBinaryContent('multiple', `${resourceUri}#binary`),
    ])
    const imported = await store.importResource({
      sessionId: fixture.sessionId,
      result: readResult,
    })

    const expectedRoot = path.join(fixture.sessionPath, 'mcp-resources')
    assert.equal(path.dirname(imported.snapshotPath), expectedRoot)
    assert.equal(path.basename(imported.snapshotPath), imported.manifest.snapshotId)
    assert.equal(
      fs.realpathSync(imported.snapshotPath),
      path.join(fs.realpathSync(expectedRoot), imported.manifest.snapshotId),
    )
    assert.equal(fs.existsSync(path.join(fixture.sessionPath, 'inputs')), false)
    assert.equal(mode(expectedRoot), 0o700)
    assert.equal(mode(imported.snapshotPath), 0o700)
    assert.equal(mode(path.join(imported.snapshotPath, 'contents')), 0o700)
    assert.equal(mode(path.join(imported.snapshotPath, 'manifest.json')), 0o400)

    assert.deepEqual(
      imported.manifest.server,
      { id: readResult.resource.serverId, name: readResult.resource.serverName },
    )
    assert.deepEqual(imported.manifest.resource, {
      id: readResult.resource.id,
      uri: readResult.resource.uri,
      name: readResult.resource.name,
    })
    assert.equal(imported.manifest.contents.length, 2)
    assert.equal(imported.materializedInputs.length, 2)
    assert.equal(new Set(
      imported.materializedInputs.map((input) => input.filename),
    ).size, 2)

    for (let index = 0; index < imported.manifest.contents.length; index += 1) {
      const manifestContent = imported.manifest.contents[index]!
      const sourceContent = readResult.contents[index]!
      const storedPath = snapshotContentsPath(imported, index)
      const stored = fs.readFileSync(storedPath)
      const expected = sourceContent.kind === 'text'
        ? Buffer.from(sourceContent.text, 'utf8')
        : Buffer.from(sourceContent.base64, 'base64')
      assert.deepEqual(stored, expected)
      assert.equal(mode(storedPath), 0o400)
      assert.equal(manifestContent.byteLength, expected.byteLength)
      assert.equal(
        manifestContent.sha256,
        createHash('sha256').update(expected).digest('hex'),
      )
      assert.deepEqual(imported.materializedInputs[index]?.buffer, expected)
      assert.equal(
        imported.materializedInputs[index]?.filename,
        manifestContent.materializedInputFilename,
      )
    }

    const persisted = readManifest(imported.snapshotPath)
    assert.deepEqual(persisted, imported.manifest)
    const serialized = JSON.stringify(persisted)
    assert.equal(serialized.includes('transport'), false)
    assert.equal(serialized.includes('credential'), false)
    assert.equal(serialized.includes('secret'), false)

    imported.materializedInputs[0]!.buffer.fill(0)
    assert.notDeepEqual(
      fs.readFileSync(snapshotContentsPath(imported, 0)),
      imported.materializedInputs[0]!.buffer,
    )

    const single = await store.importResource({
      sessionId: fixture.sessionId,
      result: makeReadResult('requested-name'),
      requestedInputBaseName: 'Quarterly Report',
    })
    assert.match(
      single.materializedInputs[0]!.filename,
      /^quarterly-report-[a-f0-9]{32}\.txt$/,
    )
    await assert.rejects(
      store.importResource({
        sessionId: fixture.sessionId,
        result: readResult,
        requestedInputBaseName: 'not-valid-for-multiple',
      }),
      hasStoreError('invalid_request'),
    )
    assert.equal((await store.listSnapshots(fixture.sessionId)).length, 2)
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('parallel imports never overwrite, refresh creates new snapshots, and restart listing stays deterministic', async () => {
  const fixture = await createWorkspaceFixture('mcp-resource-import-parallel-')
  try {
    const store = new McpResourceImportStore({ workspacePath: fixture.workspacePath })
    const readResult = makeReadResult('parallel')
    const imports = await Promise.all(
      Array.from({ length: 16 }, () => store.importResource({
        sessionId: fixture.sessionId,
        result: readResult,
      })),
    )
    assert.equal(new Set(imports.map((entry) => entry.manifest.snapshotId)).size, 16)
    assert.equal(new Set(
      imports.map((entry) => entry.materializedInputs[0]!.filename),
    ).size, 16)

    const resourcesPath = path.join(fixture.sessionPath, 'mcp-resources')
    assert.deepEqual(
      fs.readdirSync(resourcesPath)
        .filter((entry) => entry.startsWith('.import-')),
      [],
    )
    for (const imported of imports) {
      assert.equal(fs.existsSync(imported.snapshotPath), true)
      assert.equal(mode(path.join(imported.snapshotPath, 'manifest.json')), 0o400)
    }

    const staleTemporaryName = `.import-${randomUUID()}-${randomBytes(8).toString('hex')}.tmp`
    const staleTemporaryPath = path.join(resourcesPath, staleTemporaryName)
    fs.mkdirSync(staleTemporaryPath, { mode: 0o700 })
    fs.writeFileSync(path.join(staleTemporaryPath, 'partial'), 'partial')

    const restarted = new McpResourceImportStore({
      workspacePath: fixture.workspacePath,
    })
    const firstList = await restarted.listSnapshots(fixture.sessionId)
    const secondList = await restarted.listSnapshots(fixture.sessionId)
    assert.equal(firstList.length, 16)
    assert.deepEqual(firstList, secondList)

    const expectedOrder = imports.map((entry) => entry.manifest).sort(
      (left, right) => right.capturedAt.localeCompare(left.capturedAt)
        || left.snapshotId.localeCompare(right.snapshotId),
    )
    assert.deepEqual(
      firstList.map((entry) => entry.snapshotId),
      expectedOrder.map((entry) => entry.snapshotId),
    )

    const selectedNames = [
      imports[0]!.materializedInputs[0]!.filename,
      imports[15]!.materializedInputs[0]!.filename,
    ]
    const selected = await restarted.selectProvenance(
      fixture.sessionId,
      selectedNames,
    )
    assert.deepEqual(
      new Set(selected.map((entry) => entry.snapshotId)),
      new Set([imports[0]!.manifest.snapshotId, imports[15]!.manifest.snapshotId]),
    )
    assert.equal(fs.existsSync(path.join(fixture.sessionPath, 'inputs')), false)
    fs.rmSync(staleTemporaryPath, { recursive: true, force: true })
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('restart listing fails closed on corrupt manifests, tampered content, permissions, and unsafe entries', async (t) => {
  async function importedFixture(prefix: string): Promise<{
    fixture: WorkspaceFixture
    store: McpResourceImportStore
    imported: McpResourceImportResult
  }> {
    const fixture = await createWorkspaceFixture(prefix)
    const store = new McpResourceImportStore({ workspacePath: fixture.workspacePath })
    const imported = await store.importResource({
      sessionId: fixture.sessionId,
      result: makeReadResult(prefix),
    })
    return { fixture, store, imported }
  }

  await t.test('rejects invalid JSON and undeclared manifest fields', async () => {
    const { fixture, store, imported } = await importedFixture('mcp-import-bad-json-')
    try {
      const manifestPath = path.join(imported.snapshotPath, 'manifest.json')
      fs.chmodSync(manifestPath, 0o600)
      fs.writeFileSync(manifestPath, '{')
      fs.chmodSync(manifestPath, 0o400)
      await assert.rejects(
        store.listSnapshots(fixture.sessionId),
        hasStoreError('corrupt_store'),
      )

      writeManifest(imported.snapshotPath, {
        ...imported.manifest,
        transport: { url: 'https://secret.invalid' },
      })
      await assert.rejects(
        store.listSnapshots(fixture.sessionId),
        hasStoreError('corrupt_store'),
      )
    } finally {
      fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
    }
  })

  await t.test('rejects content hash tampering and permission changes', async () => {
    const { fixture, store, imported } = await importedFixture('mcp-import-tamper-')
    try {
      const contentPath = snapshotContentsPath(imported, 0)
      const original = fs.readFileSync(contentPath)
      fs.chmodSync(contentPath, 0o600)
      fs.writeFileSync(contentPath, Buffer.alloc(original.byteLength, 0x78))
      fs.chmodSync(contentPath, 0o400)
      await assert.rejects(
        store.listSnapshots(fixture.sessionId),
        hasStoreError('corrupt_store'),
      )

      fs.chmodSync(contentPath, 0o600)
      fs.writeFileSync(contentPath, original)
      await assert.rejects(
        store.listSnapshots(fixture.sessionId),
        hasStoreError('corrupt_store'),
      )
    } finally {
      fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
    }
  })

  await t.test('rejects extra files and published snapshot symlinks', {
    skip: process.platform === 'win32',
  }, async () => {
    const { fixture, store, imported } = await importedFixture('mcp-import-unsafe-')
    try {
      fs.writeFileSync(path.join(imported.snapshotPath, 'extra.txt'), 'extra')
      await assert.rejects(
        store.listSnapshots(fixture.sessionId),
        hasStoreError('corrupt_store'),
      )
      fs.rmSync(path.join(imported.snapshotPath, 'extra.txt'))

      const outsidePath = path.join(fixture.workspacePath, 'outside-snapshot')
      fs.mkdirSync(outsidePath)
      const linkedSnapshotId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      fs.symlinkSync(
        outsidePath,
        path.join(fixture.sessionPath, 'mcp-resources', linkedSnapshotId),
      )
      await assert.rejects(
        store.listSnapshots(fixture.sessionId),
        hasStoreError('corrupt_store'),
      )
    } finally {
      fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
    }
  })

  await t.test('rejects stored-content symlinks without reading their target', {
    skip: process.platform === 'win32',
  }, async () => {
    const { fixture, store, imported } = await importedFixture('mcp-import-content-link-')
    try {
      const outsidePath = path.join(fixture.workspacePath, 'outside-content.txt')
      fs.writeFileSync(outsidePath, 'outside-content-must-remain')
      const contentPath = snapshotContentsPath(imported, 0)
      fs.rmSync(contentPath)
      fs.symlinkSync(outsidePath, contentPath)
      await assert.rejects(
        store.listSnapshots(fixture.sessionId),
        hasStoreError('corrupt_store'),
      )
      assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'outside-content-must-remain')
    } finally {
      fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
    }
  })
})

test('session, resource-root, and requested-name path escapes are rejected before writes', async () => {
  const fixture = await createWorkspaceFixture('mcp-resource-import-paths-')
  try {
    const store = new McpResourceImportStore({ workspacePath: fixture.workspacePath })
    await assert.rejects(
      store.importResource({ sessionId: '../session', result: makeReadResult('bad') }),
      hasStoreError('invalid_request'),
    )
    await assert.rejects(
      store.importResource({
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        result: makeReadResult('missing'),
      }),
      hasStoreError('not_found'),
    )
    await assert.rejects(
      store.importResource({
        sessionId: fixture.sessionId,
        result: makeReadResult('unsafe-name'),
        requestedInputBaseName: '../outside',
      }),
      hasStoreError('invalid_request'),
    )

    if (process.platform !== 'win32') {
      const outsidePath = path.join(fixture.workspacePath, 'outside-resources')
      const resourcesPath = path.join(fixture.sessionPath, 'mcp-resources')
      fs.mkdirSync(outsidePath)
      fs.symlinkSync(outsidePath, resourcesPath)
      await assert.rejects(
        store.importResource({
          sessionId: fixture.sessionId,
          result: makeReadResult('resource-root-link'),
        }),
        hasStoreError('invalid_request'),
      )
      assert.deepEqual(fs.readdirSync(outsidePath), [])
      fs.rmSync(resourcesPath)

      const metadataPath = path.join(fixture.sessionPath, 'session.json')
      const outsideMetadataPath = path.join(fixture.workspacePath, 'outside-session.json')
      fs.copyFileSync(metadataPath, outsideMetadataPath)
      fs.rmSync(metadataPath)
      fs.symlinkSync(outsideMetadataPath, metadataPath)
      await assert.rejects(
        store.listSnapshots(fixture.sessionId),
        hasStoreError('corrupt_store'),
      )
    }
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('content count, aggregate size, byte accounting, MIME, and refresh semantics are enforced', async () => {
  const fixture = await createWorkspaceFixture('mcp-resource-import-bounds-')
  try {
    const store = new McpResourceImportStore({
      workspacePath: fixture.workspacePath,
      maxAggregateBytes: 32,
    })
    const oversized = makeTextContent('x'.repeat(40))
    await assert.rejects(
      store.importResource({
        sessionId: fixture.sessionId,
        result: makeReadResult('oversized', [oversized]),
      }),
      hasStoreError('result_too_large'),
    )

    const tooMany = Array.from({ length: 65 }, (_unused, index) =>
      makeTextContent(`content-${index}`),
    )
    await assert.rejects(
      store.importResource({
        sessionId: fixture.sessionId,
        result: makeReadResult('too-many', tooMany),
      }),
      hasStoreError('result_too_large'),
    )

    const mismatched = makeReadResult('mismatch')
    await assert.rejects(
      store.importResource({
        sessionId: fixture.sessionId,
        result: { ...mismatched, totalBytes: mismatched.totalBytes + 1 },
      }),
      hasStoreError('invalid_request'),
    )

    const unsafeMime = makeTextContent('unsafe-mime')
    await assert.rejects(
      store.importResource({
        sessionId: fixture.sessionId,
        result: makeReadResult('unsafe-mime', [{
          ...unsafeMime,
          mimeType: 'text/html',
        }]),
      }),
      hasStoreError('invalid_request'),
    )

    const refreshSource = makeReadResult('refresh')
    const first = await store.importResource({
      sessionId: fixture.sessionId,
      result: refreshSource,
    })
    const second = await store.importResource({
      sessionId: fixture.sessionId,
      result: refreshSource,
    })
    assert.notEqual(first.manifest.snapshotId, second.manifest.snapshotId)
    assert.notEqual(first.snapshotPath, second.snapshotPath)
    assert.notEqual(
      first.materializedInputs[0]?.filename,
      second.materializedInputs[0]?.filename,
    )
    assert.equal(fs.existsSync(first.snapshotPath), true)
    assert.equal(fs.existsSync(second.snapshotPath), true)
    assert.deepEqual(
      fs.readdirSync(path.join(fixture.sessionPath, 'mcp-resources'))
        .filter((entry) => entry.startsWith('.import-')),
      [],
    )
  } finally {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})
