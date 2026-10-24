import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'

import {
  serialCapabilityEffect,
  type CapabilityEffect,
} from '../contracts/capability-effect.js'
import type { ToolSafetyRefusalCode } from '../contracts/capability-policy-denial.js'
import { PI_BUILTIN_TOOL_NAMES } from '../core/pi-runtime.js'
import { analyzeBashCommand } from '../core/tool-policy.js'
import type { TeamRuntimeToolAdapterFactory } from './capability-tool-adapter.js'

export const PIPELINE_GOVERNED_PI_TOOL_NAMES = PI_BUILTIN_TOOL_NAMES

export type PipelineGovernedPiToolName =
  (typeof PIPELINE_GOVERNED_PI_TOOL_NAMES)[number]

export interface PipelinePiToolRegistration<
  TParams extends TSchema,
  TDetails,
  TState,
> {
  readonly name: PipelineGovernedPiToolName
  readonly capabilityId: string
  readonly effect: CapabilityEffect
  readonly risk: string
  readonly tool: ToolDefinition<TParams, TDetails, TState>
}

export interface PipelinePiToolRegistrar {
  register<TParams extends TSchema, TDetails, TState>(
    registration: PipelinePiToolRegistration<TParams, TDetails, TState>,
  ): void
}

/**
 * A refusal these tools return, narrowed to the codes the shared contract
 * declares copy for. The same discipline the other two gates keep
 * (`team-runtime/capability-tool-policy.ts:14`,
 * `team-runtime/capability-bypass-detector.ts:20`): the codes live in one place,
 * so refusing with one this build cannot explain is a type error rather than a
 * bare identifier on a reader's screen.
 */
interface PipelinePiToolSafetyDenial {
  readonly kind: 'deny'
  readonly code: ToolSafetyRefusalCode
  readonly reason: string
}

type PipelinePiToolAuthorization =
  | { readonly kind: 'allow' }
  | PipelinePiToolSafetyDenial

/**
 * Told about a refusal so the runtime can record it.
 *
 * Necessary because this gate's denial is the one the dispatcher resolves —
 * `resolveCapabilityPolicy` returns the first deny of
 * `[adapter, prepared, policy]` (`core/capability-policy.ts:25`) — while the
 * capability policy is evaluating the very same call and allowing it. Its
 * `onDenied` therefore never fires here, and without this callback the refusal
 * reached the timeline as "failed using tool bash" with the reason discarded.
 */
export interface PipelinePiToolRefusal {
  readonly toolName: PipelineGovernedPiToolName
  readonly toolCallId: string
  readonly decision: PipelinePiToolSafetyDenial
}

export function createPipelinePiToolAdapterFactory<
  TParams extends TSchema,
  TDetails,
>(input: {
  readonly name: PipelineGovernedPiToolName
  readonly cwd: string
  readonly effect: CapabilityEffect
  onRefused?(refusal: PipelinePiToolRefusal): void
}): TeamRuntimeToolAdapterFactory<TParams, TDetails> {
  const authorize = async (
    toolCallId: string,
    value: unknown,
  ): Promise<PipelinePiToolAuthorization> => {
    const decision = await authorizePiToolArguments(input.name, input.cwd, value)
    if (decision.kind === 'deny') {
      // Reporting cannot change the answer, so a reporter that throws must not
      // turn a refusal into a dispatch failure.
      try {
        input.onRefused?.({
          toolName: input.name,
          toolCallId,
          decision,
        })
      } catch {
        // The refusal stands whether or not anyone recorded it.
      }
    }
    return decision
  }
  return {
    capabilityId: `team-runtime.pi.${input.name}`,
    createPreparedExecution: async (preparedInput) => {
      const policyDecision = await authorize(
        preparedInput.invocation.toolCallId,
        preparedInput.arguments,
      )
      return {
        effect: input.effect,
        risk: input.name === 'bash'
          ? bashRisk(preparedInput.arguments)
          : input.effect.kind,
        argumentNames: preparedInput.argumentNames,
        policyDecision,
        authorize: async ({ phase }) => phase === 'before-execute'
          ? authorize(
              preparedInput.invocation.toolCallId,
              preparedInput.arguments,
            )
          : { kind: 'allow' },
        execute: async ({ signal }) => preparedInput.executeRaw(signal),
        acceptResult: async ({ value }) => ({ value }),
      }
    },
  }
}

export function createPipelinePiToolDefinitions(cwd: string) {
  return {
    read: createReadToolDefinition(cwd),
    bash: createBashToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    grep: createGrepToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
  }
}

export function registerEnabledPipelinePiTools(input: {
  readonly cwd: string
  readonly enabled: ReadonlySet<string>
  readonly registrar: PipelinePiToolRegistrar
}): void {
  const tools = createPipelinePiToolDefinitions(input.cwd)
  if (input.enabled.has('read')) {
    input.registrar.register(readRegistration('read', tools.read))
  }
  if (input.enabled.has('bash')) {
    input.registrar.register(writeRegistration('bash', tools.bash, 'unknown'))
  }
  if (input.enabled.has('edit')) {
    input.registrar.register(writeRegistration('edit', tools.edit, 'mutating'))
  }
  if (input.enabled.has('write')) {
    input.registrar.register(writeRegistration('write', tools.write, 'mutating'))
  }
  if (input.enabled.has('grep')) {
    input.registrar.register(readRegistration('grep', tools.grep))
  }
  if (input.enabled.has('find')) {
    input.registrar.register(readRegistration('find', tools.find))
  }
  if (input.enabled.has('ls')) {
    input.registrar.register(readRegistration('ls', tools.ls))
  }
}

function readRegistration<
  TParams extends TSchema,
  TDetails,
  TState,
>(
  name: PipelineGovernedPiToolName,
  tool: ToolDefinition<TParams, TDetails, TState>,
): PipelinePiToolRegistration<TParams, TDetails, TState> {
  return {
    name,
    capabilityId: `team-runtime.pi.${name}`,
    effect: serialCapabilityEffect('read-only'),
    risk: 'read-only',
    tool,
  }
}

function writeRegistration<
  TParams extends TSchema,
  TDetails,
  TState,
>(
  name: PipelineGovernedPiToolName,
  tool: ToolDefinition<TParams, TDetails, TState>,
  effectKind: 'mutating' | 'unknown',
): PipelinePiToolRegistration<TParams, TDetails, TState> {
  return {
    name,
    capabilityId: `team-runtime.pi.${name}`,
    effect: serialCapabilityEffect(effectKind),
    risk: effectKind,
    tool,
  }
}

async function authorizePiToolArguments(
  name: PipelineGovernedPiToolName,
  cwd: string,
  value: unknown,
): Promise<PipelinePiToolAuthorization> {
  if (name === 'bash') {
    const command = readStringProperty(value, 'command')
    if (!command || analyzeBashCommand(command).risk === 'high') {
      return {
        kind: 'deny',
        code: 'unsafe_bash_command',
        reason: 'The bash command exceeds the Team Runtime risk boundary.',
      }
    }
    return { kind: 'allow' }
  }

  const requestedPath = readFileToolPath(name, value)
  if (requestedPath === null || !await isContainedWorkspacePath(cwd, requestedPath)) {
    return {
      kind: 'deny',
      code: 'tool_path_outside_workspace',
      reason: 'The tool path must remain inside the Team Runtime workspace.',
    }
  }
  return { kind: 'allow' }
}

function bashRisk(value: unknown): string {
  const command = readStringProperty(value, 'command')
  return command ? `bash-${analyzeBashCommand(command).risk}` : 'bash-invalid'
}

function readFileToolPath(
  name: Exclude<PipelineGovernedPiToolName, 'bash'>,
  value: unknown,
): string | null {
  const pathValue = readStringProperty(value, 'path')
  if (pathValue) return pathValue
  return name === 'grep' || name === 'find' || name === 'ls' ? '.' : null
}

function readStringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const propertyValue: unknown = Reflect.get(value, property)
  return typeof propertyValue === 'string' ? propertyValue : undefined
}

async function isContainedWorkspacePath(
  cwd: string,
  requestedPath: string,
): Promise<boolean> {
  try {
    const resolvedCwd = path.resolve(cwd)
    const canonicalCwd = await fs.realpath(resolvedCwd)
    const targetPath = path.resolve(resolvedCwd, requestedPath)
    if (!isWithin(resolvedCwd, targetPath)) return false
    const canonicalExistingPath = await realpathOfNearestExisting(targetPath)
    return isWithin(canonicalCwd, canonicalExistingPath)
  } catch {
    return false
  }
}

async function realpathOfNearestExisting(targetPath: string): Promise<string> {
  let candidate = targetPath
  for (;;) {
    try {
      return await fs.realpath(candidate)
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      const parent = path.dirname(candidate)
      if (parent === candidate) throw error
      candidate = parent
    }
  }
}

function isWithin(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath)
  return relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error &&
    'code' in error &&
    error.code === 'ENOENT'
}
