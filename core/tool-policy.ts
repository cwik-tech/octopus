import { STAGE_TYPE } from './constants.js'
import { PI_BUILTIN_TOOL_NAMES } from './pi-runtime.js'
import type { LoadedAgent } from './types.js'

/**
 * The mid-run task inspection tool a coordinator can call while delegated work
 * is in flight. Named here so the level allow-set and the registration site
 * cannot drift apart.
 */
export const INSPECT_TASK_STATE_TOOL_NAME = 'inspect-task-state'

/**
 * The runtime-owned tools a coordinator may call at a level.
 *
 * This is a ceiling rather than a preference list: an agent's own `tools:` is
 * resolved against it by `resolveCoordinatorAllowedTools`, which returns this
 * set whenever it is non-empty. A tool that a level registers but omits here is
 * therefore denied at dispatch even when the agent declares it, so anything
 * registered under a permission has to be reachable from the same branch.
 */
export function resolveLevelAllowedTools(input: {
  readonly stageType?: string | undefined
  readonly spawnTeams: boolean
  readonly hasWorkflows: boolean
  readonly alwaysAllowed: readonly string[]
}): Set<string> {
  const allowed = new Set<string>(input.alwaysAllowed)

  switch (input.stageType) {
    case STAGE_TYPE.ROUTING:
      break
    case STAGE_TYPE.DISCUSSION:
      allowed.add('set_roster')
      allowed.add('create_brief')
      allowed.add('converse')
      break
    case STAGE_TYPE.PIPELINE:
      allowed.add('dispatch')
      break
    case STAGE_TYPE.CHAIN:
      allowed.add('handoff')
      break
    case STAGE_TYPE.BROADCAST:
      allowed.add('broadcast')
      break
    case STAGE_TYPE.REVIEW:
      allowed.add('submit_for_review')
      break
    default:
      break
  }

  if (input.spawnTeams) {
    allowed.add('spawn_team')
    if (input.hasWorkflows) allowed.add('spawn_workflow')
    // Registered in the same permission branch as `spawn_team`, because it
    // exists to inspect the work that branch delegates. Omitting it here denied
    // the shipped receptionist a tool its own roster entry declares.
    allowed.add(INSPECT_TASK_STATE_TOOL_NAME)
  }

  return allowed
}

export type BashRiskLevel = 'low' | 'medium' | 'high'

export interface BashCommandAnalysis {
  risk: BashRiskLevel
  flags: string[]
  normalizedCommand: string
}

export function parseToolList(value: unknown): string[] | undefined {
  if (value == null) return undefined

  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean)
  }

  const raw = String(value).trim()
  if (!raw) return undefined
  if (raw.toLowerCase() === 'none') return []

  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function formatAllowedTools(tools: string[] | undefined): string {
  if (tools === undefined) return 'all registered tools'
  if (tools.length === 0) return 'none'
  return tools.join(', ')
}

export function isToolAllowed(agent: LoadedAgent | undefined, toolName: string): boolean {
  if (!agent || agent.tools === undefined) return true
  return agent.tools.includes(toolName)
}

export function mergeAllowedTools(
  tools: string[] | undefined,
  additionalTools: Iterable<string> | undefined,
): string[] | undefined {
  const extras = additionalTools ? Array.from(additionalTools) : []
  if (tools === undefined) {
    return extras.length > 0 ? extras : undefined
  }

  return Array.from(new Set([...tools, ...extras]))
}

/**
 * The governed file tools a persona's `tools:` list grants it.
 *
 * The one algorithm, so the three places that need the answer cannot disagree:
 * the registration that creates the tools, the authorization that admits their
 * calls, and the tool policy the coordinator is told in its own prompt. A
 * persona with no list at all is unrestricted, which is the same rule the
 * registration has always used.
 */
export function resolveGrantedGovernedFileTools(
  tools: string[] | undefined,
): string[] {
  return PI_BUILTIN_TOOL_NAMES.filter(
    (name) => tools === undefined || tools.includes(name),
  )
}

/**
 * What this coordinator may call right now.
 *
 * The level's set is a ceiling and replaces the persona's list, so a
 * coordinator cannot reach another level's engine tools by declaring them.
 * `grantedTools` is the exception that ceiling needs: a governed file tool is
 * granted by the persona's list and by nothing else, so replacing that list is
 * also what revokes it — the runtime registers it under the grant
 * (`team-runtime/index.ts:1505`) and then refuses every call, which is the
 * drift this module's own header warns about. Passing the grant through widens
 * the ceiling by exactly the granted tools and by nothing else.
 *
 * The granted tools are not added to the level's set, only to this coordinator's
 * allowance. A level tool may be used once per coordinator turn, because using
 * one is how a stage advances (`team-runtime/capability-tool-policy.ts:124`);
 * a file tool is not that kind of tool and must not inherit that cap.
 */
export function resolveCoordinatorAllowedTools(
  tools: string[] | undefined,
  levelTools: Iterable<string> | undefined,
  grantedTools?: Iterable<string>,
): string[] | undefined {
  const allowedLevelTools = levelTools ? Array.from(new Set(levelTools)) : []
  if (allowedLevelTools.length > 0) {
    const granted = grantedTools ? Array.from(grantedTools) : []
    if (granted.length === 0) return allowedLevelTools
    return Array.from(new Set([...allowedLevelTools, ...granted]))
  }
  return tools
}

export function isRuntimeOwnedStageToolAllowed(
  hasCoordinator: boolean,
  levelTools: Iterable<string> | undefined,
  toolName: string,
): boolean {
  if (hasCoordinator) return true
  const allowedLevelTools = levelTools ? Array.from(new Set(levelTools)) : []
  if (allowedLevelTools.length === 0) return true
  return allowedLevelTools.includes(toolName)
}

export function buildToolPolicyBlock(agent: LoadedAgent | undefined, additionalTools?: Iterable<string>): string {
  const effectiveTools = mergeAllowedTools(agent?.tools, additionalTools)
  if (!agent || effectiveTools === undefined) return ''

  const renderedTools = effectiveTools.length > 0 ? effectiveTools.join(', ') : '(none)'
  return (
    `\n\n## Tool Permissions\n\n` +
    `You may only use these tools: ${renderedTools}.\n` +
    `Any other tool call will be blocked by the runtime.\n` +
    (effectiveTools.includes('bash')
      ? `When using bash, avoid destructive commands, shell chaining, curl-pipe-shell patterns, sudo, and broad permission changes.\n`
      : '')
  )
}

export function analyzeBashCommand(command: string): BashCommandAnalysis {
  const normalizedCommand = stripHeredocBodies(command).trim()
  const flags = new Set<string>()

  if (hasShellChainingOperators(normalizedCommand)) flags.add('shell_chaining')
  if (/\brm\s+(?:-[^\s]*[rf][^\s]*|-[^\s]*r[^\s]*\s+-[^\s]*f[^\s]*|-[^\s]*f[^\s]*\s+-[^\s]*r[^\s]*)/i.test(normalizedCommand)) {
    flags.add('destructive_remove')
  }
  if (/\b(?:curl|wget)\b[\s\S]*(?:\|\s*(?:sh|bash|zsh)\b|>\s*\/tmp\/[^\s;&|]+[\s\S]*\b(?:sh|bash|zsh)\b)/i.test(normalizedCommand)) {
    flags.add('download_execute')
  }
  if (/\bsudo\b/.test(normalizedCommand)) flags.add('sudo')
  if (/\bchmod\s+(?:-[^\s]*R[^\s]*\s+)?(?:777|a\+w|ugo\+w)\b/i.test(normalizedCommand)) {
    flags.add('broad_permissions')
  }
  if (/(^|[;&|]\s*)>\s*\/dev\/(?:sd[a-z]|disk\d+)/i.test(normalizedCommand)) {
    flags.add('raw_device_write')
  }

  const flagList = [...flags]
  const risk: BashRiskLevel = flagList.some((flag) =>
    ['destructive_remove', 'download_execute', 'sudo', 'broad_permissions', 'raw_device_write'].includes(flag)
  )
    ? 'high'
    : flagList.length > 0
      ? 'medium'
      : 'low'

  return { risk, flags: flagList, normalizedCommand }
}

export function isBashCommandAllowed(command: string, maxRisk: BashRiskLevel = 'medium'): boolean {
  const riskRank: Record<BashRiskLevel, number> = { low: 0, medium: 1, high: 2 }
  return riskRank[analyzeBashCommand(command).risk] <= riskRank[maxRisk]
}

export function hasShellChainingOperators(command: string): boolean {
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    const next = command[i + 1]

    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ';') return true
    if (char === '&' && next === '&') return true
    if (char === '|' && next === '|') return true
    if (char === '|' && next !== '|') return true
  }

  return false
}

export function stripHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/)
  const output: string[] = []
  let heredocTerminator: string | null = null

  for (const line of lines) {
    if (heredocTerminator) {
      if (line.trim() === heredocTerminator) {
        heredocTerminator = null
        output.push(line)
      }
      continue
    }

    output.push(line)
    const match = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/)
    const terminator = match?.[1]
    if (terminator) {
      heredocTerminator = terminator
    }
  }

  return output.join('\n')
}
