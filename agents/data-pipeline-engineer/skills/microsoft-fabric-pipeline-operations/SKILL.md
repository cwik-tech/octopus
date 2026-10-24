---
name: microsoft-fabric-pipeline-operations
description: >
  Create, update, run, schedule, and monitor Microsoft Fabric Data Factory pipelines through the Fabric REST API. Use for Fabric pipeline items (DataPipeline) and Copy Jobs, pipeline definition JSON payloads, pipeline activities (Copy, Notebook, Lookup, ForEach), triggering a pipeline run via the job scheduler API, monitoring pipeline runs and activity runs, or setting up pipeline schedules in Microsoft Fabric.
---

# Microsoft Fabric Pipeline Operations

## Outcome

Manage Fabric Data Factory pipelines as code: create or update pipeline item definitions via REST, trigger runs, monitor them to a terminal state, and attach schedules — with approval for every mutation.

## Setup

1. Follow the `microsoft-fabric-api-operations` skill first: Entra ID identity, token scope `https://api.fabric.microsoft.com/.default`, base URL `https://api.fabric.microsoft.com/v1`, LRO polling, and 429 handling all apply. Never place connection credentials or tokens in pipeline JSON or artifacts — Fabric pipelines reference connection objects and workspace identities, not inline secrets.
2. Verify the workspace and capacity: `GET /v1/workspaces` and confirm the target workspace ID. Pipeline creation requires a workspace on a Fabric capacity and Member or Admin workspace role for writes.
3. Check item-type support for your identity: the DataPipeline item reference pages state service-principal support; verify before automating with one.

## Pipeline definitions as items

- A pipeline is an item of `type: "DataPipeline"`. Create it: `POST /v1/workspaces/{workspaceId}/items` with `{displayName, type: "DataPipeline"}`, or with a `definition` payload for a fully defined pipeline. `POST` may return 202 — poll the `Location` header until `Succeeded`.
- The definition is a set of base64-encoded parts under `definition.parts[]`: `pipeline-content.json` (the pipeline: `properties.activities[]` with `dependsOn`, `parameters`, `variables`) plus the `.platform` metadata part. Fetch the current definition with `POST /v1/workspaces/{wsId}/items/{itemId}/getDefinition`; replace it with `POST .../updateDefinition`. Always `getDefinition` before `updateDefinition` so the change is a reviewable diff and the prior definition is the rollback.
- Activities: `Copy` (data movement with source/sink, translator, staging), `Lookup`, `SetVariable`, `ForEach`, `IfCondition`, `Notebook`, plus `ExecutePipeline`. Chained execution uses `dependsOn: [{activity, dependencyConditions: ["Succeeded"]}]`.
- Copy Job: a separate item type (`CopyJob`) for managed copy-with-incremental behavior; create it the same way with `type: "CopyJob"`. Prefer it over hand-built Copy activities when the requirement is simple ongoing data movement.

## Run, monitor, schedule

- Trigger on demand: `POST /v1/workspaces/{wsId}/items/{itemId}/jobs/instances?jobType=Pipeline` returns 202 with a `Location` header pointing at the job instance.
- Monitor: `GET <Location>` (or `GET /v1/workspaces/{wsId}/items/{itemId}/jobs/instances/{jobInstanceId}`) until `status` is `Completed`, `Failed`, or `Cancelled`. List recent runs with `GET .../jobs/instances`. For activity-level detail, use the pipeline run monitoring guidance in the Data Factory docs.
- Schedule: create a schedule on the item via the job scheduler schedules API (`POST /v1/workspaces/{wsId}/items/{itemId}/jobs/Pipeline/schedules`) with `enabled`, `configuration` (cron-type with `startDateTime`, `endDateTime`, `localTimeZoneId`, `times`), and `owner`. New schedules start disabled until approved.
- Cancel: `POST .../jobs/instances/{id}/cancel` — mutating, requires approval and a reason.

## Permissions and safety

- Reads (`getDefinition`, item/run lists) are unrestricted. Creates, definition updates, runs, schedule changes, and deletes require a written plan (workspace ID, item ID, definition diff or run parameters) and explicit user approval. Deleting a pipeline item requires confirming no schedule or downstream dependency uses it, and a saved definition for rollback.
- Workflow: inspect (get item + definition) → plan (definition diff) → execute (update, poll LRO) → verify (re-read definition; trigger a run and watch it reach terminal state) → rollback (re-`updateDefinition` from the saved definition).

## Troubleshooting

- `updateDefinition` fails validation: `pipeline-content.json` must be valid pipeline JSON and base64-encoded per part; check part `path` values exactly match (`pipeline-content.json`, `.platform`).
- Run stuck or never starts: you ignored the 202 `Location` — poll the job instance; also check capacity throttling (429 with `Retry-After`).
- Copy activity fails on connection: the pipeline references a Fabric connection ID that does not exist in this workspace or the caller lacks access; list connections and rebind before rerunning.
- Run shows `Failed` with no detail at the job level: fetch activity-run details per the monitoring doc; job-instance status alone hides the failing activity.
- Schedule fires at the wrong time: `localTimeZoneId` must be a valid Windows/IANA zone; verify with a get-schedule call after creation.

## References

- Fabric pipelines via REST (Data Factory): https://learn.microsoft.com/en-us/fabric/data-factory/pipeline-rest-api
- Create Data Pipeline: https://learn.microsoft.com/en-us/rest/api/fabric/datapipeline/items/create-data-pipeline
- Update pipeline definition: https://learn.microsoft.com/en-us/rest/api/fabric/datapipeline/items/update-data-pipeline-definition
- Data pipeline item reference: https://learn.microsoft.com/en-us/rest/api/fabric/datapipeline/items
- Run on-demand item job: https://learn.microsoft.com/en-us/rest/api/fabric/core/job-scheduler/run-on-demand-item-job
- Monitor pipeline runs: https://learn.microsoft.com/en-us/fabric/data-factory/monitor-pipeline-runs
- Item definition format: https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/item-definition-overview

## Shared resources

Load only if the task needs them; the skill is self-contained without them.

- `../../templates/pipeline-design-specification.md`
- `../../templates/incident-runbook.md`
- `../../references/reliability-and-slo-guide.md`

## Completion check

`getDefinition` matches the approved pipeline definition, the triggered run reached `Completed` (or a diagnosed terminal state) with activity-level evidence, any schedule exists with the approved times and timezone, and no credentials appear in the pipeline JSON or any artifact.
