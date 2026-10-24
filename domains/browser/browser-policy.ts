import * as fs from 'node:fs'
import { isIP } from 'node:net'
import * as path from 'node:path'

import {
  serialCapabilityEffect,
  type CapabilityEffect,
} from '../../contracts/capability-effect.js'
import { parseAgentFrontmatter } from '../../parsers/load-agent.js'
import { parseToolList } from '../../core/tool-policy.js'

export interface BrowserAgentPolicy {
  readonly enabled: boolean
  readonly restrictDomains: boolean
  readonly domains: readonly string[]
}

export interface BrowserTargetDescription {
  readonly tag: string
  readonly type?: string
  readonly role?: string
  readonly name?: string
  readonly href?: string
  readonly download?: boolean
  readonly formMethod?: string
}

export type BrowserActionRisk = 'read-only' | 'mutating' | 'destructive'

const DESTRUCTIVE_PATTERN = /\b(delete|remove|destroy|erase|revoke|terminate|cancel subscription)\b/i

export function parseBrowserDomains(value: unknown): string[] {
  if (value == null) return []
  const source = Array.isArray(value) ? value.map(String) : String(value).split(',')
  return [...new Set(source
    .map((item) => String(item).trim().toLowerCase())
    .filter(isValidDomainPattern))]
}

export function readBrowserAgentPolicy(
  repoRootPath: string,
  agentPath: string,
): BrowserAgentPolicy {
  const agentName = normalizeAgentName(agentPath)
  if (!agentName) return disabledPolicy()
  const personaPath = path.join(repoRootPath, 'agents', agentName, `${agentName}.md`)
  if (!fs.existsSync(personaPath)) return disabledPolicy()
  try {
    const frontmatter = parseAgentFrontmatter(personaPath).frontmatter
    return {
      enabled: parseToolList(frontmatter.tools)?.includes('browser') ?? false,
      restrictDomains: parseBoolean(frontmatter.browser_restrict_domains),
      domains: parseBrowserDomains(frontmatter.browser_domains),
    }
  } catch {
    return disabledPolicy()
  }
}

export function browserUrlAllowed(
  value: string,
  domains: readonly string[],
  options: {
    readonly allowHttpLocalhost?: boolean
    readonly restrictDomains?: boolean
  } = {},
): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  const localHttp = options.allowHttpLocalhost === true &&
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)
  if (url.protocol !== 'https:' && !localHttp) return false
  if (url.username || url.password) return false
  if (options.restrictDomains !== false) {
    return domains.length > 0 && domains.some((domain) => domainMatches(host, domain))
  }
  return localHttp || isPublicWebHost(host)
}

export function isPublicWebHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false
  if (['local', 'internal', 'home', 'lan', 'test'].some((suffix) =>
    host === suffix || host.endsWith(`.${suffix}`)
  )) return false
  const version = isIP(host)
  if (version === 4) return isPublicIpv4(host)
  if (version === 6) return isPublicIpv6(host)
  return host.includes('.') && isValidDomainPattern(host)
}

export function classifyBrowserAction(
  action: string,
  target?: BrowserTargetDescription,
  key?: string,
): BrowserActionRisk {
  if (action === 'download') return 'mutating'
  if (action === 'press' && key?.toLowerCase() === 'enter') return 'mutating'
  if (action !== 'click') return 'read-only'
  const label = `${target?.name ?? ''} ${target?.role ?? ''}`.trim()
  if (DESTRUCTIVE_PATTERN.test(label)) return 'destructive'
  if (target?.download) return 'mutating'
  if (target?.tag === 'a' && target.href) return 'read-only'
  if (
    target?.tag === 'button' ||
    target?.type === 'submit' ||
    target?.role === 'button' ||
    target?.formMethod
  ) {
    return 'mutating'
  }
  return 'read-only'
}

export function resolveBrowserCapabilityEffect(
  risk: BrowserActionRisk,
): CapabilityEffect {
  return serialCapabilityEffect(risk)
}

function normalizeAgentName(agentPath: string): string | null {
  const match = agentPath.trim().match(/^agents\/([a-z0-9][a-z0-9-]{0,127})$/)
  return match?.[1] ?? null
}

function disabledPolicy(): BrowserAgentPolicy {
  return { enabled: false, restrictDomains: false, domains: [] }
}

function parseBoolean(value: unknown): boolean {
  if (value === true) return true
  return typeof value === 'string' && value.trim().toLowerCase() === 'true'
}

function isValidDomainPattern(value: string): boolean {
  if (!value || value.length > 253 || value.includes('://') || value.includes('/')) {
    return false
  }
  const host = value.startsWith('*.') ? value.slice(2) : value
  return Boolean(host) && host.split('.').every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  )
}

function domainMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2)
    return host !== suffix && host.endsWith(`.${suffix}`)
  }
  return host === pattern
}

function isPublicIpv4(value: string): boolean {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  const [a, b, c] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && c <= 2) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

type Ipv6Groups = readonly [
  number, number, number, number, number, number, number, number,
]

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or `undefined` when the
 * value is not one.
 *
 * Matching an IPv6 address by its text is unsound: `new URL()` re-spells a
 * literal before any policy code sees it, so `::ffff:127.0.0.1` arrives as
 * `::ffff:7f00:1` and a pattern written against the dotted form never fires.
 * Everything downstream therefore decides on groups, never on spelling.
 */
function expandIpv6Groups(value: string): Ipv6Groups | undefined {
  const zoneStart = value.indexOf('%')
  const literal = (zoneStart === -1 ? value : value.slice(0, zoneStart)).toLowerCase()
  const lastColon = literal.lastIndexOf(':')
  if (lastColon === -1) return undefined

  // A trailing dotted quad is folded into the two groups it occupies, so the
  // rest of the parse only ever handles hextets.
  let hextetText = literal
  const trailing = literal.slice(lastColon + 1)
  if (trailing.includes('.')) {
    const octets = trailing.split('.')
    if (octets.length !== 4) return undefined
    let high = 0
    let low = 0
    for (const [index, octet] of octets.entries()) {
      if (!/^\d{1,3}$/.test(octet)) return undefined
      const parsed = Number(octet)
      if (parsed > 255) return undefined
      if (index < 2) high = high * 256 + parsed
      else low = low * 256 + parsed
    }
    hextetText = `${literal.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`
  }

  const parseHextets = (part: string): number[] | undefined => {
    if (part === '') return []
    const parsed: number[] = []
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return undefined
      parsed.push(Number.parseInt(piece, 16))
    }
    return parsed
  }

  const gapStart = hextetText.indexOf('::')
  let groups: number[] | undefined
  if (gapStart === -1) {
    const parsed = parseHextets(hextetText)
    groups = parsed && parsed.length === 8 ? parsed : undefined
  } else if (hextetText.indexOf('::', gapStart + 1) !== -1) {
    return undefined
  } else {
    const head = parseHextets(hextetText.slice(0, gapStart))
    const tail = parseHextets(hextetText.slice(gapStart + 2))
    if (!head || !tail) return undefined
    const omitted = 8 - head.length - tail.length
    if (omitted < 1) return undefined
    groups = [...head, ...new Array<number>(omitted).fill(0), ...tail]
  }
  if (!groups) return undefined

  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = groups
  if (
    first === undefined || second === undefined || third === undefined ||
    fourth === undefined || fifth === undefined || sixth === undefined ||
    seventh === undefined || eighth === undefined
  ) return undefined
  return [first, second, third, fourth, fifth, sixth, seventh, eighth]
}

function isPublicIpv6(value: string): boolean {
  const groups = expandIpv6Groups(value)
  // Defensive depth only: `isPublicWebHost` calls `isIP` first, so an
  // unparseable value takes the domain branch and never reaches here, and a
  // valid literal always expands. Denying is still the right answer if that
  // ever stops holding.
  if (!groups) return false

  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = groups
  const topIsZero = first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0

  // Prefixes that carry an IPv4 address in their low 32 bits are decided by that
  // address rather than by the IPv6 prefix: RFC 4291 IPv4-mapped, the deprecated
  // IPv4-compatible range (which also covers `::` and `::1`), and the RFC 6052
  // well-known NAT64 prefix.
  const carriesIpv4 =
    (topIsZero && sixth === 0xffff) ||
    (topIsZero && sixth === 0) ||
    (first === 0x0064 && second === 0xff9b && third === 0 && fourth === 0 && fifth === 0 && sixth === 0)
  if (carriesIpv4) {
    return isPublicIpv4(
      `${seventh >> 8}.${seventh & 0xff}.${eighth >> 8}.${eighth & 0xff}`,
    )
  }

  if ((first & 0xfe00) === 0xfc00) return false // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false // ff00::/8 multicast
  return true
}
