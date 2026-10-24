# Desktop journey fixtures

How an Electron journey under `tests/electron/` sets up the desktop app so it
runs offline, answers deterministically, and leaves nothing running. These
rules come from repairing the desktop journeys in the architecture-audit
follow-up; each one prevents a failure that happened.

## Launch environment

- Launch through `desktopEnvironment(paths)`
  (`tests/electron/support/model-selection-fixture.ts`) or
  `fixtureDesktopEnvironment()` (`tests/support/desktop-journey-environment.ts`).
  Never spread `process.env` into a launch: that hands the app the runner's
  provider credentials, and lets it find an installed provider CLI.
- The guard keeps only `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`,
  `LC_ALL`, `LC_CTYPE`, `TERM` and `PIPELINE_DESKTOP_E2E_HEADLESS`, removes
  every `PATH` folder that holds `claude`, `codex`, `gemini`, `kimi`, `qwen` or
  `pi`, and sets `PIPELINE_CLI_PATH_FALLBACK=0`. It guards the environment
  only; it is not network isolation.
- A journey that wants a narrower `PATH` passes it through the guard, as
  `desktopEnvironment(paths, { ...process.env, PATH: '/usr/bin:/bin' })` or
  `fixtureDesktopEnvironment({ ...process.env, PATH: '/usr/bin:/bin' })`, so
  the guard still filters it. Do not set `PATH` again after the guard.
- Add fixture keys and endpoints after the guard, with made-up values and
  loopback URLs only.

## Models and providers

- The app never infers a default model: it reads the application default
  from saved settings only. A journey that sends a chat turn or runs a
  workflow must seed one, with `seedProviderSettings({ ..., defaultModel })`,
  or give each Agent its own pair. Without it, a turn is refused
  (`not_configured`) and a Team or workflow step stops with "no model
  selected".
- Seed keyless fixture connections with `kind: 'lm-studio'`. The native tool
  route every Agent chat turn takes refuses a keyless `openai-compatible`
  connection (`provider_unsupported`), and `seedProviderSettings` still
  defaults to `openai-compatible`.
- Tool-enabled Team, worker, MCP and workflow turns keep one buffered request
  per round (the accepted streaming ADR). A journey that asserts visible
  token growth uses a lane that streams: `useDirectAnthropicLane`
  (`tests/electron/support/direct-anthropic-lane.ts`) puts a Team member on
  the bare `anthropic` provider, backed by
  `startFakeAnthropicMessagesServer`, with the fake key set in the guarded
  launch. Assert whole-answer delivery and durable replacement for the
  buffered members separately.
- The fake servers stage answers: `startDeterministicOpenAiServer` holds
  chunks and the terminal until released, and reports a held request with
  `waitForBlockedRequest` and `isHoldingRequest`;
  `startFakeAnthropicMessagesServer` offers `releaseHeldChunks`,
  `releaseTerminal` and `waitForRequest`. Match a scripted turn by what the
  request carries (the persona marker, whether it streams, whether it offers
  tools), never by arrival order.
- The app sends its own provider health checks. Count requests without them
  by filtering exactly `isProviderHealthProbe`
  (`tests/support/fake-chat-completions-server.ts`).

## Readiness and synchronization

- `app.firstWindow()` resolves on the startup window, which is painted before
  the desktop seeds the project folder. Before reading or rewriting seeded
  files, wait for the renderer's API handover (the `pipeline-api-base-url`
  hash), which comes after seeding and after the API starts.
- Synchronize on events or observable state: a server's held-request event, a
  visible element, a stored record. No fixed sleeps, and no longer timeouts
  to hide a race.
- Keep a real precondition. If the event a journey waits for never occurs on
  the path it exercises, find the one that does; do not drop or lengthen the
  wait.

## Teardown

- Register each resource the moment it exists (fake server, app, gate),
  inside one guard that also covers settings seeding, launch and
  `firstWindow`.
- Attempt every teardown step even when an earlier one fails, and report the
  test's own failure first with every cleanup error beside it.
- Stop a process only by verified identity: `stopProcessCarrying(pid, marker)`
  for a process whose command line carries its marker, and
  `stopProcessesWorkingUnder(folder)` for processes working inside the
  journey's own folder (`tests/support/owned-processes.ts`).

## UI steps

Update a stale step only to the contract that current UI source and its unit
test pin (for example, tool switches save on change; the Run sidebar has no
"Select Agents" heading). Keep the journey's purpose and its persistence
checks.

## Running journeys

- Build the renderer with `VITE_ENABLE_WORKFLOWS=1`, and rebuild
  `dist-electron` after backend source changes.
- Run on Node 22, with `PIPELINE_CLI_PATH_FALLBACK=0` and, for evidence runs,
  sentinel CLIs first on `PATH` writing to their own log; that log must stay
  absent.
- Run one desktop run at a time, and record the machine load; rerun a
  timing-bound failure at low load before classifying it.
- Afterwards, read each journal's `requestedProvider` (journals without one
  prove nothing about providers) and check that no process still works under
  the run's output folder.
