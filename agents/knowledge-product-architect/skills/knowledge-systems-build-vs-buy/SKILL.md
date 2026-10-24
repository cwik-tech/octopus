---
name: knowledge-systems-build-vs-buy
description: Evaluate self-managed knowledge systems (ADLS + AI Search + functions + observability) versus platform solutions (M365 Copilot, third-party RAG), with explicit build-vs-buy criteria and cost-benefit analysis
---

# Knowledge Systems Build-vs-Buy Analysis

## Purpose

Drive the critical early decision: should this project build a self-managed knowledge system (Azure ADLS + AI Search + ingestion + observability) or buy a platform solution (M365 Copilot + Graph connectors, third-party RAG services, etc.)? This decision gates all subsequent technical work.

## When to Use This Skill

- **WP1 (Early):** Before any technical work starts, analyze build-vs-buy options and document the decision criteria.
- **Mid-Project Pivot:** If the self-managed approach hits cost, complexity, or timeline friction, revisit the build-vs-buy analysis and recommend a pivot.

## Core Heuristics

**The Duplication Test:** Most knowledge bases already sit in M365 (SharePoint, Teams, OneDrive). M365 Copilot and Graph connectors index this content automatically for RAG-like workflows. Self-build is justified only if:
- The platform does not support the required use cases (e.g., agent runtime integration, custom chunking, fine-grained metadata filtering that Graph connectors don't provide)
- You have measured evidence that platform capabilities are insufficient
- The self-managed cost is materially lower than platform pricing + admin overhead

**The Handover Reality Check:** Self-managed stacks (ADLS + Functions + AI Search + observability) are operationally complex. Who owns it post-pilot? If the answer is "we'll figure that out later," you don't have a buildable project.

**The Cost-Benefit Threshold:** Document the cost of self-build (compute, storage, indexing, monitoring, headcount) and the benefit (faster time-to-insight, custom integration, cost savings, improved quality). If benefit doesn't clearly exceed cost, recommend the platform.

**The Time-to-Pilot Trade-Off:** M365 Copilot can be operationalized in weeks; self-managed stacks take months to secure, deploy, and validate. If time-to-pilot is critical, bias toward platform.

## Build-vs-Buy Framework

### Platform Solution (M365 Copilot + Graph Connectors)

**Advantages:**
- Content already in SharePoint/Teams; minimal parsing or migration
- Fine-grained access control (ACLs) propagated automatically via Entra ID
- Included with M365 licenses; no additional compute infrastructure
- Microsoft support; no operational burden on FST team
- Fast path to pilot (weeks)

**Disadvantages:**
- Limited control over chunking and embedding strategies
- Pricing model tied to M365 licensing (opaque per-query cost)
- Integration with non-M365 data sources requires additional connectors
- Less transparency into retrieval quality and citation mechanics

**When to recommend:**
- Most FST knowledge lives in SharePoint/Teams
- Time-to-pilot is critical
- Custom parsing/chunking is not a blocker
- Operational simplicity is valued over technical control

### Self-Managed Stack (ADLS + AI Search + AI Functions + OpenAI)

**Advantages:**
- Full control over parsing, chunking, and metadata schema
- Custom integration with FST systems (agents, data pipelines, workflows)
- Measurable per-query cost and usage (potential optimization)
- Flexibility to swap components (embeddings, ranking, inference)
- Better observability for retrieval quality and failure modes

**Disadvantages:**
- High operational complexity: ingestion, indexing, monitoring, cost management
- Upfront engineering work: parsing pipeline, evaluation harness, security hardening
- Requires FST team ownership and runbooks (not plug-and-play)
- Longer time-to-pilot (3–6 months)
- Azure infrastructure cost; ongoing monitoring and optimization
- Duplicates work M365 already does (if content is in SharePoint)

**When to recommend:**
- Knowledge is distributed across multiple formats/sources (not just SharePoint)
- Custom chunking (e.g., technical tables, diagrams, section boundaries) is critical
- FST has the operational capacity to own the stack
- Measurable retrieval quality is a hard requirement (and platform opacity is a blocker)
- Direct agent-runtime integration is required
- Time-to-pilot flexibility exists (3–6 months acceptable)

## Build-vs-Buy Criteria Checklist

**Scope & Scale:**
- [ ] Where does knowledge live? (SharePoint, file shares, databases, systems)
- [ ] What languages/regions? (M365 support scope, encoding requirements)
- [ ] How many documents? (Platform throughput limits, ingestion cost)
- [ ] Update frequency? (Real-time sync, batch, manual)

**Technical Requirements:**
- [ ] Do agents need custom chunking/metadata filtering? (platform limitation)
- [ ] Must retrieval citations be verifiable at document fragment level? (platform opacity)
- [ ] Is multimodal retrieval (images, diagrams) required? (platform gap)
- [ ] Must the retrieval API integrate with custom agent frameworks? (platform integration cost)

**Access & Governance:**
- [ ] Are FST ACLs complex (nested groups, time-based, per-document)? (M365 propagates; self-build requires effort)
- [ ] Is confidential content mixed with public? (platform supports per-document marking; self-build requires access-control layer)
- [ ] Are there audit/compliance requirements? (M365 audit logging; self-build requires instrumentation)

**Operational Capacity:**
- [ ] Does FST have a named team to own ingestion, monitoring, cost management? (If no, recommend platform)
- [ ] Can FST hire/dedicate engineering for 3–6 months + ongoing ops? (If no, recommend platform)
- [ ] Is observability and alerting a known capability? (Self-build requires this; platform provides limited visibility)

**Cost & Timeline:**
- [ ] What is the M365 licensing baseline (already paying)? (Self-build cost must beat this + admin overhead)
- [ ] What is acceptable time-to-pilot? (Weeks vs. months)
- [ ] What is the long-term cost model (per-query, per-document, per-month)? (Verify break-even)

## Decision Template

**Build-vs-Buy Recommendation: [PLATFORM | SELF-MANAGED | HYBRID]**

**Rationale:**
- Scope: [Knowledge lives in X; scale is Y]
- Technical justification: [Platform suffices / Platform gap is Z]
- Operational readiness: [FST has / lacks Y]
- Time-to-pilot: [X weeks platform | Y months self-managed]
- Cost-benefit: [Platform = $X/year | Self-managed = $Y/year; net benefit = $Z]

**Go/No-Go:**
- [PROCEED with platform] OR [PROCEED with self-managed] OR [REVISIT if X changes]

**Fallback:**
- If self-managed cost/timeline exceeds X, pivot to platform
- If platform capabilities prove insufficient, escalate