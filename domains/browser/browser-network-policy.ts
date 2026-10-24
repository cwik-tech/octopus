import { whenDefined } from '../../core/optional-properties.js'
import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'

import {
  browserUrlAllowed,
  isPublicWebHost,
  type BrowserAgentPolicy,
} from './browser-policy.js'

export interface BrowserNetworkPolicyOptions {
  readonly allowHttpLocalhost?: boolean
  readonly lookup?: typeof dns.lookup
  readonly cacheTtlMs?: number
  readonly now?: () => number
}

interface CachedResolution {
  readonly allowed: boolean
  readonly expiresAt: number
}

/**
 * Enforces the synchronous URL policy and resolves unrestricted public hosts
 * before Chrome can navigate to them. Restricted-domain mode intentionally
 * permits explicitly granted internal hosts; unrestricted mode never does.
 */
export class BrowserNetworkPolicy {
  private readonly lookup: typeof dns.lookup
  private readonly cacheTtlMs: number
  private readonly now: () => number
  private readonly resolutions = new Map<string, CachedResolution>()

  constructor(private readonly options: BrowserNetworkPolicyOptions = {}) {
    this.lookup = options.lookup ?? dns.lookup
    this.cacheTtlMs = Math.max(0, Math.min(options.cacheTtlMs ?? 5_000, 60_000))
    this.now = options.now ?? Date.now
  }

  async allows(urlValue: string, policy: BrowserAgentPolicy): Promise<boolean> {
    if (!policy.enabled || !browserUrlAllowed(urlValue, policy.domains, {
      ...whenDefined(this.options.allowHttpLocalhost, (definedValue) => ({ allowHttpLocalhost: definedValue })),
      restrictDomains: policy.restrictDomains,
    })) return false
    if (policy.restrictDomains || isAllowedTestLocalhost(urlValue, this.options.allowHttpLocalhost)) {
      return true
    }

    const url = new URL(urlValue)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (isIP(host)) return isPublicWebHost(host)
    const cached = this.resolutions.get(host)
    if (cached && cached.expiresAt >= this.now()) return cached.allowed

    let allowed = false
    try {
      const answers = await this.lookup(host, { all: true, verbatim: true })
      allowed = answers.length > 0 && answers.every((answer) => isPublicWebHost(answer.address))
    } catch {
      allowed = false
    }
    this.resolutions.set(host, { allowed, expiresAt: this.now() + this.cacheTtlMs })
    if (this.resolutions.size > 512) this.resolutions.delete(this.resolutions.keys().next().value as string)
    return allowed
  }

  async allowsSubresource(urlValue: string, policy: BrowserAgentPolicy): Promise<boolean> {
    const protocol = safeProtocol(urlValue)
    if (protocol !== 'http:' && protocol !== 'https:') return true
    if (policy.restrictDomains && browserUrlAllowed(urlValue, policy.domains, {
      ...whenDefined(this.options.allowHttpLocalhost, (definedValue) => ({ allowHttpLocalhost: definedValue })),
      restrictDomains: true,
    })) return true
    return this.allows(urlValue, { ...policy, restrictDomains: false, domains: [] })
  }
}

function isAllowedTestLocalhost(value: string, enabled: boolean | undefined): boolean {
  if (!enabled) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

function safeProtocol(value: string): string | null {
  try {
    return new URL(value).protocol
  } catch {
    return null
  }
}
