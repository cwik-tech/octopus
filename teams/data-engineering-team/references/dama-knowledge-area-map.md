# DAMA-DMBOK Knowledge-Area Map

## Provenance

This map records the chapter anchors supplied in the team-creation brief for *DAMA-DMBOK, 2nd edition* (2017). The source PDF was reported as truncated in the original chat context. Treat these as navigation anchors, not verified quotations or page-level citations. Check the source PDF before citing chapter language or claiming direct documentary support.

## Agent grounding

| Agent | Brief-supplied anchors | Primary assessment targets | Boundaries |
|---|---|---|---|
| Data Engineering Lead | Cross-cutting knowledge-area coordination | Requirements, topology, ownership, decisions, integrated review | Escalates detailed governance, legal, privacy, and security work |
| Data Pipeline Engineer | Chapter 6 Storage and Operations; Chapter 8 Integration and Interoperability; Chapter 14 Big Data and Data Science | Pipeline topology, ingestion mode, transformation, storage interaction, deployment, monitoring | Does not own enterprise governance operating models or legal interpretation |
| Data Modeling and Metadata Engineer | Chapter 5 Modeling and Design; Chapter 12 Metadata Management; Chapter 10 Reference and Master Data | Model fitness, naming, contracts, metadata, lineage, identity, reference-data implications | Does not own a business-wide MDM program unless requested |
| Data Quality and Reliability Engineer | Chapter 13 Data Quality; Chapter 6 auditing and validation; Chapter 11 SLAs and user acceptance | Rules, profiling, monitoring, SLOs, failure handling, remediation | Does not perform infrastructure cybersecurity or regulatory audits |

## Consolidation rationale

- Integration, storage operations, and large-scale processing form one pipeline-engineering responsibility.
- Modeling, metadata, lineage, identity, and reference-data implications form one coherent semantic-design responsibility.
- Data quality and operational reliability share the same measurable controls, response paths, and consumer outcomes.
- Governance, security, privacy, and change management are cross-cutting constraints. Add a specialist when screening is insufficient.

## Currency rule

DAMA-DMBOK supplies durable management concepts. Product capabilities, cloud services, pricing, limits, security controls, and tool syntax change independently and require current primary vendor evidence.
