import { DEFAULT_CDP_HOST_ALLOWLIST } from './cloud-browser-metering.js'

/**
 * The cloud browser's runtime inputs, read from the environment.
 *
 * A pure function rather than logic inside the settings service, so the parsing
 * rules can be tested on their own and the service keeps one narrow job. These
 * are provider *runtime* inputs — where the control endpoint may live and which
 * exit to ask for — not the enable flag or the spend ceiling, which are
 * deliberately configuration rather than environment.
 *
 * Every value is validated here, before anything is constructed, so a mistyped
 * variable fails at the boundary instead of becoming a request to the provider.
 */

const HOST_LABEL = '[a-z0-9]([a-z0-9-]*[a-z0-9])?'
/**
 * An exact host: one or more labels, which also covers `localhost` and an IPv4
 * literal for a loopback fixture or a self-hosted deployment. A bracketed IPv6
 * literal is deliberately not accepted here; nothing needs it yet, and half
 * supporting it would be worse than not supporting it.
 */
const EXACT_HOST_PATTERN = new RegExp(`^${HOST_LABEL}(\\.${HOST_LABEL})*$`, 'u')
/**
 * A suffix, which must be registrable-looking rather than a public suffix.
 *
 * `.browser-use.com` names one organisation. `.com` names every organisation
 * there is, and admitting it would authorize a CDP endpoint on any host under
 * it — so a suffix has to carry at least two labels.
 */
const SUFFIX_HOST_PATTERN = new RegExp(
  `^\\.${HOST_LABEL}(\\.${HOST_LABEL})+$`,
  'u',
)
const MAXIMUM_CDP_HOSTS = 16
const MAXIMUM_CDP_HOST_LENGTH = 253
const COUNTRY_CODE_PATTERN = /^[a-z]{2}$/u

export interface CloudBrowserEnvironment {
  readonly cdpHostAllowlist: readonly string[]
  /**
   * The exit country to request.
   *
   * `null` runs unproxied, which the provider treats as different from omitting
   * the field; `undefined` means nothing was configured and the provider's own
   * default applies.
   */
  readonly proxyCountryCode?: string | null
}

export function parseCloudBrowserEnvironment(
  environment: NodeJS.ProcessEnv,
): CloudBrowserEnvironment {
  const allowlist = parseCdpHostAllowlist(
    environment.BROWSER_USE_CDP_HOST_ALLOWLIST,
  )
  const country = parseProxyCountry(environment.BROWSER_USE_PROXY_COUNTRY)
  return {
    cdpHostAllowlist: allowlist,
    ...(country === undefined ? {} : { proxyCountryCode: country }),
  }
}

/**
 * Parses `BROWSER_USE_CDP_HOST_ALLOWLIST`.
 *
 * The built-in default matches the provider host observed by the opt-in live
 * smoke check. An operator using another legitimate host still needs a way to
 * accept it that is not a code change. Widening it must not mean accepting
 * anything, so each entry has to be a bare host or a leading-dot suffix; the
 * protocol and exact/suffix rules in `cdpEndpointAllowed` remain in force.
 */
function parseCdpHostAllowlist(raw: string | undefined): readonly string[] {
  const trimmed = raw?.trim()
  if (!trimmed) return DEFAULT_CDP_HOST_ALLOWLIST
  const entries = trimmed
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
  if (entries.length === 0 || entries.length > MAXIMUM_CDP_HOSTS) {
    throw new Error(
      `The cloud browser CDP host allowlist must name 1 to ${MAXIMUM_CDP_HOSTS} hosts.`,
    )
  }
  for (const entry of entries) {
    const valid = entry.startsWith('.')
      ? SUFFIX_HOST_PATTERN.test(entry)
      : EXACT_HOST_PATTERN.test(entry)
    if (entry.length > MAXIMUM_CDP_HOST_LENGTH || !valid) {
      throw new Error(
        'The cloud browser CDP host allowlist accepts an exact host, or a ' +
          'leading-dot suffix of at least two labels.',
      )
    }
  }
  return entries
}

/** Parses `BROWSER_USE_PROXY_COUNTRY`; `none` means run unproxied. */
function parseProxyCountry(raw: string | undefined): string | null | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  const value = trimmed.toLowerCase()
  if (value === 'none') return null
  if (!COUNTRY_CODE_PATTERN.test(value)) {
    throw new Error(
      "The cloud browser proxy country must be a two-letter code, or 'none' to run unproxied.",
    )
  }
  return value
}
