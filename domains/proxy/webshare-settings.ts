/**
 * The Webshare proxy configuration shared by every consumer.
 *
 * It lives outside the YouTube domain because web-research acquisition uses the
 * same credential. Persistence and secret storage still belong to one owner;
 * this file only names the shape that owner hands out.
 */

export type WebshareCredentialMode = 'api-token' | 'username-password'

export interface WebshareProxyValues {
  readonly proxyEnabled: boolean
  readonly credentialMode: WebshareCredentialMode
  readonly proxyHost: string
  readonly proxyPort: number
  readonly countries: readonly string[]
  readonly username: string
}

/** Parent-process-only configuration. Never serialize this object. */
export interface WebshareRuntimeConfig extends WebshareProxyValues {
  readonly apiToken?: string
  readonly password?: string
}
