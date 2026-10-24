# Business workflow: first-load provider information

## Scope and starting conditions

On app launch or opening AI Providers, show saved model information
before waiting for local CLI discovery. A separate refresh updates the display.

## Flow

1. Open the main window without resolving the model catalog merely to recover
   the already-known broker address. Read saved API connections and the last CLI
   model-discovery cache.
2. Display the saved information using current enabled-model preferences.
3. Discover CLI models in the background; simultaneous refreshes share one job.
4. Replace the displayed information when discovery finishes and save its metadata
   for the next launch. Keep the saved display if refresh fails.

## Alternative flows

- No discovery cache, malformed cache, or changed executable path: use the
  installed tool's fallback entries while refreshing. API models remain visible.
- Removed CLI: exclude its saved models. Runtime readiness continues using fresh
  probes; the display cache does not authorize execution or MCP capability.
- A newer selection/load supersedes an old request; its response cannot overwrite
  the current display. Leaving a screen prevents its pending load updating it.

## Business rules and test mapping

| ID | Required outcome | Boundary and test |
| --- | --- | --- |
| PL-01 | Saved models appear after restart while discovery is blocked, then refresh | Real loopback API/filesystem/process: `tests/integration/provider-startup-loading.test.ts`, "after restart Settings shows saved models before discovery completes, then publishes refreshed models"; `tests/electron/provider-startup-loading.spec.ts`, "first launch shows saved chat models and Settings before discovery finishes, then updates both" |
| PL-02 | Current preferences and executable availability override cached display; fresh discovery updates the runtime default | `tests/integration/provider-discovery-cache.test.ts`: "saved discovery uses current model preferences and does not claim fresh MCP readiness", "a removed executable cannot remain available through its saved discovery cache", "background discovery updates the runtime default when the saved model is no longer available" |
| PL-03 | Malformed or absent caches allow first use | `tests/integration/provider-discovery-cache.test.ts`: "first use still shows installed CLI fallback models with absent discovery cache", and its invalid JSON/metadata cases |
| PL-04 | Concurrent refreshes share discovery | `tests/integration/provider-discovery-cache.test.ts`, "concurrent refreshes share one CLI discovery process" |
| PL-05 | Pending refreshes preserve current UI state and recoverable saved results | `ui/src/contexts/__tests__/provider-catalog-context.test.tsx`: "keeps a newer catalog when an earlier discovery response arrives last", "keeps saved models usable when background refresh fails"; `ui/src/components/settings/__tests__/provider-settings.test.tsx`: "shows saved CLI information while discovery waits and replaces it when discovery completes" |

## Coverage boundaries

Test mappings describe intended coverage; run the relevant checks against the current checkout.

## Cache and read API

`<provider-settings-file>.cli-cache.json` is disposable, versioned CLI metadata,
validated when read. It contains no connection credentials or runtime MCP grants.
Current enabled-model preferences override saved metadata. Missing, unreadable,
malformed, or executable-path-mismatched metadata falls back to installed CLI
aliases until discovery completes; previously discovered custom names may need
that first refresh when no cache exists yet.

`GET /settings/providers` and `GET /settings/model-catalog` return the display
snapshot. Adding `?refresh=1` waits for fresh discovery. Each screen requests the
saved response first, then a refresh, and cancels its obsolete HTTP reads. Runtime
provider checks continue through the existing authoritative snapshot path.
