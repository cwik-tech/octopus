import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  startApiServer,
  type StartedApiServer,
} from '../../server/api-server.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import {
  McpResourceClientService,
  type McpResourceDescriptor,
} from '../../domains/mcp/mcp-resource-client-service.js'
import {
  McpResourceImportStore,
  type McpResourceImportManifest,
} from '../../domains/mcp/mcp-resource-import-store.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import {
  McpSettingsService,
  type McpSecretCodec,
} from '../../services/mcp-settings-service.js'
import type { ImportSessionMcpResourceResult } from '../../services/mcp-resource-import-service.js'
import { McpResourceImportService } from '../../services/mcp-resource-import-service.js'
import {
  FileSystemSessionStore,
  type SessionStore,
} from '../../domains/sessions/session-store.js'
import type { SessionFile } from '../../contracts/sessions.js'

const repoRoot = process.cwd()
const fixtureDirectory = path.join(repoRoot, 'tests', 'fixtures', 'mcp')
const resourceRoot = 'mcp-resource-fixture://resources'
const cleanupTimeoutMs = 5_000
const stdioServerId = 'api-resource-stdio'
const httpServerId = 'api-resource-http'
const stdioSecret = 'STDIO_API_RESOURCE_SECRET_DO_NOT_EXPOSE'
const httpSecret = 'HTTP_API_RESOURCE_SECRET_DO_NOT_EXPOSE'

interface LifecycleEvent {
  readonly event: 'ready' | 'read_started' | 'stopped'
  readonly pid: number
}

interface HttpFixture {
  readonly child: ChildProcess
  readonly pid: number
  readonly url: string
  readonly lifecyclePath: string
  readonly readStderr: () => string
}

interface JsonResponse<T> {
  readonly response: Response
  readonly text: string
  readonly body: T
}

interface CatalogPayload {
  readonly resources: readonly McpResourceDescriptor[]
  readonly nextCursor?: string
}

interface ImportsPayload {
  readonly imports: readonly McpResourceImportManifest[]
}

interface FilesPayload {
  readonly files: readonly SessionFile[]
}

interface ErrorPayload {
  readonly error: string
  readonly code?: string
  readonly retryable?: boolean
}

function createSecretCodec(): McpSecretCodec {
  const key = randomBytes(32)
  return {
    encrypt(value) {
      const initializationVector = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, initializationVector)
      const ciphertext = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ])
      return Buffer.concat([
        initializationVector,
        cipher.getAuthTag(),
        ciphertext,
      ]).toString('base64')
    },
    decrypt(value) {
      const payload = Buffer.from(value, 'base64')
      const initializationVector = payload.subarray(0, 12)
      const authenticationTag = payload.subarray(12, 28)
      const decipher = createDecipheriv('aes-256-gcm', key, initializationVector)
      decipher.setAuthTag(authenticationTag)
      return Buffer.concat([
        decipher.update(payload.subarray(28)),
        decipher.final(),
      ]).toString('utf8')
    },
  }
}

function readLifecycle(filePath: string): LifecycleEvent[] {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LifecycleEvent)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = cleanupTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`Timed out waiting for ${description}`)
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, remaining)))
  }
}

async function waitForLifecycle(
  filePath: string,
  event: LifecycleEvent['event'],
  pid: number,
): Promise<void> {
  await waitForCondition(
    () => readLifecycle(filePath).some(
      (entry) => entry.event === event && entry.pid === pid,
    ),
    `${event} lifecycle event for ${pid}`,
  )
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error('Timed out waiting for fixture process exit')),
        cleanupTimeoutMs,
      )
    }),
  ])
}

async function stopChild(child: ChildProcess, pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return
  child.kill('SIGTERM')
  await waitForChildExit(child).catch(async () => {
    if (isProcessAlive(pid)) child.kill('SIGKILL')
    await waitForChildExit(child).catch(() => undefined)
  })
}

async function startHttpFixture(
  lifecyclePath: string,
  port?: number,
): Promise<HttpFixture> {
  const child = spawn(
    process.execPath,
    [path.join(fixtureDirectory, 'resource-streamable-http-server.mjs')],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        MCP_FIXTURE_LIFECYCLE_PATH: lifecyclePath,
        ...(port === undefined ? {} : { MCP_FIXTURE_PORT: String(port) }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  if (!child.stdout) throw new Error('HTTP resource fixture stdout is unavailable')
  const stdout = child.stdout
  const ready = await Promise.race([
    new Promise<{ pid: number; url: string }>((resolve, reject) => {
      let buffer = ''
      const cleanup = () => {
        stdout.off('data', onData)
        child.off('exit', onExit)
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup()
        reject(new Error(
          `HTTP fixture exited early (code=${code}, signal=${signal}): ${stderr}`,
        ))
      }
      const onData = (chunk: Buffer | string) => {
        buffer += String(chunk)
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) {
            try {
              const message = JSON.parse(line) as {
                type?: string
                pid?: number
                url?: string
              }
              if (
                message.type === 'ready'
                && typeof message.pid === 'number'
                && typeof message.url === 'string'
              ) {
                cleanup()
                resolve({ pid: message.pid, url: message.url })
                return
              }
            } catch (error) {
              cleanup()
              reject(error)
              return
            }
          }
          newline = buffer.indexOf('\n')
        }
      }
      stdout.on('data', onData)
      child.once('exit', onExit)
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`Timed out waiting for HTTP fixture: ${stderr}`)),
        4_000,
      )
    }),
  ])
  return {
    child,
    pid: ready.pid,
    url: ready.url,
    lifecyclePath,
    readStderr: () => stderr,
  }
}

async function jsonRequest<T>(
  url: string,
  init?: RequestInit,
): Promise<JsonResponse<T>> {
  const response = await fetch(url, init)
  const text = await response.text()
  return { response, text, body: JSON.parse(text) as T }
}

function importRequest(
  apiUrl: string,
  sessionId: string,
  serverId: string,
  uri: string,
  requestedInputBaseName?: string,
  signal?: AbortSignal,
): Promise<JsonResponse<ImportSessionMcpResourceResult>> {
  return jsonRequest(`${apiUrl}/sessions/${sessionId}/mcp-resources/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId,
      uri,
      ...(requestedInputBaseName ? { requestedInputBaseName } : {}),
    }),
    ...(signal ? { signal } : {}),
  })
}

async function listCatalog(params: {
  apiUrl: string
  sessionId: string
  serverId?: string
  limit: number
}): Promise<McpResourceDescriptor[]> {
  const resources: McpResourceDescriptor[] = []
  let cursor: string | undefined
  do {
    const url = new URL(
      `${params.apiUrl}/sessions/${params.sessionId}/mcp-resources`,
    )
    url.searchParams.set('limit', String(params.limit))
    if (params.serverId) url.searchParams.set('serverId', params.serverId)
    if (cursor) url.searchParams.set('cursor', cursor)
    const page = await jsonRequest<CatalogPayload>(url.toString())
    assert.equal(page.response.status, 200)
    assert.equal(page.response.headers.get('cache-control'), 'no-store')
    assertRedacted(page.text)
    resources.push(...page.body.resources)
    cursor = page.body.nextCursor
  } while (cursor)
  return resources
}

function assertRedacted(text: string): void {
  for (const forbidden of [stdioSecret, httpSecret, 'MCP_FIXTURE_SECRET_DO_NOT_EXPOSE']) {
    assert.equal(text.includes(forbidden), false)
  }
}

function assertNoStore(response: Response): void {
  assert.equal(response.headers.get('cache-control'), 'no-store')
}

function expectedFileSource(
  manifest: McpResourceImportManifest,
  content: McpResourceImportManifest['contents'][number],
): NonNullable<SessionFile['source']> {
  return {
    kind: 'mcp-resource',
    snapshotId: manifest.snapshotId,
    serverId: manifest.server.id,
    serverName: manifest.server.name,
    resourceId: manifest.resource.id,
    resourceName: manifest.resource.name,
    resourceUri: manifest.resource.uri,
    contentId: content.id,
    contentUri: content.sourceUri,
    mimeType: content.mimeType,
    capturedAt: manifest.capturedAt,
    sha256: content.sha256,
  }
}

function assertMaterializedImport(
  imported: ImportSessionMcpResourceResult,
  sessionStore: SessionStore,
  sessionId: string,
): void {
  assert.equal(imported.files.length, imported.import.contents.length)
  for (const content of imported.import.contents) {
    const file = imported.files.find(
      (candidate) => candidate.name === content.materializedInputFilename,
    )
    assert.ok(file)
    assert.equal(file.size, content.byteLength)
    assert.equal(file.parseStatus, 'pending')
    assert.deepEqual(file.source, expectedFileSource(imported.import, content))
    const inputPath = path.join(sessionStore.inputsDir(sessionId), file.name)
    const buffer = fs.readFileSync(inputPath)
    assert.equal(buffer.byteLength, content.byteLength)
    assert.equal(createHash('sha256').update(buffer).digest('hex'), content.sha256)
  }
}

function createManager(): McpClientManager {
  return new McpClientManager({
    connectTimeoutMs: 3_000,
    requestTimeoutMs: 300,
    closeTimeoutMs: 3_000,
  })
}

async function startResourcesApi(params: {
  workspacePath: string
  sessionStore: FileSystemSessionStore
  settingsService: McpSettingsService
  providerSettingsService: ProviderSettingsService
}): Promise<StartedApiServer> {
  const importStore = new McpResourceImportStore({
    workspacePath: params.workspacePath,
  })
  const importService = new McpResourceImportService({
    resourceClient: new McpResourceClientService({
      settingsService: params.settingsService,
      clientManager: params.settingsService.getResourceClientManager(),
      requestTimeoutMs: 300,
    }),
    importStore,
    sessionStore: params.sessionStore,
  })
  return startApiServer({
    store: new FileSystemRunStore(params.workspacePath),
    launcher: new PiRunLauncher(),
    workspacePath: params.workspacePath,
    sessionStore: params.sessionStore,
    mcpSettingsService: params.settingsService,
    providerSettingsService: params.providerSettingsService,
    mcpResourceImportService: importService,
  })
}

test('real MCP resource API contract spans stdio, Streamable HTTP, persistence, failures, and cleanup', { timeout: 45_000 }, async (t) => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-resources-api-'),
  )
  const stdioLifecyclePath = path.join(workspacePath, 'stdio-lifecycle.jsonl')
  const httpLifecyclePath = path.join(workspacePath, 'http-lifecycle.jsonl')
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'MCP resource API' })
  const manager = createManager()
  const settingsService = new McpSettingsService({
    storagePath: path.join(workspacePath, 'mcp-settings.json'),
    secretCodec: createSecretCodec(),
    clientManager: manager,
  })
  const providerSettingsService = new ProviderSettingsService({
    storagePath: path.join(workspacePath, 'provider-settings.json'),
  })
  let httpFixture: HttpFixture | null = null
  let apiServer: StartedApiServer | null = null

  try {
    httpFixture = await startHttpFixture(httpLifecyclePath)
    await waitForLifecycle(httpLifecyclePath, 'ready', httpFixture.pid)
    apiServer = await startResourcesApi({
      workspacePath,
      sessionStore,
      settingsService,
      providerSettingsService,
    })

    const stdioServer = await settingsService.saveServer({
      id: stdioServerId,
      name: 'API stdio resources',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [path.join(fixtureDirectory, 'resource-stdio-server.mjs')],
        cwd: repoRoot,
        secretEnvironment: {
          MCP_FIXTURE_LIFECYCLE_PATH: {
            operation: 'replace',
            value: stdioLifecyclePath,
          },
          MCP_FIXTURE_TEST_SECRET: {
            operation: 'replace',
            value: stdioSecret,
          },
        },
      },
    })
    const httpServer = await settingsService.saveServer({
      id: httpServerId,
      name: 'API HTTP resources',
      transport: {
        type: 'streamable-http',
        url: httpFixture.url,
        secretHeaders: {
          'X-Resource-Fixture-Secret': {
            operation: 'replace',
            value: httpSecret,
          },
        },
      },
    })
    await settingsService.validateServer(stdioServer.id, {
      stdioTrustAcknowledged: true,
    })
    await settingsService.validateServer(httpServer.id)
    const firstStdioPid = manager.getSnapshot(stdioServer.id)?.processId
    assert.ok(firstStdioPid)
    await waitForLifecycle(stdioLifecyclePath, 'ready', firstStdioPid)

    await t.test('catalog paginates, filters, and never exposes configuration', async () => {
      const all = await listCatalog({
        apiUrl: apiServer!.url,
        sessionId: session.id,
        limit: 5,
      })
      assert.equal(all.length, 16)
      assert.equal(new Set(all.map((resource) => resource.id)).size, 16)
      assert.deepEqual(
        new Set(all.map((resource) => resource.serverId)),
        new Set([stdioServerId, httpServerId]),
      )

      const filtered = await listCatalog({
        apiUrl: apiServer!.url,
        sessionId: session.id,
        serverId: stdioServerId,
        limit: 3,
      })
      assert.equal(filtered.length, 8)
      assert.ok(filtered.every((resource) => resource.serverId === stdioServerId))
      assert.equal(
        filtered.find((resource) => resource.uri === `${resourceRoot}/blocked`)
          ?.disposition,
        'blocked',
      )

      const invalidLimit = await jsonRequest<ErrorPayload>(
        `${apiServer!.url}/sessions/${session.id}/mcp-resources?limit=101`,
      )
      assert.equal(invalidLimit.response.status, 400)
      assertNoStore(invalidLimit.response)
      assertRedacted(invalidLimit.text)

      const duplicateFilter = await jsonRequest<ErrorPayload>(
        `${apiServer!.url}/sessions/${session.id}/mcp-resources?serverId=${stdioServerId}&serverId=${httpServerId}`,
      )
      assert.equal(duplicateFilter.response.status, 400)
      assertNoStore(duplicateFilter.response)
    })

    let textImport: ImportSessionMcpResourceResult
    let binaryImport: ImportSessionMcpResourceResult
    let multipleImport: ImportSessionMcpResourceResult

    await t.test('POST imports materialize exact text, binary, and multiple contents with provenance', async () => {
      const text = await importRequest(
        apiServer!.url,
        session.id,
        stdioServerId,
        `${resourceRoot}/text`,
        'api-text',
      )
      assert.equal(text.response.status, 201)
      assertNoStore(text.response)
      assertRedacted(text.text)
      textImport = text.body
      assertMaterializedImport(textImport, sessionStore, session.id)
      assert.equal(
        fs.readFileSync(
          path.join(sessionStore.inputsDir(session.id), textImport.files[0]!.name),
          'utf8',
        ),
        'mcp-resource-text-marker',
      )

      const binary = await importRequest(
        apiServer!.url,
        session.id,
        httpServerId,
        `${resourceRoot}/binary`,
      )
      assert.equal(binary.response.status, 201)
      assertNoStore(binary.response)
      binaryImport = binary.body
      assertMaterializedImport(binaryImport, sessionStore, session.id)
      assert.equal(
        fs.readFileSync(
          path.join(sessionStore.inputsDir(session.id), binaryImport.files[0]!.name),
        ).toString('hex'),
        '89504e470d0a1a0a',
      )

      const multiple = await importRequest(
        apiServer!.url,
        session.id,
        httpServerId,
        `${resourceRoot}/multiple`,
      )
      assert.equal(multiple.response.status, 201)
      assertNoStore(multiple.response)
      multipleImport = multiple.body
      assertMaterializedImport(multipleImport, sessionStore, session.id)
      assert.deepEqual(
        new Set(multipleImport.import.contents.map((content) => content.kind)),
        new Set(['text', 'binary']),
      )

      const imports = await jsonRequest<ImportsPayload>(
        `${apiServer!.url}/sessions/${session.id}/mcp-resources/imports`,
      )
      assert.equal(imports.response.status, 200)
      assertNoStore(imports.response)
      assert.equal(imports.body.imports.length, 3)
      assertRedacted(imports.text)

      const files = await jsonRequest<FilesPayload>(
        `${apiServer!.url}/sessions/${session.id}/files`,
      )
      assert.equal(files.response.status, 200)
      assert.equal(files.body.files.length, 4)
      assert.ok(files.body.files.every((file) => file.source?.kind === 'mcp-resource'))
      for (const file of files.body.files) {
        const imported = [textImport, binaryImport, multipleImport].find(
          (candidate) => candidate.import.snapshotId === file.source?.snapshotId,
        )
        assert.ok(imported)
        const content = imported.import.contents.find(
          (candidate) => candidate.materializedInputFilename === file.name,
        )
        assert.ok(content)
        assert.deepEqual(file.source, expectedFileSource(imported.import, content))
      }
    })

    await t.test('refresh publishes a new snapshot and never overwrites the prior input', async () => {
      const originalFilename = textImport.files[0]!.name
      const originalPath = path.join(sessionStore.inputsDir(session.id), originalFilename)
      const originalBytes = fs.readFileSync(originalPath)
      const refreshed = await importRequest(
        apiServer!.url,
        session.id,
        stdioServerId,
        `${resourceRoot}/text`,
        'api-text',
      )
      assert.equal(refreshed.response.status, 201)
      assert.notEqual(refreshed.body.import.snapshotId, textImport.import.snapshotId)
      assert.notEqual(refreshed.body.files[0]!.name, originalFilename)
      assert.deepEqual(fs.readFileSync(originalPath), originalBytes)
      assertMaterializedImport(refreshed.body, sessionStore, session.id)

      const imports = await jsonRequest<ImportsPayload>(
        `${apiServer!.url}/sessions/${session.id}/mcp-resources/imports`,
      )
      assert.equal(imports.body.imports.length, 4)
    })

    await t.test('deleting a materialized file preserves its immutable import but removes run provenance selection', async () => {
      const deletedFilename = textImport.files[0]!.name
      const deleteResponse = await fetch(
        `${apiServer!.url}/sessions/${session.id}/files/${encodeURIComponent(deletedFilename)}`,
        { method: 'DELETE' },
      )
      assert.equal(deleteResponse.status, 204)
      assert.equal(
        fs.existsSync(path.join(sessionStore.inputsDir(session.id), deletedFilename)),
        false,
      )

      const imports = await jsonRequest<ImportsPayload>(
        `${apiServer!.url}/sessions/${session.id}/mcp-resources/imports`,
      )
      assert.equal(imports.response.status, 200)
      assert.equal(imports.body.imports.length, 4)
      assert.ok(imports.body.imports.some(
        (entry) => entry.snapshotId === textImport.import.snapshotId,
      ))

      const files = await jsonRequest<FilesPayload>(
        `${apiServer!.url}/sessions/${session.id}/files`,
      )
      assert.equal(files.body.files.length, 4)
      assert.ok(files.body.files.every((file) => file.name !== deletedFilename))
      const selected = await new McpResourceImportStore({ workspacePath })
        .selectProvenance(
          session.id,
          files.body.files.map((file) => file.name),
        )
      assert.ok(selected.every(
        (entry) => entry.snapshotId !== textImport.import.snapshotId,
      ))
    })

    await t.test('validation and protocol failures map to stable redacted statuses', async () => {
      const missingSessionId = randomUUID()
      const missingImports = await jsonRequest<ErrorPayload>(
        `${apiServer!.url}/sessions/${missingSessionId}/mcp-resources/imports`,
      )
      assert.equal(missingImports.response.status, 404)
      assert.equal(missingImports.body.code, 'not_found')
      assertNoStore(missingImports.response)

      const missingResource = await importRequest(
        apiServer!.url,
        session.id,
        httpServerId,
        `${resourceRoot}/does-not-exist`,
      ) as JsonResponse<unknown> as JsonResponse<ErrorPayload>
      assert.equal(missingResource.response.status, 404)
      assert.equal(missingResource.body.code, 'not_found')

      const blocked = await importRequest(
        apiServer!.url,
        session.id,
        httpServerId,
        `${resourceRoot}/blocked`,
      ) as JsonResponse<unknown> as JsonResponse<ErrorPayload>
      assert.equal(blocked.response.status, 400)
      assert.equal(blocked.body.code, 'configuration_invalid')

      const oversized = await importRequest(
        apiServer!.url,
        session.id,
        httpServerId,
        `${resourceRoot}/oversize`,
      ) as JsonResponse<unknown> as JsonResponse<ErrorPayload>
      assert.equal(oversized.response.status, 413)
      assert.equal(oversized.body.code, 'result_too_large')

      const malformed = await importRequest(
        apiServer!.url,
        session.id,
        httpServerId,
        `${resourceRoot}/malformed`,
      ) as JsonResponse<unknown> as JsonResponse<ErrorPayload>
      assert.equal(malformed.response.status, 502)
      assert.equal(malformed.body.code, 'protocol_error')

      const sourceFailure = await importRequest(
        apiServer!.url,
        session.id,
        httpServerId,
        `${resourceRoot}/source-failure`,
      ) as JsonResponse<unknown> as JsonResponse<ErrorPayload>
      assert.equal(sourceFailure.response.status, 502)
      assert.equal(sourceFailure.body.code, 'protocol_error')

      const timeout = await importRequest(
        apiServer!.url,
        session.id,
        httpServerId,
        `${resourceRoot}/slow`,
      ) as JsonResponse<unknown> as JsonResponse<ErrorPayload>
      assert.equal(timeout.response.status, 504)
      assert.equal(timeout.body.code, 'timeout')
      assert.equal(timeout.body.retryable, true)

      for (const response of [
        missingResource,
        blocked,
        oversized,
        malformed,
        sourceFailure,
        timeout,
      ]) {
        assertNoStore(response.response)
        assertRedacted(response.text)
        assert.equal(response.text.includes(httpFixture!.url), false)
      }

      const invalidBody = await jsonRequest<ErrorPayload>(
        `${apiServer!.url}/sessions/${session.id}/mcp-resources/imports`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            serverId: httpServerId,
            uri: `${resourceRoot}/text`,
            unexpected: true,
          }),
        },
      )
      assert.equal(invalidBody.response.status, 400)
      assertNoStore(invalidBody.response)

      const invalidRoute = await jsonRequest<ErrorPayload>(
        `${apiServer!.url}/sessions/%252F/mcp-resources`,
      )
      assert.equal(invalidRoute.response.status, 400)

      const wrongMethod = await jsonRequest<ErrorPayload>(
        `${apiServer!.url}/sessions/${session.id}/mcp-resources`,
        { method: 'POST' },
      )
      assert.equal(wrongMethod.response.status, 405)
      assert.equal(wrongMethod.response.headers.get('allow'), 'GET')
    })

    await t.test('lifecycle and client cancellation map safely without materializing files', async () => {
      const beforeImports = await jsonRequest<ImportsPayload>(
        `${apiServer!.url}/sessions/${session.id}/mcp-resources/imports`,
      )
      const beforeFiles = await jsonRequest<FilesPayload>(
        `${apiServer!.url}/sessions/${session.id}/files`,
      )

      const lifecycleCancelledRequest = importRequest(
        apiServer!.url,
        session.id,
        stdioServerId,
        `${resourceRoot}/slow`,
      ) as Promise<JsonResponse<unknown>> as Promise<JsonResponse<ErrorPayload>>
      const activeStdioPid = manager.getSnapshot(stdioServerId)?.processId
      assert.ok(activeStdioPid)
      await waitForLifecycle(stdioLifecyclePath, 'read_started', activeStdioPid)
      const disabled = await settingsService.setServerEnabled(stdioServerId, false)
      assert.equal(disabled.status, 'disabled')
      const lifecycleCancelled = await lifecycleCancelledRequest
      assert.equal(lifecycleCancelled.response.status, 408)
      assert.equal(lifecycleCancelled.body.code, 'cancelled')
      assert.equal(lifecycleCancelled.body.retryable, false)
      assertNoStore(lifecycleCancelled.response)
      assertRedacted(lifecycleCancelled.text)
      const reenabled = await settingsService.setServerEnabled(stdioServerId, true)
      assert.equal(reenabled.status, 'connected')

      const controller = new AbortController()
      const request = importRequest(
        apiServer!.url,
        session.id,
        httpServerId,
        `${resourceRoot}/slow`,
        undefined,
        controller.signal,
      )
      const timer = setTimeout(() => controller.abort(), 40)
      try {
        await assert.rejects(
          request,
          (error: unknown) => error instanceof Error && error.name === 'AbortError',
        )
      } finally {
        clearTimeout(timer)
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
      const afterImports = await jsonRequest<ImportsPayload>(
        `${apiServer!.url}/sessions/${session.id}/mcp-resources/imports`,
      )
      const afterFiles = await jsonRequest<FilesPayload>(
        `${apiServer!.url}/sessions/${session.id}/files`,
      )
      assert.equal(afterImports.body.imports.length, beforeImports.body.imports.length)
      assert.equal(afterFiles.body.files.length, beforeFiles.body.files.length)
      assert.equal(manager.isConnected(httpServerId), true)
    })

    await t.test('API restart rehydrates live transports and preserves imports and file provenance', async () => {
      const previousStdioPid = manager.getSnapshot(stdioServerId)?.processId
      assert.ok(previousStdioPid)
      await apiServer!.close()
      apiServer = null
      await waitForLifecycle(stdioLifecyclePath, 'stopped', previousStdioPid)
      assert.equal(isProcessAlive(previousStdioPid), false)

      const httpPort = Number(new URL(httpFixture!.url).port)
      await stopChild(httpFixture!.child, httpFixture!.pid)
      await waitForLifecycle(httpFixture!.lifecyclePath, 'stopped', httpFixture!.pid)
      httpFixture = await startHttpFixture(httpLifecyclePath, httpPort)
      await waitForLifecycle(httpLifecyclePath, 'ready', httpFixture.pid)

      apiServer = await startResourcesApi({
        workspacePath,
        sessionStore,
        settingsService,
        providerSettingsService,
      })
      assert.equal((await settingsService.getServer(stdioServerId))?.status, 'connected')
      assert.equal((await settingsService.getServer(httpServerId))?.status, 'connected')
      const restartedStdioPid = manager.getSnapshot(stdioServerId)?.processId
      assert.ok(restartedStdioPid)
      assert.notEqual(restartedStdioPid, previousStdioPid)

      const imports = await jsonRequest<ImportsPayload>(
        `${apiServer.url}/sessions/${session.id}/mcp-resources/imports`,
      )
      const files = await jsonRequest<FilesPayload>(
        `${apiServer.url}/sessions/${session.id}/files`,
      )
      assert.equal(imports.body.imports.length, 4)
      assert.equal(files.body.files.length, 4)
      assert.ok(files.body.files.every((file) => file.source?.kind === 'mcp-resource'))
      assert.equal(
        (await listCatalog({
          apiUrl: apiServer.url,
          sessionId: session.id,
          serverId: httpServerId,
          limit: 4,
        })).length,
        8,
      )
    })

    await t.test('global disable removes catalog entries and rejects new imports', async () => {
      const activeStdioPid = manager.getSnapshot(stdioServerId)?.processId
      assert.ok(activeStdioPid)
      const disabled = await settingsService.setServerEnabled(stdioServerId, false)
      assert.equal(disabled.status, 'disabled')
      await waitForLifecycle(stdioLifecyclePath, 'stopped', activeStdioPid)

      const globalCatalog = await listCatalog({
        apiUrl: apiServer!.url,
        sessionId: session.id,
        limit: 5,
      })
      assert.equal(globalCatalog.length, 8)
      assert.ok(globalCatalog.every((resource) => resource.serverId === httpServerId))

      const filtered = await jsonRequest<ErrorPayload>(
        `${apiServer!.url}/sessions/${session.id}/mcp-resources?serverId=${stdioServerId}`,
      )
      assert.equal(filtered.response.status, 409)
      assert.equal(filtered.body.code, 'server_disabled')
      assertNoStore(filtered.response)

      const rejectedImport = await importRequest(
        apiServer!.url,
        session.id,
        stdioServerId,
        `${resourceRoot}/text`,
      ) as JsonResponse<unknown> as JsonResponse<ErrorPayload>
      assert.equal(rejectedImport.response.status, 409)
      assert.equal(rejectedImport.body.code, 'server_disabled')
      assertRedacted(rejectedImport.text)
    })
  } finally {
    await apiServer?.close().catch(() => undefined)
    await settingsService.closeAll().catch(() => undefined)
    if (httpFixture) {
      await stopChild(httpFixture.child, httpFixture.pid)
      await waitForLifecycle(httpFixture.lifecyclePath, 'stopped', httpFixture.pid)
        .catch(() => undefined)
    }
    for (const event of readLifecycle(stdioLifecyclePath)) {
      if (event.event === 'ready' && isProcessAlive(event.pid)) {
        process.kill(event.pid, 'SIGKILL')
      }
    }
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
