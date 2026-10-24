import { randomUUID } from 'node:crypto'

import type {
  BuiltinAgentToolAdapter,
  BuiltinToolArtifact,
} from '../domains/mcp/builtin-agent-tool-adapter.js'
import type {
  McpBrokerCallRequest,
  McpBrokerCallResult,
  McpBrokerRequestContext,
  McpJsonObject,
  McpNamespacedTool,
  McpSanitizedError,
} from '../domains/mcp/mcp-runtime.js'
import type { ProviderToolExecutionResult } from '../domains/provider/provider-tool-loop.js'
import {
  outranksObservedWebSource,
  type ObservedWebSource,
} from '../domains/browser/web-research-evidence.js'

export interface ProviderCapabilityBrokerPort {
  callTool(
    request: McpBrokerCallRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<McpBrokerCallResult>
}

export interface ProviderCapabilityCall {
  readonly toolCallId: string
  /** Trusted provider-facing name from the host-owned tool inventory. */
  readonly capabilityId: string
  readonly arguments: McpJsonObject
  readonly signal: AbortSignal
  /** Provider tool-call order for the turn, when the provider exposes it. */
  readonly providerCallOrdinal?: number
}

export interface ProviderCapabilityGatewayOptions {
  readonly context: Omit<McpBrokerRequestContext, 'requestId'>
  readonly broker: ProviderCapabilityBrokerPort
  readonly tools: readonly McpNamespacedTool[]
  readonly builtinTools: readonly BuiltinAgentToolAdapter[]
  readonly requiredServerIds: ReadonlySet<string>
}

type ProviderCapabilityBinding = (
  call: ProviderCapabilityCall,
) => Promise<ProviderToolExecutionResult>

/**
 * One provider-facing invocation seam over already-governed built-in and MCP
 * gateways. Provider transports receive only their stable wire result; host
 * lifecycle, policy, effect, and evidence metadata remain inside the host.
 */
export class ProviderCapabilityGateway {
  private readonly bindings: ReadonlyMap<string, ProviderCapabilityBinding>
  private readonly resolvedCapabilityIds = new Set<string>()
  private readonly webSourcesByUrl = new Map<string, ObservedWebSource>()
  private readonly artifactsByPath = new Map<string, BuiltinToolArtifact>()
  private fatalError: McpSanitizedError | undefined

  constructor(private readonly options: ProviderCapabilityGatewayOptions) {
    this.bindings = this.createBindings()
  }

  async execute(
    call: ProviderCapabilityCall,
  ): Promise<ProviderToolExecutionResult> {
    const binding = this.bindings.get(call.capabilityId)
    if (!binding) {
      throw new Error('Provider requested an unavailable governed capability.')
    }
    const result = await binding(call)
    // Recorded only once the binding has resolved. A capability that threw
    // never handed the provider a result, and a dispatch or infrastructure
    // failure must not be able to pass for one.
    this.resolvedCapabilityIds.add(call.capabilityId)
    return result
  }

  /**
   * Sorted by URL rather than returned in insertion order: under a parallel
   * segment insertion order is completion order, so the sequence — not just
   * each retained record — has to be a pure function of the observation set.
   */
  observedWebSources(): readonly ObservedWebSource[] {
    return [...this.webSourcesByUrl.values()].sort((left, right) =>
      left.url < right.url ? -1 : left.url > right.url ? 1 : 0,
    )
  }

  producedArtifacts(): readonly BuiltinToolArtifact[] {
    return [...this.artifactsByPath.values()].sort((left, right) => {
      if (left.role !== right.role) return left.role === 'final' ? -1 : 1
      return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    })
  }

  fatalBrokerError(): McpSanitizedError | undefined {
    return this.fatalError
  }

  /**
   * Whether this capability returned a wire result during the turn, whether it
   * reported success or a typed error. Deciding what a given result proves is
   * the caller's business; the gateway only records that one arrived.
   */
  hasResolvedCapabilityResult(capabilityId: string): boolean {
    return this.resolvedCapabilityIds.has(capabilityId)
  }

  private createBindings(): ReadonlyMap<string, ProviderCapabilityBinding> {
    const builtinByName = new Map<string, BuiltinAgentToolAdapter>()
    for (const adapter of this.options.builtinTools) {
      if (adapter.name !== adapter.tool.namespacedName) {
        throw new Error('Built-in provider capability identity is inconsistent.')
      }
      if (builtinByName.has(adapter.name)) {
        throw new Error('Built-in provider capability identity is duplicated.')
      }
      builtinByName.set(adapter.name, adapter)
    }

    const bindings = new Map<string, ProviderCapabilityBinding>()
    for (const tool of this.options.tools) {
      if (bindings.has(tool.namespacedName)) {
        throw new Error('Provider capability identity is duplicated.')
      }
      const builtin = builtinByName.get(tool.namespacedName)
      bindings.set(
        tool.namespacedName,
        builtin
          ? (call) => this.executeBuiltin(builtin, call)
          : (call) => this.executeMcp(tool, call),
      )
    }
    return bindings
  }

  private async executeBuiltin(
    adapter: BuiltinAgentToolAdapter,
    call: ProviderCapabilityCall,
  ): Promise<ProviderToolExecutionResult> {
    const result = await adapter.execute({
      context: {
        ...this.options.context,
        requestId: randomUUID(),
        ...(call.providerCallOrdinal === undefined
          ? {}
          : { providerCallOrdinal: call.providerCallOrdinal }),
      },
      toolCallId: call.toolCallId,
      input: call.arguments,
      signal: call.signal,
    })
    const observation = result.webObservation
    if (observation?.url && observation.text.trim()) {
      const previous = this.webSourcesByUrl.get(observation.url)
      if (!previous || outranksObservedWebSource(observation, previous)) {
        this.webSourcesByUrl.set(observation.url, observation)
      }
    }
    for (const artifact of result.artifacts ?? []) {
      this.artifactsByPath.set(artifact.path, artifact)
    }
    return {
      content: result.content,
      isError: result.isError,
      ...(result.interruption ? { interruption: result.interruption } : {}),
      ...(result.images ? { images: result.images } : {}),
    }
  }

  private async executeMcp(
    tool: McpNamespacedTool,
    call: ProviderCapabilityCall,
  ): Promise<ProviderToolExecutionResult> {
    const result = await this.options.broker.callTool(
      {
        context: {
          ...this.options.context,
          requestId: randomUUID(),
          ...(call.providerCallOrdinal === undefined
            ? {}
            : { providerCallOrdinal: call.providerCallOrdinal }),
        },
        toolCallId: call.toolCallId,
        namespacedToolName: tool.namespacedName,
        arguments: call.arguments,
      },
      { signal: call.signal },
    )
    if (
      result.error &&
      this.options.requiredServerIds.has(tool.serverId)
    ) {
      if (!this.fatalError) {
        this.fatalError = result.error
      }
      throw new Error('A required governed capability failed.')
    }
    return sanitizedMcpResult(result)
  }
}

function sanitizedMcpResult(
  result: McpBrokerCallResult,
): ProviderToolExecutionResult {
  return {
    content: JSON.stringify({
      content: result.content,
      ...(result.error
        ? {
            error: {
              code: result.error.code,
              message: result.error.message,
              retryable: result.error.retryable,
            },
          }
        : {}),
    }),
    isError: result.isError,
  }
}
