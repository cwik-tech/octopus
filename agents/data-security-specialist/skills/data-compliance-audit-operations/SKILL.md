---
name: data-compliance-audit-operations
description: >
  Produce audit-ready evidence for GDPR, HIPAA, or SOC 2 data controls, query platform audit logs, and operate data-subject access and deletion requests. Use when collecting compliance evidence, querying Databricks system.access.audit or Microsoft Purview audit logs, defining audit log retention, or handling a GDPR erasure, access, or deletion request against data platform tables.
---

# Data Compliance Audit Operations

## Outcome

Every claimed control has a stored evidence artifact produced from the platform's own audit data, and every data-subject request has a traceable, completed execution record.

## Evidence thinking

Auditors do not accept "we have encryption." For each control claim, produce one evidence artifact containing: the control statement, the exact query or API call, the timestamped raw output, the scope (workspace, catalog, tenant, date range), and the reviewer. Store artifacts outside the audited system so they survive an incident. Never include raw personal data or secrets in evidence — record counts, principals, and configuration, not values.

Framework anchors: GDPR (Regulation (EU) 2016/679), HIPAA Security Rule (45 CFR Parts 160 and 164, administrative/physical/technical safeguards), SOC 2 (AICPA Trust Services Criteria — security, availability, confidentiality). Map each claim to a criterion before collecting evidence.

## Setup

- Databricks audit logs live in the system table `system.access.audit` (columns include `event_time`, `user_identity.email`, `service_name`, `action_name`, `request_params`, `response`). Access requires privileges on the system catalog — an account admin grants `USE CATALOG`/`USE SCHEMA`/`SELECT` on `system.access`. Most logs are regional to the workspace; account-level events record `workspace_id = 0`. Some events (for example `runCommand`) require verbose audit logs enabled on the workspace.
- Fabric user activities are logged to the Microsoft Purview audit log. Search it in the Purview portal (requires the Audit Logs role in Exchange Online) or via Exchange Online PowerShell (`Connect-ExchangeOnline`, then `Search-UnifiedAuditLog`). Data-plane access to OneLake additionally requires OneLake diagnostics to be enabled into a lakehouse.
- Never log protected values in your own queries or artifacts; audit trails must record access events, not the data itself.

## Audit queries

Read-only. Run in a SQL warehouse with system table access:

```sql
-- Who accessed a sensitive table in the last 7 days
SELECT user_identity.email AS user,
       IFNULL(request_params.full_name_arg, request_params.name) AS table_name,
       action_name, event_time
FROM system.access.audit
WHERE (request_params.full_name_arg = :table_full_name
       OR (request_params.name = :table_name
           AND request_params.schema_name = :schema_name))
  AND action_name IN ('createTable', 'getTable', 'deleteTable')
  AND event_date > now() - interval 7 day
ORDER BY event_time DESC;
```

```sql
-- Every permission change in the account
SELECT event_time, user_identity.email, request_params.securable_type,
       request_params.securable_full_name, request_params.changes
FROM system.access.audit
WHERE service_name = 'unityCatalog' AND action_name = 'updatePermissions'
ORDER BY event_time DESC;
```

```powershell
# Fabric/Purview: export a date-bounded audit slice for evidence
Search-UnifiedAuditLog -StartDate 2026-08-01 -EndDate 2026-08-31 `
  -RecordType PowerBI -ResultSize 5000 | Export-Csv evidence-fabric-aug.csv
```

## Retention

Record where each audit stream lives and how long it persists: `system.access.audit` retention depends on system table policy; Purview audit retention depends on the organization's audit retention policies; OneLake diagnostics persist in the lakehouse you configured. Verify the actual configured retention and state it in the evidence artifact — never assume a default satisfies the framework's requirement.

## Data-subject request procedure

1. Intake: record requester identity, verified identity proof, request type (access, rectification, erasure), legal deadline, and owner.
2. Locate: find the subject's data across catalogs, schemas, tables, exports, and derived datasets using classification tags and audit queries (`Which tables did a user access recently?` on `system.access.audit` is a starting pattern).
3. Execute: for erasure, delete the rows, then handle Delta time travel — historical files still hold the data until `VACUUM` with a reduced retention or a rewrite; table clones must be handled separately. In Fabric, delete at the OneLake item level and check downstream semantic models and exports. Deletion is destructive — confirm scope, identity verification, and legal-hold status, and get explicit user approval before running any `DELETE` or `VACUUM`.
4. Verify: re-run the locate queries and confirm zero remaining rows in scope.
5. Close: append the execution record (who, what, when, verification result) to the request log without storing the subject's data in it.

## Workflow and permission boundaries

- Inspect and evidence collection are read-only (`SELECT` on system tables, Purview search) — run freely.
- Enabling verbose audit logs, changing retention, and enabling OneLake diagnostics are configuration changes — propose, then get approval.
- Deletions and `VACUUM` are destructive and gated as above.
- Least privilege: grant the auditor identity `SELECT` on `system.access` only; it must not need table `SELECT` on the data being audited.

## Troubleshooting

- Query returns no events: wrong region (most audit logs are workspace-regional), or the event needs verbose audit logs enabled — check both before concluding no activity occurred.
- `system.access` not visible: the identity lacks grants on the system catalog — an account admin must grant them; workspace admin alone is not enough.
- Fabric activity missing from Purview: the search window predates the retention policy, or the caller lacks the Exchange Online Audit Logs role.
- Permission changes not attributed: `user_identity.email` may be null for service principal actions — check `identity_metadata` (`run_by`/`run_as`) and `request_params`.
- Erasure still visible downstream: a derived table, clone, cache, or exported file retains the data — repeat the locate step across clones and non-production.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package; the skill works without them.

- `../../references/evidence-citation-guide.md`
- `../../references/security-control-baseline.md`

## References

- Databricks audit log system table and sample queries: https://docs.databricks.com/en/admin/system-tables/audit-logs.html
- Track user activities in Fabric (Purview audit log, PowerShell): https://learn.microsoft.com/en-us/fabric/admin/track-user-activities
- GDPR full text (Regulation (EU) 2016/679): https://eur-lex.europa.eu/eli/reg/2016/679/oj
- HIPAA Security Rule (HHS): https://www.hhs.gov/hipaa/for-professionals/security/index.html

## Completion check

Each claimed control has an evidence artifact with query, timestamped output, scope, and reviewer; audit retention is stated from configuration, not assumed; and the latest data-subject request shows a completed locate-execute-verify-close record.
