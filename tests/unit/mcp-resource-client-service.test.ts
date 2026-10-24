import assert from 'node:assert/strict'
import test from 'node:test'

import {
  McpClientManagerError,
  type McpConnectionSnapshot,
  type McpRequestOptions,
} from '../../domains/mcp/mcp-client-manager.js'
import {
  McpResourceClientError,
  McpResourceClientService,
} from '../../domains/mcp/mcp-resource-client-service.js'
import type { McpServerView } from '../../domains/mcp/mcp-settings.js'

const ROOT = 'mcp-resource-test://resources'

class InMemorySettingsReader {
  servers: McpServerView[]

  constructor(servers: McpServerView[]) {
    this.servers = servers
  }

  async listServers(): Promise<McpServerView[]> {
    return [...this.servers]
  }

  async getServer(serverId: string): Promise<McpServerView | null> {
    return this.servers.find((server) => server.id === serverId) ?? null
  }
}

class InMemoryResourceManager {
  readonly live = new Set<string>()
  readonly snapshots = new Map<string, McpConnectionSnapshot>()
  readonly reads: Array<{ serverId: string; uri: string; options: McpRequestOptions }> = []
  readResult: unknown = {
    contents: [{ uri: `${ROOT}/text`, mimeType: 'text/plain', text: 'fixture' }],
  }
  readFailure: unknown = null

  isConnected(serverId: string): boolean {
    return this.live.has(serverId)
  }

  getSnapshot(serverId: string): McpConnectionSnapshot | null {
    return this.snapshots.get(serverId) ?? null
  }

  async readResource(
    serverId: string,
    uri: string,
    options: McpRequestOptions = {},
  ): Promise<unknown> {
    this.reads.push({ serverId, uri, options })
    if (this.readFailure) throw this.readFailure
    return this.readResult
  }
}

function serverView(
  id = 'resource-server',
  overrides: Partial<McpServerView> = {},
): McpServerView {
  return {
    id,
    name: `Server ${id}`,
    enabled: true,
    capabilityAliases: [],
    transport: {
      type: 'stdio',
      command: 'node',
      args: [],
      environmentKeys: [],
      hasSecrets: false,
    },
    status: 'connected',
    capabilities: {
      resources: { listChanged: false, subscribe: false },
      logging: false,
    },
    ...overrides,
  }
}

function snapshot(
  server: McpServerView,
  resources: McpConnectionSnapshot['resources'],
): McpConnectionSnapshot {
  return {
    serverId: server.id,
    serverName: server.name,
    capabilities: server.capabilities,
    tools: [],
    resources,
    connectedAt: '2026-07-12T12:00:00.000Z',
  }
}

function createHarness(
  resources: McpConnectionSnapshot['resources'],
  options: {
    server?: McpServerView
    maxContentBytes?: number
    maxAggregateBytes?: number
  } = {},
): {
  settings: InMemorySettingsReader
  manager: InMemoryResourceManager
  service: McpResourceClientService
  server: McpServerView
} {
  const server = options.server ?? serverView()
  const settings = new InMemorySettingsReader([server])
  const manager = new InMemoryResourceManager()
  manager.live.add(server.id)
  manager.snapshots.set(server.id, snapshot(server, resources))
  const service = new McpResourceClientService({
    settingsService: settings,
    clientManager: manager,
    ...(options.maxContentBytes ? { maxContentBytes: options.maxContentBytes } : {}),
    ...(options.maxAggregateBytes ? { maxAggregateBytes: options.maxAggregateBytes } : {}),
  })
  return { settings, manager, service, server }
}

function hasResourceError(code: McpResourceClientError['code']) {
  return (error: unknown): boolean =>
    error instanceof McpResourceClientError && error.code === code
}

test('catalog pagination is stable, bounded, fingerprinted, and contains no synthetic templates', async () => {
  const firstUri = `${ROOT}/a`
  const secondUri = `${ROOT}/b`
  const { settings, manager, service, server } = createHarness([
    { uri: secondUri, name: 'B', mimeType: 'application/json' },
    { uri: firstUri, name: 'A', mimeType: 'text/plain' },
  ])

  const first = await service.listResources({ limit: 1 })
  assert.equal(first.resources.length, 1)
  assert.equal(first.resources[0]?.uri, firstUri)
  assert.match(first.resources[0]!.id, /^mcp_resource_[a-f0-9]{64}$/)
  assert.ok(first.nextCursor)
  assert.equal(Object.hasOwn(first, 'templates'), false)

  const second = await service.listResources({ limit: 1, cursor: first.nextCursor })
  assert.deepEqual(second.resources.map((resource) => resource.uri), [secondUri])
  assert.equal(second.nextCursor, undefined)
  assert.equal(
    (await service.listResources({ limit: 1 })).resources[0]?.id,
    first.resources[0]?.id,
  )

  await assert.rejects(
    service.listResources({ limit: 0 }),
    hasResourceError('invalid_request'),
  )
  await assert.rejects(
    service.listResources({ limit: 101 }),
    hasResourceError('invalid_request'),
  )
  await assert.rejects(
    service.listResources({ cursor: 'not-a-valid-cursor' }),
    hasResourceError('invalid_request'),
  )

  manager.snapshots.set(server.id, snapshot(server, [
    { uri: secondUri, name: 'B', mimeType: 'application/json' },
    { uri: firstUri, name: 'A', mimeType: 'text/plain' },
    { uri: `${ROOT}/c`, name: 'C', mimeType: 'text/plain' },
  ]))
  await assert.rejects(
    service.listResources({ limit: 1, cursor: first.nextCursor }),
    hasResourceError('invalid_request'),
  )

  const refreshed = await service.listResources({ limit: 1 })
  assert.ok(refreshed.nextCursor)
  settings.servers = [{ ...server, status: 'error' }]
  await assert.rejects(
    service.listResources({ limit: 1, cursor: refreshed.nextCursor }),
    hasResourceError('invalid_request'),
  )
})

test('MCP resource URIs remain opaque identifiers for file, HTTPS, and custom schemes', async () => {
  const fileUri = 'file:///tmp/mcp-resource-do-not-open.txt'
  const httpsUri = 'https://example.invalid/mcp-resource-do-not-fetch'
  const customUri = 'custom+fixture://catalog/item'
  const { manager, service, server } = createHarness([
    { uri: fileUri, name: 'File identifier', mimeType: 'text/plain' },
    { uri: httpsUri, name: 'HTTPS identifier', mimeType: 'text/plain' },
    { uri: customUri, name: 'Custom identifier', mimeType: 'text/plain' },
  ])

  assert.deepEqual(
    (await service.listResources()).resources.map((resource) => resource.uri),
    [customUri, fileUri, httpsUri],
  )
  assert.equal(manager.reads.length, 0)

  manager.readResult = {
    contents: [{ uri: fileUri, mimeType: 'text/plain', text: 'from-mcp-only' }],
  }
  const read = await service.readResource({ serverId: server.id, uri: fileUri })
  assert.equal(read.contents[0]?.kind, 'text')
  assert.deepEqual(manager.reads.map(({ uri }) => uri), [fileUri])

  await assert.rejects(
    service.readResource({
      serverId: server.id,
      uri: 'https://user:credential@example.invalid/resource',
    }),
    (error: unknown) =>
      hasResourceError('invalid_request')(error)
      && !String(error).includes('credential'),
  )
})

test('catalog applies deny-first MIME classification without reading blocked resources', async () => {
  const fixtures = [
    ['safe-json', 'application/problem+json', 'text'],
    ['safe-png', 'image/png', 'binary'],
    ['safe-pdf', 'application/pdf', 'binary'],
    ['html', 'text/html', 'blocked'],
    ['svg', 'image/svg+xml', 'blocked'],
    ['script', 'application/javascript', 'blocked'],
    ['archive', 'application/zip', 'blocked'],
    ['executable', 'application/vnd.microsoft.portable-executable', 'blocked'],
    ['opaque', 'application/octet-stream', 'blocked'],
  ] as const
  const { manager, service, server } = createHarness([
    ...fixtures.map(([name, mimeType]) => ({
      uri: `${ROOT}/${name}`,
      name,
      mimeType,
    })),
    { uri: `${ROOT}/unknown`, name: 'unknown' },
  ])

  const listed = await service.listResources()
  const dispositions = new Map(
    listed.resources.map((resource) => [resource.name, resource.disposition]),
  )
  for (const [name, _mimeType, disposition] of fixtures) {
    assert.equal(dispositions.get(name), disposition)
  }
  assert.equal(dispositions.get('unknown'), 'unknown')

  await assert.rejects(
    service.readResource({ serverId: server.id, uri: `${ROOT}/html` }),
    hasResourceError('configuration_invalid'),
  )
  assert.equal(manager.reads.length, 0)
})

test('readResource normalizes UTF-8 text, strict base64 binary, and multiple contents', async () => {
  const textUri = `${ROOT}/text`
  const binaryUri = `${ROOT}/binary`
  const multipleUri = `${ROOT}/multiple`
  const { manager, service, server } = createHarness([
    { uri: textUri, name: 'Text', mimeType: 'text/plain; charset=utf-8' },
    { uri: binaryUri, name: 'Binary', mimeType: 'image/png' },
    { uri: multipleUri, name: 'Multiple' },
  ])

  manager.readResult = {
    contents: [{ uri: textUri, text: 'hello ☃' }],
  }
  const textResult = await service.readResource({ serverId: server.id, uri: textUri })
  assert.deepEqual(textResult.contents[0], {
    id: textResult.contents[0]!.id,
    uri: textUri,
    mimeType: 'text/plain',
    kind: 'text',
    byteLength: 9,
    text: 'hello ☃',
  })
  assert.equal(textResult.totalBytes, 9)

  manager.readResult = {
    contents: [{ uri: binaryUri, blob: 'iVBORw0KGgo=' }],
  }
  const binaryResult = await service.readResource({
    serverId: server.id,
    uri: binaryUri,
  })
  assert.equal(binaryResult.contents[0]?.kind, 'binary')
  assert.equal(binaryResult.contents[0]?.byteLength, 8)
  assert.equal(
    binaryResult.contents[0]?.kind === 'binary'
      ? binaryResult.contents[0].base64
      : null,
    'iVBORw0KGgo=',
  )

  manager.readResult = {
    contents: [
      { uri: `${multipleUri}#text`, mimeType: 'application/json', text: '{}' },
      { uri: `${multipleUri}#png`, mimeType: 'image/png', blob: 'iVBORw0KGgo=' },
    ],
  }
  const multiple = await service.readResource({
    serverId: server.id,
    uri: multipleUri,
  })
  assert.deepEqual(multiple.contents.map((content) => content.kind), ['text', 'binary'])
  assert.equal(multiple.totalBytes, 10)
  assert.notEqual(multiple.contents[0]?.id, multiple.contents[1]?.id)
})

test('per-content and aggregate byte limits fail closed', async () => {
  const uri = `${ROOT}/limited`
  const { manager, service, server } = createHarness(
    [{ uri, name: 'Limited', mimeType: 'text/plain' }],
    { maxContentBytes: 8, maxAggregateBytes: 10 },
  )

  manager.readResult = {
    contents: [{ uri, mimeType: 'text/plain', text: '123456789' }],
  }
  await assert.rejects(
    service.readResource({ serverId: server.id, uri }),
    hasResourceError('result_too_large'),
  )

  manager.readResult = {
    contents: [
      { uri: `${uri}#one`, mimeType: 'text/plain', text: '123456' },
      { uri: `${uri}#two`, mimeType: 'text/plain', text: '123456' },
    ],
  }
  await assert.rejects(
    service.readResource({ serverId: server.id, uri }),
    hasResourceError('result_too_large'),
  )
})

test('malformed response shapes and non-canonical base64 are rejected', async () => {
  const uri = `${ROOT}/malformed`
  const { manager, service, server } = createHarness([
    { uri, name: 'Malformed', mimeType: 'image/png' },
  ])

  manager.readResult = {
    contents: [{ uri, mimeType: 'image/png', blob: 'not base64' }],
  }
  await assert.rejects(
    service.readResource({ serverId: server.id, uri }),
    hasResourceError('protocol_error'),
  )

  manager.readResult = {
    contents: [{ uri, mimeType: 'image/png', text: 'text', blob: 'aGVsbG8=' }],
  }
  await assert.rejects(
    service.readResource({ serverId: server.id, uri }),
    hasResourceError('protocol_error'),
  )
})

test('eligibility is enforced for global status, live state, and advertised identity', async () => {
  const uri = `${ROOT}/text`
  const disabled = serverView('disabled-server', {
    enabled: false,
    status: 'disabled',
  })
  const disabledHarness = createHarness(
    [{ uri, name: 'Text', mimeType: 'text/plain' }],
    { server: disabled },
  )
  await assert.rejects(
    disabledHarness.service.readResource({ serverId: disabled.id, uri }),
    hasResourceError('server_disabled'),
  )

  const { manager, service, server } = createHarness([
    { uri, name: 'Text', mimeType: 'text/plain' },
  ])
  manager.live.delete(server.id)
  assert.deepEqual((await service.listResources()).resources, [])
  await assert.rejects(
    service.readResource({ serverId: server.id, uri }),
    hasResourceError('connection_failed'),
  )

  manager.live.add(server.id)
  await assert.rejects(
    service.readResource({ serverId: server.id, uri: `${ROOT}/not-advertised` }),
    hasResourceError('not_found'),
  )
})

test('abort, timeout, and source failures remain sanitized', async () => {
  const uri = `${ROOT}/text`
  const { manager, service, server } = createHarness([
    { uri, name: 'Text', mimeType: 'text/plain' },
  ])
  const cancelled = new AbortController()
  cancelled.abort('MCP_CALLER_SECRET_DO_NOT_EXPOSE')
  await assert.rejects(
    service.readResource({ serverId: server.id, uri, signal: cancelled.signal }),
    (error: unknown) =>
      hasResourceError('cancelled')(error)
      && !String(error).includes('MCP_CALLER_SECRET_DO_NOT_EXPOSE'),
  )
  assert.equal(manager.reads.length, 0)

  manager.readFailure = new McpClientManagerError('timeout', true)
  await assert.rejects(
    service.readResource({ serverId: server.id, uri, timeoutMs: 25 }),
    (error: unknown) =>
      hasResourceError('timeout')(error)
      && error instanceof McpResourceClientError
      && error.retryable,
  )

  manager.readFailure = new Error('MCP_SOURCE_SECRET_DO_NOT_EXPOSE')
  await assert.rejects(
    service.readResource({ serverId: server.id, uri }),
    (error: unknown) =>
      hasResourceError('internal')(error)
      && !String(error).includes('MCP_SOURCE_SECRET_DO_NOT_EXPOSE'),
  )
})

test('duplicate resource identities are rejected instead of ambiguously merged', async () => {
  const uri = `${ROOT}/duplicate`
  const { service } = createHarness([
    { uri, name: 'First', mimeType: 'text/plain' },
    { uri, name: 'Second', mimeType: 'text/plain' },
  ])
  await assert.rejects(
    service.listResources(),
    hasResourceError('protocol_error'),
  )
})
