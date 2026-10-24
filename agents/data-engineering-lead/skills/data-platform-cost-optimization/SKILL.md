---
name: data-platform-cost-optimization
description: >
  Find and reduce data platform spend by measuring cost drivers, detecting idle resources, right-sizing compute, and setting budget alerts on Databricks and Microsoft Fabric. Use when analyzing DBU or capacity unit consumption, querying system.billing tables, installing or reading the Fabric Capacity Metrics app, finding idle clusters or underutilized capacities, right-sizing clusters or SKUs, pausing Fabric capacities off-hours, configuring budget alerts, or answering why the platform bill went up.
---

# Data Platform Cost Optimization

## Outcome

A quantified cost baseline, a ranked list of savings actions with expected impact, and verified savings that did not break workload SLOs.

## Setup

Databricks cost data lives in system tables and the CLI. Authenticate as for any workspace work (profile or `DATABRICKS_HOST` plus service-principal env vars; never write tokens into files, prompts, logs, or artifacts):

```sh
databricks --version          # keep current; system table coverage grows over time
databricks current-user me    # confirm identity and workspace before querying
```

Querying `system.billing.usage` and `system.billing.list_prices` requires access to the system catalog (granted by an account admin); run the SQL in a SQL warehouse or notebook on a workspace with system tables enabled.

Fabric cost data lives in the Capacity Metrics app and Azure APIs. Install `fab` and authenticate (`fab auth login`, or a service principal via env vars). Reading the Capacity Metrics app requires capacity admin; listing capacities via Azure REST requires read access on the Fabric capacity resources.

## Where the money goes

- **Databricks:** every workload bills in DBUs against a SKU. Key drivers: all-purpose (interactive) clusters cost several times more per DBU-hour than job compute for the same work; serverless jobs, pipelines, and notebooks bill per use; SQL warehouses bill while running; idle all-purpose clusters without autotermination are the classic leak. `billing_origin_product` and `product_features.is_serverless` in `system.billing.usage` separate these.
- **Fabric:** a capacity is a fixed pool of Capacity Units (CUs) at an SKU price (F2…F2048). Cost drivers: sustained background operations (Spark, pipelines, refreshes), throttling from overcommit, and paying for a capacity that sits idle off-hours. Pausing a capacity stops billing; overages are billed when you pause.

## Measure: gather cost data (read-only)

Daily DBU consumption by SKU and workspace (Databricks SQL):

```sql
SELECT usage_date, sku_name, workspace_id,
       SUM(usage_quantity) AS dbus
FROM system.billing.usage
WHERE usage_date >= current_date() - INTERVAL 30 DAYS
GROUP BY ALL
ORDER BY dbus DESC;
```

Top clusters and jobs by consumption, handling retraction/restatement corrections:

```sql
SELECT usage_metadata.cluster_id, usage_metadata.job_id,
       billing_origin_product, SUM(usage_quantity) AS dbus
FROM system.billing.usage
WHERE usage_date >= current_date() - INTERVAL 30 DAYS
GROUP BY ALL
HAVING dbus != 0
ORDER BY dbus DESC
LIMIT 25;
```

Convert DBUs to money by joining `system.billing.list_prices` on `sku_name` and the most recent `price_start_time`, using `pricing.default` (list price). Note that billing records typically land within 12 hours and may be corrected later.

Fabric capacities and their state (read-only):

```sh
fab api capacities                       # list capacities the identity can see
```

```sh
curl "https://management.azure.com/subscriptions/{subscriptionId}/providers/Microsoft.Fabric/capacities?api-version=2023-11-01" \
  -H "Authorization: Bearer $AZURE_TOKEN"
```

For CU-level detail, install the Microsoft Fabric Capacity Metrics app (capacity admin) and read the Compute page: 14-day utilization, throttling, and the matrix of operations by item. Its data lags 10–15 minutes.

## Idle-resource detection and right-sizing

Read-only detection first; change only with approval.

- Databricks clusters: list all-purpose compute and check autotermination and last activity — `databricks clusters list`. Clusters with no `autotermination_minutes`, running for days with low usage, or sized far above their jobs are candidates. Attribute spend via `usage_metadata.cluster_id`.
- SQL warehouses and serverless: warehouses with long idle windows and tiny query counts; serverless usage where classic job compute would be cheaper, or vice versa.
- Right-size: move scheduled workloads from all-purpose to job compute; enable autoscaling; cap waste with compute policies (max DBUs per hour, fixed node types, enforced autotermination). Policy changes to running compute restart it — treat as mutating.
- Fabric: find capacities with low sustained CU% in the Metrics app; downsize the SKU, or pause off-hours capacities via the Azure REST Suspend/Resume operations or an Azure runbook schedule. Pausing a production capacity is destructive to availability — gate it behind explicit approval and confirm nothing depends on it.

## Budget alerts

- Azure (covers Fabric capacities and Databricks on Azure): create Cost Management budgets at subscription or resource-group scope with actual-cost and forecast thresholds; alerts email within about an hour of evaluation. Needs Cost Management contributor; reader can only view.
- Databricks: schedule the spend queries above as a job and alert on threshold breaches; track `usage_policy_id` in `system.billing.usage` to attribute serverless spend to usage policies.

## Agent-safe workflow

1. **Measure (read-only):** run the queries and listings above; build the baseline.
2. **Identify:** rank findings by spend and confidence; state expected savings per action.
3. **Recommend and get approval:** present each mutating action (edit cluster, apply policy, resize or pause capacity) with its blast radius. Deleting compute or pausing a production capacity requires explicit approval each time.
4. **Execute** the approved actions one at a time.
5. **Verify:** re-query spend after the billing latency window and confirm workload SLOs still hold. Savings that break pipelines are not savings.

## Permission boundaries

- **Read:** workspace access plus SELECT on `system.billing.*` (account-admin granted); Fabric capacity admin (or Metrics app share) for CU detail; Azure reader for capacity listings.
- **Change:** CAN MANAGE on the specific Databricks compute; compute-policy authoring needs workspace admin. Fabric SKU changes and pause/resume need Azure RBAC on the capacity resource (`Microsoft.Fabric/capacities/write`, `suspend/action`, `resume/action`) — a custom role, not a broad privileged role.

## Troubleshooting

- **`system.billing.usage` returns nothing:** system tables are not enabled for the workspace, or the principal lacks access. Ask an account admin to enable and grant access; records for new workspaces can take longer than 12 hours.
- **Spend numbers change retroactively:** corrections arrive as `RETRACTION`/`RESTATEMENT` records. Always `SUM(usage_quantity)` across record types rather than filtering to `ORIGINAL`.
- **Cluster/job attribution columns are null:** `usage_metadata` fields populate only for the relevant compute type — serverless usage has no `cluster_id`. Join `system.compute.clusters` for all-purpose cluster ownership.
- **Cost estimate disagrees with the invoice:** you joined list prices from the wrong window or missed negotiated discounts. Use the latest `price_start_time` on or before the usage date and treat results as list-price estimates.
- **Fabric Metrics app shows no data for a new capacity:** dimensions refresh on a scheduled model refresh; trigger a manual refresh and re-check the `RegionName` parameter.
- **Throttling after downsizing a Fabric capacity:** the SKU no longer fits peak load. Review the Metrics app Timepoint page, spread background operations, or scale back up.

## Documentation

- [Databricks billable usage system table (`system.billing.usage`)](https://docs.databricks.com/aws/en/admin/system-tables/billing)
- [Databricks pricing system table (`system.billing.list_prices`)](https://docs.databricks.com/aws/en/admin/system-tables/pricing)
- [Databricks compute policies](https://docs.databricks.com/aws/en/admin/clusters/policies)
- [Databricks CLI](https://docs.databricks.com/dev-tools/cli/) and [authentication](https://docs.databricks.com/aws/en/dev-tools/auth/)
- [Microsoft Fabric Capacity Metrics app](https://learn.microsoft.com/en-us/fabric/enterprise/metrics-app)
- [Pause and resume a Fabric capacity](https://learn.microsoft.com/en-us/fabric/enterprise/pause-resume)
- [Fabric Capacities Azure REST API](https://learn.microsoft.com/en-us/rest/api/microsoftfabric/fabric-capacities)
- [Create and manage Azure budgets](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets)
- [Microsoft Fabric CLI (`fab`)](https://pypi.org/project/ms-fabric-cli/)

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../references/reliability-and-slo-guide.md`
- `../../references/security-control-baseline.md`

## Completion check

The work is done when there is a measured baseline, each recommended action carries an expected saving and an approval state, executed actions show reduced consumption in `system.billing.usage` or the Capacity Metrics app after the latency window, and no workload SLO regressed. A recommendation without a measured baseline is a guess, not an optimization.
