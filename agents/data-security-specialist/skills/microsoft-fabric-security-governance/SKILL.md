---
name: microsoft-fabric-security-governance
description: >
  Configure and verify Microsoft Fabric security and governance, including tenant settings, workspace roles, item-level sharing, OneLake data access roles, RLS and OLS in semantic models, and Microsoft Purview sensitivity labels. Use when securing a Fabric tenant or workspace, assigning Admin, Member, Contributor, or Viewer roles, checking effective permissions via the Fabric REST API, or troubleshooting unexpected access or denials.
---

# Microsoft Fabric Security Governance

## Outcome

A Fabric tenant and workspace security posture where every role assignment, data access role, and label is verifiable through the Fabric REST API and portal, and restricted identities see exactly what the design intends.

## Setup

- All Fabric management uses the REST base `https://api.fabric.microsoft.com/v1/...` with an Entra token for scope `https://api.fabric.microsoft.com/.default`. Keep tokens in environment variables or a secret store — never in files, prompts, logs, or artifacts.
- Before using a service principal, a tenant admin must enable "Service principals can call Fabric public APIs" (Developer settings). Read-only admin APIs additionally require "Service principals can access read-only admin APIs".
- Tenant settings change at the admin portal level (Fabric admin role); there is no public CLI — treat portal configuration as code-reviewed change requests with screenshots or exports as evidence.

## Security layers

Configure from the outside in; each layer narrows the previous one:

1. **Tenant settings**: gate risky capabilities at the tenant — external data sharing, guest user access, publish to web, export to Excel/CSV, OneLake access from external apps, customer-managed keys ("Apply customer-managed keys"). Prefer group-scoped enablement over tenant-wide.
2. **Workspace roles**: Admin (manage workspace and people), Member (add members, publish), Contributor (create/write items), Viewer (read only). Assign security groups, not individuals. Only Viewers are subject to OneLake security and semantic model RLS/OLS — Admin, Member, and Contributor have elevated data access that bypasses them.
3. **Item-level sharing**: share an item directly without workspace membership. `Read` shows metadata; `ReadData` allows SQL endpoint reads; `ReadAll` allows OneLake reads through the DefaultReader role; `Write` grants data write. Reshare must be deliberate.
4. **OneLake data access roles**: deny-by-default data-plane roles on a lakehouse, scoped to folders, tables, or schemas, with optional row and column constraints (T-SQL predicates). Edit or remove the DefaultReader role when default read-all access is too broad.
5. **Semantic model RLS/OLS**: RLS restricts rows via DAX filter expressions (dynamic pattern: `[UserEmail] = USERPRINCIPALNAME()`); OLS hides whole tables or columns via TMDL `metadataPermission: none`. Both apply to Viewers only. Validate with "Test as role", but note it uses your own identity — dynamic RLS for B2B guests must be validated by signing in as the guest.
6. **Sensitivity labels and Purview**: Purview Information Protection labels classify and protect items, inherit downstream, and travel with supported exports; Purview also provides audit, DLP for Fabric data, and Unified Catalog discovery.

## Verify effective permissions via API

Read-only; safe to run without approval:

```bash
# Workspace role assignments (caller needs Member or higher; scope Workspace.Read.All)
curl -H "Authorization: Bearer $FABRIC_TOKEN" \
  "https://api.fabric.microsoft.com/v1/workspaces/$WORKSPACE_ID/roleAssignments"

# OneLake data access roles on an item (scope OneLake.Read.All)
curl -H "Authorization: Bearer $FABRIC_TOKEN" \
  "https://api.fabric.microsoft.com/v1/workspaces/$WORKSPACE_ID/items/$ITEM_ID/dataAccessRoles"
```

Interpret the results: workspace role first (Viewer or not), then item permissions, then OneLake data access roles, then semantic model RLS/OLS. A user's effective access is the union across OneLake roles; RLS predicates combine with OR, so over-broad membership silently widens access.

## Mutating operations — gated

- Add/change workspace role assignment: `POST /v1/workspaces/{workspaceId}/roleAssignments` (scope `Workspace.ReadWrite.All`; caller needs Member or higher, Admin to add admins).
- Create or update OneLake data access roles: `PUT /v1/workspaces/{workspaceId}/items/{itemId}/dataAccessRoles` (scope `OneLake.ReadWrite.All`), using the `ETag` from a prior GET for concurrency.
- Tenant setting changes: portal, Fabric admin.

For each: capture the current state with the GET calls above (this is your rollback), state the exact diff, get explicit user approval, execute, then re-run the GET and confirm the intended diff is present. Removing a role or demoting a user can break production pipelines running under that identity — check what runs as the principal before demoting.

## Version and feature checks

Fabric is a SaaS platform: features ship and change continuously, and several (authorized third-party engines for OneLake security, some DLP surfaces) are in preview with per-tenant availability. Before relying on a capability, confirm it in the current tenant settings page and the linked docs below, and note preview status in the design. Role definition changes take about 5 minutes to apply; group membership changes can take about an hour (plus engine caching) — do not conclude a change failed from an immediate test.

## Troubleshooting

- Service principal gets 401/403 on Fabric APIs: the tenant settings for service principal API access are off, or the SP has no workspace role — the roleAssignments API itself requires Member or higher.
- Viewer still sees all data in the lakehouse: the DefaultReader role grants read to all users with ReadAll — edit or delete it and create scoped roles.
- RLS not applied to a user: they hold Admin, Member, or Contributor — RLS and OLS apply to Viewers only.
- B2B guest sees no data under dynamic RLS: `USERPRINCIPALNAME()` returns a `#EXT#` UPN that does not match the mapping table — display the function's value in a test card and align the table.
- Distribution list in a OneLake role not enforced at the SQL analytics endpoint: the endpoint cannot resolve distribution list membership — use Entra security groups.
- API returns 429: honor the `Retry-After` header before retrying.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package; the skill works without them.

- `../../references/security-control-baseline.md`
- `../../templates/production-readiness-checklist.md`

## References

- Fabric tenant settings index: https://learn.microsoft.com/en-us/fabric/admin/tenant-settings-index
- Workspace roles (Admin/Member/Contributor/Viewer): https://learn.microsoft.com/en-us/fabric/fundamentals/roles-workspaces
- OneLake security overview: https://learn.microsoft.com/en-us/fabric/onelake/onelake-security
- OneLake data access control model (roles, RLS/CLS, evaluation): https://learn.microsoft.com/en-us/fabric/onelake/security/data-access-control-model
- Row-level security in semantic models: https://learn.microsoft.com/en-us/fabric/security/service-admin-row-level-security
- Object-level security: https://learn.microsoft.com/en-us/power-bi/enterprise/service-admin-ols
- Sensitivity labels and information protection: https://learn.microsoft.com/en-us/fabric/governance/information-protection
- Microsoft Purview integration with Fabric: https://learn.microsoft.com/en-us/fabric/governance/microsoft-purview-fabric
- Workspace role assignments API: https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/list-workspace-role-assignments
- OneLake data access roles API: https://learn.microsoft.com/en-us/rest/api/fabric/core/onelake-data-access-security/list-data-access-roles

## Completion check

The roleAssignments and dataAccessRoles API responses match the approved design, a Viewer-role test identity sees exactly the permitted rows and columns (proven by sign-in, not just "Test as role"), and every tenant setting that permits sharing, export, or external access is either disabled or scoped to a named group with a recorded owner.
