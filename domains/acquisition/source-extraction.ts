import { createHash } from 'node:crypto'

import type {
  ExtractedFieldResult,
  ExtractionFieldProvenance,
  ExtractionMode,
  SourceExtractionResult,
} from './acquisition-types.js'
import type {
  SourceRepresentationManifest,
  SourceStructuredRepresentation,
} from './source-representations.js'
import { isUnknownArray } from '../../core/unknown-array.js'

const MAX_SCHEMA_BYTES = 64 * 1_024
const MAX_SCHEMA_DEPTH = 8
const MAX_LEAF_FIELDS = 100
const MAX_RAW_FIELD_CHARS = 4_000
const MAX_EXTRACTED_FIELD_BYTES = 8 * 1_024
const MAX_UNMAPPED_ITEMS = 50
const MAX_UNMAPPED_VALUE_CHARS = 2_000

const SUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  'title',
  'description',
  'type',
  'properties',
  'items',
  'enum',
  'format',
  'additionalProperties',
  'required',
  'default',
])

const SUPPORTED_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
])

export interface ValidatedExtractionSchema {
  readonly schema: Readonly<Record<string, unknown>>
  readonly schemaSha256: string
  readonly fields: readonly ExtractionFieldDefinition[]
}

export interface ExtractionFieldDefinition {
  readonly path: string
  readonly type: readonly string[]
  readonly schema: Readonly<Record<string, unknown>>
  readonly description?: string
  readonly enumValues?: readonly unknown[]
  readonly format?: string
}

export interface DeterministicExtraction {
  readonly result: SourceExtractionResult
  readonly unresolved: readonly ExtractionFieldDefinition[]
}

export interface ModelFieldCandidate {
  readonly path: string
  readonly status: 'present' | 'missing' | 'ambiguous' | 'incompatible'
  readonly value?: unknown
  readonly quote?: string
  readonly confidence?: number
  readonly message?: string
}

export function validateExtractionSchema(
  value: unknown,
): ValidatedExtractionSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Extraction schema must be an object.')
  }
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES) {
    throw new Error('Extraction schema exceeds the 64 KB limit.')
  }
  const schema = value as Readonly<Record<string, unknown>>
  const rootTypes = schemaTypes(schema.type)
  if (!rootTypes.includes('object') || !isRecord(schema.properties)) {
    throw new Error('Extraction schema must have an object root with properties.')
  }
  const fields: ExtractionFieldDefinition[] = []
  walkSchema(schema, '', 0, fields)
  if (fields.length < 1) {
    throw new Error('Extraction schema must define at least one leaf field.')
  }
  if (fields.length > MAX_LEAF_FIELDS) {
    throw new Error('Extraction schema exceeds the 100-field limit.')
  }
  return {
    schema,
    schemaSha256: createHash('sha256').update(serialized).digest('hex'),
    fields,
  }
}

export function validateRequiredFields(
  fields: readonly ExtractionFieldDefinition[],
  requiredFields: readonly string[] | undefined,
): readonly string[] {
  if (!requiredFields) return []
  if (!isBoundedFieldPathList(requiredFields)) {
    throw new Error('requiredFields must contain at most 100 bounded field paths.')
  }
  const known = new Set(fields.map((field) => field.path))
  const normalized = [...new Set(requiredFields.map((field) => field.trim()))]
  const unknown = normalized.find((field) => !known.has(field))
  if (unknown) {
    throw new Error(`Required field '${unknown}' is not defined by the schema.`)
  }
  return normalized
}

// Callers may pass untyped JSON, so the declared type is checked at runtime.
function isBoundedFieldPathList(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    value.length <= MAX_LEAF_FIELDS &&
    !value.some((field) =>
      typeof field !== 'string' ||
      !field.trim() ||
      field.length > 512)
}

export function extractDeterministically(params: {
  readonly extractionId: string
  readonly sourceReceiptId: string
  readonly sourceContentSha256: string
  readonly schema: ValidatedExtractionSchema
  readonly requiredFields: readonly string[]
  readonly mode: ExtractionMode
  readonly representations: SourceRepresentationManifest
}): DeterministicExtraction {
  const data: Record<string, unknown> = {}
  const fields: ExtractedFieldResult[] = []
  const usedPointers = new Set<string>()
  const unresolved: ExtractionFieldDefinition[] = []

  for (const field of params.schema.fields) {
    const candidates = findCandidates(field, params.representations.representations)
    const compatible = candidates.flatMap((candidate) => {
      const converted = compatibleValue(candidate.value, field)
      return converted.ok ? [{ ...candidate, value: converted.value }] : []
    })
    const incompatible = candidates.filter((candidate) =>
      !compatibleValue(candidate.value, field).ok)
    const distinct = distinctCandidates(compatible)
    if (distinct.length === 1) {
      const [candidate] = distinct
      if (!candidate) throw new Error('A single distinct extraction candidate must exist.')
      setPath(data, field.path, candidate.value)
      usedPointers.add(`${candidate.representationId}\0${candidate.pointer}`)
      fields.push({
        path: field.path,
        status: 'present',
        value: candidate.value,
        confidence: candidate.exactPath ? 1 : 0.9,
        provenance: [structuredProvenance(params.sourceReceiptId, candidate)],
      })
      continue
    }
    if (distinct.length > 1) {
      fields.push({
        path: field.path,
        status: 'conflicting',
        rawValue: boundRawValue(distinct.map((candidate) => candidate.value)),
        confidence: 0,
        provenance: distinct.map((candidate) =>
          structuredProvenance(params.sourceReceiptId, candidate)),
        message: 'Stored structured representations contain conflicting values.',
      })
      unresolved.push(field)
      continue
    }
    if (incompatible.length > 0) {
      fields.push({
        path: field.path,
        status: 'incompatible',
        rawValue: boundRawValue(incompatible.map((candidate) => candidate.value)),
        confidence: 0,
        provenance: incompatible.map((candidate) =>
          structuredProvenance(params.sourceReceiptId, candidate)),
        message: 'A candidate value exists but does not match the requested type.',
      })
      unresolved.push(field)
      continue
    }
    fields.push({
      path: field.path,
      status: 'missing',
      confidence: 0,
      provenance: [],
    })
    unresolved.push(field)
  }

  const requirementsMet = params.requiredFields.every((path) =>
    fields.some((field) => field.path === path && field.status === 'present'))
  return {
    result: {
      schemaVersion: 1,
      extractionId: params.extractionId,
      sourceReceiptId: params.sourceReceiptId,
      sourceContentSha256: params.sourceContentSha256,
      schemaSha256: params.schema.schemaSha256,
      mode: params.mode,
      complete: fields.every((field) => field.status === 'present'),
      requirementsMet,
      data,
      fields,
      unmappedData: collectUnmapped(
        params.representations.representations,
        usedPointers,
      ),
      methodsAttempted: ['deterministic'],
      warnings: [...params.representations.warnings],
    },
    unresolved,
  }
}

export function applyModelCandidates(params: {
  readonly base: SourceExtractionResult
  readonly definitions: readonly ExtractionFieldDefinition[]
  readonly requiredFields: readonly string[]
  readonly candidates: readonly ModelFieldCandidate[]
  readonly content: string
  readonly repaired: boolean
}): SourceExtractionResult {
  const definitions = new Map(params.definitions.map((field) => [field.path, field]))
  const candidates = new Map(params.candidates.map((field) => [field.path, field]))
  const data = structuredClone(params.base.data) as Record<string, unknown>
  const fields = params.base.fields.map((current): ExtractedFieldResult => {
    if (current.status === 'present') return current
    const definition = definitions.get(current.path)
    const candidate = candidates.get(current.path)
    if (!definition || !candidate) return current
    if (candidate.status !== 'present') {
      if (current.status !== 'missing') return current
      return {
        ...current,
        status: candidate.status,
        ...(candidate.value !== undefined
          ? { rawValue: boundRawValue(candidate.value) }
          : {}),
        ...(candidate.message ? { message: candidate.message } : {}),
      }
    }
    const converted = compatibleValue(candidate.value, definition)
    if (!converted.ok) {
      return {
        path: current.path,
        status: 'incompatible',
        rawValue: boundRawValue(candidate.value),
        confidence: 0,
        provenance: [],
        message: 'The model value does not match the requested field type.',
      }
    }
    const quote = candidate.quote?.normalize('NFC').trim()
    if (!quote || !normalizedEvidence(params.content).includes(normalizedEvidence(quote))) {
      return {
        path: current.path,
        status: 'invalid_evidence',
        rawValue: boundRawValue(candidate.value),
        confidence: 0,
        provenance: [],
        message: 'The model value was not supported by a verifiable source quote.',
      }
    }
    setPath(data, current.path, converted.value)
    return {
      path: current.path,
      status: 'present',
      value: converted.value,
      confidence: boundedConfidence(candidate.confidence),
      provenance: [{
        sourceReceiptId: params.base.sourceReceiptId,
        representationId: 'content-markdown',
        quote: quote.slice(0, 2_000),
        method: 'model',
      }],
      ...(candidate.message ? { message: candidate.message } : {}),
    }
  })
  const requirementsMet = params.requiredFields.every((path) =>
    fields.some((field) => field.path === path && field.status === 'present'))
  return {
    ...params.base,
    complete: fields.every((field) => field.status === 'present'),
    requirementsMet,
    data,
    fields,
    methodsAttempted: [
      ...params.base.methodsAttempted,
      'model',
      ...(params.repaired ? ['model-repair' as const] : []),
    ],
  }
}

export function markModelUnsupported(
  result: SourceExtractionResult,
  paths: readonly string[],
  warning: string,
): SourceExtractionResult {
  const targets = new Set(paths)
  return {
    ...result,
    fields: result.fields.map((field) =>
      targets.has(field.path) && field.status === 'missing'
        ? {
            ...field,
            status: 'unsupported',
            message: warning,
          }
        : field),
    warnings: [...result.warnings, warning],
  }
}

export function modelExtractionOutputSchema(): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['fields'],
    properties: {
      fields: {
        type: 'array',
        maxItems: MAX_LEAF_FIELDS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'path',
            'status',
            'valueJson',
            'quote',
            'confidence',
            'message',
          ],
          properties: {
            path: { type: 'string' },
            status: {
              type: 'string',
              enum: ['present', 'missing', 'ambiguous', 'incompatible'],
            },
            valueJson: { type: ['string', 'null'] },
            quote: { type: ['string', 'null'] },
            confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
            message: { type: ['string', 'null'] },
          },
        },
      },
    },
  }
}

export function parseModelExtractionOutput(
  text: string,
  allowedFields: readonly string[],
): readonly ModelFieldCandidate[] {
  const value = parseJsonText(text)
  if (!isRecord(value) || !Array.isArray(value.fields)) {
    throw new Error('Model extraction output must contain a fields array.')
  }
  const allowed = new Set(allowedFields)
  const seen = new Set<string>()
  return value.fields.map((entry): ModelFieldCandidate => {
    if (!isRecord(entry)) throw new Error('Model extraction field must be an object.')
    const path = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (!allowed.has(path) || seen.has(path)) {
      throw new Error('Model extraction returned an unknown or duplicate field path.')
    }
    seen.add(path)
    if (!['present', 'missing', 'ambiguous', 'incompatible'].includes(
      String(entry.status),
    )) {
      throw new Error('Model extraction returned an invalid field status.')
    }
    let parsedValue: unknown
    if (typeof entry.valueJson === 'string') {
      try {
        parsedValue = JSON.parse(entry.valueJson)
      } catch {
        throw new Error(`Model extraction value for '${path}' is not valid JSON.`)
      }
    }
    return {
      path,
      status: entry.status as ModelFieldCandidate['status'],
      ...(entry.valueJson !== null ? { value: parsedValue } : {}),
      ...(typeof entry.quote === 'string' ? { quote: entry.quote } : {}),
      ...(typeof entry.confidence === 'number'
        ? { confidence: entry.confidence }
        : {}),
      ...(typeof entry.message === 'string' ? { message: entry.message } : {}),
    }
  })
}

function walkSchema(
  schema: Readonly<Record<string, unknown>>,
  prefix: string,
  depth: number,
  output: ExtractionFieldDefinition[],
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new Error('Extraction schema exceeds eight nesting levels.')
  }
  validateSchemaShape(schema)
  const unknownKey = Object.keys(schema).find((key) => !SUPPORTED_SCHEMA_KEYS.has(key))
  if (unknownKey) {
    throw new Error(`Extraction schema keyword '${unknownKey}' is unsupported.`)
  }
  if ('$ref' in schema || 'oneOf' in schema || 'anyOf' in schema || 'allOf' in schema) {
    throw new Error('Extraction schema references and combinators are unsupported.')
  }
  const types = schemaTypes(schema.type)
  if (types.some((type) => !SUPPORTED_TYPES.has(type))) {
    throw new Error('Extraction schema contains an unsupported type.')
  }
  if (types.includes('object')) {
    if (!isRecord(schema.properties)) {
      throw new Error('Object fields must define properties.')
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!key.trim() || key.includes('.') || !isRecord(child)) {
        throw new Error('Extraction schema property names and definitions are invalid.')
      }
      const path = prefix ? `${prefix}.${key}` : key
      const childTypes = schemaTypes(child.type)
      if (childTypes.includes('object')) {
        walkSchema(child, path, depth + 1, output)
      } else {
        validateLeafSchema(child)
        output.push({
          path,
          type: childTypes,
          schema: child,
          ...(typeof child.description === 'string'
            ? { description: child.description.slice(0, 2_000) }
            : {}),
          ...(isUnknownArray(child.enum) ? { enumValues: child.enum } : {}),
          ...(typeof child.format === 'string' ? { format: child.format } : {}),
        })
      }
    }
  }
}

function validateLeafSchema(schema: Readonly<Record<string, unknown>>): void {
  validateSchemaShape(schema)
  const unknownKey = Object.keys(schema).find((key) => !SUPPORTED_SCHEMA_KEYS.has(key))
  if (unknownKey) {
    throw new Error(`Extraction schema keyword '${unknownKey}' is unsupported.`)
  }
  const types = schemaTypes(schema.type)
  if (types.length === 0 || types.includes('object')) {
    throw new Error('Leaf fields must declare a supported non-object type.')
  }
  if (types.includes('array')) {
    if (!isRecord(schema.items)) {
      throw new Error('Array fields must define an items schema.')
    }
    validateSchemaNode(schema.items, 1)
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length > 50)) {
    throw new Error('Field enum must contain at most 50 values.')
  }
}

function validateSchemaNode(
  schema: Readonly<Record<string, unknown>>,
  depth: number,
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new Error('Extraction schema exceeds eight nesting levels.')
  }
  validateSchemaShape(schema)
  const unknownKey = Object.keys(schema).find((key) => !SUPPORTED_SCHEMA_KEYS.has(key))
  if (unknownKey) throw new Error(`Extraction schema keyword '${unknownKey}' is unsupported.`)
  const types = schemaTypes(schema.type)
  if (types.length === 0 || types.some((type) => !SUPPORTED_TYPES.has(type))) {
    throw new Error('Array item schema contains an unsupported type.')
  }
  if (types.includes('array')) {
    if (!isRecord(schema.items)) throw new Error('Nested arrays must define items.')
    validateSchemaNode(schema.items, depth + 1)
  }
  if (types.includes('object')) {
    if (!isRecord(schema.properties)) throw new Error('Object items must define properties.')
    for (const child of Object.values(schema.properties)) {
      if (!isRecord(child)) throw new Error('Object item property is invalid.')
      validateSchemaNode(child, depth + 1)
    }
  }
}

function validateSchemaShape(schema: Readonly<Record<string, unknown>>): void {
  const properties = isRecord(schema.properties) ? schema.properties : null
  if (
    schema.required !== undefined &&
    (
      !Array.isArray(schema.required) ||
      schema.required.length > MAX_LEAF_FIELDS ||
      schema.required.some((entry) =>
        typeof entry !== 'string' || !entry.trim() || entry.length > 512)
    )
  ) {
    throw new Error('Schema required entries are invalid.')
  }
  if (
    Array.isArray(schema.required) &&
    properties &&
    schema.required.some((entry) =>
      typeof entry === 'string' && !(entry in properties))
  ) {
    throw new Error('Schema required entries must name defined properties.')
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean'
  ) {
    throw new Error('Schema additionalProperties must be a boolean.')
  }
  for (const field of ['$schema', 'title', 'description', 'format'] as const) {
    if (
      schema[field] !== undefined &&
      (
        typeof schema[field] !== 'string' ||
        schema[field].length > 2_000
      )
    ) {
      throw new Error(`Schema ${field} must be a bounded string.`)
    }
  }
}

interface Candidate {
  readonly representationId: string
  readonly pointer: string
  readonly value: unknown
  readonly exactPath: boolean
}

function findCandidates(
  field: ExtractionFieldDefinition,
  representations: readonly SourceStructuredRepresentation[],
): Candidate[] {
  const exact: Candidate[] = []
  const fuzzy: Candidate[] = []
  const segments = field.path.split('.')
  const leaf = normalizeKey(segments.at(-1) ?? '')
  for (const representation of representations) {
    const exactValue = getPath(representation.data, segments)
    if (exactValue.found) {
      exact.push({
        representationId: representation.id,
        pointer: exactValue.pointer,
        value: exactValue.value,
        exactPath: true,
      })
      continue
    }
    walkValues(representation.data, '', (pointer, key, value) => {
      if (normalizeKey(key) === leaf) {
        fuzzy.push({
          representationId: representation.id,
          pointer,
          value,
          exactPath: false,
        })
      }
    })
  }
  return exact.length > 0 ? exact : fuzzy
}

function compatibleValue(
  value: unknown,
  field: ExtractionFieldDefinition,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const converted = convertAgainstSchema(value, field.schema)
  if (
    !converted.ok ||
    serializedBytes(converted.value) > MAX_EXTRACTED_FIELD_BYTES
  ) {
    return { ok: false }
  }
  return converted
}

function distinctCandidates(candidates: readonly Candidate[]): Candidate[] {
  const unique = new Map<string, Candidate>()
  for (const candidate of candidates) {
    unique.set(safeSerialize(candidate.value), candidate)
  }
  return [...unique.values()]
}

function structuredProvenance(
  sourceReceiptId: string,
  candidate: Candidate,
): ExtractionFieldProvenance {
  return {
    sourceReceiptId,
    representationId: candidate.representationId,
    pointer: candidate.pointer,
    method: 'deterministic',
  }
}

function collectUnmapped(
  representations: readonly SourceStructuredRepresentation[],
  used: ReadonlySet<string>,
): SourceExtractionResult['unmappedData'] {
  const result: Array<{
    representationId: string
    pointer: string
    value: unknown
  }> = []
  for (const representation of representations) {
    walkValues(representation.data, '', (pointer, _key, value) => {
      if (
        result.length < MAX_UNMAPPED_ITEMS &&
        !used.has(`${representation.id}\0${pointer}`) &&
        isPrimitive(value)
      ) {
        result.push({
          representationId: representation.id,
          pointer,
          value: boundUnmappedValue(value),
        })
      }
    })
    if (result.length >= MAX_UNMAPPED_ITEMS) break
  }
  return result
}

function walkValues(
  value: unknown,
  pointer: string,
  visit: (pointer: string, key: string, value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      walkValues(child, `${pointer}/${index}`, visit)
    }
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${escapePointer(key)}`
    visit(childPointer, key, child)
    walkValues(child, childPointer, visit)
  }
}

function getPath(
  value: unknown,
  segments: readonly string[],
): { readonly found: boolean; readonly value?: unknown; readonly pointer: string } {
  let current = value
  let pointer = ''
  for (const segment of segments) {
    if (!isRecord(current)) return { found: false, pointer }
    const exactKey = Object.keys(current).find((key) => normalizeKey(key) === normalizeKey(segment))
    if (!exactKey) return { found: false, pointer }
    current = current[exactKey]
    pointer += `/${escapePointer(exactKey)}`
  }
  return { found: true, value: current, pointer }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  const leaf = segments.at(-1)
  if (leaf === undefined) throw new Error('Extraction field path must have a leaf segment.')
  let current = target
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment]
    if (!isRecord(next)) current[segment] = {}
    current = current[segment] as Record<string, unknown>
  }
  current[leaf] = value
}

function schemaTypes(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? [...new Set(value)]
    : []
}

function boundRawValue(value: unknown): unknown {
  const serialized = safeSerialize(value)
  return serialized.length <= MAX_RAW_FIELD_CHARS
    ? value
    : `${serialized.slice(0, MAX_RAW_FIELD_CHARS)}…`
}

function convertAgainstSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const types = schemaTypes(schema.type)
  for (const type of types) {
    const exact = convertExactType(value, type, schema)
    if (exact.ok && matchesEnum(exact.value, schema.enum)) return exact
  }
  for (const type of types) {
    const coerced = coercePrimitive(value, type)
    if (coerced.ok && matchesEnum(coerced.value, schema.enum)) return coerced
  }
  return { ok: false }
}

function convertExactType(
  value: unknown,
  type: string,
  schema: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (type === 'null') {
    return value === null ? { ok: true, value: null } : { ok: false }
  }
  if (type === 'string') {
    return typeof value === 'string' ? { ok: true, value } : { ok: false }
  }
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      ? { ok: true, value }
      : { ok: false }
  }
  if (type === 'integer') {
    return Number.isSafeInteger(value)
      ? { ok: true, value }
      : { ok: false }
  }
  if (type === 'boolean') {
    return typeof value === 'boolean' ? { ok: true, value } : { ok: false }
  }
  if (type === 'array') {
    if (!Array.isArray(value) || !isRecord(schema.items)) return { ok: false }
    const converted: unknown[] = []
    for (const item of value) {
      const result = convertAgainstSchema(item, schema.items)
      if (!result.ok) return { ok: false }
      converted.push(result.value)
    }
    return { ok: true, value: converted }
  }
  if (type === 'object') {
    if (!isRecord(value) || !isRecord(schema.properties)) return { ok: false }
    const converted: Record<string, unknown> =
      schema.additionalProperties === false ? {} : { ...value }
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : []
    if (required.some((key) => !(key in value))) return { ok: false }
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (!(key in value)) continue
      if (!isRecord(childSchema)) return { ok: false }
      const child = convertAgainstSchema(value[key], childSchema)
      if (!child.ok) return { ok: false }
      converted[key] = child.value
    }
    return { ok: true, value: converted }
  }
  return { ok: false }
}

function coercePrimitive(
  value: unknown,
  type: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (type === 'string' && isPrimitive(value) && value !== null) {
    return { ok: true, value: String(value) }
  }
  if (
    (type === 'number' || type === 'integer') &&
    typeof value === 'string' &&
    value.trim() &&
    Number.isFinite(Number(value))
  ) {
    const converted = Number(value)
    return type === 'integer' && !Number.isSafeInteger(converted)
      ? { ok: false }
      : { ok: true, value: converted }
  }
  if (
    type === 'boolean' &&
    typeof value === 'string' &&
    /^(?:true|false)$/iu.test(value.trim())
  ) {
    return { ok: true, value: value.trim().toLowerCase() === 'true' }
  }
  return { ok: false }
}

function matchesEnum(value: unknown, enumValue: unknown): boolean {
  return !Array.isArray(enumValue) ||
    enumValue.some((candidate) => safeSerialize(candidate) === safeSerialize(value))
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(safeSerialize(value), 'utf8')
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function boundUnmappedValue(value: unknown): unknown {
  return typeof value === 'string' && value.length > MAX_UNMAPPED_VALUE_CHARS
    ? `${value.slice(0, MAX_UNMAPPED_VALUE_CHARS)}…`
    : value
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim()
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
  return JSON.parse(unfenced)
}

function boundedConfidence(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0.7
}

function normalizedEvidence(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

function normalizeKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '')
}

function escapePointer(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}
