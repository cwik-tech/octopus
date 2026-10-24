---
name: data-platform-deployment-safety
description: >
  Apply changes to a live data platform without breaking production, using an inspect-plan-execute-verify-rollback workflow with read-only and mutating operations separated and destructive actions gated behind explicit user approval. Use when deploying, promoting, or rolling back jobs, pipelines, notebooks, clusters, or workspaces on Databricks or Microsoft Fabric, planning a change window, promoting between dev/test/prod environments, assessing blast radius, using feature flags or bundle deployment modes, or running post-deploy verification.
---

# Data Platform Deployment Safety

## Outcome

A change reaches production through a planned, gated, and verifiable path, and a failed change can be undone without silent data loss or orphaned resources.

## Setup

Databricks. Install the CLI and confirm the version — Asset Bundles require v0.218.0 or above:

```sh
databricks --version
```

Authenticate with a named profile or environment variables (`DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET` for service principals). Use a service principal, not a personal user, for automated production deploys. Confirm which identity and workspace you are about to touch before anything else:

```sh
databricks current-user me
```

Microsoft Fabric. Install and authenticate the Fabric CLI (`fab`):

```sh
pip install ms-fabric-cli
fab --version
fab auth login                 # interactive browser login
# or: fab auth login -u "$FABRIC_CLIENT_ID" -p "$FABRIC_CLIENT_SECRET" --tenant "$FABRIC_TENANT_ID"
```

Fabric REST calls need a Microsoft Entra token for `https://api.fabric.microsoft.com`.

Secret handling rule: never write tokens, client secrets, or connection strings into files, prompts, logs, notebooks, or artifacts. Reference environment variables or the platform secret store (Databricks secret scopes, Azure Key Vault). Keep dev and prod in separate profiles/capacities, and verify the target host URL before every mutating command.

## Core workflow: inspect, plan, execute, verify, rollback

1. **Inspect (read-only).** Capture current state so rollback has a known-good target: `databricks jobs get <job-id>`, `databricks clusters get <cluster-id>`, `fab get ws.Workspace/item.Notebook`, and `databricks runs list --active-only` to check nothing is mid-run. Record the current Git commit or item version.
2. **Plan.** Write the change set: exact objects, old vs new configuration, blast radius, rollback command, and the approval that covers it. Validate before deploying: `databricks bundle validate -t prod`.
3. **Execute.** Apply one change set at a time, inside the agreed change window: `databricks bundle deploy -t prod`, or a Fabric stage deployment (see below).
4. **Verify.** Confirm the deployed state matches the plan and consumers still work — see Post-deploy verification.
5. **Rollback.** Redeploy the previous Git commit with `databricks bundle deploy -t prod`, or redeploy the previous item definitions in Fabric (deployment pipelines have no automatic rollback — redeploy the prior stage content or the Git-synced previous version). Record what happened in the incident runbook.

## Read-only vs mutating operations

- **Read-only, run any time:** `get`, `list`, `validate`, `current-user me`, `fab ls`, `fab get`, SQL against `system.*` tables, Fabric operation-state polling.
- **Mutating, require a written plan:** `deploy`, `create`, `update`, `run-now`, item `import`/`export`, pause/resume of schedules.
- **Destructive, require explicit user approval each time:** `delete`, workspace unassignment, table drops, permission revocation, capacity pause, and override flags such as `--force` on a production bundle deploy. Present the exact command and its blast radius; never treat approval for one destructive action as approval for the next.

## Blast-radius assessment

Before executing, enumerate: which stage/environment the change touches; which jobs, pipelines, warehouses, and dashboards depend on the changed objects (use lineage); whether the change writes data or only metadata; whether running executions must be drained or cancelled; and which downstream consumers observe a schema or semantic change. A change that rewrites a production table's schema has a larger blast radius than a notebook code update, even at the same size.

## Environment promotion and change windows

- **Databricks:** model dev/test/prod as bundle targets with `mode: development` and `mode: production`. Development mode prefixes resources, pauses schedules and triggers, and allows cluster overrides. Production mode validates that pipelines are marked `development: false` and that the current Git branch matches the target's configured branch (overridable only with `--force`, a gated destructive override).
- **Fabric:** promote through deployment pipeline stages (Development → Test → Production). Deploy programmatically with the Deploy Stage Content API, which is a long-running operation:

```sh
curl -X POST "https://api.fabric.microsoft.com/v1/deploymentPipelines/{pipelineId}/deploy" \
  -H "Authorization: Bearer $FABRIC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sourceStageId": "<test-stage-id>", "targetStageId": "<prod-stage-id>", "note": "release 2026-09"}'
# Poll the Location header / GET /v1/operations/{operation-id} until status is Succeeded or Failed.
```

Beware pairing: unpaired items are duplicated in the target stage rather than overwritten.

- **Change windows:** apply production changes only in agreed windows, after confirming no active runs depend on the objects being replaced. Communicate the window and rollback deadline to consumers.

## Feature flags

Keep new logic dark until deliberately enabled: bundle variables or job parameters that gate new code paths, Fabric variable libraries per stage, or a config table read at runtime. Deploying disabled code is safe; flipping a flag is a small, reversible change.

## Post-deploy verification

1. Re-read the deployed objects and diff against the plan (`databricks jobs get`, `fab get`).
2. Run a smoke execution and check it end to end: `databricks runs get <run-id>` until a terminal state; for Fabric, confirm the deploy operation result and run the affected pipeline or notebook once.
3. Confirm schedules resumed, downstream consumers refreshed, and no unexpected objects changed. Watch the first scheduled run after the window closes.

## Permission boundaries

- **Databricks:** separate service principals per environment; production deploys need CAN MANAGE on the target jobs, pipelines, and clusters. Inspect operations need only CAN VIEW. System tables and account-level APIs require account-level grants — do not request them for a workspace deploy.
- **Fabric:** Deploy Stage Content requires an admin deployment-pipeline role plus contributor on both source and target workspaces (delegated scope `Pipeline.Deploy`). Capacity pause/resume requires the Azure RBAC actions `Microsoft.Fabric/capacities/suspend/action` and `resume/action`. Request the narrowest role that covers the planned action.

## Troubleshooting

- **401/403 on deploy:** wrong profile or expired token. Re-check `databricks current-user me` / `fab auth status` and confirm the principal's permissions on the target objects.
- **Bundle production deploy fails branch validation:** you are not on the Git branch configured in the target. Deploy from the correct branch; reach for `--force` only with explicit approval.
- **Fabric deploy returns 202 and never finishes:** poll `GET /v1/operations/{operation-id}` honoring the `Retry-After` header; back off on 429 instead of retrying in a tight loop.
- **Duplicate items in the target Fabric stage:** items were not paired. Fix pairing (reassign or clean deploy) instead of deleting blindly — unpaired items never overwrite.
- **Production job still runs old code after deploy:** a development-mode deployment pauses schedules and may pin a cluster. Re-check `pause_status` and redeploy with the production target.
- **Deploy succeeded but consumers see stale results:** caches, SQL endpoints, or semantic models were not refreshed. Add the refresh step to the verification checklist rather than redeploying.

## Documentation

- [Databricks CLI](https://docs.databricks.com/dev-tools/cli/)
- [Databricks Asset Bundles](https://docs.databricks.com/dev-tools/bundles/) and [deployment modes](https://docs.databricks.com/aws/en/dev-tools/bundles/deployment-modes)
- [Authentication for the Databricks CLI](https://docs.databricks.com/aws/en/dev-tools/auth/)
- [Fabric deployment pipelines overview](https://learn.microsoft.com/en-us/fabric/cicd/deployment-pipelines/intro-to-deployment-pipelines) and [automation with REST APIs](https://learn.microsoft.com/en-us/fabric/cicd/deployment-pipelines/pipeline-automation-fabric)
- [Deploy Stage Content REST API](https://learn.microsoft.com/en-us/rest/api/fabric/core/deployment-pipelines/deploy-stage-content)
- [Microsoft Fabric CLI (`fab`)](https://pypi.org/project/ms-fabric-cli/)

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/incident-runbook.md`
- `../../templates/production-readiness-checklist.md`
- `../../references/security-control-baseline.md`

## Completion check

The work is done when the change is live in the intended environment, the deployed state matches the plan, post-deploy verification passed against an independent expected result, and a tested rollback path is recorded. If you cannot state exactly how to undo the change, it was not safe to execute.
