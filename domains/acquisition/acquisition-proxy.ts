import type { Dispatcher } from "undici";

/**
 * The transport seam for a proxied acquisition retry.
 *
 * Acquisition never learns where the credentials come from. The composition
 * root supplies a port; this domain only knows how to ask it for a session and
 * how to close one. Keeping the shape structural also keeps `domains/` free of
 * an edge into `services/`, which `scripts/architecture-check.ts` forbids.
 */

/**
 * The half of a proxy session that issues requests.
 *
 * A dispatcher rather than a `fetch`, because the acquirer needs manual
 * redirects and streamed bodies. Handing it the dispatcher keeps the proxied
 * and unproxied reads on one code path with identical semantics.
 */
export interface AcquisitionProxyTransport {
  readonly dispatcher: Dispatcher
}

/**
 * The same proxy, addressed the way a browser needs it.
 *
 * Parent-process-only. Chrome cannot take credentials in its proxy option, so
 * `server` carries no userinfo and the pair is handed to `page.authenticate`
 * on the proxied page alone. It must never be serialized, returned to a tool
 * caller, journalled, or logged.
 */
export interface AcquisitionProxyBrowserEndpoint {
  /** `scheme://host:port`, with no userinfo. */
  readonly server: string
  readonly username: string
  readonly password: string
}

/** One open proxy session. The opener closes it. */
export interface AcquisitionProxySession extends AcquisitionProxyTransport {
  /**
   * Absent when the port cannot express a browser endpoint, which is a
   * decision rather than a fault: the proxied browser retry simply does not
   * run, and the proxied direct rung is unaffected.
   */
  readonly browserEndpoint?: AcquisitionProxyBrowserEndpoint
  close(): Promise<void>
}

export interface WebshareProxyPort {
  /**
   * Resolves the current configuration and opens one session.
   *
   * Returns `undefined` when the proxy is configured off, which is a decision
   * rather than a failure. Throws when it is configured on but unusable, which
   * the caller records as a failed attempt instead of swallowing.
   */
  open(signal?: AbortSignal): Promise<AcquisitionProxySession | undefined>
}
