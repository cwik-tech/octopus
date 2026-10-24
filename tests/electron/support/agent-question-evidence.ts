import { readFileSync, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { z } from 'zod'

const taskOutcomeSchema = z.object({ id: z.string(), runId: z.string(), status: z.string(), error: z.string().optional() })

const agentEvidenceSchema = z.object({
  event: z.string(), agent_name: z.string().optional(), status: z.string().optional(),
  provider: z.string().optional(), model: z.string().optional(),
  dispatch_id: z.string().optional(), logical_invocation_id: z.string().optional(),
  cost: z.number().optional(), input_tokens: z.number().optional(), output_tokens: z.number().optional(),
  duration_ms: z.number().optional(),
})
const hostEvidenceSchema = z.object({
  event: z.string(), host_provider: z.string().nullable().optional(), host_model: z.string().nullable().optional(),
  initial_host_provider: z.string().nullable().optional(), initial_host_model: z.string().nullable().optional(),
})

/** Read only the provider/identity evidence; exclude prompts and credentials. */
export async function readQuestionProviderEvidence(workspace: string, identity: { sessionId: string; runId: string; childRunId: string }) {
  const logs = path.join(workspace, 'sessions', identity.sessionId, 'runs', identity.runId, 'assignments', identity.childRunId, 'logs')
  const [agents, hosts] = await Promise.all([
    readFile(path.join(logs, 'agent-runs.jsonl'), 'utf8'), readFile(path.join(logs, 'host-events.jsonl'), 'utf8'),
  ])
  return {
    agents: agents.trim().split('\n').filter(Boolean).map((line) => agentEvidenceSchema.parse(JSON.parse(line))),
    hosts: hosts.trim().split('\n').filter(Boolean).map((line) => hostEvidenceSchema.parse(JSON.parse(line)))
      .filter((event) => event.event === 'host.session_start'),
  }
}

/** Observe the real durable task record; no timer polling or substituted runtime. */
export function observeQuestionTaskOutcome(workspace: string, question: { sessionId: string; taskId: string }, timeoutMs: number) {
  const directory = path.join(workspace, 'sessions', question.sessionId, 'tasks', question.taskId)
  return new Promise<z.infer<typeof taskOutcomeSchema>>((resolve, reject) => {
    const watcher = watch(directory, inspect)
    const timeout = setTimeout(() => finish(new Error(`Task ${question.taskId} did not settle within ${timeoutMs} ms.`)), timeoutMs)
    function finish(error?: Error, outcome?: z.infer<typeof taskOutcomeSchema>) {
      watcher.close()
      clearTimeout(timeout)
      if (error) reject(error)
      else if (outcome) resolve(outcome)
    }
    function inspect() {
      try {
        const outcome = taskOutcomeSchema.parse(JSON.parse(readFileSync(path.join(directory, 'task.json'), 'utf8')))
        if (['done', 'failed', 'blocked', 'cancelled'].includes(outcome.status)) finish(undefined, outcome)
      } catch (error) { finish(error instanceof Error ? error : new Error('Could not read the task outcome.')) }
    }
    watcher.on('error', finish)
    inspect()
  })
}
