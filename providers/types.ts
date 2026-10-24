/**
 * Provider Abstraction — Type Definitions
 *
 * Defines the Provider interface and associated types for the multi-CLI
 * provider abstraction layer. Each provider wraps a different CLI tool
 * (Pi, Codex, Gemini, etc.) and returns a uniform ProviderResult.
 */

import {
  normalizeTokenUsage,
  type NormalizedTokenUsage,
} from '../contracts/model-diagnostics.js'
import type { ProviderTurnDiagnosticsRecorder } from '../domains/runtime/provider-turn-diagnostics.js'
import type { ThinkingLevel } from '../core/types.js'
import type { ProviderProtocolEvent } from '../contracts/provider.js'
import type { ModelImage } from '../contracts/model-image.js'

export type {
  ProviderProtocolEvent,
  ProviderProtocolEventKind,
} from '../contracts/provider.js'

/**
 * Ephemeral, parent-owned MCP endpoint exposed to one provider invocation.
 * This capability is runtime-only and must never be persisted in providerConfig.
 */
export interface ProviderMcpBridge {
  readonly url: string
  readonly tokenEnvironmentVariable: string
  readonly token: string
  /** Raw tool names advertised by the bridge server named `pipeline`. */
  readonly proxyToolNames: readonly string[]
  /** Friendly, runtime-only metadata for provider-side deferred tool discovery. */
  readonly toolInventory?: readonly ProviderMcpBridgeToolInventoryEntry[]
}

export interface ProviderMcpBridgeToolInventoryEntry {
  readonly proxyName: string
  readonly serverName: string
  readonly toolName: string
  readonly description?: string
}

export interface ProviderExecuteOptions {
  systemPrompt: string
  userMessage: string
  images?: readonly ModelImage[]
  model: string
  thinking: ThinkingLevel
  tools?: string[]
  cwd?: string
  signal?: AbortSignal
  outputPath?: string
  /** Optional JSON Schema constraining the provider's final response. */
  outputSchema?: Readonly<Record<string, unknown>>
  sessionId?: string
  rootSessionId?: string
  agentName?: string
  providerConfig?: Record<string, unknown>
  mcpBridge?: ProviderMcpBridge
  /** Runtime-only observer fired when a CLI child process has spawned. */
  onProcessStarted?: () => void
  /** Runtime-only observer fired for each parsed provider protocol event. */
  onProtocolEvent?: (event: ProviderProtocolEvent) => void
  /**
   * Override the silence thresholds for this turn. The defaults are tuned to
   * observed provider behaviour; this exists so the policy can be exercised
   * without waiting out a real two-minute stall, and so an operator can tune a
   * deployment whose provider is legitimately slower.
   */
  stallWatchdog?: {
    readonly idleMs?: number
    readonly abortIdleMs?: number
    readonly pollMs?: number
  }
  /**
   * A content-free account of this turn's process, for the callers that keep
   * one.
   *
   * Deliberately not `outputPath`. That writes the provider's protocol
   * transcript, assistant text included, and a turn's *process* record has to
   * be safe to keep for every ordinary chat turn — which a copy of the
   * conversation is not.
   */
  turnDiagnostics?: ProviderTurnDiagnosticsRecorder
}

export interface ProviderResult {
  text: string
  cost: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  contextTokens: number
  model: string
  /** True when cost is API-reported, configured, or intentionally zero-cost. */
  costTracked?: boolean
  costSource?: 'reported' | 'provider_config' | 'environment' | 'zero_cost' | 'untracked'
}

export interface Provider {
  readonly name: string
  execute(options: ProviderExecuteOptions): Promise<ProviderResult>
  stream?(options: ProviderExecuteOptions): AsyncIterable<ProviderProtocolEvent>
}

/**
 * A CLI provider's token counts, in the one shape every provider reduces to.
 *
 * `ProviderResult` always carries the two numbers, so absence has to be spelled
 * a different way here: a turn with zero tokens on both sides is a provider
 * that does not report usage, not a turn that cost nothing. Recording `0/0/0`
 * would be indistinguishable from a measurement, and every total built from it
 * would be wrong by exactly the amount nobody measured.
 */
export function normalizeProviderResultUsage(
  result: Pick<ProviderResult, 'inputTokens' | 'outputTokens'>,
): NormalizedTokenUsage | undefined {
  if (result.inputTokens === 0 && result.outputTokens === 0) return undefined
  return normalizeTokenUsage({
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  })
}
