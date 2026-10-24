import { z } from 'zod'
import { agentProgressReportSchema, agentProgressTaskStatusSchema, type AgentProgressUpdate } from '../../contracts/agent-progress.js'
import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type { BuiltinAgentToolAdapter } from './builtin-agent-tool-adapter.js'

export const AGENT_PROGRESS_INSTRUCTION = 'Use report_progress for a short user-facing milestone when beginning substantial work or changing approach. For multi-step work, include a small checklist with stable task IDs and update it at meaningful milestones. These are reported statuses, not proof of completion. Do not expose private reasoning or secrets. Do not call it just to say you are still working. It performs no work itself.'

const REPORT_LIMITS = 'The summary and each task label must have 1-160 characters. Use at most 12 tasks, each with a unique ID of up to 64 letters, digits, _ or -.'

/**
 * Advertised without the limits. A native tool loop fails the whole reply when
 * a call breaks the advertised schema, and a display-only report must not be
 * able to do that. `execute` applies the limits and rejects only the call.
 */
const advertisedReportSchema = z.object({
  summary: z.string(),
  tasks: z.array(z.object({ id: z.string(), label: z.string(), status: agentProgressTaskStatusSchema })).optional(),
})

/** Display-only reporting; never grants file, execution or task-state authority. */
export function createAgentProgressToolAdapter(report: (update: AgentProgressUpdate) => void): BuiltinAgentToolAdapter {
  return {
    name: 'report_progress',
    tool: {
      serverId: 'agent-progress', serverName: 'Agent progress',
      toolName: 'report_progress', namespacedName: 'report_progress',
      description: `Report a short user-facing milestone and optionally replace your checklist. Keep task IDs stable. Omitting tasks retains the previous checklist; an empty list clears it. This only updates the progress display, not actual task outcomes. ${REPORT_LIMITS}`,
      inputSchema: z.toJSONSchema(advertisedReportSchema),
      annotations: { readOnlyHint: true, destructiveHint: false },
      risk: 'read-only', effect: serialCapabilityEffect('read-only'), requiresApproval: false,
    },
    isEnabledForAgent: () => true,
    async execute(input) {
      input.signal?.throwIfAborted()
      const parsed = agentProgressReportSchema.safeParse(input.input)
      if (!parsed.success) return { output: { reported: false }, content: `Progress was not reported. ${REPORT_LIMITS}`, isError: true }
      report({ kind: 'reported', ...parsed.data })
      return { output: { reported: true }, content: 'Progress reported.', isError: false }
    },
  }
}
