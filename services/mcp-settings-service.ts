import { whenDefined } from '../core/optional-properties.js'
import { createHash, randomUUID } from 'node:crypto'
import * as fsSync from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  McpClientManager,
  McpClientManagerError,
  type McpConnectionSecrets,
  type McpConnectionSnapshot,
  type McpClientElicitationHandler,
} from '../domains/mcp/mcp-client-manager.js'
import type { McpSanitizedErrorCode } from '../domains/mcp/mcp-runtime.js'
import type {
  McpAuthorizationGuard,
  McpAuthorizationRevocationCode,
} from '../domains/mcp/mcp-parent-broker.js'
import {
  MCP_SETTINGS_SCHEMA_VERSION,
  normalizeMcpAgentPath,
  normalizeMcpCapabilityAliases,
  normalizeMcpServerInput,
  redactMcpServer,
  type McpAgentGrant,
  type McpConnectionStatus,
  type McpEncryptedSecret,
  type McpEncryptedSecretMap,
  type McpNegotiatedCapabilities,
  type McpOAuthAuthorizationStatus,
  type McpServerInput,
  type McpServerSettings,
  type McpServerView,
  type McpSettingsFile,
  type McpStreamableHttpAuthenticationInput,
  type McpStreamableHttpAuthenticationSettings,
  type McpTransportInput,
  type McpTransportSettings,
  type McpSecretInputMap,
} from '../domains/mcp/mcp-settings.js'
import { isSafePathSegment } from '../core/path-safety.js'

const MAX_SERVER_NAME_LENGTH = 160
const MAX_COMMAND_LENGTH = 4_096
const MAX_ARGUMENT_LENGTH = 16_384
const MAX_ARGUMENT_COUNT = 256
const MAX_SECRET_LENGTH = 65_536
const MAX_SECRET_COUNT = 256
const MAX_URL_LENGTH = 4_096
const MAX_SCOPE_LENGTH = 256
const STDIO_TRUST_DIGEST_PATTERN = /^[a-f0-9]{64}$/
const FORBIDDEN_HTTP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'mcp-session-id',
  'transfer-encoding',
])
const CONNECTION_STATUSES = new Set<McpConnectionStatus>([
  'unvalidated',
  'connecting',
  'connected',
  'disconnected',
  'error',
  'disabled',
  'revoked',
])
const OAUTH_STATUSES = new Set<McpOAuthAuthorizationStatus>([
  'not-authorized',
  'authorization-required',
  'authorized',
  'expired',
  'error',
])

export interface McpSecretCodec {
  encrypt(value: string): string
  decrypt(value: string): string
}

export interface McpSettingsServiceOptions {
  readonly storagePath?: string
  readonly secretCodec?: McpSecretCodec
  readonly clientManager?: McpClientManager
  readonly now?: () => Date
}

export interface McpServerValidationOptions {
  readonly stdioTrustAcknowledged?: boolean
}

export type {
  McpAuthorizationCompletionFence,
  McpAuthorizationGuard,
  McpAuthorizationRevocationCode,
} from '../domains/mcp/mcp-parent-broker.js'

interface MutableMcpAuthorizationGuard {
  readonly agentPath: string
  readonly serverId: string
  readonly controller: AbortController
  revocationCode: McpAuthorizationRevocationCode | null
  pendingRevocationCode: McpAuthorizationRevocationCode | null
  activeCompletions: number
  completionWaiters: Array<() => void>
  readonly view: McpAuthorizationGuard
}

export class McpSettingsServiceError extends Error {
  readonly code: McpSanitizedErrorCode
  readonly server: McpServerView | undefined

  constructor(
    code: McpSanitizedErrorCode,
    message: string,
    server?: McpServerView,
  ) {
    super(message)
    this.name = 'McpSettingsServiceError'
    this.code = code
    this.server = server
  }
}

export class McpSettingsService {
  private state: McpSettingsFile | null = null
  private loadPromise: Promise<McpSettingsFile> | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly authorizationGuards = new Map<
    string,
    MutableMcpAuthorizationGuard
  >()
  private readonly clientManager: McpClientManager
  private readonly now: () => Date

  constructor(private readonly options: McpSettingsServiceOptions = {}) {
    this.clientManager = options.clientManager ?? new McpClientManager()
    this.now = options.now ?? (() => new Date())
  }

  /** Parent-process broker boundary; never pass this object to a worker or renderer. */
  getBrokerClientManager(): Pick<
    McpClientManager,
    'getSnapshot' | 'callTool'
  > {
    return this.clientManager
  }

  /** Parent-process resource boundary; never pass this object to a worker or renderer. */
  getResourceClientManager(): Pick<
    McpClientManager,
    'isConnected' | 'getSnapshot' | 'readResource'
  > {
    return this.clientManager
  }

  /** Configure parent-owned elicitation before reconnecting persisted servers. */
  async configureElicitationHandler(
    handler: McpClientElicitationHandler | undefined,
  ): Promise<void> {
    await this.revokeAllAuthorizations('server_disabled')
    await this.clientManager.closeAll()
    this.clientManager.setElicitationHandler(handler)
  }

  /**
   * Parent-only execution fence. A broker captures this before transport work so
   * grant/server revocation can abort the request and serialize the final
   * evidence commit ahead of the revocation becoming observable.
   */
  getAuthorizationGuard(
    agentPath: string,
    serverId: string,
  ): McpAuthorizationGuard {
    const normalizedAgentPath = requireAgentPath(agentPath)
    const normalizedServerId = requireAuthorizationServerId(serverId)
    const key = authorizationGuardKey(normalizedAgentPath, normalizedServerId)
    const existing = this.authorizationGuards.get(key)
    if (existing) return existing.view

    const guard = createAuthorizationGuard(
      normalizedAgentPath,
      normalizedServerId,
    )
    this.authorizationGuards.set(key, guard)
    return guard.view
  }

  async listServers(): Promise<McpServerView[]> {
    const state = await this.ensureLoaded()
    return state.servers.map(redactMcpServer)
  }

  async getServer(serverId: string): Promise<McpServerView | null> {
    const state = await this.ensureLoaded()
    const server = state.servers.find((candidate) => candidate.id === serverId)
    return server ? redactMcpServer(server) : null
  }

  async listAgentGrants(): Promise<readonly McpAgentGrant[]> {
    const state = await this.ensureLoaded()
    return state.agentGrants.map((grant) => ({ ...grant }))
  }

  async isAgentGranted(agentPath: string, serverId: string): Promise<boolean> {
    const normalizedAgentPath = requireAgentPath(agentPath)
    const state = await this.ensureLoaded()
    return state.agentGrants.some(
      (grant) =>
        grant.agentPath === normalizedAgentPath &&
        grant.serverId === serverId &&
        grant.enabled,
    )
  }

  async setAgentGrant(
    agentPath: string,
    serverId: string,
    enabled: boolean,
  ): Promise<McpAgentGrant> {
    const normalizedAgentPath = requireAgentPath(agentPath)
    return this.enqueueWrite(async () => {
      const state = await this.ensureLoaded()
      const server = state.servers.find((candidate) => candidate.id === serverId)
      if (!server) throw serviceError('not_found', 'MCP server was not found.')
      if (enabled && !server.enabled) {
        throw serviceError('server_disabled', 'MCP server is globally disabled.')
      }
      if (enabled && server.status !== 'connected') {
        throw serviceError(
          'connection_failed',
          'MCP server must be connected before access can be granted.',
        )
      }

      const wasEnabled = state.agentGrants.some(
        (candidate) =>
          candidate.agentPath === normalizedAgentPath &&
          candidate.serverId === serverId &&
          candidate.enabled,
      )
      if (!enabled) {
        await this.revokeAuthorization(
          normalizedAgentPath,
          serverId,
          'grant_required',
        )
      }

      const grant: McpAgentGrant = {
        agentPath: normalizedAgentPath,
        serverId,
        enabled,
        updatedAt: this.now().toISOString(),
      }
      const otherGrants = state.agentGrants.filter(
        (candidate) =>
          candidate.agentPath !== normalizedAgentPath ||
          candidate.serverId !== serverId,
      )
      this.state = {
        ...state,
        agentGrants: enabled ? [...otherGrants, grant] : otherGrants,
      }
      await this.persist()
      if (enabled && !wasEnabled) {
        this.resetAuthorization(normalizedAgentPath, serverId)
      }
      return grant
    })
  }

  async deleteAgentGrants(agentPath: string): Promise<number> {
    const normalizedAgentPath = requireAgentPath(agentPath)
    return this.enqueueWrite(async () => {
      const state = await this.ensureLoaded()
      const remaining = state.agentGrants.filter(
        (grant) => grant.agentPath !== normalizedAgentPath,
      )
      const deleted = state.agentGrants.length - remaining.length
      if (deleted === 0) return 0
      const removed = state.agentGrants.filter(
        (grant) => grant.agentPath === normalizedAgentPath,
      )
      await Promise.all(removed.map((grant) =>
        this.revokeAuthorization(
          normalizedAgentPath,
          grant.serverId,
          'grant_required',
        ),
      ))
      this.state = { ...state, agentGrants: remaining }
      await this.persist()
      return deleted
    })
  }

  async saveServer(input: McpServerInput): Promise<McpServerView> {
    return this.saveServerInternal(input, false)
  }

  async updateServer(
    serverId: string,
    input: McpServerInput,
  ): Promise<McpServerView> {
    if (input.id !== undefined && input.id !== serverId) {
      throw serviceError('invalid_request', 'MCP server id cannot be changed.')
    }
    return this.saveServerInternal({ ...input, id: serverId }, true)
  }

  private async saveServerInternal(
    input: McpServerInput,
    requireExisting: boolean,
  ): Promise<McpServerView> {
    return this.enqueueWrite(async () => {
      const state = await this.ensureLoaded()
      const normalized = normalizeMcpServerInput(input)
      validateServerIdentity(normalized.id, normalized.name)
      const existing = normalized.id
        ? state.servers.find((server) => server.id === normalized.id)
        : undefined
      if (requireExisting && !existing) {
        throw serviceError('not_found', 'MCP server was not found.')
      }
      const id = normalized.id ?? randomUUID()
      await this.revokeServerAuthorizations(id, 'server_disabled')
      await this.clientManager.close(id)
      const transport = buildTransportSettings({
        input: normalized.transport,
        rawInput: input.transport,
        ...whenDefined(existing?.transport, (definedValue) => ({ existing: definedValue })),
        encryptSecret: (value) => this.encryptSecret(value),
      })
      const next: McpServerSettings = {
        id,
        name: normalized.name,
        enabled: normalized.enabled,
        capabilityAliases: normalized.capabilityAliases,
        transport,
        status: normalized.enabled ? 'unvalidated' : 'disabled',
        capabilities: emptyCapabilities(),
      }
      this.state = {
        ...state,
        servers: existing
          ? state.servers.map((server) => server.id === id ? next : server)
          : [...state.servers, next],
      }
      await this.persist()
      return redactMcpServer(next)
    })
  }

  async validateServer(
    serverId: string,
    options: McpServerValidationOptions = {},
  ): Promise<McpServerView> {
    const candidate = await this.prepareServerValidation(serverId, options)
    if (!candidate.enabled) {
      throw serviceError('server_disabled', 'MCP server is disabled.')
    }

    await this.revokeServerAuthorizations(serverId, 'server_disabled')

    let snapshot: McpConnectionSnapshot | null = null
    let failure: McpSettingsServiceError | null = null
    try {
      snapshot = await this.clientManager.connect(
        candidate,
        this.resolveConnectionSecrets(candidate),
      )
    } catch (error) {
      failure = sanitizeConnectionFailure(error)
      await this.clientManager.close(serverId)
    }

    const view = await this.enqueueWrite(async () => {
      const state = await this.ensureLoaded()
      const current = state.servers.find((server) => server.id === serverId)
      if (!current) {
        await this.clientManager.close(serverId)
        throw serviceError('not_found', 'MCP server was not found.')
      }
      if (!current.enabled || !sameConnectionConfiguration(current, candidate)) {
        await this.clientManager.close(serverId)
        return redactMcpServer(current)
      }

      const checkedAt = this.now().toISOString()
      const { statusMessage: _statusMessage, ...currentWithoutStatusMessage } = current
      const next: McpServerSettings = snapshot
        ? {
            ...currentWithoutStatusMessage,
            status: 'connected',
            capabilities: snapshot.capabilities,
            lastCheckedAt: checkedAt,
          }
        : {
            ...current,
            status: 'error',
            capabilities: emptyCapabilities(),
            lastCheckedAt: checkedAt,
            statusMessage: failure?.message ?? 'MCP server connection failed.',
          }
      this.replaceServer(state, next)
      await this.persist()
      return redactMcpServer(next)
    })
    if (failure && view.status === 'error') {
      throw serviceError(failure.code, failure.message, view)
    }
    if (view.status === 'connected') this.resetServerAuthorizations(serverId)
    return view
  }

  async setServerEnabled(serverId: string, enabled: boolean): Promise<McpServerView> {
    await this.requireServer(serverId)
    await this.revokeServerAuthorizations(serverId, 'server_disabled')
    await this.clientManager.close(serverId)
    const view = await this.enqueueWrite(async () => {
      const state = await this.ensureLoaded()
      const current = state.servers.find((server) => server.id === serverId)
      if (!current) throw serviceError('not_found', 'MCP server was not found.')
      const { statusMessage: _statusMessage, ...currentWithoutStatusMessage } = current
      const next: McpServerSettings = {
        ...currentWithoutStatusMessage,
        enabled,
        status: enabled ? 'unvalidated' : 'disabled',
      }
      this.replaceServer(state, next)
      await this.persist()
      return redactMcpServer(next)
    })
    return enabled ? this.validateServer(serverId) : view
  }

  async deleteServer(serverId: string): Promise<boolean> {
    await this.revokeServerAuthorizations(serverId, 'server_disabled')
    await this.clientManager.close(serverId)
    return this.enqueueWrite(async () => {
      const state = await this.ensureLoaded()
      if (!state.servers.some((server) => server.id === serverId)) return false
      this.state = {
        ...state,
        servers: state.servers.filter((server) => server.id !== serverId),
        agentGrants: state.agentGrants.filter((grant) => grant.serverId !== serverId),
      }
      await this.persist()
      return true
    })
  }

  async hydrate(): Promise<void> {
    const state = await this.markUntrustedStdioServersUnvalidated()
    await this.revokeAllAuthorizations('server_disabled')
    await this.clientManager.closeAll()
    const reconnectable = state.servers.filter(
      (candidate) => candidate.enabled && candidate.status === 'connected',
    )
    await Promise.all(reconnectable.map(async (candidate) => {
      let snapshot: McpConnectionSnapshot | null = null
      let failure: McpSettingsServiceError | null = null
      try {
        snapshot = await this.clientManager.connect(
          candidate,
          this.resolveConnectionSecrets(candidate),
        )
      } catch (error) {
        failure = sanitizeConnectionFailure(error)
        await this.clientManager.close(candidate.id)
      }
      await this.recordHydrationResult(candidate, snapshot, failure)
      if (snapshot) this.resetServerAuthorizations(candidate.id)
    }))
  }

  async closeAll(): Promise<void> {
    await this.revokeAllAuthorizations('server_disabled')
    await this.clientManager.closeAll()
  }

  private async revokeAuthorization(
    agentPath: string,
    serverId: string,
    code: McpAuthorizationRevocationCode,
  ): Promise<void> {
    const guard = this.authorizationGuards.get(
      authorizationGuardKey(agentPath, serverId),
    )
    if (!guard) return
    if (!guard.revocationCode && !guard.pendingRevocationCode) {
      guard.pendingRevocationCode = code
    }
    await waitForAuthorizationCompletions(guard)
    if (!guard.revocationCode) {
      guard.revocationCode = guard.pendingRevocationCode ?? code
    }
    guard.pendingRevocationCode = null
    if (!guard.controller.signal.aborted) guard.controller.abort()
  }

  private async revokeServerAuthorizations(
    serverId: string,
    code: McpAuthorizationRevocationCode,
  ): Promise<void> {
    await Promise.all(
      [...this.authorizationGuards.values()]
        .filter((guard) => guard.serverId === serverId)
        .map((guard) => this.revokeAuthorization(
          guard.agentPath,
          guard.serverId,
          code,
        )),
    )
  }

  private async revokeAllAuthorizations(
    code: McpAuthorizationRevocationCode,
  ): Promise<void> {
    await Promise.all(
      [...this.authorizationGuards.values()].map((guard) =>
        this.revokeAuthorization(guard.agentPath, guard.serverId, code),
      ),
    )
  }

  private resetAuthorization(agentPath: string, serverId: string): void {
    const key = authorizationGuardKey(agentPath, serverId)
    const guard = this.authorizationGuards.get(key)
    if (guard?.controller.signal.aborted && guard.activeCompletions === 0) {
      this.authorizationGuards.delete(key)
    }
  }

  private resetServerAuthorizations(serverId: string): void {
    for (const guard of this.authorizationGuards.values()) {
      if (guard.serverId === serverId) {
        this.resetAuthorization(guard.agentPath, serverId)
      }
    }
  }

  private async recordHydrationResult(
    candidate: McpServerSettings,
    snapshot: McpConnectionSnapshot | null,
    failure: McpSettingsServiceError | null,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.ensureLoaded()
      const current = state.servers.find((server) => server.id === candidate.id)
      if (!current || !sameConnectionConfiguration(current, candidate)) return
      const checkedAt = this.now().toISOString()
      const { statusMessage: _statusMessage, ...currentWithoutStatusMessage } = current
      const next: McpServerSettings = snapshot
        ? {
            ...currentWithoutStatusMessage,
            status: 'connected',
            capabilities: snapshot.capabilities,
            lastCheckedAt: checkedAt,
          }
        : {
            ...current,
            status: 'error',
            capabilities: emptyCapabilities(),
            lastCheckedAt: checkedAt,
            statusMessage: failure?.message ?? 'MCP server connection failed.',
          }
      this.replaceServer(state, next)
      await this.persist()
    })
  }

  private replaceServer(state: McpSettingsFile, next: McpServerSettings): void {
    this.state = {
      ...state,
      servers: state.servers.map((server) => server.id === next.id ? next : server),
    }
  }

  private async requireServer(serverId: string): Promise<McpServerSettings> {
    const state = await this.ensureLoaded()
    const server = state.servers.find((candidate) => candidate.id === serverId)
    if (!server) throw serviceError('not_found', 'MCP server was not found.')
    return server
  }

  private async prepareServerValidation(
    serverId: string,
    options: McpServerValidationOptions,
  ): Promise<McpServerSettings> {
    return this.enqueueWrite(async () => {
      const state = await this.ensureLoaded()
      const server = state.servers.find((candidate) => candidate.id === serverId)
      if (!server) throw serviceError('not_found', 'MCP server was not found.')
      if (!server.enabled) return server
      if (server.transport.type !== 'stdio' || isStdioConfigurationTrusted(server)) {
        return server
      }
      if (options.stdioTrustAcknowledged !== true) {
        throw serviceError(
          'configuration_invalid',
          'MCP stdio command trust acknowledgement is required.',
        )
      }
      const trusted: McpServerSettings = {
        ...server,
        stdioTrustDigest: stdioConfigurationDigest(server.transport),
      }
      this.replaceServer(state, trusted)
      await this.persist()
      return trusted
    })
  }

  private async markUntrustedStdioServersUnvalidated(): Promise<McpSettingsFile> {
    return this.enqueueWrite(async () => {
      const state = await this.ensureLoaded()
      let changed = false
      const servers = state.servers.map((server): McpServerSettings => {
        if (
          server.transport.type !== 'stdio' ||
          isStdioConfigurationTrusted(server) ||
          !server.enabled ||
          server.status === 'unvalidated'
        ) {
          return server
        }
        changed = true
        const {
          lastCheckedAt: _lastCheckedAt,
          statusMessage: _statusMessage,
          ...serverWithoutValidation
        } = server
        return {
          ...serverWithoutValidation,
          status: 'unvalidated',
          capabilities: emptyCapabilities(),
        }
      })
      if (!changed) return state
      this.state = { ...state, servers }
      await this.persist()
      return this.state
    })
  }

  private resolveConnectionSecrets(server: McpServerSettings): McpConnectionSecrets {
    if (server.transport.type === 'stdio') {
      return { environment: this.decryptSecretMap(server.transport.encryptedEnvironment) }
    }
    if (server.transport.authentication.type !== 'secret-headers') {
      return { headers: {} }
    }
    const headers = this.decryptSecretMap(server.transport.encryptedHeaders)
    if (Object.values(headers).some((value) => /[\r\n]/.test(value))) {
      throw serviceError(
        'configuration_invalid',
        'Stored MCP HTTP headers are invalid.',
      )
    }
    return { headers }
  }

  private encryptSecret(value: string): McpEncryptedSecret {
    if (!this.options.secretCodec) {
      throw serviceError(
        'configuration_invalid',
        'Secure MCP credential storage is unavailable.',
      )
    }
    try {
      const ciphertext = this.options.secretCodec.encrypt(value)
      if (
        !ciphertext ||
        ciphertext.length > MAX_SECRET_LENGTH * 2 ||
        ciphertext.includes('\0')
      ) {
        throw new Error('invalid encrypted secret')
      }
      return {
        format: 'opaque-platform-ciphertext',
        ciphertext,
      }
    } catch {
      throw serviceError(
        'configuration_invalid',
        'Secure MCP credential storage failed.',
      )
    }
  }

  private decryptSecretMap(secrets: McpEncryptedSecretMap): Record<string, string> {
    if (Object.keys(secrets).length === 0) return {}
    const { secretCodec } = this.options
    if (!secretCodec) {
      throw serviceError(
        'configuration_invalid',
        'Secure MCP credential storage is unavailable.',
      )
    }
    try {
      const decrypted = Object.fromEntries(
        Object.entries(secrets).map(([key, secret]) => [
          key,
          secretCodec.decrypt(secret.ciphertext),
        ]),
      )
      if (
        Object.values(decrypted).some((value) =>
          !value || value.length > MAX_SECRET_LENGTH || value.includes('\0'),
        )
      ) {
        throw new Error('invalid decrypted secret')
      }
      return decrypted
    } catch {
      throw serviceError(
        'configuration_invalid',
        'Stored MCP credentials could not be decrypted.',
      )
    }
  }

  private async ensureLoaded(): Promise<McpSettingsFile> {
    if (this.state) return this.state
    if (!this.loadPromise) this.loadPromise = this.loadSettings()
    try {
      this.state = await this.loadPromise
      return this.state
    } finally {
      this.loadPromise = null
    }
  }

  private async loadSettings(): Promise<McpSettingsFile> {
    if (!this.options.storagePath) return emptySettings()
    try {
      const content = await fs.readFile(this.options.storagePath, 'utf8')
      return parseSettingsFile(content)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySettings()
      if (error instanceof McpSettingsServiceError) throw error
      throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
    }
  }

  private async persist(): Promise<void> {
    if (!this.options.storagePath || !this.state) return
    await fs.mkdir(path.dirname(this.options.storagePath), {
      recursive: true,
      mode: 0o700,
    })
    const temporaryPath = `${this.options.storagePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      await fs.rename(temporaryPath, this.options.storagePath)
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.writeQueue.then(operation)
    this.writeQueue = running.then(() => undefined, () => undefined)
    return running
  }
}

function buildTransportSettings(params: {
  input: McpTransportInput
  rawInput: McpTransportInput
  existing?: McpTransportSettings
  encryptSecret: (value: string) => McpEncryptedSecret
}): McpTransportSettings {
  if (params.input.type === 'stdio') {
    const existingSecrets = params.existing?.type === 'stdio'
      ? params.existing.encryptedEnvironment
      : {}
    return {
      type: 'stdio',
      command: normalizeStdioCommand(params.input.command),
      args: normalizeStdioArgs(params.input.args ?? []),
      ...(params.input.cwd ? { cwd: normalizeStdioCwd(params.input.cwd) } : {}),
      encryptedEnvironment: applySecretPatch({
        existing: existingSecrets,
        patch: params.input.secretEnvironment,
        normalizeKey: normalizeEnvironmentKey,
        encryptSecret: params.encryptSecret,
      }),
    }
  }

  const existingHeaders = params.existing?.type === 'streamable-http'
    ? params.existing.encryptedHeaders
    : {}
  const authenticationInput = resolveAuthenticationInput(params)
  return {
    type: 'streamable-http',
    url: normalizeHttpUrl(params.input.url),
    encryptedHeaders: applySecretPatch({
      existing: existingHeaders,
      patch: params.input.secretHeaders,
      normalizeKey: normalizeHeaderName,
      encryptSecret: params.encryptSecret,
      validateValue: validateHeaderSecretValue,
    }),
    authentication: buildAuthenticationSettings(
      authenticationInput,
      params.existing?.type === 'streamable-http'
        ? params.existing.authentication
        : undefined,
      params.encryptSecret,
    ),
  }
}

function resolveAuthenticationInput(params: {
  input: McpTransportInput
  rawInput: McpTransportInput
  existing?: McpTransportSettings
}): McpStreamableHttpAuthenticationInput {
  if (params.input.type !== 'streamable-http') return { type: 'none' }
  if (
    params.rawInput.type === 'streamable-http' &&
    params.rawInput.authentication === undefined &&
    params.existing?.type === 'streamable-http'
  ) {
    return authenticationSettingsAsInput(params.existing.authentication)
  }
  return params.input.authentication ?? { type: 'none' }
}

function authenticationSettingsAsInput(
  settings: McpStreamableHttpAuthenticationSettings,
): McpStreamableHttpAuthenticationInput {
  if (settings.type !== 'oauth') return settings
  return {
    type: 'oauth',
    ...(settings.authorizationServerUrl
      ? { authorizationServerUrl: settings.authorizationServerUrl }
      : {}),
    ...(settings.clientId ? { clientId: settings.clientId } : {}),
    scopes: [...settings.scopes],
  }
}

function buildAuthenticationSettings(
  input: McpStreamableHttpAuthenticationInput,
  existing: McpStreamableHttpAuthenticationSettings | undefined,
  encryptSecret: (value: string) => McpEncryptedSecret,
): McpStreamableHttpAuthenticationSettings {
  if (input.type !== 'oauth') return input
  const encryptedCredentials = applySecretPatch({
    existing: existing?.type === 'oauth' ? existing.encryptedCredentials : {},
    patch: input.secretCredentials,
    normalizeKey: normalizeCredentialKey,
    encryptSecret,
  })
  return {
    type: 'oauth',
    ...(input.authorizationServerUrl
      ? { authorizationServerUrl: normalizeHttpUrl(input.authorizationServerUrl) }
      : {}),
    ...(input.clientId ? { clientId: normalizeClientId(input.clientId) } : {}),
    scopes: normalizeScopes(input.scopes ?? []),
    status: 'authorization-required',
    encryptedCredentials,
  }
}

function applySecretPatch(params: {
  existing: McpEncryptedSecretMap
  patch: McpSecretInputMap | undefined
  normalizeKey: (key: string) => string
  encryptSecret: (value: string) => McpEncryptedSecret
  validateValue?: (value: string) => void
}): McpEncryptedSecretMap {
  if (!params.patch) return { ...params.existing }
  if (Object.keys(params.patch).length > MAX_SECRET_COUNT) {
    throw serviceError('invalid_request', 'Too many MCP secret fields were provided.')
  }
  const next: Record<string, McpEncryptedSecret> = { ...params.existing }
  const seen = new Set<string>()
  for (const [rawKey, operation] of Object.entries(params.patch)) {
    const key = params.normalizeKey(rawKey)
    if (seen.has(key)) {
      throw serviceError('invalid_request', 'MCP secret field names must be unique.')
    }
    seen.add(key)
    if (operation.operation === 'remove') {
      delete next[key]
      continue
    }
    if (operation.operation === 'preserve') {
      if (!next[key]) {
        throw serviceError('invalid_request', 'MCP secret field cannot be preserved.')
      }
      continue
    }
    validateSecretValue(operation.value)
    params.validateValue?.(operation.value)
    next[key] = params.encryptSecret(operation.value)
  }
  return next
}

function normalizeStdioCommand(value: string): string {
  const command = value.trim()
  if (!command || command.length > MAX_COMMAND_LENGTH || /[\0\r\n]/.test(command)) {
    throw serviceError('invalid_request', 'MCP stdio command is invalid.')
  }
  if (path.isAbsolute(command)) {
    try {
      const realPath = fsSync.realpathSync(command)
      if (!fsSync.statSync(realPath).isFile()) throw new Error('not a file')
      return realPath
    } catch {
      throw serviceError('invalid_request', 'MCP stdio command is invalid.')
    }
  }
  if (command.includes('/') || command.includes('\\')) {
    throw serviceError('invalid_request', 'MCP stdio command is invalid.')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(command)) {
    throw serviceError('invalid_request', 'MCP stdio command is invalid.')
  }
  return command
}

function normalizeStdioArgs(args: readonly string[]): readonly string[] {
  if (args.length > MAX_ARGUMENT_COUNT) {
    throw serviceError('invalid_request', 'Too many MCP stdio arguments were provided.')
  }
  return args.map((argument) => {
    if (
      typeof argument !== 'string' ||
      argument.length > MAX_ARGUMENT_LENGTH ||
      /[\0\r\n]/.test(argument)
    ) {
      throw serviceError('invalid_request', 'MCP stdio argument is invalid.')
    }
    if (containsStdioArgumentCredential(argument)) {
      throw serviceError(
        'invalid_request',
        'MCP stdio credentials must use secret environment variables.',
      )
    }
    return argument
  })
}

function containsStdioArgumentCredential(argument: string): boolean {
  if (/^--(?:token|api-key|secret|password|credential)(?:=|$)/i.test(argument)) {
    return true
  }
  return /(?:^|=)[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i.test(argument)
}

function normalizeStdioCwd(value: string): string {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw serviceError('invalid_request', 'MCP stdio working directory is invalid.')
  }
  try {
    const realPath = fsSync.realpathSync(value)
    if (!fsSync.statSync(realPath).isDirectory()) throw new Error('not a directory')
    return realPath
  } catch {
    throw serviceError('invalid_request', 'MCP stdio working directory is invalid.')
  }
}

function normalizeEnvironmentKey(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw serviceError('invalid_request', 'MCP environment variable name is invalid.')
  }
  return value
}

function normalizeHeaderName(value: string): string {
  const name = value.trim().toLowerCase()
  if (
    !name ||
    FORBIDDEN_HTTP_HEADERS.has(name) ||
    !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)
  ) {
    throw serviceError('invalid_request', 'MCP HTTP header name is invalid.')
  }
  return name
}

function normalizeCredentialKey(value: string): string {
  const key = value.trim()
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)) {
    throw serviceError('invalid_request', 'MCP OAuth credential name is invalid.')
  }
  return key
}

function normalizeHttpUrl(value: string): string {
  if (!value || value.length > MAX_URL_LENGTH || /[\0\r\n]/.test(value)) {
    throw serviceError('invalid_request', 'MCP HTTP URL is invalid.')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw serviceError('invalid_request', 'MCP HTTP URL is invalid.')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw serviceError('invalid_request', 'MCP HTTP URL is invalid.')
  }
  return url.toString()
}

function normalizeClientId(value: string): string {
  const clientId = value.trim()
  if (!clientId || clientId.length > 512 || /[\0\r\n]/.test(clientId)) {
    throw serviceError('invalid_request', 'MCP OAuth client metadata is invalid.')
  }
  return clientId
}

function normalizeScopes(scopes: readonly string[]): readonly string[] {
  const normalized = scopes.map((scope) => scope.trim())
  if (
    normalized.some((scope) =>
      !scope || scope.length > MAX_SCOPE_LENGTH || /[\s\0]/.test(scope),
    )
  ) {
    throw serviceError('invalid_request', 'MCP OAuth scope is invalid.')
  }
  return [...new Set(normalized)].sort()
}

function validateSecretValue(value: string): void {
  if (!value || value.length > MAX_SECRET_LENGTH || value.includes('\0')) {
    throw serviceError('invalid_request', 'MCP secret value is invalid.')
  }
}

function validateHeaderSecretValue(value: string): void {
  if (/[\r\n]/.test(value)) {
    throw serviceError('invalid_request', 'MCP HTTP header value is invalid.')
  }
}

function validateServerIdentity(id: string | undefined, name: string): void {
  if (id !== undefined && !isSafePathSegment(id)) {
    throw serviceError('invalid_request', 'MCP server id is invalid.')
  }
  if (!name || name.length > MAX_SERVER_NAME_LENGTH || /[\0\r\n]/.test(name)) {
    throw serviceError('invalid_request', 'MCP server name is invalid.')
  }
}

function parseSettingsFile(content: string): McpSettingsFile {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  const record = asRecord(value)
  if (record?.version !== MCP_SETTINGS_SCHEMA_VERSION) {
    throw serviceError('configuration_invalid', 'MCP settings version is unsupported.')
  }
  if (!Array.isArray(record.servers) || !Array.isArray(record.agentGrants)) {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  const servers = record.servers.map((server) =>
    parsePersistedConfiguration(() => parsePersistedServer(server)),
  )
  const serverIds = new Set(servers.map((server) => server.id))
  if (serverIds.size !== servers.length) {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  const agentGrants = record.agentGrants.map((grant) =>
    parsePersistedConfiguration(() => parsePersistedGrant(grant)),
  )
  const grantKeys = new Set(
    agentGrants.map((grant) => `${grant.agentPath}\0${grant.serverId}`),
  )
  if (
    grantKeys.size !== agentGrants.length ||
    agentGrants.some((grant) => !serverIds.has(grant.serverId))
  ) {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  return {
    version: MCP_SETTINGS_SCHEMA_VERSION,
    servers,
    agentGrants,
  }
}

function parsePersistedServer(value: unknown): McpServerSettings {
  const record = asRecord(value)
  if (
    !record ||
    typeof record.id !== 'string' ||
    !isSafePathSegment(record.id) ||
    typeof record.name !== 'string' ||
    typeof record.enabled !== 'boolean' ||
    typeof record.status !== 'string' ||
    !CONNECTION_STATUSES.has(record.status as McpConnectionStatus)
  ) {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  validateServerIdentity(record.id, record.name)
  const status = record.status as McpConnectionStatus
  if ((!record.enabled && status !== 'disabled') || (record.enabled && status === 'disabled')) {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  const aliases = Array.isArray(record.capabilityAliases)
    ? normalizeMcpCapabilityAliases(record.capabilityAliases.map(parseAliasInput))
    : []
  const transport = parsePersistedTransport(record.transport)
  if (
    record.stdioTrustDigest !== undefined &&
    (
      typeof record.stdioTrustDigest !== 'string' ||
      !STDIO_TRUST_DIGEST_PATTERN.test(record.stdioTrustDigest)
    )
  ) {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  return {
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    capabilityAliases: aliases,
    transport,
    ...(transport.type === 'stdio' && typeof record.stdioTrustDigest === 'string'
      ? { stdioTrustDigest: record.stdioTrustDigest }
      : {}),
    status,
    capabilities: parseCapabilities(record.capabilities),
    ...(typeof record.lastCheckedAt === 'string'
      ? { lastCheckedAt: normalizeTimestamp(record.lastCheckedAt) }
      : {}),
    ...(safePersistedStatusMessage(status)
      ? { ...whenDefined(safePersistedStatusMessage(status), (statusMessage) => ({ statusMessage })) }
      : {}),
  }
}

function parsePersistedTransport(value: unknown): McpTransportSettings {
  const record = asRecord(value)
  if (record?.type === 'stdio') {
    if (
      typeof record.command !== 'string' ||
      !Array.isArray(record.args) ||
      record.args.some((argument) => typeof argument !== 'string') ||
      (record.cwd !== undefined && typeof record.cwd !== 'string')
    ) {
      throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
    }
    return {
      type: 'stdio',
      command: normalizeStdioCommand(record.command),
      args: normalizeStdioArgs(record.args as string[]),
      ...(typeof record.cwd === 'string'
        ? { cwd: normalizeStdioCwd(record.cwd) }
        : {}),
      encryptedEnvironment: parseEncryptedMap(
        record.encryptedEnvironment,
        normalizeEnvironmentKey,
      ),
    }
  }
  if (record?.type === 'streamable-http' && typeof record.url === 'string') {
    return {
      type: 'streamable-http',
      url: normalizeHttpUrl(record.url),
      encryptedHeaders: parseEncryptedMap(record.encryptedHeaders, normalizeHeaderName),
      authentication: parseAuthenticationSettings(record.authentication),
    }
  }
  throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
}

function parseAuthenticationSettings(
  value: unknown,
): McpStreamableHttpAuthenticationSettings {
  const record = asRecord(value)
  if (record?.type === 'none' || record?.type === 'secret-headers') {
    return { type: record.type }
  }
  if (
    record?.type !== 'oauth' ||
    !Array.isArray(record.scopes) ||
    record.scopes.some((scope) => typeof scope !== 'string') ||
    typeof record.status !== 'string' ||
    !OAUTH_STATUSES.has(record.status as McpOAuthAuthorizationStatus)
  ) {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  return {
    type: 'oauth',
    ...(typeof record.authorizationServerUrl === 'string'
      ? { authorizationServerUrl: normalizeHttpUrl(record.authorizationServerUrl) }
      : {}),
    ...(typeof record.clientId === 'string'
      ? { clientId: normalizeClientId(record.clientId) }
      : {}),
    scopes: normalizeScopes(record.scopes as string[]),
    status: 'authorization-required',
    encryptedCredentials: parseEncryptedMap(
      record.encryptedCredentials,
      normalizeCredentialKey,
    ),
  }
}

function parseEncryptedMap(
  value: unknown,
  normalizeKey: (key: string) => string,
): McpEncryptedSecretMap {
  const record = asRecord(value)
  if (!record) throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  if (Object.keys(record).length > MAX_SECRET_COUNT) {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  const entries: Array<[string, McpEncryptedSecret]> = []
  const normalizedKeys = new Set<string>()
  for (const [rawKey, rawSecret] of Object.entries(record)) {
    const secret = asRecord(rawSecret)
    if (
      secret?.format !== 'opaque-platform-ciphertext' ||
      typeof secret.ciphertext !== 'string' ||
      !secret.ciphertext ||
      secret.ciphertext.length > MAX_SECRET_LENGTH * 2 ||
      secret.ciphertext.includes('\0')
    ) {
      throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
    }
    const key = normalizeKey(rawKey)
    if (normalizedKeys.has(key)) {
      throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
    }
    normalizedKeys.add(key)
    entries.push([
      key,
      { format: 'opaque-platform-ciphertext', ciphertext: secret.ciphertext },
    ])
  }
  return Object.fromEntries(entries)
}

function parsePersistedGrant(value: unknown): McpAgentGrant {
  const record = asRecord(value)
  const agentPath = typeof record?.agentPath === 'string'
    ? normalizeMcpAgentPath(record.agentPath)
    : null
  if (
    !agentPath ||
    typeof record?.serverId !== 'string' ||
    !isSafePathSegment(record.serverId) ||
    typeof record.enabled !== 'boolean'
  ) {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  return {
    agentPath,
    serverId: record.serverId,
    enabled: record.enabled,
    ...(typeof record.updatedAt === 'string'
      ? { updatedAt: normalizeTimestamp(record.updatedAt) }
      : {}),
  }
}

function parseAliasInput(value: unknown): {
  capability: string
  access?: 'read' | 'write' | 'any'
} {
  const record = asRecord(value)
  if (
    !record ||
    typeof record.capability !== 'string' ||
    (record.access !== undefined &&
      record.access !== 'read' &&
      record.access !== 'write' &&
      record.access !== 'any')
  ) {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  return {
    capability: record.capability,
    ...(record.access ? { access: record.access } : {}),
  }
}

function parseCapabilities(value: unknown): McpNegotiatedCapabilities {
  const record = asRecord(value)
  if (!record || typeof record.logging !== 'boolean') {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  const tools = parseBooleanCapability(record.tools, ['listChanged'])
  const resources = parseBooleanCapability(record.resources, ['listChanged', 'subscribe'])
  const prompts = parseBooleanCapability(record.prompts, ['listChanged'])
  return {
    ...(tools ? { tools } : {}),
    ...(resources ? { resources } : {}),
    ...(prompts ? { prompts } : {}),
    logging: record.logging,
  } as McpNegotiatedCapabilities
}

function parseBooleanCapability(
  value: unknown,
  keys: readonly string[],
): Record<string, boolean> | null {
  if (value === undefined) return null
  const record = asRecord(value)
  if (!record || keys.some((key) => typeof record[key] !== 'boolean')) {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  return Object.fromEntries(keys.map((key) => [key, record[key] as boolean]))
}

function sanitizeConnectionFailure(error: unknown): McpSettingsServiceError {
  if (error instanceof McpSettingsServiceError) return error
  if (error instanceof McpClientManagerError) {
    return serviceError(error.code, error.message)
  }
  return serviceError('connection_failed', 'MCP server connection failed.')
}

function sameConnectionConfiguration(
  left: McpServerSettings,
  right: McpServerSettings,
): boolean {
  return left.id === right.id && JSON.stringify(left.transport) === JSON.stringify(right.transport)
}

function isStdioConfigurationTrusted(server: McpServerSettings): boolean {
  return server.transport.type === 'stdio' &&
    server.stdioTrustDigest === stdioConfigurationDigest(server.transport)
}

function stdioConfigurationDigest(
  transport: Extract<McpTransportSettings, { readonly type: 'stdio' }>,
): string {
  const encryptedEnvironment = Object.entries(transport.encryptedEnvironment)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => [key, value.format, value.ciphertext])
  const normalizedConfiguration = JSON.stringify({
    command: transport.command,
    args: transport.args,
    cwd: transport.cwd ?? null,
    encryptedEnvironment,
  })
  return createHash('sha256').update(normalizedConfiguration, 'utf8').digest('hex')
}

function parsePersistedConfiguration<T>(operation: () => T): T {
  try {
    return operation()
  } catch {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
}

function normalizeTimestamp(value: string): string {
  if (value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw serviceError('configuration_invalid', 'MCP settings file is invalid.')
  }
  return value
}

function safePersistedStatusMessage(status: McpConnectionStatus): string | undefined {
  switch (status) {
    case 'error':
      return 'MCP server connection failed.'
    case 'revoked':
      return 'MCP server authorization was revoked.'
    default:
      return undefined
  }
}

function emptySettings(): McpSettingsFile {
  return {
    version: MCP_SETTINGS_SCHEMA_VERSION,
    servers: [],
    agentGrants: [],
  }
}

function emptyCapabilities(): McpNegotiatedCapabilities {
  return { logging: false }
}

function createAuthorizationGuard(
  agentPath: string,
  serverId: string,
): MutableMcpAuthorizationGuard {
  const controller = new AbortController()
  let guard!: MutableMcpAuthorizationGuard
  const view: McpAuthorizationGuard = {
    signal: controller.signal,
    getRevocationCode: () =>
      guard.revocationCode ?? guard.pendingRevocationCode,
    beginCompletion: () => {
      if (
        guard.revocationCode ||
        guard.pendingRevocationCode ||
        guard.controller.signal.aborted
      ) {
        return null
      }
      guard.activeCompletions += 1
      let released = false
      return {
        release() {
          if (released) return
          released = true
          guard.activeCompletions = Math.max(0, guard.activeCompletions - 1)
          if (guard.activeCompletions !== 0) return
          const waiters = guard.completionWaiters.splice(0)
          for (const resolve of waiters) resolve()
        },
      }
    },
  }
  guard = {
    agentPath,
    serverId,
    controller,
    revocationCode: null,
    pendingRevocationCode: null,
    activeCompletions: 0,
    completionWaiters: [],
    view,
  }
  return guard
}

async function waitForAuthorizationCompletions(
  guard: MutableMcpAuthorizationGuard,
): Promise<void> {
  if (guard.activeCompletions === 0) return
  await new Promise<void>((resolve) => guard.completionWaiters.push(resolve))
}

function authorizationGuardKey(agentPath: string, serverId: string): string {
  return JSON.stringify([agentPath, serverId])
}

function requireAuthorizationServerId(serverId: string): string {
  const normalized = serverId.trim()
  if (!isSafePathSegment(normalized)) {
    throw serviceError('invalid_request', 'MCP server id is invalid.')
  }
  return normalized
}

function requireAgentPath(agentPath: string): string {
  const normalized = normalizeMcpAgentPath(agentPath)
  if (!normalized) {
    throw serviceError('invalid_request', 'MCP agent path is invalid.')
  }
  return normalized
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function serviceError(
  code: McpSanitizedErrorCode,
  message: string,
  server?: McpServerView,
): McpSettingsServiceError {
  return new McpSettingsServiceError(code, message, server)
}
