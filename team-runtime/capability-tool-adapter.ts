import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'

import type { CapabilityEffect } from '../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityAuthorizationPhase,
  CapabilityExecutionContext,
  CapabilityInvocationIdentity,
  CapabilityPolicyDecision,
  CapabilityPreparedExecution,
} from '../contracts/capability-dispatch.js'
import {
  CapabilityDispatchRejection,
  type CapabilityDispatcher,
} from '../core/capability-dispatcher.js'
import { whenDefined } from '../core/optional-properties.js'

const retainedPiToolResults = new WeakSet<object>()

export type TeamRuntimeToolInvocationChannel = 'model' | 'runtime'

/** Derive argument values from Pi's public ToolDefinition contract so the
 * adapter follows the installed SDK's schema typing. */
export type TeamRuntimeToolArguments<TParams extends TSchema> = Parameters<
  ToolDefinition<TParams, unknown, unknown>['execute']
>[1]

export interface TeamRuntimeToolAdapterFactoryInput<
  TParams extends TSchema,
  TDetails,
> {
  readonly arguments: TeamRuntimeToolArguments<TParams>
  readonly context: CapabilityExecutionContext
  readonly invocation: CapabilityInvocationIdentity
  readonly signal: AbortSignal
  readonly argumentNames: readonly string[]
  executeRaw(signal: AbortSignal): Promise<AgentToolResult<TDetails>>
}

/**
 * Capability-specific lifecycle seam. Phase-specific adapters may own result
 * settlement and lifecycle projection while this module owns Pi revalidation
 * and mandatory dispatch.
 */
export interface TeamRuntimeToolAdapterFactory<
  TParams extends TSchema,
  TDetails,
> {
  readonly capabilityId: string
  createPreparedExecution(
    input: TeamRuntimeToolAdapterFactoryInput<TParams, TDetails>,
  ): Promise<CapabilityPreparedExecution>
}

export interface DefaultTeamRuntimeToolAdapterFactoryOptions {
  readonly capabilityId: string
  readonly effect: CapabilityEffect
  readonly risk: string
  authorize?(input: {
    readonly phase: CapabilityAuthorizationPhase
    readonly signal?: AbortSignal
  }): Promise<CapabilityPolicyDecision>
  readActualCostUsd?(): number | undefined
}

export interface GovernTeamRuntimeToolOptions<
  TParams extends TSchema,
  TDetails,
  TState,
> {
  readonly tool: ToolDefinition<TParams, TDetails, TState>
  readonly dispatcher: Pick<CapabilityDispatcher, 'dispatch'>
  readonly budgetAdoptionScope?: TeamRuntimeBudgetAdoptionScope
  readonly getContext: (
    channel: TeamRuntimeToolInvocationChannel,
  ) => CapabilityExecutionContext
  readonly modelSource: CapabilityInvocationIdentity['source']
  readonly runtimeSource: CapabilityInvocationIdentity['source']
  readonly adapterFactory: TeamRuntimeToolAdapterFactory<TParams, TDetails>
  onRawError?(toolCallId: string, error: unknown): void
}

export interface TeamRuntimeBudgetAdoptionScope {
  runWithAdoptionScope<T>(input: {
    readonly context: CapabilityExecutionContext
    readonly invocation: CapabilityInvocationIdentity
    readonly operation: () => Promise<T>
  }): Promise<T>
}

export interface TeamRuntimeToolInvocation<TDetails> {
  readonly channel: TeamRuntimeToolInvocationChannel
  readonly toolCallId: string
  readonly input: unknown
  readonly signal?: AbortSignal
  readonly onUpdate?: AgentToolUpdateCallback<TDetails>
  readonly extensionContext: ExtensionContext
}

export interface GovernedTeamRuntimeTool<
  TParams extends TSchema,
  TDetails,
  TState,
> {
  readonly definition: ToolDefinition<TParams, TDetails, TState>
  invoke(input: TeamRuntimeToolInvocation<TDetails>): Promise<AgentToolResult<TDetails>>
  readonly runtimeInvoker: TeamRuntimeInternalToolInvoker
}

export interface TeamRuntimeInternalToolInvoker {
  invoke(input: {
    readonly toolCallId: string
    readonly input: unknown
    readonly signal?: AbortSignal
    readonly extensionContext: ExtensionContext
  }): Promise<unknown>
}

export class TeamRuntimeToolDispatchError extends Error {
  constructor(
    readonly status: 'rejected' | 'cancelled' | 'failed' | 'indeterminate',
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(`Team Runtime tool dispatch ${status}: ${code}`)
    this.name = 'TeamRuntimeToolDispatchError'
  }
}

export function createDefaultTeamRuntimeToolAdapterFactory<
  TParams extends TSchema,
  TDetails,
>(
  options: DefaultTeamRuntimeToolAdapterFactoryOptions,
): TeamRuntimeToolAdapterFactory<TParams, TDetails> {
  return {
    capabilityId: options.capabilityId,
    createPreparedExecution: async (input) => ({
      effect: options.effect,
      risk: options.risk,
      argumentNames: input.argumentNames,
      policyDecision: { kind: 'allow' },
      authorize: options.authorize ?? allowCapability,
      execute: async ({ signal }) => input.executeRaw(signal),
      acceptResult: async ({ value }) => ({
        value,
        ...(options.readActualCostUsd
          ? whenDefined(options.readActualCostUsd(), (actualCostUsd) => ({ actualCostUsd }))
          : {}),
      }),
    }),
  }
}

export function governTeamRuntimeTool<
  TParams extends TSchema,
  TDetails,
  TState,
>(
  options: GovernTeamRuntimeToolOptions<TParams, TDetails, TState>,
): GovernedTeamRuntimeTool<TParams, TDetails, TState> {
  if (options.adapterFactory.capabilityId.length === 0) {
    throw new Error('A Team Runtime tool capability ID is required.')
  }

  const invoke = async (
    input: TeamRuntimeToolInvocation<TDetails>,
    toolContext?: ExtensionToolContext,
  ): Promise<AgentToolResult<TDetails>> => {
    const context = options.getContext(input.channel)
    const source = input.channel === 'model'
      ? options.modelSource
      : options.runtimeSource
    let rawFailure: unknown
    let rawFailed = false
    let rawResult: AgentToolResult<TDetails> | undefined

    const adapter: CapabilityAdapter = {
      capabilityId: options.adapterFactory.capabilityId,
      prepare: async (prepareInput) => {
        if (!isTeamRuntimeToolArguments(
          options.tool.parameters,
          prepareInput.arguments,
        )) {
          throw new CapabilityDispatchRejection('invalid_tool_arguments')
        }
        const validatedArguments = prepareInput.arguments
        const prepared = await options.adapterFactory.createPreparedExecution({
          arguments: validatedArguments,
          context: prepareInput.context,
          invocation: prepareInput.invocation,
          signal: prepareInput.signal,
          argumentNames: Object.keys(validatedArguments).sort(),
          executeRaw: async (signal) => {
            try {
              const executeTool = () => options.tool.execute(
                  input.toolCallId,
                  validatedArguments,
                  signal,
                  input.onUpdate,
                  toolContext ?? createRuntimeToolContext(input.extensionContext),
                )
              const value = options.budgetAdoptionScope
                ? await options.budgetAdoptionScope.runWithAdoptionScope({
                    context: prepareInput.context,
                    invocation: prepareInput.invocation,
                    operation: executeTool,
                  })
                : await executeTool()
              rawResult = value
              return value
            } catch (error) {
              rawFailed = true
              rawFailure = error
              try {
                options.onRawError?.(input.toolCallId, error)
              } catch {
                // Observability callbacks cannot replace the raw tool failure.
              }
              throw error
            }
          },
        })
        return retainExactResult(prepared, () => rawResult)
      },
    }

    const dispatchResult = await options.dispatcher.dispatch({
      context,
      invocation: {
        capabilityId: options.adapterFactory.capabilityId,
        source,
        toolCallId: input.toolCallId,
        input: input.input,
      },
      adapter,
      ...(input.signal ? { signal: input.signal } : {}),
    })

    if (dispatchResult.status === 'completed') {
      if (isRetainedPiToolResult<TDetails>(dispatchResult.value)) {
        return dispatchResult.value
      }
      throw new TeamRuntimeToolDispatchError(
        'failed',
        'capability_result_unavailable',
      )
    }
    if (rawFailed) throw rawFailure
    throw new TeamRuntimeToolDispatchError(
      dispatchResult.status,
      dispatchResult.code,
      dispatchResult.detail,
    )
  }

  return {
    definition: {
      ...options.tool,
      execute: async (toolCallId, params, signal, onUpdate, extensionContext) =>
        invoke({
          channel: 'model',
          toolCallId,
          input: params,
          ...(signal ? { signal } : {}),
          ...(onUpdate ? { onUpdate } : {}),
          extensionContext,
        }, extensionContext),
    },
    invoke,
    runtimeInvoker: {
      invoke: (input) => invoke({ channel: 'runtime', ...input }),
    },
  }
}

async function allowCapability(): Promise<CapabilityPolicyDecision> {
  return { kind: 'allow' }
}

function retainExactResult<TDetails>(
  prepared: CapabilityPreparedExecution,
  getRawResult: () => AgentToolResult<TDetails> | undefined,
): CapabilityPreparedExecution {
  return {
    ...prepared,
    acceptResult: async (input) => {
      const accepted = await prepared.acceptResult(input)
      const rawResult = getRawResult()
      if (!rawResult) {
        throw new Error('The Team Runtime tool returned no exact Pi result.')
      }
      retainedPiToolResults.add(rawResult)
      return { ...accepted, value: rawResult }
    },
  }
}

/** The dispatcher binds replay to the same capability, arguments, and scope;
 * this marker proves the retained object came from a typed Pi execute result. */
function isRetainedPiToolResult<TDetails>(
  value: unknown,
): value is AgentToolResult<TDetails> {
  return value !== null &&
    typeof value === 'object' &&
    retainedPiToolResults.has(value)
}

function isTeamRuntimeToolArguments<TParams extends TSchema>(
  schema: TParams,
  value: unknown,
): value is TeamRuntimeToolArguments<TParams> {
  return Value.Check(schema, value)
}

/** Runtime autostarts have no Pi tool-call authority. Model calls retain the
 * original Pi context; direct runtime calls must use our dispatcher again. */
function createRuntimeToolContext(context: ExtensionContext): ExtensionToolContext {
  return {
    ...context,
    tools: [],
    executeTool: async () => {
      throw new TeamRuntimeToolDispatchError(
        'rejected',
        'runtime_nested_tool_unavailable',
      )
    },
  }
}
