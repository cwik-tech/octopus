# Module ownership

The backend dependency order and folder responsibilities are enforced by
`npm run arch:check` (`scripts/architecture-check.ts`).

## Dependency tiers

A backend module may import its own tier or a lower one, never a higher one.
The checker gives a path the tier of its longest matching prefix, so a
specific `domains/<name>/` prefix overrides the plain `domains/` one.

| Order | Tier | Prefixes |
|---|---|---|
| 0 | core | `core/` |
| 1 | runtime foundation | `domains/runtime/` |
| 2 | parsers/providers | `parsers/`, `providers/`, `domains/provider/` |
| 3 | domains | every other `domains/<name>/` |
| 4 | engines/workflows | `engines/`, `workflows/`, `domains/run-orchestrator/`, `domains/workflow-generator/` |
| 5 | sessions/services | `services/`, `domains/projects/`, `domains/scheduling/`, `domains/sessions/` |
| 6 | entrypoints | `server/`, `team-runtime/`, `electron/` |

`contracts/`, `scripts/`, `tests/` and `ui/src/` have no tier. Other rules
cover them: `contracts/` imports only `contracts/`,
`core/optional-properties.ts`, Zod and Node built-ins; `core/` imports only
`core/`, `contracts/`, packages and Node built-ins; the UI imports only `ui/` and `contracts/`; and only
`electron/`, `scripts/`, `server/`, `team-runtime/` and tests import
`server/`.

## What each folder owns

| Folder | Tier | Owns |
|---|---|---|
| `contracts/` | none | Zod wire schemas, DTOs the UI and server share, durable-record and port shapes that `core/` implements, and small rules both sides must compute the same way. |
| `core/` | 0 | The `team.yaml` and runtime type model, shared policies (budget, context window, tool and spawn policy, timeouts, rate limits, verdict parsing), the execution journal and dispatch journal, and filesystem helpers for atomic writes, owned files and cross-process locks. |
| `parsers/` | 2 | Reading and validating authoring files: `team.yaml`, `teams.yaml`, `start.yaml`, agent frontmatter, input directories and `plan.md`. |
| `providers/` | 2 | One adapter per model vendor or CLI that runs an agent turn and returns a `ProviderResult`, plus the registry, cost tables and telemetry. |
| `engines/` | 4 | The stage engines registered as Pi tools (discussion, pipeline, chain, broadcast, review), the gate checker, and the spawn tools. |
| `workflows/` | 4 | Loading, validating and running Workflows, and the per-assignment workflow state store and journal. |
| `services/` | 5 | Application services that `server/composition.ts` wires: session and task dispatch, chat turns, capability tool services, settings, deep research, schedules, batches, and the journal registries. |
| `server/` | 6 | The HTTP API process: composition, routing, per-resource routes, and the broker endpoints that provider CLI children call. |
| `team-runtime/` | 6 | The Pi extension that runs one team: boot, tool registration, level lifecycle and gates, coordinator prompts, governed tool calls, and the terminal dashboard. |
| `electron/` | 6 | The desktop main process: project root, composition, the in-process API server, headless runtimes, the batch-folder picker and the preload script. |
| `scripts/` | none | Tooling that npm scripts run: architecture and type-safety checks, version bump and check, launchers, packaging, signing and benchmarks. No production module imports it. |
| `domains/acquisition/` | 3 | The `research_web` gateway: search and reader clients, the direct HTTP acquirer and its network policy, source assessment, and the source observation and extraction stores. |
| `domains/agent-execution/` | 3 | Dispatching an agent or a delegated child team to a provider, with the shared retry, backoff and circuit-breaker policy. |
| `domains/agent-generator/` | 3 | The Agent Architect's persona and skill authoring and agent package publication, and Team Builder's `team.yaml` editing. |
| `domains/batches/` | 3 | Batch runs over a folder: types, stores, folder scanning and folder grants. |
| `domains/browser/` | 3 | The managed Chrome capability, its network policy and authorization, Browser Use, and web-answer evidence validation. |
| `domains/conversations/` | 3 | Pure `conversation.turn` journal payloads, retention selection, and crash classification. |
| `domains/deep-research/` | 3 | Deep Research plan contracts, worker policy, evidence and citations, publication audit, quality evaluation, and run artifacts. |
| `domains/delegation/` | 3 | Child-team invocation and result contracts, the delegation log, and the delegated autostart prompt builders. |
| `domains/document-reader/` | 3 | Reading PDFs through OpenAI or Gemini and rendering the page evidence. |
| `domains/excel-generation/` | 3 | Markdown-to-workbook conversion, templates, and the `generate_excel` tool. |
| `domains/file-sources/` | 3 | A contained upload folder with atomic writes and a usage ledger, shared by projects, sessions, team files and batches. |
| `domains/job-title/` | 3 | Short card titles, deterministic and model-written. |
| `domains/mcp/` | 3 | MCP server settings and clients, and the parent broker for worker tool calls with its approval, elicitation and evidence stores. |
| `domains/projects/` | 5 | Project records, files, memory and session membership on disk. |
| `domains/provider/` | 2 | Direct model calls for architect and helper turns, provider catalogs and preflight, and the app default model. |
| `domains/proxy/` | 3 | Resolving the Webshare proxy. |
| `domains/resource-architect/` | 3 | The Resource Architect chat turn, its reviewer pass, and `resource_updates` plans. |
| `domains/resource-library/` | 3 | Immutable skill revisions, exact Agent attachments, catalog generations, non-destructive migration, runtime compatibility projections, and resource-package policy. The application service and HTTP routes sit in their usual higher tiers. |
| `domains/run-orchestrator/` | 4 | Pure `RunPlan` construction and transitions, and Deep Research readiness rules. |
| `domains/run/` | 3 | Run records and Team host process launch. |
| `domains/runtime/` | 1 | Runtime logging, events, checkpoints, transcripts, artifacts, team chat messages, capability evidence, and the Team host's runtime context. |
| `domains/scheduling/` | 5 | Schedule and scheduling-queue schemas and scheduled result file names. The scheduler itself is `services/schedule-service.ts`. |
| `domains/sessions/` | 5 | Session and task lifecycle: the session store, task admission and recovery, run plans, the detached task runner, and the front-door turn. |
| `domains/stage/` | 3 | Stage contracts, the stage status machine, and follow-up messages. |
| `domains/team-files/` | 3 | Team-scoped uploaded documents and their context for the Resource Architect. |
| `domains/word-generation/` | 3 | Markdown-to-DOCX conversion, Mermaid rendering, and the `generate_word` tool. |
| `domains/workflow-generator/` | 4 | The Create-tab workflow architect and edits to `workflows/registry.yaml`. |
| `domains/youtube/` | 3 | The `youtube_extract` capability: media tools, captions, frames, Gemini analysis, and manuals. |

## Where new code goes

- A rule the UI and the server must both compute goes in `contracts/`.
- A pure policy goes in the lowest tier all of its callers can import. Keep
  file and process access out of it, and pass what it needs as arguments.
- A durable store goes next to the domain that owns its data. Build on
  `core/cross-process-file-lock.ts`, `core/file-mutation.ts` and
  `core/owned-file.ts`; do not write another lock or atomic writer.
- A module that spawns processes, listens on a port, or wires an entrypoint
  goes in `server/`, `team-runtime/` or `electron/`, or behind a port that
  one of them supplies.
- Moving a module to match this document is not a goal on its own. Move it
  when you extract its responsibility, and update this document, and
  `BACKEND_LAYER_POLICY` if a prefix changes, in the same change. A new
  dependency rule needs a fixture test in
  `tests/unit/architecture-check.test.ts`.
