---
name: databricks-sql-spark-optimization
description: >
  Diagnose and tune slow or expensive Databricks SQL and Spark workloads using EXPLAIN plans, query profiles, the Spark UI, skew and spill analysis, Photon, Adaptive Query Execution, liquid clustering vs ZORDER and partitioning, SQL warehouse tuning, and the system.query.history and system.billing.usage system tables. Use when a user asks to speed up a Databricks query, investigate a long-running job, reduce DBU spend, fix data skew, tune a SQL warehouse, find costly queries, or compare liquid clustering, ZORDER, and partitioning.
---

# Databricks SQL and Spark Optimization

## Outcome

A verified performance diagnosis and an approved, reversible change that measurably reduces duration, cost, or variance of the target workload.

## Setup

1. Configure the Databricks CLI with a profile that holds no secrets in files the agent writes: `databricks configure --profile <name>` with OAuth or a token supplied via the `DATABRICKS_TOKEN` environment variable. Never write tokens into prompts, notebooks, logs, or artifacts; reference `DATABRICKS_HOST` and `DATABRICKS_TOKEN` env vars or a secret store.
2. Verify versions before relying on a feature: `databricks --version` (GA CLI is 1.0.0+; legacy 0.18 and below is unsupported). Check runtime with `SELECT current_version()` on the target compute or read the cluster's Spark version in the UI. Liquid clustering GA requires DBR 15.2+ (13.3 LTS minimum to read); AQE is enabled by default; Photon is on by default for SQL warehouses and jobs compute.
3. Confirm permissions: CAN MONITOR on the SQL warehouse to view query profiles; SELECT on `system.query.history` and `system.billing.usage` (account admin by default, or a dynamic view grant); CAN MANAGE on the warehouse or table for any tuning change.

## Method

Work in read-only mode until the diagnosis is written down and the user approves a change.

1. Inspect: find the costly or slow statements. Query `system.query.history` for the worst offenders over a representative window:

   ```sql
   SELECT statement_id, executed_by, client_application,
          total_duration_ms, execution_duration_ms, waiting_at_capacity_duration_ms,
          read_bytes, read_files, pruned_files, spilled_local_bytes, shuffle_read_bytes,
          error_message, query_source.job_info.job_id
   FROM system.query.history
   WHERE start_time >= current_date() - 7
   ORDER BY total_task_duration_ms DESC
   LIMIT 25;
   ```

   Correlate with `system.billing.usage` (usage_metadata.warehouse_id / job_id) to rank by DBU cost, not only by duration.
2. Inspect: pull the query profile for the chosen `statement_id` (Query History UI → See query profile), and check the Top operators panel, rows scanned vs pruned, spill, and Photon coverage (purple = Photon, grey = fallback). For classic clusters, open the Spark UI (Compute → Spark UI) and read the Jobs timeline, the longest stage, and the task distribution for skew (max task duration >> median) and spill.
3. Inspect: get the plan with `EXPLAIN FORMATTED <statement>` or `EXPLAIN COST <statement>`. Look for `AdaptiveSparkPlan` nodes, `Exchange` shuffles, missing filters pushed down, exploding joins, and full scans. Remember SQL EXPLAIN shows the initial plan only; AQE re-optimizes at runtime, so confirm against the executed profile.
4. Plan: state one hypothesis and one change per iteration — rewrite the statement, refresh stats (`ANALYZE TABLE ... COMPUTE STATISTICS`), change layout (liquid clustering vs ZORDER/partitioning), or change compute (Photon, warehouse size/scaling, serverless).
5. Execute only with explicit user approval. Mutating actions: `ALTER TABLE ... CLUSTER BY` / `OPTIMIZE ... FULL`, `ANALYZE TABLE`, warehouse resize via `databricks warehouses edit <id>`, or terminating a query. Never run these silently; record the pre-change baseline first.
6. Verify: rerun the statement (or wait for the next scheduled run) and compare `execution_duration_ms`, `read_bytes`, and task-time in `system.query.history` against the baseline.
7. Rollback: revert statement edits to the prior text; `RESTORE TABLE ... TO VERSION AS OF` for layout changes; restore prior warehouse settings with the same `databricks warehouses edit` call.

## Layout decision

- Default to liquid clustering for new tables: `CREATE TABLE t (...) CLUSTER BY (col)`; it replaces ZORDER and Hive-style partitioning and keys can change without a rewrite. Convert existing partitioned tables with `ALTER TABLE t REPLACE PARTITIONED BY WITH CLUSTER BY`.
- Keep ZORDER only for legacy tables you cannot convert; keep partitioning only for coarse time boundaries that double as a retention or lifecycle unit.
- Skewed joins: let AQE handle moderate skew (`isSkew=true` in the plan); for severe skew, pre-aggregate or salt the hot key rather than tuning shuffle partitions by hand.
- Warehouse tuning: right-size cluster size for latency, raise max clusters for concurrency (roughly one cluster per 10 concurrent queries), prefer serverless warehouses, and lower Auto Stop on interactive warehouses.

## Documentation

- EXPLAIN syntax: https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-syntax-qry-explain
- Spark UI diagnosis guide: https://docs.databricks.com/aws/en/optimizations/spark-ui-guide/
- Adaptive Query Execution: https://docs.databricks.com/aws/en/optimizations/aqe
- Photon: https://docs.databricks.com/aws/en/compute/photon
- Liquid clustering: https://docs.databricks.com/aws/en/delta/clustering
- SQL warehouse settings: https://docs.databricks.com/aws/en/compute/sql-warehouse/create
- Query history and query profile UI: https://docs.databricks.com/aws/en/sql/user/queries/query-history and https://docs.databricks.com/aws/en/sql/user/queries/query-profile
- Query History API: https://docs.databricks.com/api/workspace/queryhistory/list
- system.query.history schema: https://docs.databricks.com/aws/en/admin/system-tables/query-history
- Databricks CLI: https://docs.databricks.com/aws/en/dev-tools/cli

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../references/reliability-and-slo-guide.md`
- `../../templates/incident-runbook.md`

## Troubleshooting

- `statement_text` shows `<REDACTED>` in system.query.history: expected by default; account admins or the `databricks_pii_access` group see full text. Do not work around this; diagnose via the query profile instead.
- No query profile for a statement: results served from cache have no profile; change the statement trivially (e.g., adjust LIMIT) and rerun.
- EXPLAIN plan differs from executed plan: AQE re-optimized at runtime; read the final plan in the query profile, not SQL EXPLAIN.
- Photon fallback: UDFs, RDD/Dataset APIs, or unsupported expressions force fallback to the Spark runtime; check the plan for grey operators.
- system.query.history empty or lagging: records appear within about an hour and only for SQL warehouses or serverless compute; confirm system tables are enabled for the metastore.
- ALTER CLUSTER BY fails: clustering is incompatible with partitioning and ZORDER, and requires DBR 13.3 LTS+ (15.2+ for GA); check runtime and table properties first.

## Completion check

The work is done when a named baseline (statement_id, duration, read bytes, cost) and a post-change measurement from `system.query.history` or the query profile show the improvement, the applied change is recorded, and the rollback path is stated.
