---
name: databricks-unity-catalog-governance
description: >
  Govern Databricks Unity Catalog objects — metastore, catalog, schema, table, volume — including GRANT/REVOKE privileges via SQL and the Databricks CLI, tags, system.access lineage and audit tables, and external locations with storage credentials. Use when auditing data access, granting or revoking permissions, reviewing lineage, setting up external storage, or remediating over-privileged grants in Databricks.
---

# Databricks Unity Catalog Governance

## Outcome

Privileges, tags, external storage, lineage, and audit evidence on Unity Catalog securables are inspected, changed, and verified with least privilege, and every mutation is traceable and reversible.

## Setup

- Install the Databricks CLI (v0.205+; GA at v1.0.0+). Check with `databricks --version`.
- Authenticate with a profile, never by embedding tokens:
  `databricks configure --profile <name>` stores host and token in `~/.databrickscfg`.
  For automation use a service principal with OAuth: set `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, and `DATABRICKS_CLIENT_SECRET` from a secret store, never from files, prompts, or logs.
- Verify the workspace is Unity Catalog-enabled and confirm your identity:
  `databricks current-user me -p <profile>` and `databricks catalogs list -p <profile>`.
- Version/feature checks before relying on a feature:
  - SQL: `SELECT current_metastore()` to confirm metastore attachment.
  - System tables (`system.access.audit`, `system.access.table_lineage`, `system.access.column_lineage`) must be enabled by an account admin; verify with `SHOW SCHEMAS IN system` before writing queries against them.
  - Tagging requires `APPLY TAG` on the object; governed tags additionally require `ASSIGN` permission.

## Permission boundaries

- Grant/revoke on an object: metastore admin, object owner, owner of the parent catalog/schema, or a principal with `MANAGE` on the object.
- Metastore-level grants (`CREATE CATALOG`, `CREATE STORAGE CREDENTIAL`, `CREATE EXTERNAL LOCATION`): metastore admin or account admin only.
- Storage credentials and external locations: grant only to users who must create external tables, volumes, or managed storage locations. Never grant non-UC identities direct bucket access to UC-managed storage.
- Reading `system.access.*` requires use of the `system` catalog; audit rows with SQL definitions are masked unless the principal is in the `databricks_pii_access` group.
- Default to least privilege: grant on the narrowest securable (table before schema before catalog), prefer groups over individual users, and always require `USE CATALOG` + `USE SCHEMA` alongside `SELECT`.

## Commands

Object model: `metastore → catalog → schema → table|view|volume|function|model`; storage credentials, external locations, connections sit under the metastore. Address data objects with the three-part name `catalog.schema.object`.

Inspect (read-only):

```sql
SHOW GRANTS ON TABLE catalog.schema.orders;
SHOW GRANTS ON CATALOG catalog;
DESCRIBE TABLE EXTENDED catalog.schema.orders;   -- owner, type, location
SELECT * FROM catalog.information_schema.table_tags WHERE table_name = 'orders';
```

```bash
databricks catalogs list -p prod
databricks schemas list catalog_name -p prod
databricks tables list catalog_name schema_name -p prod
databricks grants get table catalog.schema.orders -p prod
```

Mutating (require explicit user approval first):

```sql
GRANT USE CATALOG ON CATALOG catalog TO `data-analysts`;
GRANT SELECT ON TABLE catalog.schema.orders TO `data-analysts`;
REVOKE MODIFY ON TABLE catalog.schema.orders FROM `data-analysts`;
ALTER TABLE catalog.schema.orders SET TAGS ('pii' = 'true', 'owner' = 'risk-team');
GRANT READ VOLUME ON VOLUME catalog.schema.raw_files TO `ingestion-jobs`;
```

External storage (mutating, approval-gated):

```sql
CREATE STORAGE CREDENTIAL s3_cred WITH IAM ROLE 'arn:aws:iam::<acct>:role/uc-role';
CREATE EXTERNAL LOCATION ext_raw URL 's3://bucket/raw/' WITH (STORAGE CREDENTIAL s3_cred);
GRANT READ FILES ON EXTERNAL LOCATION ext_raw TO `ingestion-jobs`;
```

Lineage and audit (read-only):

```sql
-- Upstream/downstream table lineage (rolling 1-year window)
SELECT source_table_full_name, target_table_full_name, created_by, event_time
FROM system.access.table_lineage
WHERE target_table_full_name = 'catalog.schema.orders' AND event_date >= current_date() - 7;

-- Who granted what, to whom, in the last 30 days
SELECT event_time, user_identity.email, request_params
FROM system.access.audit
WHERE service_name = 'unityCatalog'
  AND action_name IN ('updatePermissions', 'grantPermissions')
  AND event_date >= current_date() - 30;
```

## Operating workflow

1. **Inspect**: list catalogs/schemas/tables, `SHOW GRANTS`, check current owner and tags. Record the current grant state as the rollback baseline.
2. **Plan**: write the exact GRANT/REVOKE set with principal, privilege, and securable; confirm it is least-privilege.
3. **Execute**: apply mutations one object at a time. All GRANT/REVOKE, tag changes, ownership transfers, storage credential, and external location creation require explicit user approval.
4. **Verify**: `SHOW GRANTS` returns exactly the intended state; test-access as the target principal if possible; confirm lineage/audit tables recorded the change.
5. **Rollback**: re-apply the baseline from step 1 (grant back revoked privileges or revoke granted ones). Ownership transfers and dropped external locations need a manual inverse operation — capture their prior values before changing.

## Troubleshooting

- **`PERMISSION_DENIED` on GRANT/REVOKE**: you lack owner/`MANAGE`/metastore-admin rights on that securable. Diagnose with `SHOW GRANTS` and the owner from `DESCRIBE ... EXTENDED`.
- **Principal can see the table but not query it**: missing `USE CATALOG`/`USE SCHEMA` on parents. `SELECT` alone is not sufficient.
- **`system.access` tables are empty or missing**: system tables are not enabled for the account, or you lack privileges on the `system` catalog. Ask an account admin; do not assume lineage is absent.
- **Lineage for an external table missing by name**: path-referenced tables record `source_path`/`target_path`, not table names; filter on the storage path instead.
- **External location creation fails**: the storage credential's cloud role lacks access to the path, or you lack `CREATE EXTERNAL LOCATION` on the metastore and read on the credential. Validate the location after creation.
- **Tag assignment rejected**: you lack `APPLY TAG` on the object, or the tag is governed and you lack `ASSIGN`; tag keys are case-sensitive and limited to 50 per object.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../references/security-control-baseline.md`
- `../../templates/lineage-record.yaml`

## References

- Unity Catalog overview and object model: https://docs.databricks.com/aws/en/data-governance/unity-catalog/
- Manage privileges (GRANT/REVOKE, ownership): https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/
- Apply tags to securable objects: https://docs.databricks.com/aws/en/data-governance/unity-catalog/tags
- External locations and storage credentials: https://docs.databricks.com/aws/en/connect/unity-catalog/external-locations
- Lineage system tables: https://docs.databricks.com/aws/en/admin/system-tables/lineage
- Audit log system table: https://docs.databricks.com/aws/en/admin/system-tables/audit-logs
- Databricks CLI: https://docs.databricks.com/aws/en/dev-tools/cli/
- Grants REST API: https://docs.databricks.com/api/workspace/grants

## Completion check

`SHOW GRANTS` on every touched securable returns exactly the intended least-privilege state, the change is visible in `system.access.audit`, lineage queries still resolve for affected tables, and a recorded rollback baseline exists for every mutation.
