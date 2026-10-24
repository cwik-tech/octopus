---
name: rag-framework-assessment
description: Compares RAG frameworks (LangChain, LlamaIndex, Haystack) on completeness, integration surface, maintainability, and team operational capacity.
---

# RAG Framework Assessment

## Purpose

Select a RAG framework that is feature-complete for FST use cases, integrates cleanly with your chosen embedding model and vector store, is maintainable by your team, and doesn't hide operational complexity behind abstraction layers. The framework is where retrieval, ranking, and generation logic live; choose one that your team can debug and extend without vendor lock-in.

## Evaluation dimensions

### 1. Feature completeness

For FST knowledge-base use cases, test whether each framework supports:

- **Hybrid retrieval:** dense vector + BM25 lexical search in a single query. Can you weight dense vs. lexical results? Can you combine them without stitching multiple services together?
- **Metadata filtering:** pass filter conditions to the retriever ("product category = X, lifecycle state = approved") without retrieving all vectors and filtering in-app.
- **Reranking integration:** does the framework have built-in support for a reranker (e.g., Cohere rerank, CrossEncoder)? Or must you write custom code to call it?
- **Citation and chain-of-thought tracking:** does the framework make it easy to trace agent output back to source passages and document IDs? Can you inspect the retrieved context at each step?
- **Streaming support:** agents need to respond incrementally ("start talking while still retrieving"). Does the framework support streaming without rewriting the entire pipeline?
- **Async support:** can the framework handle concurrent retrieval requests, or will it block on I/O?
- **Graceful degradation:** what happens when retrieval finds no results? Does the framework abstain or hallucinate? Is the behavior configurable?

### 2. Integration points

- **Vector store support:** does the framework have first-class connectors for Pinecone, Weaviate, Milvus, pgvector? Or are you writing custom code to call the vector store API?
  - Test: try retrieving with metadata filters and reranking in one pipeline. Is it a one-liner or 50 lines of glue?
- **Embedding model flexibility:** can you swap OpenAI embeddings for Cohere or a fine-tuned model without rewriting the retrieval code?
- **LLM provider flexibility:** does the framework support OpenAI, Anthropic, open-source models, and self-hosted LLMs? Or is it tied to one provider?
- **Agent framework compatibility:** you're likely using the Anthropic SDK, LangChain agents, or AutoGen for the agent layer. Does your RAG framework integrate cleanly, or do you hand off retrieved context as plain strings?
- **Observability:** can you hook logging, tracing (e.g., LangSmith, OpenTelemetry) into the retrieval pipeline without forking the codebase?

### 3. Code maintainability

- **API stability:** what's the major version? How often are there breaking changes (check GitHub releases for the last 12 months)? Is the API stable enough that your team won't spend time on migrations?
- **Documentation:** are there working examples for your use case (knowledge base + hybrid retrieval + citation tracking)? Is the docs kept in sync with the code, or are examples outdated?
- **Community activity:** what's the GitHub issue response time? How many unresolved issues are there? Is the project actively maintained, or is it in maintenance mode?
- **Code readability:** try reading the source code (or at least a simple example). Is it clear enough that you could debug production issues?

### 4. Operational burden

- **Infrastructure knowledge required:** does operating this framework require understanding vector stores, embeddings, reranking, or can a standard backend engineer handle it? (High barrier = higher risk.)
- **Local development:** can you run the full RAG pipeline locally for testing, or is it cloud-only? Debugging production issues is harder without local parity.
- **Error handling:** how does the framework surface errors? Can you catch and retry failed retrievals, or do errors propagate opaquely?
- **Performance tuning:** when latency becomes an issue, does the framework expose knobs to tune (batch size, timeout, ranking threshold), or are you stuck with defaults?
- **Dependency footprint:** how many external dependencies does the framework pull in? Fewer = less surface area for supply-chain risk and version conflicts.

### 5. Vendor risk

- **Maintainer:** who maintains the framework? LangChain (LangChain Inc.), LlamaIndex (LlamaIndex Inc.), Haystack (Deepset)? Vendor-backed frameworks are more stable; community frameworks may disappear.
- **Funding and roadmap:** is there commercial backing? Does the roadmap align with your requirements (e.g., agent-RAG integration, multimodal retrieval)?
- **Commercial support:** is there paid support, or are you on the community roadmap for bug fixes?
- **Lock-in:** can you extract the context and prompts from the framework without rewriting, if you need to switch later?

### 6. Comparison matrix

Build a table like the one below. Weight features by importance to FST use cases (e.g., citation tracking is critical; streaming is optional).

| Dimension | LangChain | LlamaIndex | Haystack |
|---|---|---|---|
| **Hybrid retrieval** | Partial (BM25 separate) | Yes (fusion retrievers) | Yes (native) |
| **Metadata filtering** | Yes (via LangChain retrievers) | Yes | Yes |
| **Reranking integration** | Partial (custom code) | Yes (RerankFusion) | Yes (native) |
| **Citation tracking** | Medium (store metadata) | Excellent (response_metadata) | Good (source tracking) |
| **Streaming** | Yes | Yes | Yes |
| **Async support** | Yes | Yes | Yes |
| **Vector store integrations** | Pinecone, Weaviate, Milvus | Pinecone, Weaviate, Milvus, Neo4j | Weaviate, Milvus, Pinecone |
| **API stability** | Frequent breaking changes | Moderate changes | Stable |
| **Documentation** | Good (many examples) | Excellent | Good |
| **Community activity** | Very high (but noisy) | High | Medium |
| **Maintainer** | LangChain Inc. | LlamaIndex Inc. | Deepset |
| **Local dev experience** | Good | Good | Excellent |
| **Learning curve** | Steep (large surface) | Medium | Moderate |
| **Operational burden** | High (many components) | Medium | Medium |

### 7. Recommendation

- State the chosen framework (e.g., "LlamaIndex") and the rationale (e.g., "strong citation tracking, clean reranking integration, and stable API").
- Document the team's responsibility: you are now maintaining the integration with your embedding model, vector store, and LLM provider. If the framework doesn't have a connector, you own writing and testing it.
- Acknowledge the learning curve: new frameworks take 2–4 weeks for a team to be productive.
- Document the fallback if the primary choice doesn't work out (e.g., "Primary: LlamaIndex. Fallback: Haystack if citation tracking becomes blocking.").

## Failure modes

- **Choosing based on "getting started" tutorials.** Tutorials cover happy paths, not production requirements: streaming, error handling, access control, reranking, observability.
- **Underestimating learning curve.** A new framework takes weeks for a team to be productive. Budget for it.
- **Overestimating community support.** A popular GitHub project doesn't mean your edge case is solved. Check issues for your use case.
- **Framework version churn causing production incidents.** Check the changelog; if major versions drop every 6 months with breaking changes, you're in for maintenance work.
- **Vendor lock-in through custom code.** If you write custom retrieval logic inside the framework, you're now maintaining it. Prefer generic, composable blocks.
- **Dependency bloat.** Pulling in a framework that depends on 50 packages creates supply-chain risk and version conflict headaches. Prefer lightweight, composable libraries.
- **Observability hidden.** If the framework abstracts away logging and tracing, you can't debug production issues. Test observability hookpoints before committing.

## Output

- **Comparison matrix:** feature completeness, integration, maintainability, operational fit (as above).
- **Decision:** primary framework, rationale, fallback option.
- **Team responsibility matrix:** who integrates with the vector store, who integrates with the LLM, who owns observability/monitoring.
- **Estimated onboarding:** learning curve and ramp time (weeks, not months).
- **Integration checklist:** vector store connector status (built-in or custom), embedding model connector, reranking setup, citation tracking setup.
- **Monitoring:** which metrics to track post-launch (retrieval latency, citation presence in output, streaming start-time, error rates).
