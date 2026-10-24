# Test and Release Verification

## Product Boundary

The repository has two execution surfaces that share the same runtime:

1. the Electron desktop app, including its loopback API, renderer, persisted
   sessions, file uploads, task launcher, and packaged resources;
2. direct Pi CLI execution through `pi -e team-runtime/index.ts`.

A finished change must be tested at the lowest useful layer and at the affected
product boundary. A green TypeScript build does not prove the Electron window,
packaged task runner, live provider, or artifact flow works.

## Required Offline Gate

From the repository root:

```bash
npm test
node scripts/audit-security.mjs
```

`npm test` runs:

- core unit and integration tests through `tests/run-tests.mjs`;
- UI lint, Vitest, typecheck, and production build through `ui:check`;
- file-parser unit/integration tests.

The security script audits the root, UI, and file-parser lockfiles. It fails on
new high/critical advisories and permits only the exact, documented Pi exception
in `SECURITY.md`.

## Development Loops

Use the narrowest command while iterating:

```bash
npm run test:unit
npm run test:integration
npm run ui:test
npm run ui:check
npm run file-parser:test
npx tsc --noEmit
npm run electron:build
```

### Unit

Unit tests cover pure and filesystem-local behavior such as:

- YAML/config parsing and validation;
- workflow handoff/output/escalation contracts;
- path traversal and symlink containment;
- provider pricing and hard-budget reservations;
- task lifecycle compare-and-set/restart reconciliation;
- Electron app/project/parser entry resolution;
- UI components and clients with mocked network boundaries.

### Integration

Integration tests boot real service/runtime modules with provider and subprocess
seams replaced where needed. They cover:

- API contracts for sessions, files, tasks, runs, and Create;
- real temporary-repository team/workflow creation, validation, retry, and
  cancellation behavior;
- concurrent uploads through the real API and file-parser process;
- persisted RunPlan planning/apply behavior;
- detached task-process cancellation and service-restart recovery;
- deterministic workflow execution and artifact handoff;
- bundled Pi CLI discovery without a globally installed `pi` command;
- provider and team-runner protocol behavior;
- cancellation and explicit terminal outcomes.

## Top-Level Queue Verification

Queue and Scheduling tests are split by the boundary they prove:

- `tests/unit/scheduling-settings-service.test.ts` covers validation and
  persisted-setting behavior with real temporary files;
- `tests/integration/task-queue-core.test.ts` and
  `tests/integration/task-queue-cold-rebuild.test.ts` exercise the real
  filesystem store, task CAS, FIFO reconstruction, fencing, recovery, and the
  5,000-record cold-start guardrail;
- `tests/integration/task-queue-api-contract.test.ts`,
  `tests/integration/scheduling-settings-route.test.ts`,
  `tests/integration/scheduling-queue-route.test.ts`, and
  `tests/integration/run-orchestrator-queue-contract.test.ts` prove HTTP and
  RunPlan contracts through real services and persisted state;
- `tests/integration/api-server-process-ownership.test.ts`,
  `tests/integration/task-queue-api-crash-recovery.test.ts`, and
  `tests/integration/task-queue-real-process-api.test.ts` use separate API and
  detached worker processes for ownership, SIGKILL recovery, capacity, FIFO,
  and live-limit behavior;
- UI component/client tests cover Active/Recent grouping, Queue overview
  rendering, navigation, cancellation confirmation, and browser-client
  contracts, while `tests/electron/scheduling-settings.spec.ts` proves settings
  restart, real pending-task cancellation from the overview, and live queue
  transitions in Electron.

The critical queue path does not use mocked stores, APIs, locks, workers,
capacity, or FIFO state. Narrow client, clock, UUID, and process-liveness seams
are acceptable only when a real-process or Electron test covers the same
safety boundary.

`tests/run-tests.mjs` runs process-heavy queue tests and the 5,000-record cold
rebuild as isolated test-file invocations. This prevents unrelated parallel
filesystem and CPU load from invalidating timing assertions, and prevents
detached-process lifecycle tests from interfering with one another. Isolation
changes scheduling only; each test still uses real processes and durable files.

## Desktop Verification

Development bundle smoke:

```bash
npm run desktop:e2e
```

Packaged-resource smoke:

```bash
npm run desktop:e2e:packaged
```

Visible-window smoke (mandatory in macOS CI):

```bash
npm run desktop:e2e:visible
```

All three commands rebuild Electron, the UI, and file-parser.

**Hidden by default, visible once.** `desktop:e2e` and `desktop:e2e:packaged`
run with hidden Electron windows so routine verification never raises a window
or steals desktop focus; both Playwright configs default
`PIPELINE_DESKTOP_E2E_HEADLESS` to `1` with `??=`, and `electron/main.ts` only
calls `window.show()` when the run is not headless.

That default is convenient but it left one thing unproven: whether a window ever
actually appears. `desktop:e2e:visible` is the answer. It sets
`PIPELINE_DESKTOP_E2E_HEADLESS=0` explicitly and runs **only**
`tests/electron/electron-smoke.spec.ts`, which flips `expectsVisibleWindow` to
`true` and makes the existing `BrowserWindow.isVisible()` poll a real visibility
assertion rather than a hidden-state one. It runs as its own mandatory step in
the `desktop-package-smoke` job on `macos-14`, alongside — not instead of — the
packaged smoke. A visible window cannot be proven on a headless Linux container,
which is why it is pinned to the macOS runner.

Run it locally when you want that check; expect a window to appear and take
focus for the duration. The packaged command
creates an unpacked macOS application and launches that executable through
Playwright. The smoke verifies the expected hidden or visible window state,
sandbox preferences and
CSP, authenticated API behavior, blocked navigation, packaged project seeding,
file parsing, and a deterministic task result.

The Electron suite gives each test an isolated user-data directory and does not
route test launches through the development replacement command. Its lifecycle
coverage preserves both contracts: an ordinary second launch exits and focuses
or recreates the first instance's window, while `desktop:start` and
`desktop:dev` may cooperatively replace only a development instance that proves
it belongs to the same worktree. Replacement coverage must also prove graceful
API shutdown, a fresh process and API token, bounded timeout behavior, and that
different-worktree or legacy instances remain alive and receive an actionable
manual-quit diagnostic.

When changing upload/parser packaging, also verify a binary upload through the
installed application. Unit entry-path tests alone do not prove native parser
dependencies load on a clean machine.

## Pi Smoke and Fixture E2E

```bash
npm run test:smoke
npm run test:e2e
npm run test:e2e:reception-to-writing
```

These use real Pi launch paths and isolated fixture workspaces. They assert
runtime artifacts and terminal state, not just process exit.

## Live Provider Tests

Provider-backed runners consume real credentials and may incur cost. Run only
the paths relevant to the provider/configuration being released:

```bash
npm run test:e2e:workflow-routing
npm run test:e2e:workflow-handoff
npm run test:e2e:anthropic-board
npm run test:e2e:openrouter
npm run test:e2e:file-parser-live
npm run test:e2e:file-parser-live-llm
```

Supporting negative-path runners verify missing credentials, unsupported host
providers, child failure, retry guards, and review overrides. See `package.json`
for the complete command list.

Do not infer live model availability from offline tests. Before release, verify
the configured model ids, provider authentication, pricing source, and expected
artifact using the actual supported account.

## CI

`.github/workflows/ci.yml` runs on pushes and pull requests:

| Job | Gate |
| --- | --- |
| `core` | root install, TypeScript, Electron compile, core tests |
| `ui` | UI install, TypeScript, lint/tests/build check |
| `file-parser` | parser install, TypeScript, parser tests |
| `security` | pinned multi-lockfile advisory audit |
| `desktop-package-smoke` | macOS packaged desktop build and Playwright smoke |

CI does not use paid provider credentials and does not sign/notarize release
artifacts.

## Release Acceptance

Before calling a desktop release complete:

1. Pass the required offline and packaged desktop gates.
2. Build signed/notarized DMG and ZIP artifacts.
3. Install on a clean supported Mac.
4. Verify first-run project seeding does not overwrite later user changes.
5. Upload and parse a binary input without repository tooling.
6. Complete one real provider-backed workflow and inspect its final artifact.
7. Verify blocked, failed, and cancelled tasks remain terminal after refresh.
8. Restart during an active task and confirm it reconciles honestly rather than
   remaining stuck as running.
9. Review the security advisory acceptance and provider pricing configuration.

## Test Asset Policy

Keep fixtures, shell runners, and test-only assertions under `tests/`. Runtime
modules may expose small injectable seams when production behavior needs direct
verification; do not duplicate production logic in test helpers.

Use real repositories, files, parsers, registries, stores, API routes, and child
processes in integration tests. Test doubles are reserved for external provider
calls that require credentials or spend, and for narrow failure injection that
cannot be produced deterministically. A mocked success path is not sufficient
evidence for filesystem mutation, process lifecycle, packaging, or artifact
creation.
