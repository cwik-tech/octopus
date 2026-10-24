import { whenDefined } from '../core/optional-properties.js'
import type { FileParserLauncher } from '../core/file-parser-launcher.js'
import { withFileMutationLock } from '../core/file-mutation.js'
import {
  McpResourceClientError,
  type McpResourceClientService,
  type McpResourceListRequest,
  type McpResourceListResult,
} from '../domains/mcp/mcp-resource-client-service.js'
import {
  McpResourceImportStoreError,
  type McpResourceImportManifest,
  type McpResourceImportStore,
} from '../domains/mcp/mcp-resource-import-store.js'
import type {
  McpResourceSessionFileSource,
  SessionFile,
} from '../contracts/sessions.js'
import type { SessionStore } from '../domains/sessions/session-store.js'

export type McpResourceImportServiceErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'materialization_failed'
  | 'parse_failed'

export class McpResourceImportServiceError extends Error {
  readonly code: McpResourceImportServiceErrorCode

  constructor(code: McpResourceImportServiceErrorCode) {
    super(importServiceErrorMessage(code))
    this.name = 'McpResourceImportServiceError'
    this.code = code
  }
}

export interface ImportSessionMcpResourceRequest {
  readonly sessionId: string
  readonly serverId: string
  readonly uri: string
  readonly requestedInputBaseName?: string
  readonly signal?: AbortSignal
}

export interface ImportSessionMcpResourceResult {
  readonly files: readonly SessionFile[]
  readonly import: McpResourceImportManifest
}

export interface McpResourceImportServiceOptions {
  readonly resourceClient: McpResourceClientService
  readonly importStore: McpResourceImportStore
  readonly sessionStore: SessionStore
  readonly fileParserLauncher?: FileParserLauncher
}

/**
 * Coordinates protocol reads with session input mutation. The remote read is
 * intentionally outside the input lock; immutable snapshot publication and
 * all materialized files share the lock with run creation.
 */
export class McpResourceImportService {
  private readonly resourceClient: McpResourceClientService
  private readonly importStore: McpResourceImportStore
  private readonly sessionStore: SessionStore
  private readonly fileParserLauncher: FileParserLauncher | undefined

  constructor(options: McpResourceImportServiceOptions) {
    this.resourceClient = options.resourceClient
    this.importStore = options.importStore
    this.sessionStore = options.sessionStore
    this.fileParserLauncher = options.fileParserLauncher
  }

  async listResources(
    sessionId: string,
    request: McpResourceListRequest,
  ): Promise<McpResourceListResult> {
    await this.requireSession(sessionId)
    return this.resourceClient.listResources(request)
  }

  async listImports(
    sessionId: string,
  ): Promise<readonly McpResourceImportManifest[]> {
    await this.requireSession(sessionId)
    return this.importStore.listSnapshots(sessionId)
  }

  async listSessionFiles(sessionId: string): Promise<readonly SessionFile[]> {
    await this.requireSession(sessionId)
    const files = await this.sessionStore.listFiles(sessionId)
    if (files.length === 0) return files
    const manifests = await this.importStore.selectProvenance(
      sessionId,
      files.map((file) => file.name),
    )
    const sourceByFilename = sourceIndex(manifests)
    return files.map((file) => {
      const source = sourceByFilename.get(file.name)
      return source ? { ...file, source } : file
    })
  }

  async importResource(
    request: ImportSessionMcpResourceRequest,
  ): Promise<ImportSessionMcpResourceResult> {
    await this.requireSession(request.sessionId)
    const read = await this.resourceClient.readResource({
      serverId: request.serverId,
      uri: request.uri,
      ...whenDefined(request.signal, (definedValue) => ({ signal: definedValue })),
    })
    if (request.signal?.aborted) {
      throw new McpResourceClientError('cancelled')
    }

    const inputsDir = this.sessionStore.inputsDir(request.sessionId)
    return withFileMutationLock(inputsDir, async () => {
      const imported = await this.importStore.importResource({
        sessionId: request.sessionId,
        result: read,
        ...(request.requestedInputBaseName
          ? { requestedInputBaseName: request.requestedInputBaseName }
          : {}),
      })
      const existingNames = new Set(
        (await this.sessionStore.listFiles(request.sessionId)).map((file) => file.name),
      )
      if (imported.materializedInputs.some((input) => existingNames.has(input.filename))) {
        throw new McpResourceImportServiceError('materialization_failed')
      }

      const savedNames: string[] = []
      try {
        for (const input of imported.materializedInputs) {
          if (request.signal?.aborted) {
            throw new McpResourceClientError('cancelled')
          }
          const saved = await this.sessionStore.saveUploadedFile(request.sessionId, {
            filename: input.filename,
            contents: input.buffer,
          })
          if (!saved) {
            throw new McpResourceImportServiceError('materialization_failed')
          }
          savedNames.push(saved.name)
        }
      } catch (error) {
        for (const filename of savedNames) {
          await this.sessionStore.deleteFile(request.sessionId, filename)
            .catch(() => false)
        }
        throw error
      }

      if (this.fileParserLauncher) {
        try {
          await this.fileParserLauncher.parseDirectory(inputsDir, {
            ...whenDefined(request.signal, (definedValue) => ({ signal: definedValue })),
          })
        } catch (error) {
          if (
            request.signal?.aborted
            || (error instanceof Error && error.name === 'AbortError')
          ) {
            throw new McpResourceClientError('cancelled')
          }
          throw new McpResourceImportServiceError('parse_failed')
        }
      }

      const files = await this.listSessionFiles(request.sessionId)
      const materializedNames = new Set(
        imported.materializedInputs.map((input) => input.filename),
      )
      return {
        files: files.filter((file) => materializedNames.has(file.name)),
        import: imported.manifest,
      }
    })
  }

  private async requireSession(sessionId: string): Promise<void> {
    if (!await this.sessionStore.getSession(sessionId)) {
      throw new McpResourceImportServiceError('not_found')
    }
  }
}

function sourceIndex(
  manifests: readonly McpResourceImportManifest[],
): Map<string, McpResourceSessionFileSource> {
  const result = new Map<string, McpResourceSessionFileSource>()
  for (const manifest of manifests) {
    for (const content of manifest.contents) {
      result.set(content.materializedInputFilename, {
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
      })
    }
  }
  return result
}

function importServiceErrorMessage(
  code: McpResourceImportServiceErrorCode,
): string {
  switch (code) {
    case 'invalid_request':
      return 'MCP resource import request is invalid.'
    case 'not_found':
      return 'Session was not found.'
    case 'materialization_failed':
      return 'MCP resource could not be materialized as session input.'
    case 'parse_failed':
      return 'MCP resource was imported, but parsing failed.'
  }
}

export function isMcpResourceImportBoundaryError(
  error: unknown,
): error is McpResourceImportServiceError | McpResourceClientError | McpResourceImportStoreError {
  return error instanceof McpResourceImportServiceError
    || error instanceof McpResourceClientError
    || error instanceof McpResourceImportStoreError
}
