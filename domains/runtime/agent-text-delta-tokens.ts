/**
 * Credentials for the run child's way into a display channel.
 *
 * A Team runs two detached process hops from the hub, so its frames arrive
 * over loopback HTTP and need a credential. The authority granted is
 * deliberately tiny: one channel, for one run, until that run ends.
 *
 * Three rules shape this module.
 *
 * - **The token is never stored.** Only its digest is, so a memory dump, a
 *   log of this structure, or an error that stringifies it cannot reveal a
 *   working credential.
 * - **Lookup does not depend on the secret's content.** Resolution hashes the
 *   candidate and looks up the digest, so a wrong token costs the same as a
 *   right one.
 * - **A grant dies with its run.** There is no long-lived credential here; the
 *   TTL is only a backstop for a child that never terminates cleanly.
 */
import { createHash, randomBytes } from 'node:crypto'

/** What one token is allowed to do. */
export interface AgentTextDeltaGrant {
  readonly channelId: string
  readonly runId: string
  readonly expiresAtMs: number
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000
const TOKEN_BYTES = 32

export interface AgentTextDeltaTokenRegistryOptions {
  readonly now?: () => number
  readonly defaultTtlMs?: number
}

export class AgentTextDeltaTokenRegistry {
  private readonly grants = new Map<string, AgentTextDeltaGrant>()
  private readonly now: () => number
  private readonly defaultTtlMs: number

  constructor(options: AgentTextDeltaTokenRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS
  }

  /** Mint a credential for one channel. The plaintext is returned once. */
  issue(params: {
    readonly channelId: string
    readonly runId: string
    readonly ttlMs?: number
  }): string {
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    this.grants.set(digestOf(token), {
      channelId: params.channelId,
      runId: params.runId,
      expiresAtMs: this.now() + (params.ttlMs ?? this.defaultTtlMs),
    })
    return token
  }

  /** Resolve a candidate, or `undefined` for unknown and expired alike. */
  resolve(token: string): AgentTextDeltaGrant | undefined {
    const key = digestOf(token)
    const grant = this.grants.get(key)
    if (!grant) return undefined
    if (grant.expiresAtMs <= this.now()) {
      this.grants.delete(key)
      return undefined
    }
    return grant
  }

  /** Called when a run reaches a terminal state. */
  revokeByRun(runId: string): void {
    for (const [key, grant] of this.grants) {
      if (grant.runId === runId) this.grants.delete(key)
    }
  }

  get size(): number {
    return this.grants.size
  }
}

function digestOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64')
}

/**
 * How the three values reach a run child.
 *
 * They are separate on purpose. Only the third is a credential, and keeping it
 * apart from the address and the channel id is what allows the other two to be
 * logged, recorded on a run, and read back without leaking anything.
 *
 * None of these may be added to the provider-CLI environment allowlist: that
 * allowlist feeds untrusted grandchildren, and the sender lives in the run
 * child rather than in a provider CLI.
 */
export const AGENT_TEXT_STREAM_URL_ENV = 'PIPELINE_AGENT_TEXT_STREAM_URL'
export const AGENT_TEXT_STREAM_CHANNEL_ENV = 'PIPELINE_AGENT_TEXT_CHANNEL_ID'
export const AGENT_TEXT_STREAM_TOKEN_ENV = 'PIPELINE_AGENT_TEXT_STREAM_TOKEN'

/** Fixed and public: the credential is in the header, never the path. */
export const AGENT_TEXT_STREAM_INGEST_PATH = '/internal/agent-text-stream'

/**
 * Where a run child posts its frames.
 *
 * The address is only known once the server is listening, and it is not a
 * secret — it is the plain loopback origin plus a fixed path. Keeping it apart
 * from the token is the point: this value may be logged and handed around,
 * and the token may not.
 */
export class AgentTextDeltaEndpoint {
  private endpointUrl: string | undefined

  bind(baseUrl: string): void {
    this.endpointUrl = `${baseUrl.replace(/\/+$/, '')}${AGENT_TEXT_STREAM_INGEST_PATH}`
  }

  get url(): string | undefined {
    return this.endpointUrl
  }
}
