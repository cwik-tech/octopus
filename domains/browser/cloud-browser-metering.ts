/**
 * The pure rules a cloud browser session depends on: money and endpoints.
 *
 * They live apart from the client so they can be tested without opening a
 * socket, and so the two decisions that are easy to get quietly wrong — how a
 * fraction of a cent is rounded, and which websocket this process is willing to
 * drive a browser through — are stated in one place each.
 */

/**
 * Hosts a CDP endpoint may live on when nothing is configured.
 *
 * **Unconfirmed.** The V4 reference documents `cdpUrl` only as a nullable
 * string; it does not promise a host. This default is a conservative guess at
 * the provider's own domain, and confirming the real host is part of the live
 * gate. Until then a deployment that sees a different host configures the
 * allowlist rather than having this client quietly connect anywhere.
 */
export const DEFAULT_CDP_HOST_ALLOWLIST: readonly string[] = Object.freeze([
  '.browser-use.com',
])

/**
 * A non-negative JSON decimal, in any form the provider might emit.
 *
 * A leading `+`, a bare fractional part (`.5`) and a trailing point (`0.`) are
 * all valid decimal text, and nothing obliges an API to send the shortest form.
 * Rejecting them would read a real cost as unparseable and silently fall back to
 * a stale meter. Negatives stay rejected: a negative cost is not a cost.
 */
export const DECIMAL_PATTERN = /^\+?(\d+(\.\d*)?|\.\d+)$/u
const MICRO_DIGITS = 6

/**
 * Converts a provider decimal string to integer micros, rounding **up**.
 *
 * The result backs a spend threshold, so every discarded fraction is an
 * under-count in the direction that lets spending continue. Nearest rounding
 * would drop `0.0000004` on every call it was consulted; a ceiling cannot.
 *
 * The arithmetic is integral rather than `parseFloat(x) * 1e6` because that
 * product is 23399.999999999996 for `0.0234`. Both give 23400 after rounding,
 * so no test distinguishes them — this is a class of bug kept out rather than
 * one observed and fixed.
 *
 * Returns `undefined` for anything that is not a plain non-negative decimal, or
 * that cannot be counted exactly.
 */
export function decimalToMicrosCeiling(value: string): number | undefined {
  return scaledCeiling(value, MICRO_DIGITS)
}

/** Thousandths of the provider's own `proxyUsedMb` unit, rounded up. */
export function decimalToMilliUnitsCeiling(value: string): number | undefined {
  return scaledCeiling(value, 3)
}

/**
 * The shared conversion: a decimal string to an integer at `digits` places,
 * rounded up, without floating point.
 *
 * One implementation rather than two, because the two differ only in scale and
 * a copy is how they end up disagreeing about which decimal forms are legal.
 */
function scaledCeiling(value: string, digits: number): number | undefined {
  if (!DECIMAL_PATTERN.test(value)) return undefined
  const unsigned = value.startsWith('+') ? value.slice(1) : value
  const [whole = '', fraction = ''] = unsigned.split('.')
  const kept = fraction.slice(0, digits).padEnd(digits, '0')
  const roundUp = /[1-9]/u.test(fraction.slice(digits)) ? 1 : 0
  const scaled = Number(whole || '0') * 10 ** digits + Number(kept || '0') + roundUp
  return Number.isSafeInteger(scaled) && scaled >= 0 ? scaled : undefined
}

/**
 * Whether this process will connect a browser to `cdpUrl`.
 *
 * Two rules, both applied whatever the allowlist says:
 *
 * - **CDP transport only.** A direct endpoint is `ws:` or `wss:`. Puppeteer can
 *   also discover the WebSocket endpoint from an `http:` or `https:` base URL.
 * - **Encrypted unless explicitly allowlisted.** Plaintext control hands full
 *   access to the session to anyone on the path, so `ws:` and `http:` are
 *   admitted only for a host someone named exactly. That keeps loopback tests
 *   possible without widening the production rule.
 *
 * The allowlist itself is exact-host, or a leading-dot suffix that matches only
 * a true subdomain. `evil-browser-use.com` does not match `.browser-use.com`.
 */
export function cdpEndpointAllowed(
  cdpUrl: string,
  allowlist: readonly string[],
): boolean {
  let parsed: URL
  try {
    parsed = new URL(cdpUrl)
  } catch {
    return false
  }
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(parsed.protocol)) return false

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  const listed = allowlist.some((entry) => {
    const candidate = entry.toLowerCase()
    return candidate.startsWith('.')
      ? host.endsWith(candidate)
      : host === candidate
  })
  if (!listed) return false
  return (
    parsed.protocol === 'wss:' ||
    parsed.protocol === 'https:' ||
    isExplicitHost(host, allowlist)
  )
}

/** True when the host was named outright rather than matched by suffix. */
function isExplicitHost(host: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => entry.toLowerCase() === host)
}
