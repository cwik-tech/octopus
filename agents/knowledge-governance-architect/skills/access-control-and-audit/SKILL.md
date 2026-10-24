---
name: access-control-and-audit
description: Access control propagation and audit trail — enforces source ACLs at query time, validates permission boundaries, maintains lineage, tracks citations, and logs access for compliance
---

# Access Control and Audit

## Purpose

Propagation source access control through the retrieval layer and maintain an auditable lineage for every citation. If a user cannot access a document in the source system, they cannot retrieve it through the knowledge base. If a document is retrieved, the citation must be traceable to its source. These are non-negotiable security and governance requirements.

This skill owns permission enforcement, lineage tracking, and audit compliance.

## When to Use

- Before production handover: test permission boundaries end-to-end
- Continuously: audit retrieval access logs for violations
- Quarterly: comprehensive permission-boundary re-test
- On incidents: investigate access violations or citation failures
- On source ACL changes: verify propagation to retrieval filters
- On compliance audits: provide lineage reports and access logs

## How to Use

### 1. Permission Architecture

Every document in the knowledge base comes with source ACL metadata:

```
document_id: "doc_12345"
source_uri: "https://sharepoint.company.com/sites/products/Product%20Spec.docx"
source_owner: "alice@company.com"
source_acl: ["alice@company.com", "eng-team@company.com", "product-council@company.com"]
acl_update_timestamp: "2026-08-20T14:32:00Z"
```

When an agent or user queries the knowledge base, the retrieval service must filter results:

1. **Retrieve candidate chunks** using semantic search, lexical search, reranking.
2. **Filter by ACL:** for each returned chunk, check the source document's ACL. Only return chunks from documents the querying user has permission to access.
3. **Log the access:** (see Audit Trail section below).
4. **Return filtered results:** if all chunks are filtered out, abstain (return zero results or a "not found" message, not a permission-denied error that leaks the existence of the document).

**Implementation:**

- Store source_acl and acl_update_timestamp in the metadata index (alongside chunk text and embeddings).
- At query time, resolve the querying user's identity (from authentication/authorization layer).
- For each candidate chunk, check if user ∈ chunk.source_acl.
- Return only filtered chunks.

**ACL updates:**

When a source document's ACL changes in SharePoint, the knowledge base must detect and propagate the change:

- **Detect:** during incremental sync, fetch source document ACLs; check if they have changed since the last sync.
- **Propagate:** update metadata for all chunks from that source; do NOT re-parse the document (only metadata changes).
- **Validate:** test permission boundaries immediately after ACL changes.

### 2. Permission-Boundary Testing

Before going to production and quarterly thereafter, run automated permission-boundary tests.

**Test design:**

For each document in the knowledge base:

1. **Identify a test user who should NOT have access** (use a test account with no special permissions; or create an ACL that explicitly excludes them).
2. **Query the knowledge base** with a question that would retrieve that document if permissions were not enforced (e.g., search for a unique phrase from the document).
3. **Verify that the document is NOT returned:** if the test user successfully retrieves the document, permissions are leaking.
4. **Repeat for each document category** (high-confidentiality, team-specific, archived, etc.).

**Test harness:**

```
for each document_d in knowledge_base:
  test_user = select_unprivileged_user_for(d)
  results = query_knowledge_base(unique_phrase_from(d), user=test_user)
  assert document_d NOT in results, f"SECURITY VIOLATION: test_user retrieved {d}"
```

**Execution:**
- Before production handover: run against entire corpus (100% coverage).
- Quarterly: run against a random sample (10–20% of corpus).
- After ACL changes: run tests for affected documents.
- After permission-filter code changes: run full suite.

**Escalation:**
If any test fails, it is a security violation. Stop retrieval service; investigate; fix. Do not proceed until the issue is resolved.

### 3. Lineage Tracking

Every citation returned from the knowledge base must be traceable to its authoritative source. Lineage has five layers:

**Layer 1: Citation (what the agent got)**
```
Passage retrieved by knowledge base:
"The product must operate within 15–25°C per spec section 3.2."
Internal citation ID: chunk_uuid = "5f3e2d1a-9c0b-4e2f-8f3d-1b7c8e2f4a9d"
```

**Layer 2: Chunk metadata (where it came from)**
```
chunk_metadata:
  chunk_id: "5f3e2d1a-9c0b-4e2f-8f3d-1b7c8e2f4a9d"
  document_id: "doc_12345"
  markdown_file: "products/thermal-spec-v3.md"
  heading_path: "## Thermal Requirements / ### Operating Range"
  char_offset: [2048, 2150]
  parser_version: "v2.1.0"
  parse_timestamp: "2026-08-15T10:45:00Z"
```

**Layer 3: Markdown (authoritative internal representation)**
```
Markdown excerpt from products/thermal-spec-v3.md:
---
markdown_id: "doc_12345"
source_uri: "https://sharepoint.company.com/sites/products/ThermalSpec_v3.docx"
source_revision: "rev12345"
source_owner: "therm-eng@company.com"
source_acl: ["therm-eng@company.com", "product-council@company.com"]
---

## Thermal Requirements

### Operating Range
The product must operate within 15–25°C per spec section 3.2.
```

**Layer 4: Parser metadata (how it was converted)**
```
Parser run for https://sharepoint.company.com/sites/products/ThermalSpec_v3.docx:
  parser_type: "docx_converter"
  parser_version: "v2.1.0"
  run_timestamp: "2026-08-15T10:45:00Z"
  source_content_hash: "md5:abc123def456"
  markdown_content_hash: "md5:xyz789uvw012"
  is_deterministic: true
```

**Layer 5: Source (original authority)**
```
SharePoint document: ThermalSpec_v3.docx
  URI: https://sharepoint.company.com/sites/products/ThermalSpec_v3.docx
  Revision ID: rev12345
  Last modified: 2026-08-10T14:30:00Z
  Owner: therm-eng@company.com
  ACL: ["therm-eng@company.com", "product-council@company.com"]
```

**Citation format:**

When an agent cites a passage, return all five layers:

```json
{
  "citation": "The product must operate within 15–25°C per spec section 3.2.",
  "chunk_id": "5f3e2d1a-9c0b-4e2f-8f3d-1b7c8e2f4a9d",
  "document_id": "doc_12345",
  "markdown_file": "products/thermal-spec-v3.md",
  "heading_path": "## Thermal Requirements / ### Operating Range",
  "source_uri": "https://sharepoint.company.com/sites/products/ThermalSpec_v3.docx",
  "source_revision": "rev12345",
  "source_owner": "therm-eng@company.com",
  "parser_version": "v2.1.0",
  "parse_timestamp": "2026-08-15T10:45:00Z",
  "source_modified": "2026-08-10T14:30:00Z"
}
```

**Validation:**
- Every returned citation must include all five layers.
- The source_uri must be resolvable and match the current source revision.
- The char_offset must point to the exact text in the source.
- The heading_path must match the document structure.
- If lineage breaks at any layer, the citation is untrustworthy — do not return it.

### 4. Audit Trail

Log every retrieval access for compliance and security.

**Audit log format:**

```json
{
  "timestamp": "2026-08-21T09:15:32.456Z",
  "user_id": "user_789",
  "user_identity": "bob@company.com",
  "query_id": "q_12345",
  "query_text": "operating temperature range",
  "results_count": 3,
  "results_filtered_by_acl": 1,
  "returned_documents": [
    "doc_12345",
    "doc_67890"
  ],
  "filtered_documents": [
    "doc_54321"
  ],
  "retrieval_latency_ms": 1240,
  "retrieval_model": "hybrid+reranker",
  "status": "success"
}
```

**Optional: Access-denied log:**

```json
{
  "timestamp": "2026-08-21T09:17:05.123Z",
  "user_id": "user_999",
  "user_identity": "eve@company.com",
  "query_id": "q_12346",
  "query_text": "confidential roadmap",
  "results_count": 0,
  "all_results_filtered_by_acl": true,
  "documents_in_knowledge_base_matching_query": 2,
  "user_acl_coverage": 0,
  "status": "no_results_permission_denied"
}
```

**Retention:**
- Audit logs must be retained for ≥ 1 year.
- Do not overwrite or delete logs; archive to cold storage after 90 days.
- Logs must be tamper-evident (signed, stored immutably, or in append-only storage).

**Analysis:**
- Monthly: query audit logs for access-denied patterns (e.g., repeated attempts to access restricted content by the same user).
- Monthly: compute per-user retrieval statistics (most frequently retrieved topics, retrieval patterns).
- Quarterly: search logs for anomalies (e.g., after-hours access, high-volume queries, unusual queries).

### 5. Incident Response

When a permission or lineage issue is discovered:

**Access violation (user successfully retrieved restricted document):**
1. **Stop:** disable the affected user's retrieval access immediately.
2. **Investigate:** review audit logs; identify all documents the user accessed that they should not have had permission for; determine the root cause (ACL filter misconfigured, ACL stale, permission check bypassed).
3. **Notify:** data owners of the affected documents; governance owner; security team.
4. **Fix:** update ACL metadata, fix filter code, re-run permission-boundary tests.
5. **Audit:** verify that all unauthorized retrievals have been identified; assess if the issue affected other users.
6. **Remediate:** restore user access only after fix is verified and root cause is understood.

**Lineage failure (citation cannot be traced to source):**
1. **Flag:** do not return the citation to the agent; log the failure.
2. **Investigate:** check chunk metadata (is document_id valid?); check markdown file (does it exist?); check source URI (is it resolvable?); check parser metadata (was the parser version valid?).
3. **Assess:** is this a single corrupted chunk (re-parse the document) or a systemic issue (indexing failed, storage corruption)?
4. **Repair:** re-ingest the affected document; re-run chunk validation; re-test retrieval quality.
5. **Prevent:** add validation gates to the ingestion pipeline to catch broken lineage before index time.

## Rules

1. Source ACLs must be enforced at query time; never relax permissions at the retrieval layer.
2. Every citation must be traceable through all five lineage layers to the authoritative source.
3. Permission-boundary tests must pass 100% before production handover and quarterly thereafter.
4. Audit logs must be retained for ≥ 1 year and be tamper-evident.
5. Any access violation is a security incident; investigate immediately.
6. Any lineage failure is a data-integrity incident; do not return the citation.
7. ACL updates must be detected and propagated within 24 hours of source change.
8. Do not leak document existence through error messages; return empty results for denied access.