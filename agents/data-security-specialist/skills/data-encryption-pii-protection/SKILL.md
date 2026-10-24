---
name: data-encryption-pii-protection
description: >
  Protect sensitive data with encryption at rest and in transit, customer-managed keys, column masking, tokenization, and PII discovery and classification. Use when masking or encrypting PII columns, verifying TLS or customer-managed key configuration, applying Databricks row filters, column masks, or dynamic views, or configuring Microsoft Fabric OneLake column-level security.
---

# Data Encryption and PII Protection

## Outcome

Every sensitive column is classified, and its protection (encryption, mask, filter, or tokenization) is proven by querying the platform as a restricted identity — not asserted from a design document.

## Setup

Databricks: CLI and auth as in the access control skill (`DATABRICKS_HOST` plus OAuth env vars; never write tokens or data values into files, prompts, logs, or artifacts). Fabric: Entra token for scope `https://api.fabric.microsoft.com/.default`.

Feature availability checks before relying on a feature:

- `databricks --version` — CLI 1.0.0+ is GA; legacy CLI (0.18 and below) is unsupported.
- Row filters and column masks require Databricks Runtime 12.2 LTS or above; older runtimes fail securely (no data returned). Dedicated (single-user) compute needs Runtime 15.4 LTS+ and serverless enabled.
- Fabric OneLake security is deny-by-default and applies mainly to Viewers or users with item Read permission — Admin, Member, and Contributor bypass it.

## Method

1. Discover PII before choosing controls. In Databricks, enable Data Classification on the catalog (requires catalog ownership or `MANAGE`; needs serverless compute) to auto-classify and tag sensitive columns. In Fabric, use Purview Information Protection sensitivity labels.
2. Classify each field (public / internal / confidential / restricted) with an owner; tags drive ABAC policies.
3. Encryption at rest: confirm platform default encryption covers data, logs, exports, and temp storage. Add a customer-managed key only where required — Databricks separates CMK for managed services (control plane, notebooks, secrets) from CMK for workspace storage; Fabric applies CMK per workspace via the "Apply customer-managed keys" tenant setting.
4. Encryption in transit: require TLS 1.2+. Fabric and Databricks endpoints enforce TLS 1.2 and negotiate TLS 1.3. Verify from the client side:

```bash
openssl s_client -connect <workspace-host>:443 -tls1_2 </dev/null 2>/dev/null \
  | grep -E 'Protocol|Cipher'
```

5. Choose the column-level pattern:
   - **Column mask / row filter** (Databricks): a SQL UDF bound with `ALTER TABLE ... ALTER COLUMN ... SET MASK` / `SET ROW FILTER`. Table-specific; for consistent rules across many tables use ABAC policies on governed tags.
   - **Dynamic view** (Databricks): a view over the base table gated by `is_account_group_member()`, exposing a redacted slice to users who have no access to the base table.
   - **OneLake security CLS/RLS** (Fabric): column and row constraints inside data access roles on the item.
   - **Tokenization**: replace the value with an irreversible token at ingestion; keep the mapping in a separate, more tightly controlled store. Use when even privileged readers of the main store must never see the raw value.

```sql
-- Databricks: bind a mask to a column
CREATE FUNCTION mask_email(email STRING) RETURNS STRING
RETURN CASE WHEN is_account_group_member('auditors') THEN email
            ELSE regexp_extract(email, '^.*@(.*)$', 1) END;
ALTER TABLE catalog.schema.users ALTER COLUMN email SET MASK mask_email;
```

6. Propagate: confirm downstream views, clones, exports, caches, and non-production copies inherit or re-apply the protection. Deep/shallow clones are not supported on tables with row filters or column masks — plan the masked-copy path explicitly.

## Verify the control actually works

Read-only; run after any change:

```sql
-- Who can read the table at all
SHOW GRANTS ON TABLE catalog.schema.users;
```

```sql
-- Classification tags present on the column
SELECT catalog_name, schema_name, table_name, column_name, tag_name, tag_value
FROM system.information_schema.column_tags
WHERE table_name = 'users';
```

- Query the masked column as a non-privileged principal and confirm the output is redacted. Querying as the table owner proves nothing — owners see raw values.
- Confirm a `SELECT *` from a user outside the allowed group returns masked values and filtered rows, and that query results, not just the table definition, reflect the control.

## Mutating operations — gated

Creating or dropping masks, filters, dynamic views, and OneLake data access roles, and rotating or disabling keys, are mutating. Show the exact `ALTER TABLE` or API payload, name who loses raw access, get explicit user approval, then verify with the checks above. Keep the previous definition so the mask can be restored as rollback. Disabling or deleting a customer-managed key can make data unreadable — never execute without an explicit, informed approval.

## Troubleshooting

- Mask seems ignored: you queried as the owner or an exempted principal — test with a real restricted identity.
- Runtime too old: row filters and column masks silently return no data on Runtime below 12.2 LTS; check the cluster or warehouse runtime first.
- Mask UDF type mismatch: a `STRING` column passed to an `INT` parameter is silently cast to `NULL` with ANSI mode off, which can invert the filter; enable `spark.sql.ansi.enabled=true` to fail loudly.
- `MERGE`/`UPDATE` fails on a masked table: filters or masks with nesting, aggregates, or non-deterministic functions block DML — simplify the UDF.
- Fabric viewers still see raw data: they hold Member or Contributor workspace role, which bypasses OneLake security — demote to Viewer and grant via a data access role.
- CMK change did not apply: Databricks CMK for managed services requires the Enterprise tier; Fabric CMK requires the tenant setting enabled.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package; the skill works without them.

- `../../references/security-control-baseline.md`
- `../../templates/dataset-specification.md`

## References

- Databricks row filters and column masks (syntax, runtime limits): https://docs.databricks.com/aws/en/data-governance/unity-catalog/filters-and-masks/
- Databricks dynamic views: https://docs.databricks.com/aws/en/views/dynamic
- Databricks Data Classification (PII discovery): https://docs.databricks.com/aws/en/data-governance/unity-catalog/data-classification
- Databricks customer-managed keys: https://docs.databricks.com/en/security/keys/customer-managed-keys.html
- Fabric OneLake security (encryption, CLS/RLS, CMK): https://learn.microsoft.com/en-us/fabric/onelake/onelake-security
- Fabric information protection (sensitivity labels): https://learn.microsoft.com/en-us/fabric/governance/information-protection

## Completion check

A restricted identity querying the protected table receives masked values and filtered rows, classification tags or labels exist for every known PII column, and TLS and at-rest encryption (plus CMK where required) are verified from the client and platform configuration.
