---
name: data-access-control-design
description: >
  Design and verify least-privilege access control for data platforms, including RBAC versus ABAC selection, segregation of duties, service principal lifecycle, and access review cadence. Use when designing grants or roles, onboarding or retiring a service principal, running an access review, or auditing privileges in Databricks Unity Catalog or Microsoft Fabric workspaces.
---

# Data Access Control Design

## Outcome

An access model where every principal's effective privileges are documented, minimal, and verifiable from the platform itself — not from a diagram.

## Setup

Databricks: install the current CLI (GA is version 1.0.0 and above; versions 0.18 and below are legacy and unsupported). Check with `databricks --version`. Authenticate per profile — never write tokens into files, prompts, or artifacts; reference environment variables or a secret store.

- Interactive: `databricks auth login --host https://<workspace-host>` (OAuth U2M, browser flow).
- Automation: set `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET` (OAuth M2M for a service principal). Prefer OAuth over personal access tokens; PATs only when the tool has no OAuth support.

Microsoft Fabric: acquire an Entra token for scope `https://api.fabric.microsoft.com/.default` and call `https://api.fabric.microsoft.com/v1/...`. A tenant admin must enable "Service principals can call Fabric public APIs" before a service principal can use these endpoints.

## Method

1. Inventory principals (users, groups, service principals) and securables (catalogs, schemas, tables, workspaces, items). Separate authentication from authorization.
2. Grant to groups, not individuals. Map each group to a job function and give it the minimum privilege set: `USE CATALOG`, `USE SCHEMA`, `SELECT` for readers; add `MODIFY` only for writers; reserve `MANAGE` and ownership for stewards.
3. Choose RBAC or ABAC. RBAC (explicit grants, Fabric workspace roles) fits stable team boundaries. ABAC (Databricks policies on governed tags) fits classification-driven rules that must apply automatically to new tables. Decide per domain, not per table.
4. Enforce segregation of duties: the identity that writes production data does not approve its own grants; the identity that deploys pipelines is not a workspace Admin; break-glass access is named, logged, and time-boxed.
5. Manage the service principal lifecycle: create with a named owner and purpose, store its secret in a secret store, scope to one environment, rotate on a schedule, review quarterly, disable before delete, and record decommissioning.
6. Set an access review cadence: quarterly for privileged roles, semi-annual for general read access, on event (offboarding, org change, incident) for anything sensitive.

## Inspect before you change

Read-only verification — safe to run without approval:

```sql
-- Databricks SQL: privileges on a securable (requires admin, owner,
-- MANAGE on the object plus USE CATALOG / USE SCHEMA on its parents,
-- or being the named principal)
SHOW GRANTS ON TABLE catalog.schema.sensitive_table;
SHOW GRANTS `group-name` ON SCHEMA catalog.schema;
```

```sql
-- Effective grants across levels via information schema
SELECT grantee, privilege_type, table_catalog, table_schema, table_name
FROM system.information_schema.table_privileges
WHERE table_catalog = 'catalog' AND table_schema = 'schema';
```

```bash
# Fabric: list workspace role assignments (needs Member or higher
# workspace role; delegated scope Workspace.Read.All)
curl -H "Authorization: Bearer $FABRIC_TOKEN" \
  "https://api.fabric.microsoft.com/v1/workspaces/$WORKSPACE_ID/roleAssignments"
```

Discover available CLI subcommands with `databricks grants --help` rather than assuming a command exists in your CLI version.

## Mutating operations — gated

`GRANT`, `REVOKE`, `CREATE POLICY`, and Fabric `POST /v1/workspaces/{id}/roleAssignments` (scope `Workspace.ReadWrite.All`) change who can reach data. For each: state the diff (who gains or loses what), confirm it implements an approved request, get explicit user approval, execute, then re-run the read-only check above as proof. Record the before-statement so a revoke can be replayed as rollback.

## Troubleshooting

- `SHOW GRANTS` returns empty or is denied: the caller lacks ownership/`MANAGE`/admin — run as the object owner or a workspace admin.
- A user sees data they should not: check group nesting and multiple role assignments; effective access is the union of all grants. In Fabric, Admin/Member/Contributor workspace roles bypass OneLake security entirely.
- A grant appears to do nothing: privileges inherit downward — a catalog-level `SELECT` covers every schema and table. Check parents before adding table-level grants.
- Fabric API returns 401/403 for a service principal: the tenant setting "Service principals can call Fabric public APIs" is off, or the SP has no workspace role — the API requires Member or higher for reads.
- Fabric API returns 429: honor the `Retry-After` header and retry; do not loop immediately.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package; the skill works without them.

- `../../references/security-control-baseline.md`
- `../../templates/production-readiness-checklist.md`
- `../../templates/data-contract.yaml`

## References

- SHOW GRANTS syntax and required privileges: https://docs.databricks.com/en/sql/language-manual/security-show-grant.html
- Databricks CLI overview and versions: https://docs.databricks.com/en/dev-tools/cli/index.html
- Databricks authentication methods (OAuth, profiles, env vars): https://docs.databricks.com/en/dev-tools/auth/index.html
- Fabric workspace role assignments REST API: https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/list-workspace-role-assignments
- Fabric workspace roles (Admin/Member/Contributor/Viewer): https://learn.microsoft.com/en-us/fabric/fundamentals/roles-workspaces

## Completion check

For every protected securable, a read-only query or API call shows exactly the intended principals with exactly the intended privileges, and every service principal has a named owner, a scoped secret, and a review date.
