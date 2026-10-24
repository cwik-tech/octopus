export const CAPABILITY_EFFECT_KINDS = [
  'read-only',
  'mutating',
  'destructive',
  'unknown',
] as const

export type CapabilityEffectKind =
  (typeof CAPABILITY_EFFECT_KINDS)[number]

export type CapabilityConcurrency = 'serial' | 'parallel-safe'

export interface CapabilityEffect {
  readonly kind: CapabilityEffectKind
  readonly concurrency: CapabilityConcurrency
}

const UNKNOWN_SERIAL_EFFECT: CapabilityEffect = Object.freeze({
  kind: 'unknown',
  concurrency: 'serial',
})
const READ_ONLY_SERIAL_EFFECT: CapabilityEffect = Object.freeze({
  kind: 'read-only',
  concurrency: 'serial',
})
const MUTATING_SERIAL_EFFECT: CapabilityEffect = Object.freeze({
  kind: 'mutating',
  concurrency: 'serial',
})
const DESTRUCTIVE_SERIAL_EFFECT: CapabilityEffect = Object.freeze({
  kind: 'destructive',
  concurrency: 'serial',
})
const HOST_AUDITED_PARALLEL_READ_EFFECT: CapabilityEffect = Object.freeze({
  kind: 'read-only',
  concurrency: 'parallel-safe',
})

export function serialCapabilityEffect(
  kind: CapabilityEffectKind,
): CapabilityEffect {
  switch (kind) {
    case 'read-only':
      return READ_ONLY_SERIAL_EFFECT
    case 'mutating':
      return MUTATING_SERIAL_EFFECT
    case 'destructive':
      return DESTRUCTIVE_SERIAL_EFFECT
    case 'unknown':
      return UNKNOWN_SERIAL_EFFECT
  }
}

export function normalizeExternalCapabilityEffect(
  input: unknown,
): CapabilityEffect {
  if (!isRecord(input)) return UNKNOWN_SERIAL_EFFECT
  if (!isCapabilityEffectKind(input.kind)) return UNKNOWN_SERIAL_EFFECT
  if (input.concurrency === 'serial') {
    return serialCapabilityEffect(input.kind)
  }
  if (input.kind === 'read-only' && input.concurrency === 'parallel-safe') {
    return READ_ONLY_SERIAL_EFFECT
  }
  return UNKNOWN_SERIAL_EFFECT
}

export function hostAuditedParallelReadEffect(): CapabilityEffect {
  return HOST_AUDITED_PARALLEL_READ_EFFECT
}

export function canonicalizeCapabilityEffect(
  input: unknown,
): CapabilityEffect {
  if (input === HOST_AUDITED_PARALLEL_READ_EFFECT) {
    return HOST_AUDITED_PARALLEL_READ_EFFECT
  }
  return normalizeExternalCapabilityEffect(input)
}

export function mayRunConcurrently(effect: CapabilityEffect): boolean {
  return effect === HOST_AUDITED_PARALLEL_READ_EFFECT
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCapabilityEffectKind(value: unknown): value is CapabilityEffectKind {
  return value === 'read-only' ||
    value === 'mutating' ||
    value === 'destructive' ||
    value === 'unknown'
}
