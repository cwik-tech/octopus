---
name: evaluation-question-set-design
description: Methodology for building representative labelled evaluation sets with known answer locations to benchmark retrieval quality before tooling selection.
---

# Evaluation Question Set Design

## Purpose

Build labelled evaluation sets (100–200 questions with known answer locations) that represent real agent use cases and retrieval challenges before the team commits to retrieval architecture. The evaluation set is the ground truth; retrieval architecture is justified by performance on this set, not on vendor claims or theoretical elegance.

## When to Use

- Creating an evaluation set for a new corpus or knowledge domain
- Updating evaluation sets when corpus scope changes significantly
- Validating that an evaluation set represents the actual use cases agents will face
- Before finalizing retrieval architecture or tooling decisions

## Core Methodology

### 1. Sample the Corpus Strategically

- **By document type:** PDFs (native, scanned), DOCX with embedded tables/images, XLSX workbooks, diagrams, technical drawings, mixed-format sources
- **By content density:** Dense technical specifications, loose narrative documentation, highly structured tables, sparse unstructured prose
- **By language:** English primary; secondary languages if FST operates globally
- **By domain:** If corpus spans product categories or process domains, sample across all of them

Document the composition so evaluation results can be interpreted in context.

### 2. Design Question Types

Create questions representing different retrieval challenges:

- **Exact fact lookup** ("What is the maximum operating temperature of module X?") — lexical retrieval often strong here
- **Multi-passage synthesis** ("How does the assembly process differ between variant A and B?") — requires combining passages
- **Table extraction** ("What are the dimensional tolerances for fastener Y?") — needs retrieval that preserves table structure
- **Diagram or image interpretation** ("How is the thermal flow routed through the heat sink?") — requires image understanding or good text descriptions
- **Implicit reasoning** ("Which materials are approved for high-moisture environments?") — requires inferring from specifications and constraints
- **Temporal or versioning** ("What changed in the design between revision 2.1 and 2.2?") — requires distinguishing document versions

Aim for ~30% easy (clear answers in one passage), ~50% medium (combine 2–3 passages or follow a chain), ~20% hard (synthesis across domains or handling ambiguity).

### 3. Document Answer Locations

For each question, specify:

- **Authoritative passage(s):** Text excerpts from the source corpus that answer the question completely
- **Source document:** Name, ID, revision, URL in source system (e.g., SharePoint path)
- **Chunk locator:** Heading path in final Markdown (e.g., "# Design Specifications > ## Module X > ### Operating Parameters")
- **Page or section locator:** Physical location in original document (e.g., "page 3, section 2.1" or "Sheet 'Specifications', rows 5–7")
- **Supporting passages:** Related passages that provide context but don't directly answer the question

### 4. Assign Difficulty and Metadata

- **Difficulty:** Easy / Medium / Hard (based on retrieval complexity, not question phrasing)
- **Question type:** Fact lookup, synthesis, table extraction, diagram interpretation, reasoning, versioning
- **Domain/product category:** If corpus is multi-domain
- **Language:** English, [other]
- **Recency sensitivity:** Is the answer likely to change? Mark content that ages quickly

### 5. Validate Representation

- **Coverage check:** Does the evaluation set span all major use cases agents will actually face?
- **Frequency check:** Do question types match the distribution agents will encounter?
- **Difficulty distribution:** 30/50/20 easy/medium/hard or skew based on actual use cases?

Ask domain experts: "Are these the questions your agents need to answer?" If not, iterate.

## Quality Criteria for Evaluation Sets

- **Unambiguous answers:** Every question has one clear best answer, located in the corpus. No questions with acceptable multi-answer responses.
- **Authoritative sources:** All questions answer from official FST sources (specs, SOPs, design docs). Never invent information not in the corpus.
- **Diverse retrieval challenges:** Question set exercises chunking, lexical search, dense embeddings, metadata filtering, multi-passage reasoning.
- **Representative corpus coverage:** Evaluation set samples the corpus proportionally. If 40% of the corpus is scanned PDFs, 40% of the evaluation set should test scanned-PDF retrieval.
- **Documented traceability:** Every answer location is documented with source, chunk path, page locator, and supporting passages. The evaluation team can verify every ground-truth answer.

## Anti-Patterns to Avoid

- **Questions only answerable by general knowledge:** If GPT-4's general knowledge answers the question, retrieval didn't do the work.
- **Answers not in the corpus:** Don't test questions the corpus doesn't actually answer.
- **Vague questions with multiple acceptable answers:** "How should we handle errors?" is too open-ended. "What error-handling strategy does the firmware use in scenario X?" is testable.
- **Trivial questions:** "What is the product name?" is too easy to measure meaningful retrieval quality.
- **Over-sampling easy questions:** If evaluation skews heavily toward fact lookup, it won't catch failures on synthesis or complex reasoning.
- **No cross-checks:** Don't assume an evaluation set is good just because it sounds comprehensive. Run a domain expert review against actual agent use cases.

## Output

A labelled evaluation set delivered as:
- **CSV or structured format** with columns: question ID, question text, answer text(s), source document, chunk ID/heading path, page locator, question type, difficulty, domain, language
- **Supporting materials:** Document samples, parsing screenshots, confidence notes on OCR or extraction fidelity for any answers drawn from scanned or complex content
- **Coverage report:** Breakdown by document type, question type, difficulty, domain, language; notes on any corpus areas under-represented

The evaluation set becomes the ground truth for benchmarking. Treat it as a maintained artifact: version it, update it as the corpus evolves, and track which retrieval strategies were tested against which version.
