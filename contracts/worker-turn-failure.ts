/**
 * Where a parent worker turn failed, when the parent reported no failure
 * category of its own.
 *
 * "Parent worker turn failed." covers five different failures: the child could
 * not build its own request, its worker URL was not a loopback worker URL, the
 * connection failed, the parent answered with a status and no code, or the
 * parent's answer could not be read. The stage says which.
 *
 * Closed, and carrying nothing the network, the parent or a provider wrote: a
 * transport failure carries only a Node error code from the list below, any
 * other being `other`, and a status failure only the status number. A failure
 * record keeps exactly this, never the worker URL, its path token, headers,
 * bodies or message text.
 */

/** The transport failures a record may name. Any other code is `other`. */
export const WORKER_TURN_TRANSPORT_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EMFILE',
  'ENFILE',
  'EADDRNOTAVAIL',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'other',
] as const

export type WorkerTurnTransportCode = (typeof WORKER_TURN_TRANSPORT_CODES)[number]

export type WorkerTurnFailure =
  | { readonly stage: 'request_invalid' | 'endpoint_invalid' | 'response_invalid' }
  | { readonly stage: 'transport'; readonly transportCode: WorkerTurnTransportCode }
  | { readonly stage: 'http_status_without_code'; readonly httpStatus: number }
