---
name: microsoft-fabric-lakehouse-operations
description: >
  Operate Microsoft Fabric lakehouses — create and manage via the Fabric REST API, model Delta tables and schemas, access files in OneLake over ABFS paths, query the SQL analytics endpoint, run table maintenance (OPTIMIZE/VACUUM) via notebook, Spark SQL, or REST, and create OneLake shortcuts. Use when provisioning, loading, modeling, querying, maintaining, or troubleshooting a Fabric lakehouse or OneLake data.
---

# Microsoft Fabric Lakehouse Operations

## Outcome

A Fabric lakehouse is provisioned, loaded, modeled, queried, and maintained through the REST API, Spark, and the SQL analytics endpoint, with every mutation verified and destructive operations gated.

## Setup

- Every Fabric REST call needs a Microsoft Entra bearer token in the `Authorization` header. Obtain tokens from a secret store (Azure CLI `az account get-access-token --resource https://api.fabric.microsoft.com`, MSAL, or a service principal); never write tokens into files, prompts, logs, or artifacts.
- Base URL for item operations: `https://api.fabric.microsoft.com/v1`. Address items by workspace GUID and item GUID from the Fabric portal URL — names are not unique across item types.
- Verify before relying on a feature:
  - `GET /v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}` returns `properties.sqlEndpointProperties.provisioningStatus`; it must be `Success` before querying the SQL analytics endpoint.
  - Confirm the workspace is on a Fabric capacity (trial or paid); REST operations on a capacity-less workspace fail.
  - Check API availability against the Fabric REST API reference; some operations (e.g. schema-enabled lakehouses, Lakehouse Maintenance pipeline activity) are preview and vary by tenant.

## Permission boundaries

- Workspace roles gate item operations: Admin/Member can create, update, and delete lakehouses; Contributor can write data; Viewer is read-only.
- The SQL analytics endpoint is read-only for data; T-SQL DDL/DML against tables must go through Spark.
- SQL granular permissions on the endpoint apply only through the endpoint — they do not restrict Spark or OneLake access. Set workspace roles and OneLake permissions for the other paths.
- OneLake API access accepts user tokens in the `Storage` audience only.

## Commands

Provision and inspect (REST; create/update/delete are mutating — approval-gated):

```http
POST   https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/lakehouses
       { "displayName": "bronze" }
GET    https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}
PATCH  https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}
DELETE https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}
GET    https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}/tables
```

The GET response returns `oneLakeTablesPath` / `oneLakeFilesPath` and the SQL endpoint connection string. DELETE removes the lakehouse's metadata and data; shortcut targets are preserved. Gate DELETE behind explicit user approval.

OneLake file access (ABFS):

```
abfss://<workspace>@onelake.dfs.fabric.microsoft.com/<item>.lakehouse/Files/<path>
https://onelake.dfs.fabric.microsoft.com/<workspaceGUID>/<itemGUID>/Tables/<table>
```

The ABFS driver rejects special characters (spaces) in workspace names — use GUIDs. The account name is always `onelake`; the workspace is the filesystem.

Schema modeling with Spark (notebook or Spark SQL):

```sql
CREATE SCHEMA IF NOT EXISTS bronze.sales;               -- schema-enabled lakehouse
CREATE TABLE bronze.sales.orders (order_id BIGINT, amount DECIMAL(12,2), order_date DATE)
  USING delta PARTITIONED BY (order_date);
OPTIMIZE bronze.sales.orders ZORDER BY (order_id);
VACUUM bronze.sales.orders;                              -- default retention 7 days
```

Load CSV/Parquet to Delta without Spark (async; poll the `Location` header operation URL):

```http
POST https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}/tables/orders/load
{ "relativePath": "Files/orders.csv", "pathType": "File", "mode": "Overwrite",
  "formatOptions": { "header": true, "delimiter": ",", "format": "Csv" } }
```

Table maintenance via REST (async; poll `/v1/workspaces/{workspaceId}/items/{lakehouseId}/jobs/instances/{operationId}` — note the generic `items` route):

```http
POST https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}/jobs/TableMaintenance/instances
{ "executionData": { "tableName": "orders", "schemaName": "sales",
    "optimizeSettings": { "vOrder": true, "zOrderBy": ["order_id"] },
    "vacuumSettings": { "retentionPeriod": "7:01:00:00" } } }
```

Retention under seven days is rejected by default because it breaks time travel and can corrupt tables for active readers.

Shortcuts: create in the portal or via the OneLake shortcuts REST API (`POST /v1/workspaces/{workspaceId}/items/{itemId}/shortcuts`). In the `Tables` folder, shortcuts are top-level only and auto-register as tables when the target is Delta; in the `Files` folder they can sit anywhere. Deleting a shortcut never deletes the target.

## Operating workflow

1. **Inspect**: GET the lakehouse, list tables, check endpoint provisioning status and row counts.
2. **Plan**: name the tables/schemas, load or maintenance operations, and expected post-state. Identify which calls are mutating.
3. **Execute**: run mutations one at a time; creation, schema change, load-overwrite, maintenance, and deletion all require explicit user approval.
4. **Verify**: re-list tables, confirm `operationId` status is `Success`/`Completed`, and query the table through Spark and the SQL analytics endpoint.
5. **Rollback**: loads with `mode: Overwrite` are reversible only via Delta time travel (`RESTORE` / versioned reads) — capture the current table version with `DESCRIBE HISTORY` before overwriting. A deleted lakehouse cannot be restored; a deleted shortcut can be recreated.

## Troubleshooting

- **Table missing from the SQL analytics endpoint**: only Delta tables under the `Tables` folder are exposed; data in `Files` or external Spark tables are not. Convert to Delta or create a shortcut in `Tables`. If it is still missing, force a metadata sync refresh.
- **401/403 from the Fabric REST API**: token audience wrong (must be the Fabric service; OneLake needs `Storage`), expired token, or insufficient workspace role.
- **Shortcut not recognized as a table**: the target is not Delta, or the shortcut name contains spaces. Delta table names cannot contain spaces.
- **ABFS path fails in external tooling**: endpoint validation — tools expect `dfs.core.windows.net`; allow `onelake.dfs.fabric.microsoft.com`, and switch to GUIDs if the workspace name has spaces.
- **TableMaintenance job `Failed` or `Deduped`**: `Deduped` means an instance is already running — poll the existing job. Failures with retention under seven days are by design; raise the retention or set `spark.databricks.delta.retentionDurationCheck.enabled` to `false` in the workspace Spark environment.
- **Load Table operation stuck**: poll the operation URL from the `Location` header; status 4 is `Failed` and carries an `Error` payload — check the file format, delimiter, and that the file exists under `Files`.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/dataset-specification.md`
- `../../references/data-engineering-principles.md`

## References

- Lakehouse overview: https://learn.microsoft.com/en-us/fabric/data-engineering/lakehouse-overview
- Manage the lakehouse with the Fabric REST API: https://learn.microsoft.com/en-us/fabric/data-engineering/lakehouse-api
- Lakehouse Items REST API reference: https://learn.microsoft.com/en-us/rest/api/fabric/lakehouse/items
- OneLake access API and ABFS URIs: https://learn.microsoft.com/en-us/fabric/onelake/onelake-access-api
- SQL analytics endpoint: https://learn.microsoft.com/en-us/fabric/data-engineering/lakehouse-sql-analytics-endpoint
- Table maintenance (OPTIMIZE/VACUUM): https://learn.microsoft.com/en-us/fabric/data-engineering/lakehouse-table-maintenance
- OneLake shortcuts: https://learn.microsoft.com/en-us/fabric/onelake/onelake-shortcuts
- OneLake shortcuts REST API: https://learn.microsoft.com/en-us/rest/api/fabric/core/onelake-shortcuts

## Completion check

`GET` on the lakehouse shows the intended state with the SQL analytics endpoint provisioned (`provisioningStatus: Success`), all async operations report `Success`/`Completed`, and each created or modified table is queryable through both Spark SQL and the SQL analytics endpoint.
