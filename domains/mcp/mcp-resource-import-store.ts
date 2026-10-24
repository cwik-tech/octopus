import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type {
  McpResourceContent,
  McpResourceReadResult,
} from './mcp-resource-client-service.js'
import { isValidSessionId } from '../../contracts/sessions.js'
import { isSafePathSegment } from '../../core/path-safety.js'
import { isUnknownArray } from '../../core/unknown-array.js'

export const MCP_RESOURCE_IMPORT_MANIFEST_VERSION = 1 as const

const MANIFEST_FILENAME = 'manifest.json'
const CONTENTS_DIRECTORY = 'contents'
const DEFAULT_MAX_AGGREGATE_BYTES = 4_194_304
const MAX_CONFIGURED_AGGREGATE_BYTES = 67_108_864
const MAX_CONTENTS = 64
const MAX_SESSION_METADATA_BYTES = 65_536
const MAX_MANIFEST_BYTES = 1_048_576
const MAX_SERVER_ID_LENGTH = 160
const MAX_SERVER_NAME_LENGTH = 160
const MAX_RESOURCE_NAME_LENGTH = 512
const MAX_URI_LENGTH = 4_096
const MAX_MIME_TYPE_LENGTH = 256
const MAX_INPUT_FILENAME_LENGTH = 200
const MAX_INPUT_FILENAMES = 10_000
const MAX_SNAPSHOT_ENTRIES = 10_000
const SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RESOURCE_ID = /^mcp_resource_[a-f0-9]{64}$/
const CONTENT_ID = /^mcp_content_[a-f0-9]{64}$/
const SHA256 = /^[a-f0-9]{64}$/
const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const TEMP_DIRECTORY = /^\.import-[0-9a-f-]{36}-[a-f0-9]{16}\.tmp$/
const STORED_PATH = /^contents\/\d{2}-[a-f0-9]{64}\.[a-z0-9]+$/
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
const BLOCKED_TEXT_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/ecmascript',
  'text/ecmascript',
])
const BINARY_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
])

export type McpResourceImportStoreErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'result_too_large'
  | 'corrupt_store'
  | 'io_error'

export interface McpResourceImportManifestContent {
  readonly id: string
  readonly sourceUri: string
  readonly mimeType: string
  readonly kind: 'text' | 'binary'
  readonly byteLength: number
  readonly sha256: string
  readonly storedPath: string
  readonly materializedInputFilename: string
}

export interface McpResourceImportManifest {
  readonly version: typeof MCP_RESOURCE_IMPORT_MANIFEST_VERSION
  readonly snapshotId: string
  readonly sessionId: string
  readonly capturedAt: string
  readonly server: {
    readonly id: string
    readonly name: string
  }
  readonly resource: {
    readonly id: string
    readonly uri: string
    readonly name: string
  }
  readonly totalBytes: number
  readonly contents: readonly McpResourceImportManifestContent[]
}

export interface McpResourceMaterializedInput {
  readonly contentId: string
  readonly filename: string
  readonly buffer: Buffer
}

export interface McpResourceImportRequest {
  readonly sessionId: string
  readonly result: McpResourceReadResult
  readonly requestedInputBaseName?: string
}

export interface McpResourceImportResult {
  readonly snapshotPath: string
  readonly manifest: McpResourceImportManifest
  readonly materializedInputs: readonly McpResourceMaterializedInput[]
}

export interface McpResourceStoredSnapshotContent {
  readonly contentId: string
  readonly storedPath: string
  readonly buffer: Buffer
}

export interface McpResourceStoredSnapshot {
  readonly manifest: McpResourceImportManifest
  readonly contents: readonly McpResourceStoredSnapshotContent[]
}

export interface McpResourceImportStoreOptions {
  readonly workspacePath: string
  readonly maxAggregateBytes?: number
  readonly now?: () => Date
}

interface SessionLocation {
  readonly sessionPath: string
  readonly resourcesPath: string
}

interface PreparedContent {
  readonly manifest: McpResourceImportManifestContent
  readonly buffer: Buffer
}

interface PreparedImport {
  readonly manifest: McpResourceImportManifest
  readonly contents: readonly PreparedContent[]
}

export class McpResourceImportStoreError extends Error {
  readonly code: McpResourceImportStoreErrorCode

  constructor(code: McpResourceImportStoreErrorCode) {
    super(importStoreErrorMessage(code))
    this.name = 'McpResourceImportStoreError'
    this.code = code
  }
}

export class McpResourceImportStore {
  private readonly workspacePath: string
  private readonly maxAggregateBytes: number
  private readonly now: () => Date

  constructor(options: McpResourceImportStoreOptions) {
    if (!options || typeof options.workspacePath !== 'string') {
      throw new McpResourceImportStoreError('invalid_request')
    }
    this.workspacePath = path.resolve(options.workspacePath)
    this.maxAggregateBytes = boundedAggregateLimit(options.maxAggregateBytes)
    this.now = options.now ?? (() => new Date())
  }

  async importResource(
    request: McpResourceImportRequest,
  ): Promise<McpResourceImportResult> {
    try {
      const sessionId = requireSessionId(request?.sessionId)
      const location = await this.requireSession(sessionId)
      const snapshotId = randomUUID()
      const capturedAt = requireIsoTimestamp(this.now().toISOString())
      const prepared = prepareImport({
        request,
        sessionId,
        snapshotId,
        capturedAt,
        maxAggregateBytes: this.maxAggregateBytes,
      })
      await ensureResourceRoot(location)
      return await publishImport(location, prepared)
    } catch (error) {
      throw sanitizeImportError(error)
    }
  }

  async listSnapshots(
    sessionIdInput: string,
  ): Promise<readonly McpResourceImportManifest[]> {
    try {
      const sessionId = requireSessionId(sessionIdInput)
      const location = await this.requireSession(sessionId)
      const rootStat = await fs.lstat(location.resourcesPath).catch((error) => {
        if (isFileSystemError(error, 'ENOENT')) return null
        throw error
      })
      if (!rootStat) return []
      await requireSecureDirectory(location.resourcesPath, location.sessionPath)
      requireMode(rootStat.mode, 0o700)

      const entries = await fs.readdir(location.resourcesPath, {
        withFileTypes: true,
      })
      if (entries.length > MAX_SNAPSHOT_ENTRIES) {
        throw new McpResourceImportStoreError('result_too_large')
      }
      const manifests: McpResourceImportManifest[] = []
      for (const entry of entries) {
        if (TEMP_DIRECTORY.test(entry.name) && entry.isDirectory()) continue
        if (!SNAPSHOT_ID.test(entry.name) || !entry.isDirectory()) {
          throw new McpResourceImportStoreError('corrupt_store')
        }
        manifests.push(await readPublishedSnapshot({
          resourcesPath: location.resourcesPath,
          snapshotId: entry.name,
          sessionId,
          maxAggregateBytes: this.maxAggregateBytes,
        }))
      }
      return manifests.sort(compareManifests)
    } catch (error) {
      throw sanitizeListError(error)
    }
  }

  async selectProvenance(
    sessionId: string,
    inputFilenames: readonly string[],
  ): Promise<readonly McpResourceImportManifest[]> {
    const manifests = await this.listSnapshots(sessionId)
    return selectMcpResourceProvenanceByInputFilenames(
      manifests,
      inputFilenames,
    )
  }

  async readSnapshot(
    sessionIdInput: string,
    snapshotIdInput: string,
  ): Promise<McpResourceStoredSnapshot> {
    try {
      const sessionId = requireSessionId(sessionIdInput)
      if (typeof snapshotIdInput !== 'string' || !SNAPSHOT_ID.test(snapshotIdInput)) {
        throw new McpResourceImportStoreError('invalid_request')
      }
      const location = await this.requireSession(sessionId)
      await requireSecureDirectory(location.resourcesPath, location.sessionPath)
      const manifest = await readPublishedSnapshot({
        resourcesPath: location.resourcesPath,
        snapshotId: snapshotIdInput,
        sessionId,
        maxAggregateBytes: this.maxAggregateBytes,
      })
      const snapshotPath = path.join(location.resourcesPath, snapshotIdInput)
      const contentsPath = path.join(snapshotPath, CONTENTS_DIRECTORY)
      const contents = await Promise.all(manifest.contents.map(async (content) => ({
        contentId: content.id,
        storedPath: content.storedPath,
        buffer: await readSecureFile(
          resolveStoredPath(snapshotPath, content.storedPath),
          contentsPath,
          content.byteLength + 1,
        ),
      })))
      return { manifest, contents }
    } catch (error) {
      throw sanitizeListError(error)
    }
  }

  private async requireSession(sessionId: string): Promise<SessionLocation> {
    const workspaceStat = await fs.lstat(this.workspacePath).catch((error) => {
      if (isFileSystemError(error, 'ENOENT')) return null
      throw error
    })
    if (!workspaceStat) throw new McpResourceImportStoreError('not_found')
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
      throw new McpResourceImportStoreError('invalid_request')
    }

    const sessionsPath = path.join(this.workspacePath, 'sessions')
    await requireSecureDirectory(sessionsPath, this.workspacePath)
    const sessionPath = path.join(sessionsPath, sessionId)
    await requireSecureDirectory(sessionPath, sessionsPath)
    await validateSessionMetadata(sessionPath, sessionId)
    return {
      sessionPath,
      resourcesPath: path.join(sessionPath, 'mcp-resources'),
    }
  }
}

export function selectMcpResourceProvenanceByInputFilenames(
  manifests: readonly McpResourceImportManifest[],
  inputFilenames: readonly string[],
): readonly McpResourceImportManifest[] {
  if (!isUnknownArray(manifests) || !isUnknownArray(inputFilenames)) {
    throw new McpResourceImportStoreError('invalid_request')
  }
  if (inputFilenames.length > MAX_INPUT_FILENAMES) {
    throw new McpResourceImportStoreError('invalid_request')
  }
  const names = new Set<string>()
  for (const filename of inputFilenames) names.add(requireSessionInputFilename(filename))
  if (names.size === 0) return []
  const manifestList: readonly McpResourceImportManifest[] = manifests
  return manifestList
    .filter((manifest) => manifest.contents.some(
      (content) => names.has(content.materializedInputFilename),
    ))
    .slice()
    .sort(compareManifests)
}

function prepareImport(params: {
  request: McpResourceImportRequest
  sessionId: string
  snapshotId: string
  capturedAt: string
  maxAggregateBytes: number
}): PreparedImport {
  const { result } = params.request
  if (!result || typeof result !== 'object' || !isUnknownArray(result.contents)) {
    throw new McpResourceImportStoreError('invalid_request')
  }
  if (result.contents.length > MAX_CONTENTS) {
    throw new McpResourceImportStoreError('result_too_large')
  }
  if (
    params.request.requestedInputBaseName !== undefined
    && result.contents.length !== 1
  ) {
    throw new McpResourceImportStoreError('invalid_request')
  }

  const server = validateServerIdentity(result)
  const resource = validateResourceIdentity(result)
  const baseName = params.request.requestedInputBaseName === undefined
    ? safeFilenameBase(resource.name)
    : requireRequestedBaseName(params.request.requestedInputBaseName)
  const preparedContents = prepareContents({
    contents: result.contents,
    snapshotId: params.snapshotId,
    baseName,
    maxAggregateBytes: params.maxAggregateBytes,
  })
  const totalBytes = preparedContents.reduce(
    (total, content) => total + content.buffer.byteLength,
    0,
  )
  if (!Number.isSafeInteger(result.totalBytes) || result.totalBytes !== totalBytes) {
    throw new McpResourceImportStoreError('invalid_request')
  }

  return {
    manifest: {
      version: MCP_RESOURCE_IMPORT_MANIFEST_VERSION,
      snapshotId: params.snapshotId,
      sessionId: params.sessionId,
      capturedAt: params.capturedAt,
      server,
      resource,
      totalBytes,
      contents: preparedContents.map((content) => content.manifest),
    },
    contents: preparedContents,
  }
}

function prepareContents(params: {
  contents: readonly McpResourceContent[]
  snapshotId: string
  baseName: string
  maxAggregateBytes: number
}): PreparedContent[] {
  const prepared: PreparedContent[] = []
  const contentIds = new Set<string>()
  const inputFilenames = new Set<string>()
  let aggregateBytes = 0
  for (const [index, content] of params.contents.entries()) {
    const normalized = prepareContent(content, params.maxAggregateBytes)
    if (contentIds.has(normalized.id)) {
      throw new McpResourceImportStoreError('invalid_request')
    }
    contentIds.add(normalized.id)
    aggregateBytes += normalized.buffer.byteLength
    if (aggregateBytes > params.maxAggregateBytes) {
      throw new McpResourceImportStoreError('result_too_large')
    }

    const extension = extensionForMimeType(normalized.mimeType)
    const inputFilename = materializedInputFilename({
      baseName: params.baseName,
      snapshotId: params.snapshotId,
      index,
      contentCount: params.contents.length,
      extension,
    })
    if (inputFilenames.has(inputFilename)) {
      throw new McpResourceImportStoreError('conflict')
    }
    inputFilenames.add(inputFilename)
    const contentHash = normalized.id.slice('mcp_content_'.length)
    const storedPath = `${CONTENTS_DIRECTORY}/${String(index).padStart(2, '0')}-${contentHash}.${extension}`
    prepared.push({
      buffer: normalized.buffer,
      manifest: {
        id: normalized.id,
        sourceUri: normalized.sourceUri,
        mimeType: normalized.mimeType,
        kind: normalized.kind,
        byteLength: normalized.buffer.byteLength,
        sha256: hashBuffer(normalized.buffer),
        storedPath,
        materializedInputFilename: inputFilename,
      },
    })
  }
  return prepared
}

function prepareContent(
  content: McpResourceContent,
  maximumBytes: number,
): {
  id: string
  sourceUri: string
  mimeType: string
  kind: 'text' | 'binary'
  buffer: Buffer
} {
  if (!content || typeof content !== 'object' || !CONTENT_ID.test(content.id)) {
    throw new McpResourceImportStoreError('invalid_request')
  }
  const sourceUri = requireOpaqueUri(content.uri, 'invalid_request')
  const mimeType = requireMimeType(content.mimeType, 'invalid_request')
  let buffer: Buffer
  if (content.kind === 'text') {
    if (!isAllowedTextMimeType(mimeType) || typeof content.text !== 'string') {
      throw new McpResourceImportStoreError('invalid_request')
    }
    buffer = Buffer.from(content.text, 'utf8')
    if (buffer.toString('utf8') !== content.text) {
      throw new McpResourceImportStoreError('invalid_request')
    }
  } else if (content.kind === 'binary') {
    const maximumEncodedLength = Math.ceil(maximumBytes / 3) * 4 + 4
    if (
      !BINARY_MIME_TYPES.has(mimeType)
      || typeof content.base64 !== 'string'
      || content.base64.length > maximumEncodedLength
      || !isCanonicalBase64(content.base64)
    ) {
      throw new McpResourceImportStoreError('invalid_request')
    }
    buffer = Buffer.from(content.base64, 'base64')
  } else {
    throw new McpResourceImportStoreError('invalid_request')
  }
  if (buffer.byteLength > maximumBytes) {
    throw new McpResourceImportStoreError('result_too_large')
  }
  if (!Number.isSafeInteger(content.byteLength) || content.byteLength !== buffer.byteLength) {
    throw new McpResourceImportStoreError('invalid_request')
  }
  return { id: content.id, sourceUri, mimeType, kind: content.kind, buffer }
}

function validateServerIdentity(result: McpResourceReadResult): {
  id: string
  name: string
} {
  const id = requireServerId(result.resource?.serverId, 'invalid_request')
  const name = requireText(
    result.resource?.serverName,
    MAX_SERVER_NAME_LENGTH,
    'invalid_request',
  )
  return { id, name }
}

function validateResourceIdentity(result: McpResourceReadResult): {
  id: string
  uri: string
  name: string
} {
  const resource = result.resource
  if (!resource || !RESOURCE_ID.test(resource.id)) {
    throw new McpResourceImportStoreError('invalid_request')
  }
  return {
    id: resource.id,
    uri: requireOpaqueUri(resource.uri, 'invalid_request'),
    name: requireText(
      resource.name,
      MAX_RESOURCE_NAME_LENGTH,
      'invalid_request',
    ),
  }
}

async function publishImport(
  location: SessionLocation,
  prepared: PreparedImport,
): Promise<McpResourceImportResult> {
  const snapshotId = prepared.manifest.snapshotId
  const snapshotPath = path.join(location.resourcesPath, snapshotId)
  const temporaryPath = path.join(
    location.resourcesPath,
    `.import-${snapshotId}-${randomBytes(8).toString('hex')}.tmp`,
  )
  let published = false
  try {
    await fs.mkdir(temporaryPath, { mode: 0o700 })
    await fs.chmod(temporaryPath, 0o700)
    const contentsPath = path.join(temporaryPath, CONTENTS_DIRECTORY)
    await fs.mkdir(contentsPath, { mode: 0o700 })
    await fs.chmod(contentsPath, 0o700)
    for (const content of prepared.contents) {
      const targetPath = resolveStoredPath(temporaryPath, content.manifest.storedPath)
      await writeExclusiveReadOnly(targetPath, content.buffer)
    }
    await syncDirectory(contentsPath)
    await writeExclusiveReadOnly(
      path.join(temporaryPath, MANIFEST_FILENAME),
      serializeManifest(prepared.manifest),
    )
    await syncDirectory(temporaryPath)
    await assertPublishDestinationAvailable(snapshotPath)
    await requireSecureDirectory(location.resourcesPath, location.sessionPath)
    await fs.rename(temporaryPath, snapshotPath)
    published = true
    await syncDirectory(location.resourcesPath)
    return {
      snapshotPath,
      manifest: prepared.manifest,
      materializedInputs: prepared.contents.map((content) => ({
        contentId: content.manifest.id,
        filename: content.manifest.materializedInputFilename,
        buffer: Buffer.from(content.buffer),
      })),
    }
  } finally {
    if (!published) {
      await fs.rm(temporaryPath, { recursive: true, force: true })
        .catch(() => undefined)
    }
  }
}

async function readPublishedSnapshot(params: {
  resourcesPath: string
  snapshotId: string
  sessionId: string
  maxAggregateBytes: number
}): Promise<McpResourceImportManifest> {
  const snapshotPath = path.join(params.resourcesPath, params.snapshotId)
  const snapshotStat = await requireSecureDirectory(
    snapshotPath,
    params.resourcesPath,
    'corrupt_store',
  )
  requireMode(snapshotStat.mode, 0o700)
  const entries = await fs.readdir(snapshotPath, { withFileTypes: true })
  if (
    entries.length !== 2
    || !entries.some((entry) => entry.name === MANIFEST_FILENAME && entry.isFile())
    || !entries.some((entry) => entry.name === CONTENTS_DIRECTORY && entry.isDirectory())
  ) {
    throw new McpResourceImportStoreError('corrupt_store')
  }

  const manifestPath = path.join(snapshotPath, MANIFEST_FILENAME)
  const manifestBuffer = await readSecureFile(manifestPath, snapshotPath, MAX_MANIFEST_BYTES)
  const manifestStat = await fs.lstat(manifestPath)
  requireMode(manifestStat.mode, 0o400)
  const manifest = parseManifest(manifestBuffer, {
    snapshotId: params.snapshotId,
    sessionId: params.sessionId,
    maxAggregateBytes: params.maxAggregateBytes,
  })
  if (!manifestBuffer.equals(serializeManifest(manifest))) {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  await verifyStoredContents(snapshotPath, manifest)
  return manifest
}

async function verifyStoredContents(
  snapshotPath: string,
  manifest: McpResourceImportManifest,
): Promise<void> {
  const contentsPath = path.join(snapshotPath, CONTENTS_DIRECTORY)
  const contentsStat = await requireSecureDirectory(
    contentsPath,
    snapshotPath,
    'corrupt_store',
  )
  requireMode(contentsStat.mode, 0o700)
  const entries = await fs.readdir(contentsPath, { withFileTypes: true })
  const expectedFilenames = new Set(
    manifest.contents.map((content) => content.storedPath.slice('contents/'.length)),
  )
  if (
    entries.length !== expectedFilenames.size
    || entries.some((entry) => !entry.isFile() || !expectedFilenames.has(entry.name))
  ) {
    throw new McpResourceImportStoreError('corrupt_store')
  }

  for (const content of manifest.contents) {
    const filePath = resolveStoredPath(snapshotPath, content.storedPath)
    const buffer = await readSecureFile(
      filePath,
      contentsPath,
      content.byteLength + 1,
    )
    const stat = await fs.lstat(filePath)
    requireMode(stat.mode, 0o400)
    if (
      buffer.byteLength !== content.byteLength
      || hashBuffer(buffer) !== content.sha256
    ) {
      throw new McpResourceImportStoreError('corrupt_store')
    }
  }
}

function parseManifest(
  buffer: Buffer,
  expected: {
    snapshotId: string
    sessionId: string
    maxAggregateBytes: number
  },
): McpResourceImportManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8Strict(buffer, 'corrupt_store'))
  } catch {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, [
    'version',
    'snapshotId',
    'sessionId',
    'capturedAt',
    'server',
    'resource',
    'totalBytes',
    'contents',
  ])) {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  if (
    parsed.version !== MCP_RESOURCE_IMPORT_MANIFEST_VERSION
    || parsed.snapshotId !== expected.snapshotId
    || parsed.sessionId !== expected.sessionId
    || !Array.isArray(parsed.contents)
    || parsed.contents.length > MAX_CONTENTS
  ) {
    throw new McpResourceImportStoreError('corrupt_store')
  }

  const server = parseManifestServer(parsed.server)
  const resource = parseManifestResource(parsed.resource)
  const contents = parsed.contents.map(parseManifestContent)
  assertUniqueManifestContents(contents)
  assertManifestPathsAndFilenames(contents, expected.snapshotId)
  const totalBytes = contents.reduce((total, content) => total + content.byteLength, 0)
  if (
    !Number.isSafeInteger(parsed.totalBytes)
    || parsed.totalBytes !== totalBytes
    || totalBytes > expected.maxAggregateBytes
  ) {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  return {
    version: MCP_RESOURCE_IMPORT_MANIFEST_VERSION,
    snapshotId: expected.snapshotId,
    sessionId: expected.sessionId,
    capturedAt: requireIsoTimestamp(parsed.capturedAt, 'corrupt_store'),
    server,
    resource,
    totalBytes,
    contents,
  }
}

function parseManifestServer(value: unknown): { id: string; name: string } {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'name'])) {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  return {
    id: requireServerId(value.id, 'corrupt_store'),
    name: requireText(value.name, MAX_SERVER_NAME_LENGTH, 'corrupt_store'),
  }
}

function parseManifestResource(value: unknown): {
  id: string
  uri: string
  name: string
} {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['id', 'uri', 'name'])
    || typeof value.id !== 'string'
    || !RESOURCE_ID.test(value.id)
  ) {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  return {
    id: value.id,
    uri: requireOpaqueUri(value.uri, 'corrupt_store'),
    name: requireText(value.name, MAX_RESOURCE_NAME_LENGTH, 'corrupt_store'),
  }
}

function parseManifestContent(value: unknown): McpResourceImportManifestContent {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id',
    'sourceUri',
    'mimeType',
    'kind',
    'byteLength',
    'sha256',
    'storedPath',
    'materializedInputFilename',
  ])) {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  if (
    typeof value.id !== 'string'
    || !CONTENT_ID.test(value.id)
    || (value.kind !== 'text' && value.kind !== 'binary')
    || !Number.isSafeInteger(value.byteLength)
    || (value.byteLength as number) < 0
    || typeof value.sha256 !== 'string'
    || !SHA256.test(value.sha256)
    || typeof value.storedPath !== 'string'
    || !STORED_PATH.test(value.storedPath)
  ) {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  const mimeType = requireMimeType(value.mimeType, 'corrupt_store')
  if (
    (value.kind === 'text' && !isAllowedTextMimeType(mimeType))
    || (value.kind === 'binary' && !BINARY_MIME_TYPES.has(mimeType))
  ) {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  return {
    id: value.id,
    sourceUri: requireOpaqueUri(value.sourceUri, 'corrupt_store'),
    mimeType,
    kind: value.kind,
    byteLength: value.byteLength as number,
    sha256: value.sha256,
    storedPath: value.storedPath,
    materializedInputFilename: requireMcpMaterializedInputFilename(
      value.materializedInputFilename,
      'corrupt_store',
    ),
  }
}

function assertUniqueManifestContents(
  contents: readonly McpResourceImportManifestContent[],
): void {
  const ids = new Set<string>()
  const storedPaths = new Set<string>()
  const inputFilenames = new Set<string>()
  for (const content of contents) {
    if (
      ids.has(content.id)
      || storedPaths.has(content.storedPath)
      || inputFilenames.has(content.materializedInputFilename)
    ) {
      throw new McpResourceImportStoreError('corrupt_store')
    }
    ids.add(content.id)
    storedPaths.add(content.storedPath)
    inputFilenames.add(content.materializedInputFilename)
  }
}

function assertManifestPathsAndFilenames(
  contents: readonly McpResourceImportManifestContent[],
  snapshotId: string,
): void {
  const snapshotToken = snapshotId.replaceAll('-', '')
  for (const [index, content] of contents.entries()) {
    const extension = extensionForMimeType(content.mimeType)
    const contentHash = content.id.slice('mcp_content_'.length)
    const expectedPath = `${CONTENTS_DIRECTORY}/${String(index).padStart(2, '0')}-${contentHash}.${extension}`
    const sequence = contents.length === 1
      ? ''
      : `-${String(index + 1).padStart(2, '0')}`
    const expectedSuffix = `${sequence}-${snapshotToken}.${extension}`
    if (
      content.storedPath !== expectedPath
      || !content.materializedInputFilename.endsWith(expectedSuffix)
      || content.materializedInputFilename.length <= expectedSuffix.length
    ) {
      throw new McpResourceImportStoreError('corrupt_store')
    }
  }
}

async function validateSessionMetadata(
  sessionPath: string,
  sessionId: string,
): Promise<void> {
  const metadataPath = path.join(sessionPath, 'session.json')
  const buffer = await readSecureFile(
    metadataPath,
    sessionPath,
    MAX_SESSION_METADATA_BYTES,
    'not_found',
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8Strict(buffer, 'corrupt_store'))
  } catch {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  if (
    !isRecord(parsed)
    || parsed.id !== sessionId
    || typeof parsed.title !== 'string'
    || !['idle', 'active', 'done'].includes(String(parsed.status))
    || !['chat', 'workflow'].includes(String(parsed.activityType))
  ) {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  requireIsoTimestamp(parsed.createdAt, 'corrupt_store')
  requireIsoTimestamp(parsed.updatedAt, 'corrupt_store')
}

async function ensureResourceRoot(location: SessionLocation): Promise<void> {
  try {
    await fs.mkdir(location.resourcesPath, { mode: 0o700 })
  } catch (error) {
    if (!isFileSystemError(error, 'EEXIST')) throw error
  }
  const stat = await requireSecureDirectory(
    location.resourcesPath,
    location.sessionPath,
  )
  await fs.chmod(location.resourcesPath, 0o700)
  requireMode((await fs.lstat(location.resourcesPath)).mode, 0o700)
  if (!stat.isDirectory()) throw new McpResourceImportStoreError('invalid_request')
}

async function requireSecureDirectory(
  directoryPath: string,
  parentPath: string,
  code: McpResourceImportStoreErrorCode = 'invalid_request',
): Promise<Stats> {
  const stat = await fs.lstat(directoryPath).catch((error) => {
    if (isFileSystemError(error, 'ENOENT')) {
      throw new McpResourceImportStoreError('not_found')
    }
    throw error
  })
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new McpResourceImportStoreError(code)
  }
  const [realParent, realDirectory] = await Promise.all([
    fs.realpath(parentPath),
    fs.realpath(directoryPath),
  ])
  if (!isPathInsideOrEqual(realParent, realDirectory) || realParent === realDirectory) {
    throw new McpResourceImportStoreError(code)
  }
  return stat
}

async function readSecureFile(
  filePath: string,
  parentPath: string,
  maximumBytes: number,
  missingCode: McpResourceImportStoreErrorCode = 'corrupt_store',
): Promise<Buffer> {
  const stat = await fs.lstat(filePath).catch((error) => {
    if (isFileSystemError(error, 'ENOENT')) {
      throw new McpResourceImportStoreError(missingCode)
    }
    throw error
  })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  const [realParent, realFile] = await Promise.all([
    fs.realpath(parentPath),
    fs.realpath(filePath),
  ])
  if (!isPathInsideOrEqual(realParent, realFile) || realParent === realFile) {
    throw new McpResourceImportStoreError(
      missingCode === 'not_found' ? 'invalid_request' : 'corrupt_store',
    )
  }
  return fs.readFile(filePath)
}

async function writeExclusiveReadOnly(
  filePath: string,
  contents: Uint8Array,
): Promise<void> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(filePath, 'wx', 0o400)
    await handle.writeFile(contents)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.chmod(filePath, 0o400)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function assertPublishDestinationAvailable(
  snapshotPath: string,
): Promise<void> {
  const stat = await fs.lstat(snapshotPath).catch((error) => {
    if (isFileSystemError(error, 'ENOENT')) return null
    throw error
  })
  if (stat) throw new McpResourceImportStoreError('conflict')
}

function resolveStoredPath(snapshotPath: string, storedPath: string): string {
  if (!STORED_PATH.test(storedPath)) {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  const resolved = path.resolve(snapshotPath, ...storedPath.split('/'))
  if (!isPathInsideOrEqual(path.resolve(snapshotPath), resolved)) {
    throw new McpResourceImportStoreError('corrupt_store')
  }
  return resolved
}

function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || !isValidSessionId(value)) {
    throw new McpResourceImportStoreError('invalid_request')
  }
  return value.toLowerCase()
}

function requireServerId(
  value: unknown,
  code: McpResourceImportStoreErrorCode,
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_SERVER_ID_LENGTH
    || value.trim() !== value
    || hasControlCharacters(value)
    || !isSafePathSegment(value)
  ) {
    throw new McpResourceImportStoreError(code)
  }
  return value
}

function requireText(
  value: unknown,
  maximumLength: number,
  code: McpResourceImportStoreErrorCode,
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumLength
    || hasControlCharacters(value)
  ) {
    throw new McpResourceImportStoreError(code)
  }
  return value
}

function requireOpaqueUri(
  value: unknown,
  code: McpResourceImportStoreErrorCode,
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
    throw new McpResourceImportStoreError(code)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new McpResourceImportStoreError(code)
  }
  if (
    FORBIDDEN_URI_SCHEMES.has(parsed.protocol.toLowerCase())
    || parsed.username.length > 0
    || parsed.password.length > 0
  ) {
    throw new McpResourceImportStoreError(code)
  }
  return value
}

function requireMimeType(
  value: unknown,
  code: McpResourceImportStoreErrorCode,
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_MIME_TYPE_LENGTH
    || value !== value.toLowerCase()
    || !MIME_TYPE.test(value)
  ) {
    throw new McpResourceImportStoreError(code)
  }
  return value
}

function requireRequestedBaseName(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_INPUT_FILENAME_LENGTH
    || value.trim() !== value
    || !isSafePathSegment(value)
    || hasControlCharacters(value)
  ) {
    throw new McpResourceImportStoreError('invalid_request')
  }
  return safeFilenameBase(value)
}

function safeFilenameBase(value: string): string {
  const base = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return base || 'mcp-resource'
}

function materializedInputFilename(params: {
  baseName: string
  snapshotId: string
  index: number
  contentCount: number
  extension: string
}): string {
  const randomToken = params.snapshotId.replaceAll('-', '')
  const sequence = params.contentCount === 1
    ? ''
    : `-${String(params.index + 1).padStart(2, '0')}`
  return `${params.baseName}${sequence}-${randomToken}.${params.extension}`
}

function requireMcpMaterializedInputFilename(
  value: unknown,
  code: McpResourceImportStoreErrorCode = 'invalid_request',
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_INPUT_FILENAME_LENGTH
    || value.trim() !== value
    || hasControlCharacters(value)
    || !isSafePathSegment(value)
    || !/^[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw new McpResourceImportStoreError(code)
  }
  return value
}

function requireSessionInputFilename(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_INPUT_FILENAME_LENGTH
    || value.trim() !== value
    || hasControlCharacters(value)
    || !isSafePathSegment(value)
  ) {
    throw new McpResourceImportStoreError('invalid_request')
  }
  return value
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === 'text/markdown') return 'md'
  if (mimeType === 'text/csv') return 'csv'
  if (mimeType === 'text/tab-separated-values') return 'tsv'
  if (mimeType === 'text/calendar') return 'ics'
  if (mimeType === 'application/json' || mimeType.endsWith('+json')) return 'json'
  if (mimeType === 'application/xml' || mimeType.endsWith('+xml')) return 'xml'
  if (mimeType === 'application/yaml' || mimeType === 'application/x-yaml') return 'yaml'
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'application/pdf') return 'pdf'
  return 'txt'
}

function isAllowedTextMimeType(mimeType: string): boolean {
  if (BLOCKED_TEXT_MIME_TYPES.has(mimeType)) return false
  return TEXT_MIME_TYPES.has(mimeType)
    || mimeType.endsWith('+json')
    || mimeType.endsWith('+xml')
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64.test(value)) {
    return false
  }
  return Buffer.from(value, 'base64').toString('base64') === value
}

function boundedAggregateLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_AGGREGATE_BYTES
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_CONFIGURED_AGGREGATE_BYTES
  ) {
    throw new McpResourceImportStoreError('invalid_request')
  }
  return value
}

function serializeManifest(manifest: McpResourceImportManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function hashBuffer(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function decodeUtf8Strict(
  buffer: Buffer,
  code: McpResourceImportStoreErrorCode,
): string {
  const text = buffer.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    throw new McpResourceImportStoreError(code)
  }
  return text
}

function requireIsoTimestamp(
  value: unknown,
  code: McpResourceImportStoreErrorCode = 'io_error',
): string {
  if (typeof value !== 'string') throw new McpResourceImportStoreError(code)
  const timestamp = new Date(value)
  if (!Number.isFinite(timestamp.valueOf()) || timestamp.toISOString() !== value) {
    throw new McpResourceImportStoreError(code)
  }
  return value
}

function requireMode(mode: number, expected: number): void {
  if ((mode & 0o777) !== expected) {
    throw new McpResourceImportStoreError('corrupt_store')
  }
}

function compareManifests(
  left: McpResourceImportManifest,
  right: McpResourceImportManifest,
): number {
  return right.capturedAt.localeCompare(left.capturedAt)
    || left.snapshotId.localeCompare(right.snapshotId)
}

function isPathInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath)
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001F\u007F]/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFileSystemError(error: unknown, code: string): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && (error as NodeJS.ErrnoException).code === code
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, 'r').catch(() => null)
  if (!handle) return
  try {
    await handle.sync().catch(() => undefined)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function sanitizeImportError(error: unknown): McpResourceImportStoreError {
  if (error instanceof McpResourceImportStoreError) return error
  if (isFileSystemError(error, 'EEXIST') || isFileSystemError(error, 'ENOTEMPTY')) {
    return new McpResourceImportStoreError('conflict')
  }
  return new McpResourceImportStoreError('io_error')
}

function sanitizeListError(error: unknown): McpResourceImportStoreError {
  if (error instanceof McpResourceImportStoreError) return error
  return new McpResourceImportStoreError('io_error')
}

function importStoreErrorMessage(code: McpResourceImportStoreErrorCode): string {
  switch (code) {
    case 'invalid_request':
      return 'MCP resource import request is invalid.'
    case 'not_found':
      return 'MCP resource import session was not found.'
    case 'conflict':
      return 'MCP resource import snapshot already exists.'
    case 'result_too_large':
      return 'MCP resource import exceeds the allowed size.'
    case 'corrupt_store':
      return 'MCP resource import storage is unsafe or corrupt.'
    default:
      return 'MCP resource import storage operation failed.'
  }
}
