---
name: data-platform-observability
description: >
  Build platform monitoring and SLO instrumentation for data pipelines: Databricks system tables (system.lakeflow jobs, system.billing.usage, system.access.audit, system.query.history), Databricks SQL alerts via the REST API, Microsoft Fabric Monitoring Hub and Capacity Metrics app, freshness/volume/quality SLO signals, and alert design that pages on symptoms rather than causes. Use when setting up data platform monitoring, job failure or cost alerting, Databricks or Fabric observability, pipeline SLOs, freshness checks, or on-call alert design.
---

# Data Platform Observability

## Outcome

Pipelines and platforms emit the signals needed to detect consumer-impacting failures, and every page names impact, owner, and first action — with concrete wiring for Databricks and Microsoft Fabric.

## Setup

- Databricks: configure the CLI (`databricks configure --profile <name>`); tokens come from the `DATABRICKS_TOKEN` env var or a secret store, never from files or prompts the agent writes. Verify with `databricks --version` (use GA 1.0.0+) and `databricks current-user me`. System tables require account-admin enablement per metastore and region; confirm access with `SELECT * FROM system.information_schema.tables LIMIT 5` on a SQL warehouse.
- Fabric: Monitoring Hub is available to any user with item permissions (Monitor in the nav pane). The Capacity Metrics app must be installed by a capacity admin; its data lags 10-15 minutes. Fabric REST API calls need an Entra ID token (e.g. `az account get-access-token --resource https://api.fabric.microsoft.com`).
- Never log secrets, connection strings, or query result contents into artifacts; record metric values and IDs only.

## Method

1. Define consumer-visible SLIs first: freshness (time since last successful load), volume (rows or bytes vs expected range), and quality-rule pass rate. Attach each to an SLO with a window, an owner, and an error budget before wiring any tooling.
2. Instrument the pipeline to emit results into a monitoring table: run status, duration, rows processed, watermark, and per-rule quality outcomes. Do not infer health from "the job succeeded."
3. Wire platform telemetry:
   - Databricks jobs: `system.lakeflow.job_run_timeline` and `system.lakeflow.job_task_run_timeline` for run status, duration, and failure reasons across workspaces.
   - Databricks cost: `system.billing.usage` grouped by sku_name, usage_metadata.job_id, or warehouse_id; expect up to 12 hours latency.
   - Databricks security: `system.access.audit` for who changed jobs, tables, or permissions.
   - Fabric runs: Monitoring Hub (Activities page, filter Status = Failed; Historical runs for 30-day history per item).
   - Fabric capacity: Capacity Metrics app — Health, Compute, and Timepoint pages for CU consumption, throttling, and the operations behind an overload.
4. Create alerts on the SLIs, not on infrastructure trivia. On Databricks, back an alert with a monitoring query on a SQL warehouse and create it through the Alerts REST API, e.g.:

   ```bash
   curl -X POST "$DATABRICKS_HOST/api/2.0/alerts" \
     -H "Authorization: Bearer $DATABRICKS_TOKEN" \
     -d '{"name":"orders freshness breach","query_id":"<query-id>",
          "options":{"column":"minutes_since_load","op":">","value":"60"},
          "rearm": 3600}'
   ```

   Confirm the current request shape against the Alerts API reference before sending; verify the created alert with the matching GET. Creating, updating, or deleting alerts is mutating — get user approval first. On Fabric, use scheduled-item failure notifications (Monitoring Hub → Schedule failures) and Fabric capacity overview events; the Capacity Metrics app itself does not support alerts.
5. Page on symptoms, not causes. A page means a consumer-facing SLO is burning: data is stale, volume is off, a quality rule failed. CPU spikes, queue depth, or a single retried task go to dashboards unless they already threaten the SLO. Every alert names the affected dataset and consumers (use lineage), the owner, the first check, and the runbook link; an alert without an operator action becomes a dashboard tile.
6. Verify end to end: force one stale-data, one volume-drop, and one failed-run scenario in a test workspace and confirm detection, routing, and deduplication. State the rollback: disable the alert (or delete via the API) and restore prior thresholds.

## Permission boundaries

- Databricks system tables: account admin by default; grant least-privilege read via dynamic views per team. Alerts: CAN MANAGE on the alert to change it; the alert query runs on its warehouse's identity. Billing and audit data are account-wide — restrict to platform teams.
- Fabric: Monitoring Hub shows only items the caller can view; Capacity Metrics requires capacity admin to install and share; Fabric REST API calls run as the token's identity — use a service principal with read-only workspace roles for automation.

## Documentation

- System tables reference: https://docs.databricks.com/aws/en/admin/system-tables/
- Jobs system tables (system.lakeflow): https://docs.databricks.com/aws/en/admin/system-tables/jobs
- Billing usage table: https://docs.databricks.com/aws/en/admin/system-tables/billing
- Audit log table: https://docs.databricks.com/aws/en/admin/system-tables/audit-logs
- Databricks Alerts REST API: https://docs.databricks.com/api/workspace/alerts/create
- Fabric Monitoring Hub: https://learn.microsoft.com/en-us/fabric/admin/monitoring-hub
- Fabric Capacity Metrics app: https://learn.microsoft.com/en-us/fabric/enterprise/metrics-app
- Databricks CLI: https://docs.databricks.com/aws/en/dev-tools/cli

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../references/reliability-and-slo-guide.md`
- `../../references/data-quality-dimensions.md`
- `../../templates/data-product-slo.yaml`

## Troubleshooting

- System tables return nothing: they must be enabled per metastore by an account admin, are regional, and have latency (about 1 hour for query history, 12 hours for billing); verify the metastore and window before assuming no data.
- Alert fires but query history shows success: the alert ran on stale data or the wrong warehouse; check the alert query's own record in `system.query.history` and its warehouse.
- Billing totals do not match invoice: aggregate `usage_quantity` including RETRACTION and RESTATEMENT record types, and allow 12+ hours of lag.
- Monitoring Hub missing a run: it shows up to 100 recent activities over 30 days; use Historical runs for the item or the workspace's item job API.
- Capacity Metrics app shows old data: usage lags 10-15 minutes and new items appear only after the next scheduled semantic model refresh.
- Fabric capacity throttling with no clear culprit: use the Timepoint page to break down the 30-second window by operation, then correlate with Monitoring Hub activities at that time.

## Completion check

The work is done when each critical pipeline has named SLIs and SLO targets, platform telemetry is queryable (system tables or Fabric hub), at least one symptom-based alert was proven to fire and route in a forced-failure test, and every page identifies impact, owner, and first action.
