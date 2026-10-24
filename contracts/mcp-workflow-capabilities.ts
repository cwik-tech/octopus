import {
  normalizeMcpCapabilityRequirement,
  type McpWorkflowCapabilityRequirement,
} from './mcp.js'

export const MAX_MCP_WORKFLOW_REQUIREMENTS_PER_SCOPE = 64 as const
export const MAX_MCP_WORKFLOW_CAPABILITY_LENGTH = 160 as const
export const MAX_MCP_WORKFLOW_RATIONALE_LENGTH = 1_000 as const

const ALLOWED_REQUIREMENT_KEYS = new Set([
  'capability',
  'access',
  'necessity',
  'rationale',
])
const VALID_ACCESS = new Set(['read', 'write', 'any'])
const VALID_NECESSITY = new Set(['required', 'optional'])

export interface McpWorkflowRequirementsNormalizationResult {
  requirements?: McpWorkflowCapabilityRequirement[]
  errors: string[]
}

/**
 * Normalizes one declaration scope without resolving workflow/step inheritance.
 * A later runtime phase will combine workflow-level plus step-level requirements
 * and resolve conflicts by stricter access/necessity, never by last-write-wins.
 */
export function normalizeMcpWorkflowRequirements(
  value: unknown,
  scope: string,
): McpWorkflowRequirementsNormalizationResult {
  if (value === undefined) return { errors: [] }
  if (!Array.isArray(value)) {
    return { errors: [`${scope} must be a list`] }
  }

  const errors: string[] = []
  const requirements: McpWorkflowCapabilityRequirement[] = []
  const seenCapabilities = new Set<string>()
  if (value.length > MAX_MCP_WORKFLOW_REQUIREMENTS_PER_SCOPE) {
    errors.push(
      `${scope} must contain at most ${MAX_MCP_WORKFLOW_REQUIREMENTS_PER_SCOPE} requirements`,
    )
  }

  value.forEach((item, index) => {
    const itemScope = `${scope}[${index}]`
    if (!isRecord(item)) {
      errors.push(`${itemScope} must be an object`)
      return
    }

    const startErrorCount = errors.length
    for (const key of Object.keys(item).sort(compareStrings)) {
      if (!ALLOWED_REQUIREMENT_KEYS.has(key)) {
        errors.push(`${itemScope} contains unknown key '${key}'`)
      }
    }

    const capabilityValue = item.capability
    let normalizedCapability: string | null = null
    if (typeof capabilityValue !== 'string') {
      errors.push(`${itemScope}.capability must be a string`)
    } else {
      const trimmedCapability = capabilityValue.trim()
      if (trimmedCapability.length > MAX_MCP_WORKFLOW_CAPABILITY_LENGTH) {
        errors.push(
          `${itemScope}.capability must be at most ${MAX_MCP_WORKFLOW_CAPABILITY_LENGTH} characters`,
        )
      }
      normalizedCapability = normalizeMcpCapabilityRequirement({
        capability: trimmedCapability,
        access: 'any',
        necessity: 'optional',
      })?.capability ?? null
      if (!normalizedCapability) {
        errors.push(`${itemScope}.capability '${trimmedCapability}' is invalid`)
      } else if (seenCapabilities.has(normalizedCapability)) {
        errors.push(`${scope} contains duplicate capability '${normalizedCapability}'`)
      } else {
        seenCapabilities.add(normalizedCapability)
      }
    }

    const access = item.access
    if (typeof access !== 'string' || !VALID_ACCESS.has(access)) {
      errors.push(`${itemScope}.access must be 'read', 'write', or 'any'`)
    }

    const necessity = item.necessity
    if (typeof necessity !== 'string' || !VALID_NECESSITY.has(necessity)) {
      errors.push(`${itemScope}.necessity must be 'required' or 'optional'`)
    }

    let rationale: string | undefined
    if (item.rationale !== undefined) {
      if (typeof item.rationale !== 'string') {
        errors.push(`${itemScope}.rationale must be a string`)
      } else {
        const trimmedRationale = item.rationale.trim()
        if (trimmedRationale.length > MAX_MCP_WORKFLOW_RATIONALE_LENGTH) {
          errors.push(
            `${itemScope}.rationale must be at most ${MAX_MCP_WORKFLOW_RATIONALE_LENGTH} characters`,
          )
        } else if (trimmedRationale) {
          rationale = trimmedRationale
        }
      }
    }

    if (
      errors.length === startErrorCount &&
      normalizedCapability &&
      typeof access === 'string' &&
      VALID_ACCESS.has(access) &&
      typeof necessity === 'string' &&
      VALID_NECESSITY.has(necessity)
    ) {
      requirements.push({
        capability: normalizedCapability,
        access: access as McpWorkflowCapabilityRequirement['access'],
        necessity: necessity as McpWorkflowCapabilityRequirement['necessity'],
        ...(rationale ? { rationale } : {}),
      })
    }
  })

  requirements.sort((left, right) =>
    compareStrings(left.capability, right.capability) ||
    compareStrings(left.access, right.access) ||
    compareStrings(left.necessity, right.necessity) ||
    compareStrings(left.rationale ?? '', right.rationale ?? ''),
  )

  return {
    ...(requirements.length > 0 ? { requirements } : {}),
    errors,
  }
}

export function requireValidMcpWorkflowRequirements(
  value: unknown,
  scope: string,
): McpWorkflowCapabilityRequirement[] {
  const normalized = normalizeMcpWorkflowRequirements(value, scope)
  if (normalized.errors.length > 0) {
    throw new Error(normalized.errors.join('; '))
  }
  return normalized.requirements ?? []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
