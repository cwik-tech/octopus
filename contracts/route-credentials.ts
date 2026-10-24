/**
 * Which credential the loopback transport admitted a request with.
 *
 * The API authenticates possession of a per-launch shared secret in one of two
 * scopes and nothing more: `full` is the launch token handed to the renderer,
 * `broker` is the narrower credential a worker holds so it can reach the
 * credential broker without the master token. Neither identifies a person —
 * `SECURITY.md` says so outright — which is why this is named for the
 * credential rather than for a user.
 *
 * It lives in `contracts/` because both the transport that resolves it and the
 * services that act on it need the same vocabulary, and a service that had to
 * import the server to name a credential would have the dependency backwards.
 *
 * The absence of a value is meaningful: a server configured with no token
 * authenticates nobody, so no scope is resolved at all.
 */
export type RouteCredentialScope = 'full' | 'broker'
