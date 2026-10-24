import { PI_CLI_PATH_ENV, PI_NODE_PATH_ENV } from '../../core/pi-runtime.js'
import {
  CONFIGURED_PROVIDER_BROKER_URL_ENV,
  CONFIGURED_PROVIDERS_ENV,
} from './provider-settings.js'
import {
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  AGENT_TEXT_STREAM_URL_ENV,
} from '../runtime/agent-text-delta-tokens.js'

/**
 * Provider CLIs are untrusted children of the runtime. They receive only an
 * allowlisted environment:
 * - base operational variables (PATH, HOME, locale, proxy, TLS),
 * - the broker-scoped configured-provider route (a credential whose only
 *   authority is the provider-execute endpoint — never the master API token),
 * - keys the invoking provider passes explicitly (e.g. its isolated config
 *   directory or an MCP bridge token variable).
 * Everything else — other providers' API keys, runtime-scope identities
 * (TEAM_RUNTIME_*), worker/browser/YouTube capability URLs — stays in the
 * parent.
 */
const BASE_ENVIRONMENT_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  PI_CLI_PATH_ENV,
  PI_NODE_PATH_ENV,
  CONFIGURED_PROVIDER_BROKER_URL_ENV,
  CONFIGURED_PROVIDERS_ENV,
])

/**
 * Names no caller may pass through, whatever it asks for.
 *
 * The allowlist above has an escape hatch so a caller can add the one extra
 * variable its provider needs. None of these is ever that variable: three carry
 * a run's display channel and the credential for posting into it, and the
 * fourth buys billable cloud browser sessions. A provider CLI is an untrusted
 * grandchild with no part in any of them. A rule a future caller can opt out of
 * is not a boundary, so this one is checked after the escape hatch rather than
 * before it.
 */
const NEVER_FORWARDED = new Set<string>([
  AGENT_TEXT_STREAM_URL_ENV,
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  'BROWSER_USE_API_KEY',
])

export function buildProviderSubprocessEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  passThroughKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const explicitPassThrough = new Set(passThroughKeys)
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (value === undefined) continue
    if (NEVER_FORWARDED.has(key)) continue
    if (
      BASE_ENVIRONMENT_ALLOWLIST.has(key) ||
      key.startsWith('LC_') ||
      explicitPassThrough.has(key)
    ) {
      environment[key] = value
    }
  }
  return environment
}
