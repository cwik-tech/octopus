---
name: parser-selection-methodology
description: Parser bake-off and selection — run tests against representative corpus, score fidelity and multimodal handling, measure cost and latency, produce comparison report with justified recommendation
---

# Parser Selection Methodology

## Purpose

Select parsers based on measured fidelity against your actual corpus, not vendor claims. Run a bake-off, score each candidate on structure preservation, multimodal quality, and operational metrics, and produce a comparison report that justifies the selection.

## When to Use

- Before committing to a parser for the production pipeline
- After a parser update to check for regressions
- When evaluating a new vendor or tool as a potential replacement

## Methodology

### 1. Build a Representative Test Set

Sample your corpus across:

- **File types:** PDF (native, scanned), DOCX, XLSX, images, drawings—everything you'll parse
- **Content complexity:** Simple prose, complex nested structures, multi-column layouts, intricate tables
- **Languages:** Every language in your corpus
- **Edge cases:** Low-quality scans, diagrams without captions, tables with merged cells, multilingual mixed content

Target size: 50–200 documents. Represent 80%+ of your content types and at least 5–10 examples of your highest-risk categories.

### 2. Define the Evaluation Scorecard

For each parser, measure:

**Structure Fidelity (40% weight)**
- Heading hierarchy preserved (H1 → H2 → H3)
- Lists and bullets correctly identified and nested
- Footnotes, references, hyperlinks extracted
- Section boundaries clear in Markdown output
- No spurious line breaks or text reordering

**Multimodal Handling (30% weight)**
- Tables: cell content, merged cells, multi-row headers extracted correctly
- Images: detected, described, or referenced in output
- Diagrams and drawings: native extraction vs fallback description quality
- Scanned pages: OCR character accuracy, layout preservation
- OCR confidence scores available for all text

**Operational Metrics (20% weight)**
- Latency per document (seconds)
- Cost per document (currency)
- Asset handling (images retained, referenced, or discarded)
- Failure modes (formats rejected gracefully vs crashes)
- Reproducibility (same input → same output)

**Auditability (10% weight)**
- Provenance metadata available (source file, revision, parse timestamp)
- Confidence scores per extracted component
- Position information (page, byte offset, location) retained

### 3. Run the Bake-Off

For each parser candidate:

1. Run against the full test set
2. For each document, score each criterion against the scorecard
3. Categorize failures: structure loss, multimodal quality drop, missing content, unsupported format, error/crash
4. Aggregate scores by content type (tables, scans, diagrams, multilingual, etc.)
5. Calculate cost and latency distributions (mean, p95, p99)
6. Measure end-to-end pipeline time (ingestion + parsing + validation)

### 4. Build the Comparison Report

**Format:** Side-by-side matrix with weightings and totals.

Example:

| Criterion | Weight | Parser A | Parser B | Parser C | Winner |
|-----------|--------|----------|----------|----------|--------|
| Heading hierarchy | 10% | 96% | 94% | 98% | C |
| Table correctness | 15% | 92% | 88% | 95% | C |
| OCR accuracy | 10% | 88% | 91% | 90% | B |
| Diagram extraction | 5% | Native | OCR | Fallback | A |
| Cost per doc | 10% | $0.03 | $0.01 | $0.02 | B |
| Latency (p95 sec) | 5% | 2.1 | 1.8 | 2.3 | B |
| Asset handling | 10% | Retained | Reference | Retained | Tie |
| Confidence scores | 10% | Per-component | Per-doc | None | A |
| Error handling | 5% | Graceful | Crash | Retry | A |
| **Weighted total** | **100%** | **90.2%** | **88.5%** | **92.1%** | **C** |

**Include:**
- Failure analysis: Which content types failed for each parser, and why
- Cost-benefit: Total parsing cost at scale (documents × cost per doc) vs quality gain
- Risk assessment: What happens if this parser becomes unsupported, or confidence degrades
- Sensitivity analysis: How much does cost dominate vs fidelity for your use case

### 5. Recommendation

State the winner and your confidence:

- **Primary recommendation:** [Parser name], because [specific strengths on your corpus: e.g., "95% table accuracy on XLSX, native diagram extraction, $0.01/doc"]
- **Fallback (if primary unavailable):** [Parser name], score [X]%
- **Not recommended:** [Parser name], because [specific weakness that matters: e.g., "92% OCR accuracy insufficient for scanned technical docs in your corpus"]

**Acceptance criteria:** Include the conditions under which this recommendation holds. Example: "This holds if OCR confidence stays >90% on scanned pages. If baselines degrade, we re-evaluate in Q3 2026."

## Questions to Answer Before Running Bake-Off

1. What is your test set size and composition, and does it represent your hardest content types?
2. What is an acceptable OCR confidence floor for your use case? (e.g., 90%, 95%)
3. For tables: merged cells, multi-row headers, complex layouts—what counts as correct?
4. For scanned pages: is your goal character accuracy, layout preservation, or both?
5. For diagrams: extract native vector data, generate text descriptions, or retain image?
6. What is your cost budget per document, and at what volume does that budget matter?
7. If a parser fails on 5% of your corpus, can you tolerate a manual review queue, or must you re-parse?
8. Do you need incremental sync or only full corpus re-parsing?

## Red Flags

- A parser that scores well on the vendor's test set but poorly on your actual corpus
- A parser that excels at PDFs but has no strategy for DOCX or scanned content
- A vendor unwilling to provide confidence scores or failure categorization
- Parser selection made on speed alone, without measuring fidelity on your corpus
- A test set that excludes your highest-risk content types
- Missing cost data or cost that scales non-linearly with document volume

## Output

A parser comparison report containing:

1. **Test set description:** Composition, size, sampling strategy, language distribution
2. **Evaluation scorecard:** Criteria, weights, rationale for each weight
3. **Side-by-side comparison:** Fidelity matrix with weighted totals
4. **Failure analysis:** Failure rates by content type, root cause for each parser
5. **Cost-benefit analysis:** Total cost at scale, cost per quality point gained
6. **Risk assessment:** Parser stability, vendor support, contingency strategy
7. **Recommendation:** Primary, fallback, not-recommended, with acceptance criteria
8. **Decision gate:** Clear threshold for approval (e.g., "Primary recommendation approved if weighted score >90% and OCR confidence >90%")
