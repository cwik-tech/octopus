import { isValidWorkspaceProjectId } from '../projects.js'
import type {
  BatchDefinitionInput,
  CreateBatchRequest,
  PatchBatchRequest,
  RevokeBatchFolderGrantRequest,
} from '../batches.js'

const DEFINITION_KEYS = [
  'name',
  'workflowId',
  'folderPath',
  'fileExtensions',
  'rerunPolicy',
  'projectId',
] as const

export class BatchRequestValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BatchRequestValidationError'
  }
}

export function parseCreateBatchRequest(value: unknown): CreateBatchRequest {
  const source = record(value, 'Batch request must be a JSON object.')
  exactKeys(source, DEFINITION_KEYS, 'Batch request')
  return parseDefinitionFields(source, true) as CreateBatchRequest
}

export function parsePatchBatchRequest(value: unknown): PatchBatchRequest {
  const source = record(value, 'Batch patch must be a JSON object.')
  exactKeys(source, ['expectedRevision', ...DEFINITION_KEYS], 'Batch patch')
  if (!Number.isSafeInteger(source.expectedRevision) || (source.expectedRevision as number) < 1) {
    throw new BatchRequestValidationError("Batch patch field 'expectedRevision' must be a positive integer.")
  }
  const changes = Object.keys(source).filter((key) => key !== 'expectedRevision')
  if (changes.length === 0) {
    throw new BatchRequestValidationError('Batch patch must contain at least one change.')
  }
  const parsed = parseDefinitionFields(source, false)
  return { expectedRevision: source.expectedRevision as number, ...parsed }
}

export function parseEmptyBatchRequest(value: unknown): Record<string, never> {
  if (value === undefined) return {}
  const source = record(value, 'Batch action request must be a JSON object.')
  exactKeys(source, [], 'Batch action request')
  return {}
}

export function parseRevokeBatchFolderGrantRequest(value: unknown): RevokeBatchFolderGrantRequest {
  const source = record(value, 'Batch grant request must be a JSON object.')
  exactKeys(source, ['path'], 'Batch grant request')
  if (typeof source.path !== 'string' || !isAbsolutePath(source.path)) {
    throw new BatchRequestValidationError("Batch grant request field 'path' must be an absolute path.")
  }
  return { path: source.path }
}

function parseDefinitionFields(
  source: Record<string, unknown>,
  required: boolean,
): Partial<BatchDefinitionInput> & { projectId?: string | null } {
  const result: Record<string, unknown> = {}
  for (const [key, max] of [
    ['name', 120],
    ['workflowId', 300],
  ] as const) {
    if (!(key in source)) {
      if (required) throw new BatchRequestValidationError(`Batch request field '${key}' is required.`)
      continue
    }
    if (typeof source[key] !== 'string' || !source[key].trim() || source[key].length > max) {
      throw new BatchRequestValidationError(`Batch request field '${key}' must be a non-empty string.`)
    }
    result[key] = source[key].trim()
  }
  if (!('folderPath' in source)) {
    if (required) throw new BatchRequestValidationError("Batch request field 'folderPath' is required.")
  } else if (typeof source.folderPath !== 'string' || !isAbsolutePath(source.folderPath)) {
    throw new BatchRequestValidationError("Batch request field 'folderPath' must be an absolute path.")
  } else {
    result.folderPath = source.folderPath
  }
  if (!('fileExtensions' in source)) {
    if (required) throw new BatchRequestValidationError("Batch request field 'fileExtensions' is required.")
  } else if (!Array.isArray(source.fileExtensions)) {
    throw new BatchRequestValidationError("Batch request field 'fileExtensions' must be an array.")
  } else {
    const extensions = source.fileExtensions.map((raw) => {
      if (typeof raw !== 'string') {
        throw new BatchRequestValidationError('Batch request contains an invalid extension.')
      }
      const normalized = raw.startsWith('.') ? raw.toLowerCase() : `.${raw.toLowerCase()}`
      if (!/^\.[a-z0-9][a-z0-9._+-]{0,19}$/.test(normalized)) {
        throw new BatchRequestValidationError('Batch request contains an invalid extension.')
      }
      return normalized
    })
    if (new Set(extensions).size !== extensions.length) {
      throw new BatchRequestValidationError('Batch request contains duplicate extensions.')
    }
    result.fileExtensions = extensions
  }
  if (!('rerunPolicy' in source)) {
    if (required) throw new BatchRequestValidationError("Batch request field 'rerunPolicy' is required.")
  } else if (
    source.rerunPolicy !== 'new_only' &&
    source.rerunPolicy !== 'new_and_changed' &&
    source.rerunPolicy !== 'always'
  ) {
    throw new BatchRequestValidationError("Batch request field 'rerunPolicy' is invalid.")
  } else {
    result.rerunPolicy = source.rerunPolicy
  }
  if ('projectId' in source) {
    if (source.projectId === null && !required) {
      result.projectId = null
    } else if (typeof source.projectId !== 'string' || !isValidWorkspaceProjectId(source.projectId)) {
      throw new BatchRequestValidationError("Batch request field 'projectId' must be a UUID.")
    } else {
      result.projectId = source.projectId
    }
  }
  return result as Partial<BatchDefinitionInput> & { projectId?: string | null }
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BatchRequestValidationError(message)
  }
  return value as Record<string, unknown>
}

function exactKeys(source: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new BatchRequestValidationError(`${label} contains unknown fields: ${unknown.join(', ')}.`)
  }
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}
