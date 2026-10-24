import { createHash } from 'node:crypto'
import { isUnknownArray } from '../../core/unknown-array.js'

export const MCP_ELICITATION_STATE_VERSION = 1 as const

const MAX_IDENTIFIER_LENGTH = 512
const MAX_MESSAGE_LENGTH = 4_096
const MAX_TITLE_LENGTH = 256
const MAX_DESCRIPTION_LENGTH = 2_048
const MAX_FORM_FIELDS = 64
const MAX_PROPERTY_NAME_LENGTH = 128
const MAX_SCHEMA_BYTES = 64 * 1_024
const MAX_STRING_VALUE_LENGTH = 1_048_576
const MAX_ENUM_OPTIONS = 256
const MAX_ENUM_VALUE_LENGTH = 2_048
const MAX_MULTI_SELECT_VALUES = 256
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const UNSAFE_TEXT_CONTROL = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/
const URL_CONTROL_OR_SPACE = /[\0-\x20\x7f]/

export type McpElicitationStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'expired'
  | 'interrupted'

export type McpElicitationAction = 'accept' | 'decline' | 'cancel'

export interface McpElicitationAssignmentScope {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
}

export interface McpElicitationContext extends McpElicitationAssignmentScope {
  readonly agentPath: string
}

/** Exact correlation supplied by the parent broker for every response. */
export interface McpElicitationExactBinding extends McpElicitationContext {
  readonly interactionId: string
  readonly serverId: string
  readonly parentRequestId: string
  readonly toolCallId: string
  readonly namespacedToolName: string
}

interface McpElicitationFieldBase {
  readonly title?: string
  readonly description?: string
}

export type McpElicitationStringFormat =
  | 'date'
  | 'date-time'
  | 'email'
  | 'uri'

export interface McpElicitationStringFieldSchema
  extends McpElicitationFieldBase {
  readonly type: 'string'
  readonly minLength?: number
  readonly maxLength?: number
  readonly format?: McpElicitationStringFormat
  readonly default?: string
}

export interface McpElicitationStringEnumFieldSchema
  extends McpElicitationFieldBase {
  readonly type: 'string'
  readonly enum: readonly string[]
  readonly default?: string
}

export interface McpElicitationTitledStringEnumOption {
  readonly const: string
  readonly title: string
}

export interface McpElicitationTitledStringEnumFieldSchema
  extends McpElicitationFieldBase {
  readonly type: 'string'
  readonly oneOf: readonly McpElicitationTitledStringEnumOption[]
  readonly default?: string
}

export interface McpElicitationNumberFieldSchema
  extends McpElicitationFieldBase {
  readonly type: 'number' | 'integer'
  readonly minimum?: number
  readonly maximum?: number
  readonly default?: number
}

export interface McpElicitationBooleanFieldSchema
  extends McpElicitationFieldBase {
  readonly type: 'boolean'
  readonly default?: boolean
}

export interface McpElicitationUntitledMultiSelectItems {
  readonly type: 'string'
  readonly enum: readonly string[]
}

export interface McpElicitationTitledMultiSelectItems {
  readonly anyOf: readonly McpElicitationTitledStringEnumOption[]
}

export interface McpElicitationMultiSelectFieldSchema
  extends McpElicitationFieldBase {
  readonly type: 'array'
  readonly minItems?: number
  readonly maxItems?: number
  readonly items:
    | McpElicitationUntitledMultiSelectItems
    | McpElicitationTitledMultiSelectItems
  readonly default?: readonly string[]
}

export type McpElicitationFormFieldSchema =
  | McpElicitationStringFieldSchema
  | McpElicitationStringEnumFieldSchema
  | McpElicitationTitledStringEnumFieldSchema
  | McpElicitationNumberFieldSchema
  | McpElicitationBooleanFieldSchema
  | McpElicitationMultiSelectFieldSchema

/** Restricted MCP form schema. Nested objects and arbitrary JSON Schema are rejected. */
export interface McpElicitationFormSchema {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, McpElicitationFormFieldSchema>>
  readonly required: readonly string[]
  readonly additionalProperties: false
}

export type McpElicitationFormValue =
  | string
  | number
  | boolean
  | readonly string[]

export type McpElicitationFormValues = Readonly<
  Record<string, McpElicitationFormValue>
>

export interface McpElicitationValuesHash {
  readonly algorithm: 'sha256'
  readonly value: string
}

interface McpElicitationRequestBase extends McpElicitationExactBinding {
  readonly message: string
  readonly ttlMs?: number
}

export type McpElicitationRequestInput =
  | (McpElicitationRequestBase & {
      readonly mode: 'form'
      readonly schema: unknown
    })
  | (McpElicitationRequestBase & {
      readonly mode: 'url'
      readonly url: string
      readonly elicitationId: string
    })

type McpElicitationResponseBase = McpElicitationExactBinding & {
  readonly responseId: string
}

export type McpElicitationResponseInput =
  | (McpElicitationResponseBase & {
      readonly mode: 'form'
      readonly action: 'accept'
      /** Ephemeral input. It is validated and hashed, but never retained. */
      readonly values: unknown
    })
  | (McpElicitationResponseBase & {
      readonly mode: 'form'
      readonly action: 'decline' | 'cancel'
      readonly values?: never
    })
  | (McpElicitationResponseBase & {
      readonly mode: 'url'
      readonly elicitationId: string
      readonly action: McpElicitationAction
      readonly values?: never
    })

interface McpElicitationViewBase extends McpElicitationExactBinding {
  readonly kind: 'elicitation'
  readonly message: string
  readonly status: McpElicitationStatus
  readonly createdAt: string
  readonly expiresAt: string
  readonly resolvedAt?: string
  readonly action?: McpElicitationAction
}

export interface McpElicitationFormView extends McpElicitationViewBase {
  readonly mode: 'form'
  readonly schema: McpElicitationFormSchema
}

export interface McpElicitationUrlView extends McpElicitationViewBase {
  readonly mode: 'url'
  readonly url: string
  readonly elicitationId: string
}

/** Safe persisted/API view. Form response values and their digest are absent. */
export type McpElicitationView =
  | McpElicitationFormView
  | McpElicitationUrlView

/** `values` exists only on the immediate successful form-accept call. */
export type McpElicitationResponseResult =
  | {
      readonly view: McpElicitationFormView
      readonly values: McpElicitationFormValues
    }
  | {
      readonly view: McpElicitationView
    }

export type McpElicitationErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'binding_mismatch'
  | 'already_resolved'
  | 'expired'
  | 'capacity_exceeded'
  | 'storage_invalid'

export class McpElicitationError extends Error {
  readonly code: McpElicitationErrorCode

  constructor(code: McpElicitationErrorCode) {
    super(elicitationErrorMessage(code))
    this.name = 'McpElicitationError'
    this.code = code
  }
}

export function normalizeMcpElicitationIdentifier(value: unknown): string {
  if (!isMcpElicitationIdentifier(value)) {
    throw new McpElicitationError('invalid_request')
  }
  return value
}

export function isMcpElicitationIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !/[\0-\x1f\x7f]/.test(value)
  )
}

export function normalizeMcpElicitationMessage(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_MESSAGE_LENGTH ||
    value.trim().length === 0 ||
    UNSAFE_TEXT_CONTROL.test(value)
  ) {
    throw new McpElicitationError('invalid_request')
  }
  return value
}

export function normalizeMcpElicitationUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    URL_CONTROL_OR_SPACE.test(value) ||
    value.includes('\\') ||
    value.includes('#')
  ) {
    throw new McpElicitationError('invalid_request')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new McpElicitationError('invalid_request')
  }
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1]
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname ||
    !authority ||
    authority.includes('@') ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.href.length > 4_096
  ) {
    throw new McpElicitationError('invalid_request')
  }
  return parsed.href
}

export function normalizeMcpElicitationFormSchema(
  value: unknown,
): McpElicitationFormSchema {
  try {
    const schema = requireStrictRecord(value)
    if (
      !hasOnlyKeys(schema, [
        'type',
        'properties',
        'required',
        'additionalProperties',
      ]) ||
      schema.type !== 'object' ||
      (hasOwn(schema, 'additionalProperties') &&
        schema.additionalProperties !== false)
    ) {
      throw new McpElicitationError('invalid_request')
    }
    const rawProperties = requireStrictRecord(schema.properties)
    const propertyNames = Object.keys(rawProperties).sort()
    if (propertyNames.length > MAX_FORM_FIELDS) {
      throw new McpElicitationError('invalid_request')
    }
    const properties: Record<string, McpElicitationFormFieldSchema> = {}
    for (const propertyName of propertyNames) {
      assertPropertyName(propertyName)
      properties[propertyName] = normalizeFieldSchema(
        rawProperties[propertyName],
      )
    }

    const required = hasOwn(schema, 'required')
      ? normalizeRequired(schema.required, new Set(propertyNames))
      : []
    const normalized: McpElicitationFormSchema = {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    }
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_SCHEMA_BYTES) {
      throw new McpElicitationError('invalid_request')
    }
    return normalized
  } catch (error) {
    if (error instanceof McpElicitationError) throw error
    throw new McpElicitationError('invalid_request')
  }
}

export function validateMcpElicitationFormValues(
  schemaValue: McpElicitationFormSchema,
  valuesValue: unknown,
): McpElicitationFormValues {
  const schema = normalizeMcpElicitationFormSchema(schemaValue)
  try {
    const values = requireStrictRecord(valuesValue)
    const valueNames = Object.keys(values).sort()
    const propertyNames = new Set(Object.keys(schema.properties))
    if (valueNames.some((name) => !propertyNames.has(name))) {
      throw new McpElicitationError('invalid_request')
    }
    if (schema.required.some((name) => !hasOwn(values, name))) {
      throw new McpElicitationError('invalid_request')
    }

    const normalized: Record<string, McpElicitationFormValue> = {}
    for (const name of valueNames) {
      // Unreachable: every value name was checked against the schema's properties above.
      const fieldSchema = schema.properties[name]
      if (!fieldSchema) throw new McpElicitationError('invalid_request')
      normalized[name] = validateFieldValue(fieldSchema, values[name])
    }
    return normalized
  } catch (error) {
    if (error instanceof McpElicitationError) throw error
    throw new McpElicitationError('invalid_request')
  }
}

export function hashMcpElicitationFormValues(
  schema: McpElicitationFormSchema,
  value: unknown,
): {
  readonly values: McpElicitationFormValues
  readonly valuesHash: McpElicitationValuesHash
} {
  const values = validateMcpElicitationFormValues(schema, value)
  const canonical = `{${Object.keys(values)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(values[key])}`)
    .join(',')}}`
  return {
    values,
    valuesHash: {
      algorithm: 'sha256',
      value: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    },
  }
}

export function isMcpElicitationValuesHash(
  value: unknown,
): value is McpElicitationValuesHash {
  const record = asStrictRecord(value)
  return Boolean(
    record &&
      hasExactKeys(record, ['algorithm', 'value']) &&
      record.algorithm === 'sha256' &&
      typeof record.value === 'string' &&
      /^[a-f0-9]{64}$/.test(record.value),
  )
}

export function isMcpElicitationStatus(
  value: unknown,
): value is McpElicitationStatus {
  return (
    value === 'pending' ||
    value === 'accepted' ||
    value === 'declined' ||
    value === 'cancelled' ||
    value === 'expired' ||
    value === 'interrupted'
  )
}

export function isMcpElicitationAction(
  value: unknown,
): value is McpElicitationAction {
  return value === 'accept' || value === 'decline' || value === 'cancel'
}

function normalizeFieldSchema(value: unknown): McpElicitationFormFieldSchema {
  const field = requireStrictRecord(value)
  if (field.type === 'string') return normalizeStringField(field)
  if (field.type === 'number' || field.type === 'integer') {
    return normalizeNumberField(field)
  }
  if (field.type === 'boolean') return normalizeBooleanField(field)
  if (field.type === 'array') return normalizeMultiSelectField(field)
  throw new McpElicitationError('invalid_request')
}

function normalizeStringField(
  field: Record<string, unknown>,
): McpElicitationFormFieldSchema {
  const base = normalizeFieldBase(field)
  if (hasOwn(field, 'enum')) {
    if (
      !hasOnlyKeys(field, [
        'type',
        'title',
        'description',
        'enum',
        'default',
      ])
    ) {
      throw new McpElicitationError('invalid_request')
    }
    const options = normalizeStringOptions(field.enum)
    const normalized: McpElicitationStringEnumFieldSchema = {
      type: 'string',
      ...base,
      enum: options,
      ...(hasOwn(field, 'default')
        ? { default: requireEnumDefault(field.default, options) }
        : {}),
    }
    return normalized
  }
  if (hasOwn(field, 'oneOf')) {
    if (
      !hasOnlyKeys(field, [
        'type',
        'title',
        'description',
        'oneOf',
        'default',
      ])
    ) {
      throw new McpElicitationError('invalid_request')
    }
    const options = normalizeTitledOptions(field.oneOf)
    const constants = options.map((option) => option.const)
    const normalized: McpElicitationTitledStringEnumFieldSchema = {
      type: 'string',
      ...base,
      oneOf: options,
      ...(hasOwn(field, 'default')
        ? { default: requireEnumDefault(field.default, constants) }
        : {}),
    }
    return normalized
  }
  if (
    !hasOnlyKeys(field, [
      'type',
      'title',
      'description',
      'minLength',
      'maxLength',
      'format',
      'default',
    ])
  ) {
    throw new McpElicitationError('invalid_request')
  }
  const minLength = hasOwn(field, 'minLength')
    ? requireBoundedNonNegativeInteger(field.minLength, MAX_STRING_VALUE_LENGTH)
    : undefined
  const maxLength = hasOwn(field, 'maxLength')
    ? requireBoundedNonNegativeInteger(field.maxLength, MAX_STRING_VALUE_LENGTH)
    : undefined
  if (
    minLength !== undefined &&
    maxLength !== undefined &&
    minLength > maxLength
  ) {
    throw new McpElicitationError('invalid_request')
  }
  const format = hasOwn(field, 'format')
    ? requireStringFormat(field.format)
    : undefined
  const withoutDefault: McpElicitationStringFieldSchema = {
    type: 'string',
    ...base,
    ...(minLength !== undefined ? { minLength } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(format ? { format } : {}),
  }
  if (!hasOwn(field, 'default')) return withoutDefault
  return {
    ...withoutDefault,
    default: validateFieldValue(withoutDefault, field.default) as string,
  }
}

function normalizeNumberField(
  field: Record<string, unknown>,
): McpElicitationNumberFieldSchema {
  if (
    !hasOnlyKeys(field, [
      'type',
      'title',
      'description',
      'minimum',
      'maximum',
      'default',
    ])
  ) {
    throw new McpElicitationError('invalid_request')
  }
  const type = field.type as 'number' | 'integer'
  const base = normalizeFieldBase(field)
  const minimum = hasOwn(field, 'minimum')
    ? requireFiniteNumber(field.minimum)
    : undefined
  const maximum = hasOwn(field, 'maximum')
    ? requireFiniteNumber(field.maximum)
    : undefined
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new McpElicitationError('invalid_request')
  }
  const withoutDefault: McpElicitationNumberFieldSchema = {
    type,
    ...base,
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
  }
  if (!hasOwn(field, 'default')) return withoutDefault
  return {
    ...withoutDefault,
    default: validateFieldValue(withoutDefault, field.default) as number,
  }
}

function normalizeBooleanField(
  field: Record<string, unknown>,
): McpElicitationBooleanFieldSchema {
  if (
    !hasOnlyKeys(field, [
      'type',
      'title',
      'description',
      'default',
    ])
  ) {
    throw new McpElicitationError('invalid_request')
  }
  const base = normalizeFieldBase(field)
  if (hasOwn(field, 'default') && typeof field.default !== 'boolean') {
    throw new McpElicitationError('invalid_request')
  }
  return {
    type: 'boolean',
    ...base,
    ...(hasOwn(field, 'default')
      ? { default: field.default as boolean }
      : {}),
  }
}

function normalizeMultiSelectField(
  field: Record<string, unknown>,
): McpElicitationMultiSelectFieldSchema {
  if (
    !hasOnlyKeys(field, [
      'type',
      'title',
      'description',
      'minItems',
      'maxItems',
      'items',
      'default',
    ])
  ) {
    throw new McpElicitationError('invalid_request')
  }
  const base = normalizeFieldBase(field)
  const rawItems = requireStrictRecord(field.items)
  let items:
    | McpElicitationUntitledMultiSelectItems
    | McpElicitationTitledMultiSelectItems
  let options: readonly string[]
  if (hasOwn(rawItems, 'enum')) {
    if (
      !hasExactKeys(rawItems, ['type', 'enum']) ||
      rawItems.type !== 'string'
    ) {
      throw new McpElicitationError('invalid_request')
    }
    options = normalizeStringOptions(rawItems.enum)
    items = { type: 'string', enum: options }
  } else if (hasOwn(rawItems, 'anyOf')) {
    if (!hasExactKeys(rawItems, ['anyOf'])) {
      throw new McpElicitationError('invalid_request')
    }
    const titledOptions = normalizeTitledOptions(rawItems.anyOf)
    options = titledOptions.map((option) => option.const)
    items = { anyOf: titledOptions }
  } else {
    throw new McpElicitationError('invalid_request')
  }

  const minItems = hasOwn(field, 'minItems')
    ? requireBoundedNonNegativeInteger(field.minItems, options.length)
    : undefined
  const maxItems = hasOwn(field, 'maxItems')
    ? requireBoundedNonNegativeInteger(field.maxItems, options.length)
    : undefined
  if (
    minItems !== undefined &&
    maxItems !== undefined &&
    minItems > maxItems
  ) {
    throw new McpElicitationError('invalid_request')
  }
  const withoutDefault: McpElicitationMultiSelectFieldSchema = {
    type: 'array',
    ...base,
    ...(minItems !== undefined ? { minItems } : {}),
    ...(maxItems !== undefined ? { maxItems } : {}),
    items,
  }
  if (!hasOwn(field, 'default')) return withoutDefault
  return {
    ...withoutDefault,
    default: validateFieldValue(withoutDefault, field.default) as readonly string[],
  }
}

function normalizeFieldBase(
  field: Record<string, unknown>,
): McpElicitationFieldBase {
  return {
    ...(hasOwn(field, 'title')
      ? { title: requireDisplayText(field.title, MAX_TITLE_LENGTH, false) }
      : {}),
    ...(hasOwn(field, 'description')
      ? {
          description: requireDisplayText(
            field.description,
            MAX_DESCRIPTION_LENGTH,
            false,
          ),
        }
      : {}),
  }
}

function normalizeRequired(
  value: unknown,
  properties: ReadonlySet<string>,
): readonly string[] {
  const required = requireStrictArray(value)
  if (required.length > properties.size) {
    throw new McpElicitationError('invalid_request')
  }
  const normalized = required.map((name) => {
    assertPropertyName(name)
    if (!properties.has(name)) throw new McpElicitationError('invalid_request')
    return name
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new McpElicitationError('invalid_request')
  }
  return normalized.sort()
}

function normalizeStringOptions(value: unknown): readonly string[] {
  const values = requireStrictArray(value)
  if (values.length === 0 || values.length > MAX_ENUM_OPTIONS) {
    throw new McpElicitationError('invalid_request')
  }
  const normalized = values.map((option) =>
    requireDisplayText(option, MAX_ENUM_VALUE_LENGTH, true),
  )
  if (new Set(normalized).size !== normalized.length) {
    throw new McpElicitationError('invalid_request')
  }
  return normalized
}

function normalizeTitledOptions(
  value: unknown,
): readonly McpElicitationTitledStringEnumOption[] {
  const values = requireStrictArray(value)
  if (values.length === 0 || values.length > MAX_ENUM_OPTIONS) {
    throw new McpElicitationError('invalid_request')
  }
  const normalized = values.map((entry) => {
    const option = requireStrictRecord(entry)
    if (!hasExactKeys(option, ['const', 'title'])) {
      throw new McpElicitationError('invalid_request')
    }
    return {
      const: requireDisplayText(option.const, MAX_ENUM_VALUE_LENGTH, true),
      title: requireDisplayText(option.title, MAX_TITLE_LENGTH, false),
    }
  })
  if (new Set(normalized.map((entry) => entry.const)).size !== normalized.length) {
    throw new McpElicitationError('invalid_request')
  }
  return normalized
}

function validateFieldValue(
  field: McpElicitationFormFieldSchema,
  value: unknown,
): McpElicitationFormValue {
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new McpElicitationError('invalid_request')
    }
    return value
  }
  if (field.type === 'number' || field.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (field.type === 'integer' && !Number.isSafeInteger(value)) ||
      (field.minimum !== undefined && value < field.minimum) ||
      (field.maximum !== undefined && value > field.maximum)
    ) {
      throw new McpElicitationError('invalid_request')
    }
    return value
  }
  if (field.type === 'array') {
    const selected = requireStrictArray(value).map((entry) =>
      requireDisplayText(entry, MAX_ENUM_VALUE_LENGTH, true),
    )
    if (
      selected.length > MAX_MULTI_SELECT_VALUES ||
      new Set(selected).size !== selected.length ||
      (field.minItems !== undefined && selected.length < field.minItems) ||
      (field.maxItems !== undefined && selected.length > field.maxItems)
    ) {
      throw new McpElicitationError('invalid_request')
    }
    const options = 'enum' in field.items
      ? field.items.enum
      : field.items.anyOf.map((option) => option.const)
    if (selected.some((entry) => !options.includes(entry))) {
      throw new McpElicitationError('invalid_request')
    }
    return [...selected]
  }

  if (
    typeof value !== 'string' ||
    value.length > MAX_STRING_VALUE_LENGTH ||
    UNSAFE_TEXT_CONTROL.test(value)
  ) {
    throw new McpElicitationError('invalid_request')
  }
  if ('enum' in field && !field.enum.includes(value)) {
    throw new McpElicitationError('invalid_request')
  }
  if (
    'oneOf' in field &&
    !field.oneOf.some((option) => option.const === value)
  ) {
    throw new McpElicitationError('invalid_request')
  }
  const codePointLength = [...value].length
  if (
    'minLength' in field &&
    field.minLength !== undefined &&
    codePointLength < field.minLength
  ) {
    throw new McpElicitationError('invalid_request')
  }
  if (
    'maxLength' in field &&
    field.maxLength !== undefined &&
    codePointLength > field.maxLength
  ) {
    throw new McpElicitationError('invalid_request')
  }
  if ('format' in field && field.format && !matchesFormat(value, field.format)) {
    throw new McpElicitationError('invalid_request')
  }
  return value
}

function matchesFormat(value: string, format: McpElicitationStringFormat): boolean {
  if (format === 'email') {
    return (
      value.length <= 320 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    )
  }
  if (format === 'date') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!match) return false
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const date = new Date(Date.UTC(year, month - 1, day))
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    )
  }
  if (format === 'date-time') {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    )
    if (!match) return false
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const hour = Number(match[4])
    const minute = Number(match[5])
    const second = Number(match[6])
    const offsetHour = match[8] === undefined ? 0 : Number(match[8])
    const offsetMinute = match[9] === undefined ? 0 : Number(match[9])
    const date = new Date(Date.UTC(year, month - 1, day))
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day &&
      hour <= 23 &&
      minute <= 59 &&
      second <= 59 &&
      offsetHour <= 23 &&
      offsetMinute <= 59 &&
      Number.isFinite(Date.parse(value))
    )
  }
  if (URL_CONTROL_OR_SPACE.test(value)) return false
  try {
    const parsed = new URL(value)
    return Boolean(parsed.protocol)
  } catch {
    return false
  }
}

function requireStringFormat(value: unknown): McpElicitationStringFormat {
  if (
    value !== 'date' &&
    value !== 'date-time' &&
    value !== 'email' &&
    value !== 'uri'
  ) {
    // This explicitly excludes password/secret until a non-persistent secret UI exists.
    throw new McpElicitationError('invalid_request')
  }
  return value
}

function requireEnumDefault(
  value: unknown,
  options: readonly string[],
): string {
  if (typeof value !== 'string' || !options.includes(value)) {
    throw new McpElicitationError('invalid_request')
  }
  return value
}

function requireDisplayText(
  value: unknown,
  maxLength: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxLength ||
    UNSAFE_TEXT_CONTROL.test(value)
  ) {
    throw new McpElicitationError('invalid_request')
  }
  return value
}

function requireBoundedNonNegativeInteger(
  value: unknown,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new McpElicitationError('invalid_request')
  }
  return value
}

function requireFiniteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new McpElicitationError('invalid_request')
  }
  return value
}

function assertPropertyName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PROPERTY_NAME_LENGTH ||
    value !== value.trim() ||
    /[\0-\x1f\x7f]/.test(value) ||
    FORBIDDEN_KEYS.has(value)
  ) {
    throw new McpElicitationError('invalid_request')
  }
}

function requireStrictRecord(value: unknown): Record<string, unknown> {
  const record = asStrictRecord(value)
  if (!record) throw new McpElicitationError('invalid_request')
  return record
}

function asStrictRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return null
    }
  }
  return value as Record<string, unknown>
}

function requireStrictArray(value: unknown): readonly unknown[] {
  if (!isUnknownArray(value)) throw new McpElicitationError('invalid_request')
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) {
    throw new McpElicitationError('invalid_request')
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new McpElicitationError('invalid_request')
    }
  }
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) =>
        key !== 'length' &&
        (!/^\d+$/.test(key as string) || Number(key) >= value.length),
    )
  ) {
    throw new McpElicitationError('invalid_request')
  }
  return value
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed)
  return Reflect.ownKeys(value).every(
    (key) => typeof key === 'string' && allowedSet.has(key),
  )
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    hasOnlyKeys(value, expected) &&
    expected.every((key) => hasOwn(value, key))
  )
}

function elicitationErrorMessage(code: McpElicitationErrorCode): string {
  switch (code) {
    case 'invalid_request':
      return 'MCP elicitation request is invalid.'
    case 'not_found':
      return 'MCP elicitation request was not found.'
    case 'binding_mismatch':
      return 'MCP elicitation binding does not match.'
    case 'already_resolved':
      return 'MCP elicitation request is already resolved.'
    case 'expired':
      return 'MCP elicitation request has expired.'
    case 'capacity_exceeded':
      return 'MCP elicitation store capacity was exceeded.'
    case 'storage_invalid':
      return 'MCP elicitation storage is invalid.'
  }
}
