/**
 * How the MCP tools reach Octopus: the same REST requests the window sends,
 * over loopback, with the in-memory API URL. The route keeps every rule it
 * already enforces, so REST and MCP cannot drift apart
 * (docs/adr/2026-10-09-Voice-Control-Through-MCP.md, decision 3).
 */
export interface RestResponse {
  readonly status: number
  readonly body: unknown
}

export interface LoopbackRestClient {
  /**
   * The raw response, for a stream or a file. The caller reads or cancels
   * the body; aborting `signal` ends it.
   */
  open(path: string, signal: AbortSignal): Promise<Response>
  request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options?: { readonly body?: unknown; readonly signal?: AbortSignal },
  ): Promise<RestResponse>
}

export class RestUnavailableError extends Error {
  constructor() {
    super('Octopus is still starting.')
    this.name = 'RestUnavailableError'
  }
}

/**
 * `resolveBaseUrl` returns the authenticated API URL once the server listens,
 * and undefined before that.
 */
export function createLoopbackRestClient(
  resolveBaseUrl: () => string | undefined,
  options: { readonly requestTimeoutMs?: number } = {},
): LoopbackRestClient {
  const timeoutMs = options.requestTimeoutMs ?? 120_000
  const requestSignal = (signal?: AbortSignal) => {
    const deadline = AbortSignal.timeout(timeoutMs)
    return signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  }
  return {
    async open(path, signal) {
      const baseUrl = resolveBaseUrl()
      if (baseUrl === undefined) throw new RestUnavailableError()
      return fetch(`${baseUrl}${path}`, { signal: requestSignal(signal) })
    },
    async request(method, path, options = {}) {
      const baseUrl = resolveBaseUrl()
      if (baseUrl === undefined) throw new RestUnavailableError()
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        ...(options.body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(options.body),
            }),
        signal: requestSignal(options.signal),
      })
      const text = await response.text()
      let body: unknown = null
      if (text !== '') {
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }
      return { status: response.status, body }
    },
  }
}
