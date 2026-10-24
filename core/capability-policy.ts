import type { CapabilityPolicyDecision } from '../contracts/capability-dispatch.js'

const MISSING_DECISION: CapabilityPolicyDecision = Object.freeze({
  kind: 'deny',
  code: 'policy_decision_missing',
  reason: 'A mandatory policy decision was not provided.',
})
const INVALID_DECISION: CapabilityPolicyDecision = Object.freeze({
  kind: 'deny',
  code: 'policy_decision_invalid',
  reason: 'A mandatory policy decision was invalid.',
})
const ALLOW_DECISION: CapabilityPolicyDecision = Object.freeze({ kind: 'allow' })

export function resolveCapabilityPolicy(
  inputs: readonly unknown[],
): CapabilityPolicyDecision {
  if (inputs.length === 0) return MISSING_DECISION
  const decisions: CapabilityPolicyDecision[] = []
  for (const input of inputs) {
    const decision = readCapabilityPolicyDecision(input)
    if (!decision) return INVALID_DECISION
    decisions.push(decision)
  }
  const denial = decisions.find((decision) => decision.kind === 'deny')
  if (denial) return denial
  const approval = decisions.find(
    (decision) => decision.kind === 'require-approval',
  )
  return approval ?? ALLOW_DECISION
}

export function readCapabilityPolicyDecision(
  input: unknown,
): CapabilityPolicyDecision | null {
  if (!isRecord(input) || typeof input.kind !== 'string') return null
  switch (input.kind) {
    case 'allow':
      return hasExactKeys(input, ['kind']) ? ALLOW_DECISION : null
    case 'require-approval':
      return hasExactKeys(input, ['kind', 'reason']) && isText(input.reason)
        ? { kind: 'require-approval', reason: input.reason }
        : null
    case 'deny': {
      const allowedKeys = input.detail === undefined
        ? ['code', 'kind', 'reason']
        : ['code', 'detail', 'kind', 'reason']
      if (
        !hasExactKeys(input, allowedKeys) ||
        !isIdentifier(input.code) ||
        !isText(input.reason)
      ) {
        return null
      }
      return {
        kind: 'deny',
        code: input.code,
        reason: input.reason,
        ...(input.detail === undefined ? {} : { detail: input.detail }),
      }
    }
    default:
      return null
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== 'string')) return false
  const actual = ownKeys.filter(isString).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0-\x1f\x7f]/.test(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !value.includes('\0')
}

function isString(value: string | symbol): value is string {
  return typeof value === 'string'
}
