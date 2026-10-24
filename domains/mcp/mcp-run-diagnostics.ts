import type {
  McpRunDiagnosticsSnapshot,
  McpToolResultDiagnosticsView,
} from '../../contracts/mcp.js'
import { McpEvidenceStore } from './mcp-evidence-store.js'
import { resolveRunAssignmentLocation } from '../run/run-location.js'

export type { McpRunDiagnosticsSnapshot, McpToolResultDiagnosticsView }

const EMPTY_MCP_DIAGNOSTICS: McpRunDiagnosticsSnapshot = {
  audit: [],
  toolResults: [],
}

/**
 * Reads the canonical per-assignment MCP audit and tool-result evidence.
 * Absolute evidence paths are deliberately removed at this API boundary.
 */
export async function readMcpRunDiagnostics(
  workspacePath: string,
  runId: string,
): Promise<McpRunDiagnosticsSnapshot> {
  const location = resolveRunAssignmentLocation(workspacePath, runId)
  if (!location || location.layout !== 'session') {
    return EMPTY_MCP_DIAGNOSTICS
  }

  const store = new McpEvidenceStore({
    workspacePath,
    sessionId: location.sessionId,
    runId: location.runId,
    assignmentId: location.assignmentId,
  })
  const [audit, evidence] = await Promise.all([
    store.listAuditEvents(),
    store.listToolResultEvidence(),
  ])

  return {
    audit,
    toolResults: evidence.map(({ record, totalBytes, aggregateHash, contents }) => ({
      record,
      totalBytes,
      aggregateHash,
      contents,
    })),
  }
}
