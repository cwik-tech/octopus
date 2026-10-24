---
name: retrieval-api-contract-specification
description: Specifying the agent-facing retrieval API surface, filters, response format, citation semantics, and confidence signals before agent integration.
---

# Retrieval API Contract Specification

## Purpose

Define the retrieval interface that agent teams will consume. Specify query parameters, response format, filter semantics, citation requirements, confidence signals, and error handling. Lock this contract *before* agents start integrating—changing it mid-flight breaks agent code and evaluation.

## When to Use

- Finalizing retrieval architecture before agent integration begins
- Designing the contract agents will depend on
- Specifying citation, confidence, and error semantics
- Before agents are built against the retrieval interface

## Core Contract Elements

### 1. Query Surface

What parameters can agents pass?

```
POST /retrieve
{
  "query": "string",           // Natural language question
  "top_k": integer,            // Number of results to return (default: 10, max: 50)
  "filters": {                 // Optional metadata filters
    "document_type": ["spec", "sop", "design"],  // Filter by type
    "product_category": ["module_x"],             // Filter by domain
    "language": ["en"],                           // Filter by language
    "lifecycle_state": ["approved", "current"]    // Exclude deprecated
  },
  "confidence_threshold": float // Minimum confidence to return (default: 0.0)
}
```

Decide:
- Is `confidence_threshold` an agent-tunable parameter, or fixed by the API?
- Which filters are mandatory vs. optional?
- What's the maximum `top_k`? (Prevent resource exhaustion; typical: 50 max)
- Can agents request explanations for why a passage ranked high?

### 2. Response Format

What does retrieval return?

```json
{
  "results": [
    {
      "passage_id": "doc_abc_chunk_5",     // Unique chunk ID
      "text": "...",                         // Passage text
      "source": {
        "document_id": "doc_abc",
        "document_name": "Design Spec v2.1",
        "url": "https://sharepoint/.../doc_abc",
        "revision": "2.1"
      },
      "location": {
        "heading_path": "# Design > ## Thermal > ### Cooling System",
        "page": 3,
        "section": "2.1.4"
      },
      "score": 0.87,                        // Relevance score (0–1)
      "score_breakdown": {                  // Optional: help agents understand ranking
        "lexical": 0.75,
        "semantic": 0.92,
        "reranker": 0.87
      }
    }
  ],
  "metadata": {
    "query": "How does thermal management work?",
    "filters_applied": {"lifecycle_state": ["approved"]},
    "results_count": 5,
    "total_available": 17,  // How many results *would* match without top_k
    "latency_ms": 145,
    "retrieval_strategy": "hybrid_dense_lexical_reranked"
  }
}
```

Decide:
- Is `score_breakdown` necessary, or just final `score`?
- Should agents see `total_available` (useful for understanding coverage)?
- Include `retrieval_strategy` in response? (Helps with debugging/monitoring)
- What if no results match? Return `[]` or error?

### 3. Citation Format

**Critical:** Define how agents cite sources.

FST convention:
```
According to the Design Specification (v2.1, section 2.1.4), the thermal management system...

[Citation: Design Spec v2.1, section 2.1.4 - https://sharepoint/.../doc_abc#page=3]
```

Specify:
- **Inline citation format:** How agents should present the source in text
- **Footnote/link format:** Full citation with URL, revision, locator
- **Verification contract:** A human should be able to follow the citation URL, find the document revision, navigate to the section, and verify the passage

### 4. Filter Semantics

If filters are supported, specify their behavior:

| Filter | Values | Semantics | Examples |
|---|---|---|---|
| `document_type` | `["spec", "sop", "manual", "design"]` | OR within filter (type A **or** type B); AND across filters (type A **and** approved state) | "retrieval/design OR retrieval/spec" |
| `product_category` | Per-FST catalog | Return passages only from these domains | "Module X OR Module Y" |
| `language` | `["en", "de", "ja"]` | Only passages in these languages | Default: EN only |
| `lifecycle_state` | `["approved", "current", "deprecated"]` | Exclude deprecated by default | "current AND approved" |

Default behavior: If no filter specified, what's the default? (E.g., "approved only" vs. "all documents")

### 5. Confidence Signals

How do agents decide when retrieval failed?

**Option A: Raw scores**
- Agent interprets the relevance score (0–1). Agent sets own threshold for abstention.
- Simple, but agents need to tune thresholds per use case.

**Option B: Confidence categorization**
- API returns `confidence: "high" | "medium" | "low"` based on internal thresholds
- API thresholds are tuned on evaluation set; agents trust the categorization
- Simplifies agent code

**Option C: Retrieval success flag + alternative**
- API returns `confident: true/false` and suggests alternative action
- E.g., `{"confident": false, "suggestion": "try broader query", "fallback_results": [...]}`

**Recommendation for FST:** Option B (confidence categorization) because:
- Agents can't reliably interpret raw relevance scores across different document types
- Thresholds should be tuned on your evaluation set, not agent-guessed
- Gives agents a simple decision: "Is confidence high? If yes, use it. If no, escalate."

### 6. Error Handling

What happens when retrieval fails?

- **Query timeout:** If a query takes >2 seconds, return a timeout error or partial results?
- **No results:** Return empty array, or error? Empty is simpler (agent handles naturally).
- **Filter mismatch:** If an agent filters by a product category that doesn't exist, error or just return no results? No results (simpler).
- **Rate limit:** If agent exceeds quota, return 429 with retry-after?

Specify HTTP status codes and error messages:

```json
{
  "error": {
    "code": "QUERY_TIMEOUT",
    "message": "Retrieval query exceeded 2s timeout",
    "retry_after_ms": 5000
  }
}
```

### 7. Rate Limits and Quotas

Specify operational constraints:

| Limit | Value | Rationale |
|---|---|---|
| Queries per second | 10 | Prevent resource exhaustion |
| Queries per month | 100,000 | Budget constraint ($X/month) |
| Results per query | max top_k = 50 | Prevent large responses |
| Query string length | max 2000 chars | Prevent abuse |

Return quota info in response headers:
```
X-RateLimit-Remaining: 9995
X-RateLimit-Reset: 2026-08-22T12:00:00Z
X-MonthlyQuota-Remaining: 97234
```

## Validation Against Evaluation Set

Before finalizing the contract, test it against your evaluation set:

1. **Can agents query for all evaluation questions?** Or do some need filters/parameters the API doesn't support?
2. **Are response citations sufficient for verification?** Can a human verify every citation?
3. **Does confidence signaling match evaluation results?** If evaluation showed Recall@10 of 85%, is the API's confidence level aligned?
4. **Can agents handle no results?** If a question has no match, how does the agent behave?

Example validation:
- Question: "What is the max temp of Module X?"
- Expected answer location: Design Spec v2.1, section 2.1.4
- Query: `{"query": "max temp Module X", "filters": {"document_type": ["spec"]}}`
- Expected response: Top result should be section 2.1.4 with confidence "high"
- Validation: Does it? If not, the API contract needs refinement.

## Anti-Patterns to Avoid

- **Exposing raw vector scores without interpretation:** Agents can't calibrate on scores alone.
- **Making citation optional:** "Some results might not have sources" breaks auditability.
- **Filters that can silently fail:** If a filter matches nothing, agents should know it's a filtering issue, not missing data.
- **Rate limits so tight agents can't function:** Set quotas based on actual agent load, not to force upgrades.
- **Undocumented score semantics:** If score 0.87 means different things for dense vs. lexical matches, agents will misinterpret results.

## Output

A finalized retrieval API contract specifying:

**Overview**
- Purpose: What agents consume this API for
- Query volume and latency requirements
- Evaluation set that validates the contract

**Query Interface**
- HTTP method, endpoint, authentication
- Query parameters (query, top_k, filters, confidence_threshold)
- Allowed values and constraints

**Response Format**
- JSON schema with example responses
- Citation format and verification contract
- Confidence signal interpretation
- Error cases and HTTP status codes

**Filter Semantics**
- Available filters (document_type, category, language, lifecycle_state)
- Default behavior (what happens if no filter specified)
- Combining filters (AND/OR logic)

**Performance Contract**
- Latency SLA (p50, p95)
- Rate limits and quota
- Cost per query

**Validation Results**
- Sample queries from evaluation set
- Response examples
- Citation verification walkthrough

The contract is locked before agent teams integrate. Document it in your API docs. Treat breaking changes as major versioning events.
