# Security

## Desktop Trust Boundary

The Electron backend listens only on `127.0.0.1` and chooses an ephemeral port.
Each desktop launch generates a new 256-bit token and places it in the API path
given to the renderer. Requests with a missing or incorrect token receive `401`;
token comparisons use fixed-length SHA-256 digests and timing-safe comparison.
The token is a local process boundary, not user authentication or a remote
multi-tenant authorization system.

The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and
`sandbox: true`. Its Content Security Policy blocks remote scripts, objects,
base-URI replacement, and non-local connections. New windows and in-app
navigations are denied; valid credential-free HTTP(S) links may be opened in the
system browser.

Session, task, upload, run, and artifact paths reject malformed ids, encoded
path separators, dot segments, absolute paths, and realpath/symlink escapes.
Packaged project edits are written to Electron's per-user data directory, not
application resources.

The server rejects non-loopback bind addresses. Vite-mode cross-origin access
allows only HTTP origins on `127.0.0.1`, `localhost`, or `::1`, and valid token
paths are still required when desktop auth is enabled. Do not expose the API
through a proxy. The optional token protects the desktop launch, while a manually started
`npm run api` server has no token unless its caller supplies `apiToken` through
the programmatic `startApiServer` interface.

## Dependency Gate

Follow the [source-publication checklist](docs/Public-Source-Release.md#publication-checklist)
for dependency, privacy and distribution requirements.

Run `node scripts/audit-security.mjs` before release. The check covers the root,
UI, and file-parser lockfiles and fails on unaccepted high or critical npm
advisories.

The bundled runtime uses `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-tui` 1.3.0, with matching exact internal Pi package versions
in the lockfile. The audit gate has no standing high- or
critical-severity exceptions; any future advisory at those levels must fail CI
until it is fixed or explicitly reviewed and documented.

## Release Requirements

- Run the full offline, security, and packaged desktop checks documented in
  `README.md`.
- Sign and notarize distributable macOS artifacts. Hardened runtime is enabled
  in the build configuration, but the repository does not contain release
  credentials.
- Test the installed artifact on a clean machine, including first-run seeding,
  a binary upload, a real workflow, cancellation, and restart behavior.
- Keep provider keys in environment files or the operator's secret store; never
  commit them or include them in support bundles.

## Reporting

Report suspected vulnerabilities privately to the repository owner. Do not
include credentials, uploaded source material, or generated artifacts in a
public issue.
