/**
 * The Team runtime's one connection back to the parent.
 *
 * A run has a single channel and a single sender: one bounded queue, one
 * request in flight, one credential. Each dispatch gets its own bubble inside
 * that channel rather than its own connection, because the ordering the
 * renderer depends on is per channel and a second connection would race it.
 *
 * A run that was never granted a channel gets no sender at all — not a
 * disabled one. There is nothing to configure later, nothing holding a
 * credential it never received, and no code path where a workflow run quietly
 * acquires one.
 */
import {
  createAgentTextDeltaSender,
  type AgentTextDeltaSender,
} from './agent-text-delta-sender.js'
import {
  createAgentTextDispatchSink,
  type AgentTextDispatchSink,
} from './agent-text-dispatch-sink.js'
import {
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  AGENT_TEXT_STREAM_URL_ENV,
} from './agent-text-delta-tokens.js'

export interface RunTextStream {
  /** This attempt's bubble, or `undefined` when the run has no channel. */
  sinkFor(dispatchId: string): AgentTextDispatchSink | undefined
  /** Flush and stop. Bounded by the sender's own terminal deadline. */
  close(): Promise<void>
}

const INERT: RunTextStream = {
  sinkFor: () => undefined,
  close: async () => undefined,
}

export function createRunTextStreamFromEnvironment(
  environment: NodeJS.ProcessEnv,
  options: {
    send?: (url: string, init: RequestInit) => Promise<Response>
    flushIntervalMs?: number
  } = {},
): RunTextStream {
  const url = environment[AGENT_TEXT_STREAM_URL_ENV]
  const channelId = environment[AGENT_TEXT_STREAM_CHANNEL_ENV]
  const token = environment[AGENT_TEXT_STREAM_TOKEN_ENV]
  // All three or none. Half a grant cannot post, and pretending otherwise
  // would mean discovering it one failed request at a time.
  if (!url || !channelId || !token) return INERT

  const sender: AgentTextDeltaSender = createAgentTextDeltaSender({
    url,
    channelId,
    token,
    send: options.send ?? ((target, init) => fetch(target, init)),
    ...(options.flushIntervalMs === undefined
      ? {}
      : { flushIntervalMs: options.flushIntervalMs }),
  })

  // One sink per dispatch id, because the id names one concrete attempt: its
  // sequence must keep advancing across every event that attempt produces,
  // and a second sink would restart it and make the hub report a hole.
  const sinks = new Map<string, AgentTextDispatchSink>()

  return {
    sinkFor(dispatchId) {
      const existing = sinks.get(dispatchId)
      if (existing) return existing
      const sink = createAgentTextDispatchSink({ sender, dispatchId })
      sinks.set(dispatchId, sink)
      return sink
    },
    close: () => sender.close(),
  }
}

let processStream: RunTextStream | undefined

/**
 * The stream for this process, built once from its own environment.
 *
 * Memoised because the sender owns a queue and a single in-flight slot; a
 * second one would defeat both.
 */
export function getProcessRunTextStream(): RunTextStream {
  processStream ??= createRunTextStreamFromEnvironment(process.env)
  return processStream
}
