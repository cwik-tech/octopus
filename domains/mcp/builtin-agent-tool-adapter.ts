import type { AgentQuestionInterruption } from '../../contracts/agent-questions.js'
import type {
  McpBrokerRequestContext,
  McpJsonObject,
  McpNamespacedTool,
} from './mcp-runtime.js'

export interface AssignmentScope {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly activityScopeId?: string
}

export interface BuiltinToolExecutionInput {
  readonly context: McpBrokerRequestContext & {
    readonly activityScopeId?: string
  }
  readonly toolCallId: string
  readonly input: McpJsonObject
  readonly signal?: AbortSignal
}

export interface BuiltinToolImage {
  readonly data: string
  readonly mimeType: string
}

export interface BuiltinWebObservation {
  readonly url: string
  readonly title?: string
  readonly text: string
}

export interface BuiltinToolArtifact {
  readonly path: string
  readonly title?: string
  readonly mediaType?: string
  readonly digest?: string
  readonly role: 'final' | 'secondary'
}

export interface BuiltinToolExecutionResult {
  /** Host-only control result; never inferred from model text or tool output. */
  readonly interruption?: AgentQuestionInterruption
  /**
   * Tool output remains opaque here. Each adapter owns its concrete output
   * contract so adding a built-in does not expand a central union.
   */
  readonly output: unknown
  readonly content: string
  readonly isError: boolean
  readonly images?: readonly BuiltinToolImage[]
  readonly webObservation?: BuiltinWebObservation
  readonly artifacts?: readonly BuiltinToolArtifact[]
}

export interface BuiltinAgentToolAdapter {
  readonly name: string
  readonly tool: McpNamespacedTool
  /** Bind filesystem reads to a host-admitted immutable resource root. */
  forResourceRoot?(repoRootPath: string): BuiltinAgentToolAdapter
  isEnabledForAgent(agentPath: string): boolean
  execute(input: BuiltinToolExecutionInput): Promise<BuiltinToolExecutionResult>
  releaseAssignment?(scope: AssignmentScope): Promise<void>
}
