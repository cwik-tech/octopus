import { createHash } from 'node:crypto'

import {
  McpClientManagerError,
  type McpClientManager,
  type McpConnectionSnapshot,
  type McpDiscoveredResource,
} from './mcp-client-manager.js'
import type { McpSanitizedErrorCode } from './mcp-runtime.js'
import type { McpConnectionStatus, McpServerView } from './mcp-settings.js'
import { isSafePathSegment } from '../../core/path-safety.js'
import { isUnknownArray } from '../../core/unknown-array.js'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const DEFAULT_CONTENT_BYTES = 1_048_576
const DEFAULT_AGGREGATE_BYTES = 4_194_304
const MAX_CONFIGURED_CONTENT_BYTES = 16_777_216
const MAX_CONFIGURED_AGGREGATE_BYTES = 67_108_864
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const MAX_REQUEST_TIMEOUT_MS = 60_000
const MAX_RESOURCE_COUNT = 10_000
const MAX_RESOURCE_CONTENTS = 64
const MAX_SERVER_ID_LENGTH = 160
const MAX_SERVER_NAME_LENGTH = 160
const MAX_RESOURCE_NAME_LENGTH = 512
const MAX_DESCRIPTION_LENGTH = 4_096
const MAX_URI_LENGTH = 4_096
const MAX_MIME_TYPE_LENGTH = 256
const MAX_CURSOR_LENGTH = 1_024
const CURSOR_VERSION = 1

const CONNECTION_STATUSES = new Set<McpConnectionStatus>([
  'unvalidated',
  'connecting',
  'connected',
  'disconnected',
  'error',
  'disabled',
  'revoked',
])
const FORBIDDEN_URI_SCHEMES = new Set(['data:', 'javascript:', 'vbscript:'])
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'text/calendar',
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
])
const BINARY_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
])
const BLOCKED_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/ecmascript',
  'text/ecmascript',
  'application/x-sh',
  'application/x-executable',
  'application/vnd.microsoft.portable-executable',
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/octet-stream',
])
const MIME_TOKEN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export type McpResourceMimeDisposition =
  | 'text'
  | 'binary'
  | 'blocked'
  | 'unknown'

export interface McpResourceDescriptor {
  readonly id: string
  readonly serverId: string
  readonly serverName: string
  readonly uri: string
  readonly name: string
  readonly description?: string
  readonly mimeType?: string
  readonly disposition: McpResourceMimeDisposition
}

export interface McpResourceListRequest {
  readonly serverId?: string
  readonly cursor?: string
  readonly limit?: number
}

export interface McpResourceListResult {
  readonly resources: readonly McpResourceDescriptor[]
  readonly nextCursor?: string
}

export interface McpResourceReadRequest {
  readonly serverId: string
  readonly uri: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export type McpResourceContent =
  | {
      readonly id: string
      readonly uri: string
      readonly mimeType: string
      readonly kind: 'text'
      readonly byteLength: number
      readonly text: string
    }
  | {
      readonly id: string
      readonly uri: string
      readonly mimeType: string
      readonly kind: 'binary'
      readonly byteLength: number
      readonly base64: string
    }

export interface McpResourceReadResult {
  readonly resource: McpResourceDescriptor
  readonly contents: readonly McpResourceContent[]
  readonly totalBytes: number
}

export interface McpResourceSettingsReader {
  listServers(): Promise<readonly McpServerView[]>
  getServer(serverId: string): Promise<McpServerView | null>
}

type McpResourceManager = Pick<
  McpClientManager,
  'isConnected' | 'getSnapshot' | 'readResource'
>

export interface McpResourceClientServiceOptions {
  readonly settingsService: McpResourceSettingsReader
  readonly clientManager: McpResourceManager
  readonly maxContentBytes?: number
  readonly maxAggregateBytes?: number
  readonly requestTimeoutMs?: number
}

interface ResourceCatalog {
  readonly resources: readonly McpResourceDescriptor[]
  readonly fingerprint: string
}

interface CatalogCursor {
  readonly v: typeof CURSOR_VERSION
  readonly scope: string | null
  readonly fingerprint: string
  readonly after: string
}

interface ServerStateFingerprint {
  readonly id: string
  readonly enabled: boolean
  readonly status: McpConnectionStatus
  readonly live: boolean
}

export class McpResourceClientError extends Error {
  readonly code: McpSanitizedErrorCode
  readonly retryable: boolean

  constructor(code: McpSanitizedErrorCode, retryable = false) {
    super(resourceErrorMessage(code))
    this.name = 'McpResourceClientError'
    this.code = code
    this.retryable = retryable
  }
}

/**
 * Parent-process resource boundary. Resource templates stay omitted until the
 * manager exposes protocol-backed template discovery; this service does not
 * synthesize template behavior from ordinary resources.
 */
export class McpResourceClientService {
  private readonly settingsService: McpResourceSettingsReader
  private readonly clientManager: McpResourceManager
  private readonly maxContentBytes: number
  private readonly maxAggregateBytes: number
  private readonly requestTimeoutMs: number

  constructor(options: McpResourceClientServiceOptions) {
    this.settingsService = options.settingsService
    this.clientManager = options.clientManager
    this.maxContentBytes = boundedConfiguration(
      options.maxContentBytes,
      DEFAULT_CONTENT_BYTES,
      MAX_CONFIGURED_CONTENT_BYTES,
    )
    this.maxAggregateBytes = boundedConfiguration(
      options.maxAggregateBytes,
      DEFAULT_AGGREGATE_BYTES,
      MAX_CONFIGURED_AGGREGATE_BYTES,
    )
    if (this.maxAggregateBytes < this.maxContentBytes) {
      throw new McpResourceClientError('configuration_invalid')
    }
    this.requestTimeoutMs = boundedConfiguration(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
    )
  }

  async listResources(
    request: McpResourceListRequest = {},
  ): Promise<McpResourceListResult> {
    const scope = request.serverId === undefined
      ? null
      : requireServerId(request.serverId)
    const limit = requirePageSize(request.limit)
    const catalog = await this.loadCatalog()
    const resources = scope === null
      ? catalog.resources
      : catalog.resources.filter((resource) => resource.serverId === scope)

    if (scope !== null) {
      await this.requireEligibleServer(scope)
    }

    const cursor = request.cursor === undefined
      ? null
      : decodeCursor(request.cursor)
    let start = 0
    if (cursor) {
      if (cursor.scope !== scope || cursor.fingerprint !== catalog.fingerprint) {
        throw new McpResourceClientError('invalid_request')
      }
      const cursorIndex = resources.findIndex(
        (resource) => resource.id === cursor.after,
      )
      if (cursorIndex < 0) throw new McpResourceClientError('invalid_request')
      start = cursorIndex + 1
    }

    const page = resources.slice(start, start + limit)
    const hasMore = start + page.length < resources.length
    const lastOnPage = page[page.length - 1]
    return {
      resources: page,
      ...(hasMore && lastOnPage
        ? {
            nextCursor: encodeCursor({
              v: CURSOR_VERSION,
              scope,
              fingerprint: catalog.fingerprint,
              after: lastOnPage.id,
            }),
          }
        : {}),
    }
  }

  async readResource(
    request: McpResourceReadRequest,
  ): Promise<McpResourceReadResult> {
    if (!request || typeof request !== 'object') {
      throw new McpResourceClientError('invalid_request')
    }
    const serverId = requireServerId(request.serverId)
    const uri = requireResourceUri(request.uri)
    const signal = requireAbortSignal(request.signal)
    const timeoutMs = requireRequestTimeout(request.timeoutMs, this.requestTimeoutMs)
    if (signal?.aborted) throw new McpResourceClientError('cancelled')

    const inventory = await this.requireEligibleServer(serverId)
    const resource = inventory.find((candidate) => candidate.uri === uri)
    if (!resource) throw new McpResourceClientError('not_found')
    if (resource.disposition === 'blocked') {
      throw new McpResourceClientError('configuration_invalid')
    }
    if (signal?.aborted) throw new McpResourceClientError('cancelled')

    let rawResult: unknown
    try {
      rawResult = await this.clientManager.readResource(serverId, uri, {
        ...(signal ? { signal } : {}),
        timeoutMs,
      })
    } catch (error) {
      throw sanitizeSourceError(error)
    }

    return {
      resource,
      ...normalizeReadResult(
        rawResult,
        resource,
        this.maxContentBytes,
        this.maxAggregateBytes,
      ),
    }
  }

  private async loadCatalog(): Promise<ResourceCatalog> {
    let servers: readonly McpServerView[]
    try {
      servers = await this.settingsService.listServers()
    } catch {
      throw new McpResourceClientError('internal', true)
    }
    if (!isUnknownArray(servers)) {
      throw new McpResourceClientError('protocol_error')
    }

    const serverIds = new Set<string>()
    const states: ServerStateFingerprint[] = []
    const resources: McpResourceDescriptor[] = []
    for (const server of servers) {
      validateServerView(server)
      if (serverIds.has(server.id)) {
        throw new McpResourceClientError('protocol_error')
      }
      serverIds.add(server.id)

      let live: boolean
      try {
        live = this.clientManager.isConnected(server.id)
      } catch {
        throw new McpResourceClientError('internal', true)
      }
      const serverState: ServerStateFingerprint = {
        id: server.id,
        enabled: server.enabled,
        status: server.status,
        live,
      }
      states.push(serverState)
      if (!server.enabled || server.status !== 'connected' || !live) continue

      let snapshot: McpConnectionSnapshot | null
      try {
        snapshot = this.clientManager.getSnapshot(server.id)
        live = Boolean(snapshot) && this.clientManager.isConnected(server.id)
      } catch {
        throw new McpResourceClientError('internal', true)
      }
      if (!snapshot) {
        states[states.length - 1] = { ...serverState, live: false }
        continue
      }
      if (!live) {
        states[states.length - 1] = { ...serverState, live: false }
        continue
      }
      resources.push(...descriptorsFromSnapshot(server, snapshot))
      if (resources.length > MAX_RESOURCE_COUNT) {
        throw new McpResourceClientError('result_too_large')
      }
    }

    states.sort((left, right) => left.id.localeCompare(right.id))
    resources.sort(compareResources)
    assertUniqueResourceIdentities(resources)
    return {
      resources,
      fingerprint: catalogFingerprint(states, resources),
    }
  }

  private async requireEligibleServer(
    serverId: string,
  ): Promise<readonly McpResourceDescriptor[]> {
    let server: McpServerView | null
    try {
      server = await this.settingsService.getServer(serverId)
    } catch {
      throw new McpResourceClientError('internal', true)
    }
    if (!server) throw new McpResourceClientError('not_found')
    validateServerView(server)
    if (!server.enabled) throw new McpResourceClientError('server_disabled')
    let live: boolean
    let snapshot: McpConnectionSnapshot | null
    try {
      live = this.clientManager.isConnected(serverId)
      snapshot = live ? this.clientManager.getSnapshot(serverId) : null
      live = Boolean(snapshot) && this.clientManager.isConnected(serverId)
    } catch {
      throw new McpResourceClientError('internal', true)
    }
    if (server.status !== 'connected' || !live) {
      throw new McpResourceClientError('connection_failed', true)
    }
    if (!snapshot) throw new McpResourceClientError('connection_failed', true)
    return descriptorsFromSnapshot(server, snapshot)
  }
}

function descriptorsFromSnapshot(
  server: McpServerView,
  snapshot: McpConnectionSnapshot,
): McpResourceDescriptor[] {
  if (snapshot.serverId !== server.id || !isUnknownArray(snapshot.resources)) {
    throw new McpResourceClientError('protocol_error')
  }
  if (snapshot.resources.length > MAX_RESOURCE_COUNT) {
    throw new McpResourceClientError('result_too_large')
  }

  const resources = snapshot.resources.map((resource) =>
    descriptorFromResource(server, resource),
  )
  resources.sort(compareResources)
  assertUniqueResourceIdentities(resources)
  return resources
}

function descriptorFromResource(
  server: McpServerView,
  resource: McpDiscoveredResource,
): McpResourceDescriptor {
  if (!resource || typeof resource !== 'object') {
    throw new McpResourceClientError('protocol_error')
  }
  const uri = requireResourceUri(resource.uri, 'protocol_error')
  const name = requireBoundedText(
    resource.name,
    MAX_RESOURCE_NAME_LENGTH,
    'protocol_error',
  )
  const description = resource.description === undefined
    ? undefined
    : requireBoundedText(
        resource.description,
        MAX_DESCRIPTION_LENGTH,
        'protocol_error',
        true,
      )
  const mimeType = resource.mimeType === undefined
    ? undefined
    : normalizeMimeType(resource.mimeType)
  return {
    id: stableId('mcp_resource', server.id, uri),
    serverId: server.id,
    serverName: server.name,
    uri,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    disposition: classifyMimeType(mimeType),
  }
}

function normalizeReadResult(
  rawResult: unknown,
  resource: McpResourceDescriptor,
  maxContentBytes: number,
  maxAggregateBytes: number,
): Pick<McpResourceReadResult, 'contents' | 'totalBytes'> {
  if (!isRecord(rawResult) || !isUnknownArray(rawResult.contents)) {
    throw new McpResourceClientError('protocol_error')
  }
  if (rawResult.contents.length > MAX_RESOURCE_CONTENTS) {
    throw new McpResourceClientError('result_too_large')
  }

  const contents: McpResourceContent[] = []
  let totalBytes = 0
  for (let index = 0; index < rawResult.contents.length; index += 1) {
    const content = rawResult.contents[index]
    if (!isRecord(content)) throw new McpResourceClientError('protocol_error')
    const hasText = typeof content.text === 'string'
    const hasBlob = typeof content.blob === 'string'
    if (hasText === hasBlob) throw new McpResourceClientError('protocol_error')

    const uri = requireResourceUri(content.uri, 'protocol_error')
    const declaredMime = content.mimeType === undefined
      ? resource.mimeType
      : normalizeMimeType(content.mimeType)
    const mimeType = declaredMime ?? (hasText ? 'text/plain' : 'application/octet-stream')
    const disposition = classifyMimeType(mimeType)
    if (disposition === 'blocked' || disposition === 'unknown') {
      throw new McpResourceClientError('configuration_invalid')
    }
    if ((hasText && disposition !== 'text') || (hasBlob && disposition !== 'binary')) {
      throw new McpResourceClientError('protocol_error')
    }

    const contentId = stableId('mcp_content', resource.id, uri, String(index))
    let normalized: McpResourceContent
    if (hasText) {
      const text = content.text as string
      const encodedText = Buffer.from(text, 'utf8')
      if (encodedText.toString('utf8') !== text) {
        throw new McpResourceClientError('protocol_error')
      }
      const byteLength = encodedText.byteLength
      assertContentLimit(byteLength, maxContentBytes)
      normalized = {
        id: contentId,
        uri,
        mimeType,
        kind: 'text',
        byteLength,
        text,
      }
    } else {
      const blob = content.blob as string
      const maximumEncodedLength = Math.ceil(maxContentBytes / 3) * 4 + 4
      if (blob.length > maximumEncodedLength) {
        throw new McpResourceClientError('result_too_large')
      }
      if (blob.length % 4 !== 0 || !BASE64.test(blob)) {
        throw new McpResourceClientError('protocol_error')
      }
      const decoded = Buffer.from(blob, 'base64')
      const base64 = decoded.toString('base64')
      if (base64 !== blob) throw new McpResourceClientError('protocol_error')
      assertContentLimit(decoded.byteLength, maxContentBytes)
      normalized = {
        id: contentId,
        uri,
        mimeType,
        kind: 'binary',
        byteLength: decoded.byteLength,
        base64,
      }
    }
    totalBytes += normalized.byteLength
    if (totalBytes > maxAggregateBytes) {
      throw new McpResourceClientError('result_too_large')
    }
    contents.push(normalized)
  }
  return { contents, totalBytes }
}

function validateServerView(server: McpServerView): void {
  if (!server || typeof server !== 'object') {
    throw new McpResourceClientError('protocol_error')
  }
  requireServerId(server.id, 'protocol_error')
  requireBoundedText(
    server.name,
    MAX_SERVER_NAME_LENGTH,
    'protocol_error',
  )
  if (typeof server.enabled !== 'boolean' || !CONNECTION_STATUSES.has(server.status)) {
    throw new McpResourceClientError('protocol_error')
  }
}

function requireServerId(
  value: unknown,
  code: McpSanitizedErrorCode = 'invalid_request',
): string {
  if (
    typeof value !== 'string'
    || value.length > MAX_SERVER_ID_LENGTH
    || value.trim() !== value
    || hasControlCharacters(value)
    || !isSafePathSegment(value)
  ) {
    throw new McpResourceClientError(code)
  }
  return value
}

/**
 * URI strings are validated as opaque MCP identifiers and preserved exactly.
 * This module never resolves file URIs, performs network fetches, or otherwise
 * interprets the identifier outside the already-connected MCP server.
 */
function requireResourceUri(
  value: unknown,
  code: McpSanitizedErrorCode = 'invalid_request',
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_URI_LENGTH
    || value.trim() !== value
    || /\s/u.test(value)
    || hasControlCharacters(value)
    || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    throw new McpResourceClientError(code)
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new McpResourceClientError(code)
  }
  if (
    FORBIDDEN_URI_SCHEMES.has(parsed.protocol.toLowerCase())
    || parsed.username.length > 0
    || parsed.password.length > 0
  ) {
    throw new McpResourceClientError(code)
  }
  return value
}

function requireBoundedText(
  value: unknown,
  maxLength: number,
  code: McpSanitizedErrorCode,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.length > maxLength
    || hasControlCharacters(value, allowEmpty)
  ) {
    throw new McpResourceClientError(code)
  }
  return value
}

function hasControlCharacters(value: string, allowWhitespace = false): boolean {
  return allowWhitespace
    ? /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
    : /[\u0000-\u001F\u007F]/u.test(value)
}

function normalizeMimeType(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_MIME_TYPE_LENGTH
    || hasControlCharacters(value)
  ) {
    throw new McpResourceClientError('protocol_error')
  }
  const [mediaType] = value.split(';', 1)
  if (mediaType === undefined) {
    throw new McpResourceClientError('protocol_error')
  }
  const mimeType = mediaType.trim().toLowerCase()
  if (!MIME_TOKEN.test(mimeType)) {
    throw new McpResourceClientError('protocol_error')
  }
  return mimeType
}

function classifyMimeType(
  mimeType: string | undefined,
): McpResourceMimeDisposition {
  if (mimeType === undefined) return 'unknown'
  if (BLOCKED_MIME_TYPES.has(mimeType)) return 'blocked'
  if (TEXT_MIME_TYPES.has(mimeType) || mimeType.endsWith('+json') || mimeType.endsWith('+xml')) {
    return 'text'
  }
  if (BINARY_MIME_TYPES.has(mimeType)) return 'binary'
  return 'blocked'
}

function requirePageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new McpResourceClientError('invalid_request')
  }
  return value
}

function requireRequestTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > MAX_REQUEST_TIMEOUT_MS) {
    throw new McpResourceClientError('invalid_request')
  }
  return value
}

function requireAbortSignal(
  value: AbortSignal | undefined,
): AbortSignal | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'object'
    || typeof value.aborted !== 'boolean'
    || typeof value.addEventListener !== 'function'
    || typeof value.removeEventListener !== 'function'
  ) {
    throw new McpResourceClientError('invalid_request')
  }
  return value
}

function boundedConfiguration(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new McpResourceClientError('configuration_invalid')
  }
  return value
}

function assertContentLimit(byteLength: number, maximum: number): void {
  if (byteLength > maximum) {
    throw new McpResourceClientError('result_too_large')
  }
}

function assertUniqueResourceIdentities(
  resources: readonly McpResourceDescriptor[],
): void {
  const ids = new Set<string>()
  const sourceKeys = new Set<string>()
  for (const resource of resources) {
    const sourceKey = `${resource.serverId}\0${resource.uri}`
    if (ids.has(resource.id) || sourceKeys.has(sourceKey)) {
      throw new McpResourceClientError('protocol_error')
    }
    ids.add(resource.id)
    sourceKeys.add(sourceKey)
  }
}

function compareResources(
  left: McpResourceDescriptor,
  right: McpResourceDescriptor,
): number {
  return left.serverId.localeCompare(right.serverId) || left.uri.localeCompare(right.uri)
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash('sha256')
  for (const part of parts) {
    digest.update(part, 'utf8')
    digest.update('\0')
  }
  return `${prefix}_${digest.digest('hex')}`
}

function catalogFingerprint(
  states: readonly ServerStateFingerprint[],
  resources: readonly McpResourceDescriptor[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      version: CURSOR_VERSION,
      servers: states,
      resources: resources.map((resource) => ({
        id: resource.id,
        serverId: resource.serverId,
        uri: resource.uri,
        name: resource.name,
        description: resource.description ?? null,
        mimeType: resource.mimeType ?? null,
        disposition: resource.disposition,
      })),
    }), 'utf8')
    .digest('base64url')
}

function encodeCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: unknown): CatalogCursor {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_CURSOR_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new McpResourceClientError('invalid_request')
  }

  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) {
      throw new McpResourceClientError('invalid_request')
    }
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown
    if (
      !isRecord(parsed)
      || parsed.v !== CURSOR_VERSION
      || !(parsed.scope === null || typeof parsed.scope === 'string')
      || typeof parsed.fingerprint !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(parsed.fingerprint)
      || typeof parsed.after !== 'string'
      || !/^mcp_resource_[a-f0-9]{64}$/.test(parsed.after)
    ) {
      throw new McpResourceClientError('invalid_request')
    }
    if (parsed.scope !== null) requireServerId(parsed.scope)
    return {
      v: CURSOR_VERSION,
      scope: parsed.scope,
      fingerprint: parsed.fingerprint,
      after: parsed.after,
    }
  } catch (error) {
    if (error instanceof McpResourceClientError) throw error
    throw new McpResourceClientError('invalid_request')
  }
}

function sanitizeSourceError(error: unknown): McpResourceClientError {
  if (error instanceof McpResourceClientError) return error
  if (error instanceof McpClientManagerError) {
    return new McpResourceClientError(error.code, error.retryable)
  }
  return new McpResourceClientError('internal', true)
}

function resourceErrorMessage(code: McpSanitizedErrorCode): string {
  switch (code) {
    case 'invalid_request':
      return 'MCP resource request is invalid.'
    case 'configuration_invalid':
      return 'MCP resource configuration or media type is not allowed.'
    case 'not_found':
      return 'MCP resource was not found.'
    case 'server_disabled':
      return 'MCP resource server is disabled.'
    case 'unauthorized':
      return 'MCP resource server authorization is required.'
    case 'connection_failed':
      return 'MCP resource server is unavailable.'
    case 'protocol_error':
      return 'MCP resource response is invalid.'
    case 'cancelled':
      return 'MCP resource read was cancelled.'
    case 'timeout':
      return 'MCP resource read timed out.'
    case 'result_too_large':
      return 'MCP resource exceeds the allowed size.'
    default:
      return 'MCP resource operation failed.'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
