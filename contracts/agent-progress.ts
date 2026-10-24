import { z } from 'zod'

export const AGENT_PROGRESS_HISTORY_LIMIT = 16
export const AGENT_PROGRESS_ACTIVITY_INTERVAL_MS = 2000
export const AGENT_PROGRESS_MAX_ATTEMPT = 1000

const observedProgressSchema = z.object({
  kind: z.literal('observed'),
  phase: z.enum(['starting', 'thinking', 'tool', 'waiting', 'retry', 'answering', 'rate_limited']),
  toolName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/).optional(),
  attempt: z.number().int().min(1).max(AGENT_PROGRESS_MAX_ATTEMPT).optional(),
  retryDelayMs: z.number().int().min(0).max(86_400_000).optional(),
}).strict()

export const agentProgressTaskStatusSchema = z.enum(['pending', 'active', 'completed'])
const progressTasksSchema = z.array(z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  label: z.string().trim().min(1).max(160),
  status: agentProgressTaskStatusSchema,
}).strict()).max(12).refine(tasks => new Set(tasks.map(task => task.id)).size === tasks.length, 'Task identities must be unique')
export const agentProgressReportSchema = z.object({
  summary: z.string().trim().min(1).max(160),
  tasks: progressTasksSchema.optional(),
}).strict()
const reportedProgressSchema = agentProgressReportSchema.extend({ kind: z.literal('reported') })
export const agentProgressUpdateSchema = z.discriminatedUnion('kind', [observedProgressSchema, reportedProgressSchema])
export type AgentProgressUpdate = z.infer<typeof agentProgressUpdateSchema>

export const agentProgressSnapshotSchema = z.object({
  revision: z.number().int().positive(),
  startedAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  current: agentProgressUpdateSchema,
  reported: z.object({ at: z.number().finite().nonnegative(), summary: z.string().trim().min(1).max(160), tasks: progressTasksSchema }).strict().optional(),
  history: z.array(z.object({ at: z.number().finite().nonnegative(), update: agentProgressUpdateSchema }).strict()).max(AGENT_PROGRESS_HISTORY_LIMIT),
}).strict()
export type AgentProgressSnapshot = z.infer<typeof agentProgressSnapshotSchema>

/** Fold actual activity only; timers and heartbeats never call this function. */
export function updateAgentProgress(current: AgentProgressSnapshot | undefined, update: AgentProgressUpdate, at: number): AgentProgressSnapshot {
  const same = current !== undefined && JSON.stringify(current.current) === JSON.stringify(update)
  if (same && at - current.updatedAt < AGENT_PROGRESS_ACTIVITY_INTERVAL_MS) return current
  return {
    revision: (current?.revision ?? 0) + 1,
    startedAt: current?.startedAt ?? at,
    updatedAt: Math.max(at, current?.updatedAt ?? at),
    current: update,
    ...(update.kind === 'reported' ? { reported: { at, summary: update.summary, tasks: update.tasks ?? current?.reported?.tasks ?? [] } }
      : current?.reported ? { reported: current.reported } : {}),
    history: same ? current.history : [...(current?.history ?? []), { at, update }].slice(-AGENT_PROGRESS_HISTORY_LIMIT),
  }
}
