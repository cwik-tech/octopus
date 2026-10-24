import { whenDefined } from '../../core/optional-properties.js'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import type { McpServerInput } from '../../domains/mcp/mcp-settings.js'
import {
  McpSettingsService,
  McpSettingsServiceError,
  type McpSecretCodec,
} from '../../services/mcp-settings-service.js'

const repoRoot = process.cwd()

const codec: McpSecretCodec = {
  encrypt(value) {
    return Buffer.from(
      Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa5),
    ).toString('base64')
  },
  decrypt(value) {
    return Buffer.from(
      Buffer.from(value, 'base64').map((byte) => byte ^ 0xa5),
    ).toString('utf8')
  },
}

function createStorage(): { directory: string; storagePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-settings-'))
  return { directory, storagePath: path.join(directory, 'mcp-settings.json') }
}

function errorText(error: unknown): string {
  return `${String(error)} ${JSON.stringify(error)}`
}

test('MCP settings persist redacted secret metadata and preserve secret patches across restart', async () => {
  const { directory, storagePath } = createStorage()
  const manager = new McpClientManager()
  const service = new McpSettingsService({ storagePath, secretCodec: codec, clientManager: manager })
  const alphaSecret = 'unit-alpha-secret-31b8'
  const betaSecret = 'unit-beta-secret-f420'
  const gammaSecret = 'unit-gamma-secret-a917'
  const argumentSecret = 'unit-argument-secret-08de'

  try {
    const created = await service.saveServer({
      id: 'stdio-main',
      name: 'Local tools',
      capabilityAliases: [{ capability: 'Database', access: 'read' }],
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: ['tests/fixtures/mcp/stdio-server.mjs'],
        cwd: repoRoot,
        secretEnvironment: {
          MCP_ALPHA_TOKEN: { operation: 'replace', value: alphaSecret },
          MCP_BETA_TOKEN: { operation: 'replace', value: betaSecret },
        },
      },
    })

    assert.equal(created.enabled, true)
    assert.equal(created.status, 'unvalidated')
    assert.equal(manager.isConnected(created.id), false)
    assert.deepEqual(created.capabilityAliases, [{ capability: 'database', access: 'read' }])
    assert.equal(created.transport.type, 'stdio')
    assert.deepEqual(created.transport.environmentKeys, ['MCP_ALPHA_TOKEN', 'MCP_BETA_TOKEN'])
    assert.equal(created.transport.hasSecrets, true)
    assert.doesNotMatch(JSON.stringify(created), /unit-(alpha|beta)-secret/)

    const updated = await service.updateServer('stdio-main', {
      name: 'Local tools',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: ['tests/fixtures/mcp/stdio-server.mjs'],
        cwd: repoRoot,
        secretEnvironment: {
          MCP_ALPHA_TOKEN: { operation: 'preserve' },
          MCP_BETA_TOKEN: { operation: 'remove' },
          MCP_GAMMA_TOKEN: { operation: 'replace', value: gammaSecret },
        },
      },
    })
    assert.equal(updated.transport.type, 'stdio')
    assert.deepEqual(updated.transport.environmentKeys, ['MCP_ALPHA_TOKEN', 'MCP_GAMMA_TOKEN'])

    await assert.rejects(
      service.updateServer('stdio-main', {
        name: 'Local tools',
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: [`--api-key=${argumentSecret}`],
          cwd: repoRoot,
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof McpSettingsServiceError)
        assert.doesNotMatch(errorText(error), new RegExp(argumentSecret))
        return error.code === 'invalid_request'
      },
    )

    const persisted = fs.readFileSync(storagePath, 'utf8')
    for (const plaintext of [alphaSecret, betaSecret, gammaSecret, argumentSecret]) {
      assert.equal(persisted.includes(plaintext), false)
    }
    assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600)
    assert.deepEqual(
      fs.readdirSync(directory).filter((entry) => entry.endsWith('.tmp')),
      [],
    )

    const reloaded = new McpSettingsService({ storagePath, secretCodec: codec })
    assert.deepEqual(await reloaded.listServers(), [updated])
    await reloaded.closeAll()

    const unavailableCodecService = new McpSettingsService({
      storagePath,
      secretCodec: {
        encrypt() {
          throw new Error('unavailable')
        },
        decrypt() {
          return ''
        },
      },
    })
    await assert.rejects(
      unavailableCodecService.validateServer('stdio-main', {
        stdioTrustAcknowledged: true,
      }),
      (error: unknown) =>
        error instanceof McpSettingsServiceError &&
        error.code === 'configuration_invalid' &&
        !errorText(error).includes(alphaSecret),
    )
    await unavailableCodecService.closeAll()
  } finally {
    await service.closeAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('stdio validation requires explicit trust and every update invalidates persisted trust', async () => {
  const { directory, storagePath } = createStorage()
  const manager = new McpClientManager()
  const service = new McpSettingsService({
    storagePath,
    secretCodec: codec,
    clientManager: manager,
  })
  const input: McpServerInput = {
    id: 'trusted-stdio',
    name: 'Trusted stdio',
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: ['tests/fixtures/mcp/stdio-server.mjs'],
      cwd: repoRoot,
    },
  }

  try {
    await service.saveServer(input)
    await assert.rejects(
      service.validateServer('trusted-stdio'),
      (error: unknown) =>
        error instanceof McpSettingsServiceError &&
        error.code === 'configuration_invalid' &&
        /trust acknowledgement is required/i.test(error.message),
    )
    assert.equal(manager.isConnected('trusted-stdio'), false)
    assert.doesNotMatch(fs.readFileSync(storagePath, 'utf8'), /stdioTrustDigest/)

    const connected = await service.validateServer('trusted-stdio', {
      stdioTrustAcknowledged: true,
    })
    assert.equal(connected.status, 'connected')
    assert.equal(manager.isConnected('trusted-stdio'), true)
    assert.match(
      fs.readFileSync(storagePath, 'utf8'),
      /"stdioTrustDigest": "[a-f0-9]{64}"/,
    )

    await service.updateServer('trusted-stdio', {
      ...input,
      
      name: 'Trusted stdio renamed',
    })
    assert.equal(manager.isConnected('trusted-stdio'), false)
    assert.doesNotMatch(fs.readFileSync(storagePath, 'utf8'), /stdioTrustDigest/)
    await assert.rejects(
      service.validateServer('trusted-stdio'),
      (error: unknown) =>
        error instanceof McpSettingsServiceError &&
        error.code === 'configuration_invalid',
    )
    assert.equal(manager.isConnected('trusted-stdio'), false)
  } finally {
    await service.closeAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('legacy stdio settings without a trust digest hydrate as unvalidated without spawning', async () => {
  const { directory, storagePath } = createStorage()
  const markerPath = path.join(directory, 'legacy-stdio-started')
  const initial = new McpSettingsService({ storagePath, secretCodec: codec })
  let reloaded: McpSettingsService | null = null

  try {
    await initial.saveServer({
      id: 'legacy-stdio',
      name: 'Legacy stdio',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'started')`,
        ],
      },
    })
    const document = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as {
      servers: Array<Record<string, unknown>>
    }
    document.servers[0]!.status = 'connected'
    fs.writeFileSync(storagePath, JSON.stringify(document))

    const manager = new McpClientManager()
    reloaded = new McpSettingsService({
      storagePath,
      secretCodec: codec,
      clientManager: manager,
    })
    await reloaded.hydrate()
    assert.equal(fs.existsSync(markerPath), false)
    assert.equal(manager.isConnected('legacy-stdio'), false)
    assert.equal((await reloaded.getServer('legacy-stdio'))?.status, 'unvalidated')
    assert.doesNotMatch(fs.readFileSync(storagePath, 'utf8'), /stdioTrustDigest/)
  } finally {
    await reloaded?.closeAll()
    await initial.closeAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('MCP settings reject unsafe stdio, HTTP, header, OAuth, and secret-patch inputs', async () => {
  const service = new McpSettingsService({ secretCodec: codec })
  const missingPath = path.join(os.tmpdir(), `missing-mcp-command-${process.pid}`)
  const invalidInputs: McpServerInput[] = [
    {
      id: 'empty-command',
      name: 'Invalid',
      transport: { type: 'stdio' as const, command: '   ' },
    },
    {
      id: 'missing-command',
      name: 'Invalid',
      transport: { type: 'stdio' as const, command: missingPath },
    },
    {
      id: 'unsafe-argument',
      name: 'Invalid',
      transport: { type: 'stdio' as const, command: process.execPath, args: ['bad\narg'] },
    },
    {
      id: 'credential-argument',
      name: 'Invalid',
      transport: {
        type: 'stdio' as const,
        command: process.execPath,
        args: ['--token=hidden'],
      },
    },
    {
      id: 'userinfo-argument',
      name: 'Invalid',
      transport: {
        type: 'stdio' as const,
        command: process.execPath,
        args: ['--database=postgres://hidden@localhost/tools'],
      },
    },
    {
      id: 'relative-cwd',
      name: 'Invalid',
      transport: { type: 'stdio' as const, command: process.execPath, cwd: 'relative/path' },
    },
    {
      id: 'unsafe-env',
      name: 'Invalid',
      transport: {
        type: 'stdio' as const,
        command: process.execPath,
        secretEnvironment: { 'BAD-NAME': { operation: 'replace' as const, value: 'hidden' } },
      },
    },
    {
      id: 'ftp-url',
      name: 'Invalid',
      transport: { type: 'streamable-http' as const, url: 'ftp://example.test/mcp' },
    },
    {
      id: 'credential-url',
      name: 'Invalid',
      transport: { type: 'streamable-http' as const, url: 'https://user:pass@example.test/mcp' },
    },
    {
      id: 'fragment-url',
      name: 'Invalid',
      transport: { type: 'streamable-http' as const, url: 'https://example.test/mcp#secret' },
    },
    {
      id: 'query-url',
      name: 'Invalid',
      transport: {
        type: 'streamable-http' as const,
        url: 'https://example.test/mcp?token=plaintext',
      },
    },
    {
      id: 'forbidden-header',
      name: 'Invalid',
      transport: {
        type: 'streamable-http' as const,
        url: 'https://example.test/mcp',
        secretHeaders: { Host: { operation: 'replace' as const, value: 'hidden' } },
      },
    },
    {
      id: 'unsafe-header-value',
      name: 'Invalid',
      transport: {
        type: 'streamable-http' as const,
        url: 'https://example.test/mcp',
        secretHeaders: {
          'X-Test': { operation: 'replace' as const, value: 'hidden\r\nX-Evil: yes' },
        },
      },
    },
    {
      id: 'invalid-oauth-scope',
      name: 'Invalid',
      transport: {
        type: 'streamable-http' as const,
        url: 'https://example.test/mcp',
        authentication: { type: 'oauth' as const, scopes: ['two words'] },
      },
    },
  ]

  for (const input of invalidInputs) {
    await assert.rejects(
      service.saveServer(input),
      (error: unknown) => {
        assert.ok(error instanceof McpSettingsServiceError)
        assert.equal(error.code, 'invalid_request')
        assert.doesNotMatch(errorText(error), /hidden|user:pass|bad\narg/)
        return true
      },
    )
  }

  await service.saveServer({
    id: 'preserve-target',
    name: 'Preserve target',
    transport: { type: 'stdio', command: process.execPath },
  })
  await assert.rejects(
    service.updateServer('preserve-target', {
      name: 'Preserve target',
      transport: {
        type: 'stdio',
        command: process.execPath,
        secretEnvironment: { MISSING: { operation: 'preserve' } },
      },
    }),
    (error: unknown) =>
      error instanceof McpSettingsServiceError && error.code === 'invalid_request',
  )
  await assert.rejects(
    service.updateServer('does-not-exist', {
      name: 'Missing',
      transport: { type: 'stdio', command: process.execPath },
    }),
    (error: unknown) =>
      error instanceof McpSettingsServiceError && error.code === 'not_found',
  )
})

test('OAuth metadata is persisted but validation reports authorization required without disclosure', async () => {
  const { directory, storagePath } = createStorage()
  const service = new McpSettingsService({ storagePath, secretCodec: codec })
  const headerSecret = 'oauth-header-secret-1c67'
  const clientSecret = 'oauth-client-secret-524a'

  try {
    const created = await service.saveServer({
      id: 'oauth-server',
      name: 'OAuth tools',
      transport: {
        type: 'streamable-http',
        url: 'https://mcp.example.test/rpc',
        secretHeaders: {
          'X-Workspace-Key': { operation: 'replace', value: headerSecret },
        },
        authentication: {
          type: 'oauth',
          authorizationServerUrl: 'https://auth.example.test',
          clientId: 'pipeline-desktop',
          scopes: ['tools.read'],
          secretCredentials: {
            client_secret: { operation: 'replace', value: clientSecret },
          },
        },
      },
    })
    assert.equal(created.transport.type, 'streamable-http')
    assert.deepEqual(created.transport.headerKeys, ['x-workspace-key'])
    assert.equal(created.transport.authentication.type, 'oauth')
    assert.equal(created.transport.authentication.status, 'authorization-required')
    assert.equal(created.transport.authentication.hasCredentials, true)

    await assert.rejects(
      service.validateServer(created.id),
      (error: unknown) => {
        assert.ok(error instanceof McpSettingsServiceError)
        assert.equal(error.code, 'unauthorized')
        assert.equal(error.server?.status, 'error')
        assert.equal(error.server?.statusMessage, 'MCP authorization is required.')
        assert.doesNotMatch(errorText(error), /oauth-(header|client)-secret/)
        return true
      },
    )

    const view = await service.getServer(created.id)
    const persisted = fs.readFileSync(storagePath, 'utf8')
    assert.doesNotMatch(JSON.stringify(view), /oauth-(header|client)-secret/)
    assert.equal(persisted.includes(headerSecret), false)
    assert.equal(persisted.includes(clientSecret), false)
  } finally {
    await service.closeAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('persisted settings are revalidated, redact untrusted status text, and normalize OAuth state', async () => {
  const { directory, storagePath } = createStorage()
  const service = new McpSettingsService({ storagePath, secretCodec: codec })

  try {
    await service.saveServer({
      id: 'persisted-oauth',
      name: 'Persisted OAuth',
      transport: {
        type: 'streamable-http',
        url: 'https://mcp.example.test/rpc',
        authentication: { type: 'oauth', scopes: ['tools.read'] },
      },
    })
    const document = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as {
      servers: Array<Record<string, unknown>>
    }
    document.servers[0]!.status = 'error'
    document.servers[0]!.statusMessage = 'tampered-plaintext-secret-883c'
    const transport = document.servers[0]!.transport as {
      authentication: Record<string, unknown>
    }
    transport.authentication.status = 'authorized'
    fs.writeFileSync(storagePath, JSON.stringify(document))

    const reloaded = new McpSettingsService({ storagePath, secretCodec: codec })
    const [view] = await reloaded.listServers()
    assert.equal(view?.statusMessage, 'MCP server connection failed.')
    assert.doesNotMatch(JSON.stringify(view), /tampered-plaintext-secret/)
    assert.equal(view?.transport.type, 'streamable-http')
    if (view?.transport.type === 'streamable-http') {
      assert.equal(view.transport.authentication.type, 'oauth')
      if (view.transport.authentication.type === 'oauth') {
        assert.equal(view.transport.authentication.status, 'authorization-required')
      }
    }

    document.servers[0]!.transport = {
      type: 'stdio',
      command: `${process.execPath}\n--unsafe`,
      args: [],
      encryptedEnvironment: {},
    }
    fs.writeFileSync(storagePath, JSON.stringify(document))
    const unsafeReload = new McpSettingsService({ storagePath, secretCodec: codec })
    await assert.rejects(
      unsafeReload.listServers(),
      (error: unknown) =>
        error instanceof McpSettingsServiceError && error.code === 'configuration_invalid',
    )
  } finally {
    await service.closeAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('deleting a server atomically removes its agent grants', async () => {
  const { directory, storagePath } = createStorage()
  const service = new McpSettingsService({ storagePath, secretCodec: codec })

  try {
    await service.saveServer({
      id: 'granted-server',
      name: 'Granted server',
      transport: { type: 'stdio', command: process.execPath },
    })
    const document = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as {
      agentGrants: unknown[]
    }
    document.agentGrants = [{
      agentPath: 'agents/tool-user',
      serverId: 'granted-server',
      enabled: true,
      updatedAt: '2026-07-12T12:00:00.000Z',
    }]
    fs.writeFileSync(storagePath, JSON.stringify(document))

    const reloaded = new McpSettingsService({ storagePath, secretCodec: codec })
    assert.equal((await reloaded.listAgentGrants()).length, 1)
    assert.equal(await reloaded.deleteServer('granted-server'), true)
    assert.deepEqual(await reloaded.listAgentGrants(), [])
    assert.deepEqual(JSON.parse(fs.readFileSync(storagePath, 'utf8')).agentGrants, [])
    assert.equal(await reloaded.deleteServer('granted-server'), false)
  } finally {
    await service.closeAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('authorization revocation waits for an acquired evidence completion fence', async () => {
  const { directory, storagePath } = createStorage()
  const service = new McpSettingsService({ storagePath, secretCodec: codec })

  try {
    const guard = service.getAuthorizationGuard(
      'agents/tool-user',
      'completion-server',
    )
    const completion = guard.beginCompletion()
    assert.ok(completion)
    let revocationFinished = false
    const revocation = service.closeAll().then(() => {
      revocationFinished = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal(guard.getRevocationCode(), 'server_disabled')
    assert.equal(guard.signal.aborted, false)
    assert.equal(guard.beginCompletion(), null)
    assert.equal(revocationFinished, false)

    completion.release()
    await revocation
    assert.equal(guard.signal.aborted, true)
    assert.equal(revocationFinished, true)
  } finally {
    await service.closeAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
