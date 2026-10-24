/**
 * Decide whether a run child is given a display-stream credential, and what.
 *
 * Separated from the launch shell because this is the authority question, and
 * an authority question deserves to be readable on its own: a wrong `true`
 * here hands a posting credential to a run that has no participant text to
 * show. Pure, so the decision can be stated and tested as plain data, with the
 * minter passed in rather than reached for.
 *
 * The three values it produces are deliberately separate. Only the token is a
 * credential; the address and the channel id are not, which is what lets those
 * two be recorded and logged while the token never is.
 */
import { randomUUID } from 'node:crypto'

import { whenDefined } from '../../core/optional-properties.js'
import {
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  AGENT_TEXT_STREAM_URL_ENV,
} from './agent-text-delta-tokens.js'

/** Only a Team run has participant text to show while it generates. */
const STREAMING_TARGET_KIND = 'team-chat'

export interface AgentTextStreamLaunchInput {
  /** A run's target. Anything but a Team gets no credential. */
  readonly targetKind?: string | undefined
  readonly runId: string
  /** Absent until the server is listening and knows its own address. */
  readonly endpointUrl?: string | undefined
}

/**
 * What a mint produces for one run.
 *
 * Both are made at launch. Neither is read from a stored task, so nothing
 * about this channel outlives the run that owns it.
 */
export interface AgentTextStreamGrant {
  readonly channelId: string
  readonly token: string
}

export interface AgentTextStreamLaunchPlan {
  readonly channelId: string
  readonly env: Readonly<Record<string, string>>
}

/**
 * Returns what to add to the child's environment, or `undefined` when this run
 * gets nothing.
 *
 * `mint` is called only when a plan is actually produced, so a run that is
 * refused never causes a channel or a credential to exist at all — there is
 * nothing to revoke, leak, or forget to revoke.
 */
export function planAgentTextStreamLaunch(
  input: AgentTextStreamLaunchInput,
  mint: (params: { runId: string }) => AgentTextStreamGrant,
): AgentTextStreamLaunchPlan | undefined {
  if (input.targetKind !== STREAMING_TARGET_KIND) return undefined
  const endpointUrl = input.endpointUrl
  if (!endpointUrl) return undefined

  const grant = mint({ runId: input.runId })
  return {
    channelId: grant.channelId,
    env: {
      [AGENT_TEXT_STREAM_URL_ENV]: endpointUrl,
      [AGENT_TEXT_STREAM_CHANNEL_ENV]: grant.channelId,
      [AGENT_TEXT_STREAM_TOKEN_ENV]: grant.token,
    },
  }
}

export interface AgentTextStreamLaunchRequest {
  readonly sessionId: string
  readonly runId: string
  readonly targetKind?: string | undefined
}

/** The hub operations this port needs, named so a test can stand in for them. */
export interface AgentTextStreamLaunchHub {
  openChannel(channelId: string, ownerId: string): void
  closeChannel(channelId: string): void
}

export interface AgentTextStreamLaunchTokens {
  issue(params: { channelId: string; runId: string }): string
  revokeByRun(runId: string): void
}

export interface AgentTextStreamLaunchPort {
  /** Reserve a channel and mint this attempt's credential, or refuse. */
  grant(
    request: AgentTextStreamLaunchRequest,
  ): AgentTextStreamLaunchPlan | undefined
  /** Undo a grant whose launch did not take. Safe to call twice. */
  rollback(channelId: string): void
  /** Release a run's channel and credential once it is genuinely over. */
  retire(runId: string): void
}

/**
 * Own the lifetime of one run's display channel.
 *
 * The rule that shapes this is recovery. `interrupted` is an *active* state,
 * and a recovered run relaunches under the same run id, so "issue at launch"
 * alone would leave the previous attempt's credential working and its channel
 * still serving a bubble whose attempt is gone. Every grant therefore retires
 * whatever the run held before opening anything new, and it does so in that
 * order: revoke, close, open, issue. There is never a live credential pointing
 * at a channel nobody owns, nor a channel with no way to close it.
 */
export function createAgentTextStreamLaunchPort(deps: {
  hub: AgentTextStreamLaunchHub
  tokens: AgentTextStreamLaunchTokens
  endpoint: { readonly url?: string | undefined }
  /** Injectable so a test can name the channels it asserts on. */
  newChannelId?: () => string
}): AgentTextStreamLaunchPort {
  const channelsByRun = new Map<string, string>()
  const runsByChannel = new Map<string, string>()
  const newChannelId = deps.newChannelId ?? (() => randomUUID())

  const release = (runId: string): void => {
    const previous = channelsByRun.get(runId)
    // Revoked before the channel closes: a token that outlived its channel for
    // even a moment is a credential pointing at nothing anyone owns.
    deps.tokens.revokeByRun(runId)
    channelsByRun.delete(runId)
    if (previous === undefined) return
    runsByChannel.delete(previous)
    deps.hub.closeChannel(previous)
  }

  return {
    grant(request) {
      return planAgentTextStreamLaunch(
        {
          runId: request.runId,
          ...whenDefined(request.targetKind, (targetKind) => ({ targetKind })),
          ...whenDefined(deps.endpoint.url, (endpointUrl) => ({ endpointUrl })),
        },
        ({ runId }) => {
          if (channelsByRun.has(runId)) release(runId)
          const channelId = newChannelId()
          deps.hub.openChannel(channelId, request.sessionId)
          const token = deps.tokens.issue({ channelId, runId })
          channelsByRun.set(runId, channelId)
          runsByChannel.set(channelId, runId)
          return { channelId, token }
        },
      )
    },
    rollback(channelId) {
      const runId = runsByChannel.get(channelId)
      if (runId === undefined) return
      release(runId)
    },
    retire(runId) {
      if (!channelsByRun.has(runId)) return
      release(runId)
    },
  }
}

export interface AgentTextStreamLaunchRuntime {
  readonly port: AgentTextStreamLaunchPort
  /** Stop listening. Idempotent, so a double shutdown is harmless. */
  dispose(): void
}

/**
 * The port, plus the one subscription that releases a run that actually ran.
 *
 * The launch shell hands a grant back when a launch never takes, but a run
 * that started outlives that call. Terminal assignments are already reported
 * by the store, so this listens once and releases on that signal rather than
 * polling or guessing from elapsed time.
 */
export function createAgentTextStreamLaunchRuntime(deps: {
  hub: AgentTextStreamLaunchHub
  tokens: AgentTextStreamLaunchTokens
  endpoint: { readonly url?: string | undefined }
  newChannelId?: () => string
  assignmentLifecycle?: {
    subscribeTaskTerminal?(
      listener: (scope: { runId: string }) => void | Promise<void>,
    ): () => void
  }
}): AgentTextStreamLaunchRuntime {
  const port = createAgentTextStreamLaunchPort({
    hub: deps.hub,
    tokens: deps.tokens,
    endpoint: deps.endpoint,
    ...whenDefined(deps.newChannelId, (newChannelId) => ({ newChannelId })),
  })
  // `retire` ignores a run it never granted, so a report for somebody else's
  // run costs nothing and needs no bookkeeping here.
  const unsubscribe = deps.assignmentLifecycle?.subscribeTaskTerminal?.(
    (scope) => port.retire(scope.runId),
  )
  let disposed = false
  return {
    port,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe?.()
    },
  }
}

/**
 * Carry a run child's display-stream values one process hop further.
 *
 * The Team runtime is spawned with an explicit environment rather than an
 * inherited one, so these have to be named to make the hop — the engines that
 * produce the text run there. Only these three cross, and only together: half
 * a grant is not a usable one, and forwarding an address without its
 * credential would leave the runtime posting without authorization.
 */
export function forwardAgentTextStreamEnvironment(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const url = source[AGENT_TEXT_STREAM_URL_ENV]
  const channelId = source[AGENT_TEXT_STREAM_CHANNEL_ENV]
  const token = source[AGENT_TEXT_STREAM_TOKEN_ENV]
  if (!url || !channelId || !token) return {}
  return {
    [AGENT_TEXT_STREAM_URL_ENV]: url,
    [AGENT_TEXT_STREAM_CHANNEL_ENV]: channelId,
    [AGENT_TEXT_STREAM_TOKEN_ENV]: token,
  }
}
