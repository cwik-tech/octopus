import type { EngineEventEnvelope } from './runtime-events.js'
import type { McpRunDiagnosticsSnapshot } from './mcp.js'

export type RunStatus =
  | 'active'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'incomplete'
  | 'unknown'

export interface RunSummary {
  id: string
  assignmentPath: string
  team: string | null
  jobTitle?: string | null
  startedAt: string | null
  updatedAt: string | null
  status: RunStatus
  rootRunId?: string
  parentRunId?: string | undefined
  artifactPaths: string[]
}

export interface RunDetails extends RunSummary {
  eventCount: number
  latestEventType: string | null
}

export interface RunsResponse {
  runs: RunSummary[]
}

export interface RunEventsSnapshotResponse {
  events: EngineEventEnvelope[]
}

export interface RunTranscriptSnapshot {
  canonical: Record<string, unknown>[]
  raw: Record<string, unknown>[]
}

export interface RunDelegationLifecycleSnapshot {
  lifecycle: Record<string, unknown>[]
  state: Record<string, unknown>
}

export interface RunBashRiskEvent {
  command: string
  flags: string[]
  risk: 'low' | 'medium' | 'high'
  runId: string
  timestamp: string
  toolCallId?: string
  sourceEventType: string
}

export interface RunDiagnosticsSnapshot {
  bashRisks: RunBashRiskEvent[]
  delegations: RunDelegationLifecycleSnapshot
  mcp: McpRunDiagnosticsSnapshot
  transcript: RunTranscriptSnapshot
}

export interface RunStartRequest {
  cwd: string
  env?: Record<string, string>
  processIdentity?: string
}

export interface RunLaunchResult {
  launched: true
  pid: number
  processGroupId?: number
  processIdentity?: string
  configuredProviderBrokerIdentity?: string
  cwd: string
}
